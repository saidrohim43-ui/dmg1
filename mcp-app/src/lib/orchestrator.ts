/**
 * منسّق التوليد — قلب المشروع.
 * قواعد جوهرية (لا تُخرَق):
 * 1) ترتيب المفاتيح تسلسلي صارم حسب الإضافة (created_at ASC, id ASC) — ليس round-robin.
 * 2) أي فشل مفتاح/رصيد → انتقال تلقائي للمفتاح التالي واستئناف نفس المهمة بنفس task_id.
 * 3) فشل الإنشاء على كل المفاتيح → المهمة تبقى processing وتُعاد المحاولة مع كل get_task (تهدئة ~45 ثانية).
 * 4) نموذج الذكاء الاصطناعي لا يرى أخطاء المفاتيح/الرصيد أبدًا.
 * 5) لا يُنزَّل أي ملف وسائط — روابط فقط.
 */
import { randomUUID } from "node:crypto";
import {
  getKeyPool,
  getKey,
  insertTask,
  getTask,
  updateTask,
  bumpKeyStats,
  ensureSchema,
  listRecentTasks,
  type MediaTask,
  type ApiKeyRow,
  type TaskAttempt,
} from "./turso";
import { resolveModel, type MediaType, type ProviderId } from "./models";
import { classifyProviderError, looksLikeKeyOrBalanceError, ProviderError } from "./errors";
import { getAdapter } from "./providers/types";
import { formatTask, formatList } from "./format";
import { runMerge as runMergeImpl, refreshMergeTask } from "./mergeRunner";
import type { Notify, RunResult } from "./toolTypes";

export type { Notify, RunResult };
export const runMerge = runMergeImpl;

export interface GenParams {
  prompt: string;
  image_url?: string;
  aspect_ratio?: string;
  resolution?: string;
  background?: string;
  output_format?: string;
  enable_audio?: boolean;
  duration?: number;
}

export interface RunGenOptions {
  type: MediaType;
  model?: string;
  params: GenParams;
  waitSeconds: number;
  notify?: Notify;
}

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

function buildInput(type: MediaType, p: GenParams): Record<string, unknown> {
  const input: Record<string, unknown> = { prompt: p.prompt };
  if (type === "image") {
    if (p.aspect_ratio && p.aspect_ratio !== "auto") input.aspect_ratio = p.aspect_ratio;
    if (p.resolution) input.resolution = p.resolution;
    if (p.background && p.background !== "auto") input.background = p.background;
    if (p.output_format) input.output_format = p.output_format;
  } else {
    if (p.image_url) input.image_url = p.image_url;
    if (p.aspect_ratio && p.aspect_ratio !== "auto") input.aspect_ratio = p.aspect_ratio;
    if (p.resolution) input.resolution = p.resolution;
    input.enable_audio = p.enable_audio !== false;
    input.duration = p.duration ?? 8;
  }
  return input;
}

function attempt(cand: ApiKeyRow, ok: boolean, errorClass?: string, error?: string): TaskAttempt {
  return {
    provider: cand.provider,
    keyId: cand.id,
    keyLabel: cand.label || undefined,
    ok,
    errorClass: error ? errorClass : undefined,
    error: error ?? undefined,
    at: new Date().toISOString(),
  };
}

/** نتيجة إنشاء على مرشح: مهمة غير متزامنة أو روابط متزامنة */
async function createOn(
  model: { type: MediaType; providerModel: Record<string, string> },
  cand: ApiKeyRow,
  params: GenParams
): Promise<{ providerTaskId?: string; syncUrls?: string[] }> {
  const adapter = getAdapter(cand.provider);
  const providerModel = model.providerModel[cand.provider] || model.providerModel.kie || model.providerModel.cometapi;
  const res: { providerTaskId: string; syncUrls?: string[] } = await adapter.createTask(
    cand.api_key,
    providerModel,
    buildInput(model.type, params)
  );
  if (res.syncUrls?.length) return { syncUrls: res.syncUrls };
  return { providerTaskId: res.providerTaskId };
}

interface DriveOptions {
  type: MediaType;
  model: { canonical: string; type: MediaType; providerModel: Record<string, string> };
  params: GenParams;
  waitSeconds: number;
  notify?: Notify;
  /** البدء من فهرس معين في التجمع (بعد فشل مفتاح سابق) */
  startIdx?: number;
}

/**
 * حالة "بانتظار مفتاح صالح": بقيت المهمة processing وسيُعاد المحاولة مع كل get_task.
 */
async function markWaitingForKey(taskId: string): Promise<void> {
  await updateTask(taskId, {
    error_message: "بانتظار توفر مفتاح صالح… (تُعاد المحاولة تلقائيًا)",
  });
}

/**
 * محرك التنفيذ الموحد: الإنشاء على المرشحين بالترتيب → نافذة استعلام مع بث تقدم →
 * عند فشل مفتاحي في منتصف المهمة: إعادة إنشاء نفس المهمة بنفس task_id على المفتاح التالي.
 * يعيد الحالة النهائية للمهمة (completed/failed/processing).
 */
async function driveTask(taskId: string, pool: ApiKeyRow[], opts: DriveOptions): Promise<MediaTask> {
  let idx = Math.max(0, opts.startIdx ?? 0);
  const deadline = Date.now() + opts.waitSeconds * 1000;

  while (true) {
    // ===== مرحلة الإنشاء: جرّب المرشحين بالترتيب التسلسلي =====
    let created: { provider: ProviderId; providerTaskId: string; apiKey: string; keyId: string } | null = null;

    while (idx < pool.length) {
      const cand = pool[idx];
      try {
        const res = await createOn(opts.model, cand, opts.params);
        await updateTask(taskId, {
          appendAttempt: attempt(cand, true),
        });
        await bumpKeyStats(cand.id, { ok: true });
        if (res.syncUrls?.length) {
          // صورة متزامنة اكتملت فورًا (CometAPI)
          await updateTask(taskId, {
            provider: cand.provider,
            key_id: cand.id,
            status: "completed",
            result_urls: res.syncUrls,
          });
          return (await getTask(taskId))!;
        }
        created = { provider: cand.provider as ProviderId, providerTaskId: res.providerTaskId!, apiKey: cand.api_key, keyId: cand.id };
        await updateTask(taskId, {
          provider: cand.provider,
          provider_task_id: res.providerTaskId,
          key_id: cand.id,
          progress: 5,
        });
        break;
      } catch (e) {
        const { cls, detail } = classifyProviderError(e);
        await updateTask(taskId, { appendAttempt: attempt(cand, false, cls, detail) });
        await bumpKeyStats(cand.id, { ok: false, errorClass: cls, error: detail });
        if (cls === "params") {
          // خطأ معطيات حقيقي — التبديل لن يحلّه → فشل نهائي (رسالة آمنة للعرض)
          await updateTask(taskId, { status: "failed", error_message: detail });
          return (await getTask(taskId))!;
        }
        idx++; // المفتاح التالي بنفس الترتيب — صامت تمامًا من وجهة نظر العميل
      }
    }

    if (!created) {
      // فشل على كل المفاتيح → تبقى processing وتُعاد المحاولة مع كل get_task
      await markWaitingForKey(taskId);
      return (await getTask(taskId))!;
    }

    // ===== مرحلة الاستعلام: كل 3 ثوان حتى نهاية النافذة =====
    let recreateFrom = -1; // فهرس إعادة الإنشاء إن فشل المفتاح في منتصف المهمة
    while (Date.now() < deadline) {
      await sleep(3000);
      let check: { status: string; urls?: string[]; error?: string; progress?: number };
      try {
        check = await getAdapter(created.provider).checkTask(created.apiKey, created.providerTaskId);
      } catch (e) {
        const { cls, detail } = classifyProviderError(e);
        const cand = pool[idx];
        await updateTask(taskId, { appendAttempt: attempt(cand, false, cls, detail) });
        await bumpKeyStats(cand.id, { ok: false, errorClass: cls, error: detail });
        if (cls === "params") {
          await updateTask(taskId, { status: "failed", error_message: detail });
          return (await getTask(taskId))!;
        }
        // مفتاح/رصيد/مزود/مؤقت → أعد إنشاء نفس المهمة بنفس task_id على المفتاح التالي
        recreateFrom = idx + 1;
        break;
      }

      if (check.status === "completed") {
        await updateTask(taskId, {
          status: "completed",
          result_urls: check.urls ?? [],
          progress: 100,
        });
        return (await getTask(taskId))!;
      }
      if (check.status === "failed") {
        const msg = String(check.error ?? "فشل التوليد لدى المزود");
        if (looksLikeKeyOrBalanceError(msg)) {
          // فشل مفتاح/رصيد في منتصف المهمة → تبديل صامت لنفس task_id
          const cand = pool[idx];
          await updateTask(taskId, { appendAttempt: attempt(cand, false, "provider_midtask", msg) });
          // صنّف الرسالة نفسها لتحديث حالة المفتاح الصحيحة (مستنزف/معطل)
          const msgCls = classifyProviderError(new ProviderError(0, msg)).cls;
          await bumpKeyStats(cand.id, { ok: false, errorClass: msgCls, error: msg });
          recreateFrom = idx + 1;
          break;
        }
        // فشل حقيقي (سياسة/معطيات) — لا تبديل ينفع
        await updateTask(taskId, { status: "failed", error_message: msg });
        return (await getTask(taskId))!;
      }

      // قيد المعالجة — حدّث التقدم وابث إشعارًا
      const p = check.progress ?? 0;
      await updateTask(taskId, { progress: Math.max(5, p) });
      await opts.notify?.(Math.max(5, p), 100, `قيد التوليد… ${Math.max(5, p)}%`);
    }

    if (recreateFrom >= 0) {
      idx = Math.min(recreateFrom, pool.length);
      continue; // عُد لمرحلة الإنشاء على المفتاح التالي بنفس task_id
    }
    if (Date.now() >= deadline) {
      // انتهت النافذة دون نتيجة → أعِد المهمة بحالتها (processing) والعميل يتابع بـ get_task
      return (await getTask(taskId))!;
    }
  }
}

/** توليد صورة/فيديو — التدفق الكامل (قسم 6) */
export async function runGeneration(opts: RunGenOptions): Promise<RunResult> {
  await ensureSchema();
  const model = resolveModel(opts.model, opts.type);
  if (!model) {
    return {
      text: `❌ موديل غير معروف: ${opts.model}. المتاح: gpt-image-2-6/flare-text-to-image (صور) و grok-imagine-video-1-5-preview (فيديو).`,
      isError: true,
    };
  }
  const pool = await getKeyPool(model.providers);
  if (!pool.length) {
    return {
      text: `❌ لا توجد مفاتيح نشطة لخدمة ${model.canonical}. أضف مفتاحًا واحدًا على الأقل من واجهة الإدارة، ثم أعد المحاولة.`,
      isError: true,
    };
  }
  // سجّل المهمة في قاعدة البيانات قبل أي نداء خارجي — تبقى قابلة للتتبع حتى لو انقطع الاتصال
  const task = await insertTask({
    id: randomUUID(),
    type: opts.type,
    model: model.canonical,
    prompt: opts.params.prompt,
    params_json: JSON.stringify(opts.params),
    status: "processing",
  });
  const final = await driveTask(task.id, pool, {
    type: opts.type,
    model,
    params: opts.params,
    waitSeconds: opts.waitSeconds,
    notify: opts.notify,
  });
  return { text: formatTask(final), isError: final.status === "failed", taskId: final.id };
}

/**
 * refreshTask — يستدعيها get_task: تحديث حي للمهمة الجارية من المزود أو خدمة الدمج،
 * مع نفس منطق إعادة المحاولة/التبديل.
 */
export async function refreshTask(taskId: string, notify?: Notify): Promise<RunResult> {
  await ensureSchema();
  const task = await getTask(taskId);
  if (!task) return { text: `❌ المهمة غير موجود: ${taskId}`, isError: true };

  if (task.type === "merge") return refreshMergeTask(task, notify);

  if (task.status === "completed" || task.status === "failed") {
    return { text: formatTask(task), isError: task.status === "failed", taskId: task.id };
  }

  // ===== جارية =====
  if (task.provider && task.provider_task_id && task.key_id) {
    const key = await getKey(task.key_id);
    if (key && key.status !== "disabled") {
      try {
        const check = await getAdapter(task.provider).checkTask(key.api_key, task.provider_task_id);
        if (check.status === "completed") {
          const updated = await updateTask(task.id, {
            status: "completed",
            result_urls: check.urls ?? [],
            progress: 100,
          });
          return { text: formatTask(updated!), taskId: task.id };
        }
        if (check.status === "failed") {
          const msg = String(check.error ?? "");
          if (looksLikeKeyOrBalanceError(msg)) {
            await bumpKeyStats(key.id, { ok: false, errorClass: "exhausted", error: msg });
          } else {
            // فشل حقيقي نهائي
            await updateTask(task.id, { status: "failed", error_message: msg || "فشل التوليد لدى المزود" });
            const updated = await getTask(task.id);
            return { text: formatTask(updated!), isError: true, taskId: task.id };
          }
        } else {
          await updateTask(task.id, { progress: Math.max(task.progress, check.progress ?? 0) });
          await notify?.(task.progress, 100, `قيد التوليد… ${task.progress}%`);
          const updated = await getTask(task.id);
          return { text: formatTask(updated!), taskId: task.id };
        }
      } catch (e) {
        const { cls, detail } = classifyProviderError(e);
        await bumpKeyStats(key.id, { ok: false, errorClass: cls, error: detail });
        if (cls === "params") {
          await updateTask(task.id, { status: "failed", error_message: detail });
          const updated = await getTask(task.id);
          return { text: formatTask(updated!), isError: true, taskId: task.id };
        }
        // مفتاح/رصيد/شبكة → استمر لإعادة الإنشاء أدناه بنفس task_id
      }
    }
  }

  // ===== إعادة الإنشاء (بانتظار مفتاح صالح، أو فشل المفتاح المربوط) — بتهدئة ~45 ثانية =====
  const lastMs = Date.parse(`${task.updated_at.replace(" ", "T")}Z`);
  const cooled = Number.isNaN(lastMs) || Date.now() - lastMs >= 45_000;
  if (cooled) {
    const model = resolveModel(task.model);
    if (!model) {
      await updateTask(task.id, { status: "failed", error_message: `موديل غير معروف: ${task.model}` });
      const updated = await getTask(task.id);
      return { text: formatTask(updated!), isError: true, taskId: task.id };
    }
    const pool = await getKeyPool(model.providers);
    if (!pool.length) {
      await markWaitingForKey(task.id);
    } else {
      // أعد إنشاء نفس المهمة بنفس task_id على المرشحين بالترتيب، بنافذة قصيرة للصور السريعة
      const params = safeParseParams(task);
      await driveTask(task.id, pool, {
        type: model.type,
        model,
        params,
        waitSeconds: 20,
        notify,
      });
    }
  }
  const updated = await getTask(task.id);
  return { text: formatTask(updated!), taskId: task.id };
}

function safeParseParams(task: MediaTask): GenParams {
  try {
    const p = JSON.parse(task.params_json) as GenParams;
    return { ...p, prompt: task.prompt || p.prompt || "" };
  } catch {
    return { prompt: task.prompt || "" };
  }
}

/** أحدث الوسائط المخزنة بروابطها من قاعدة البيانات — بدون إعادة توليد */
export async function listMedia(opts: { type?: string; status?: string; limit?: number }): Promise<RunResult> {
  await ensureSchema();
  const type = opts.type && ["image", "video", "merge"].includes(opts.type) ? opts.type : undefined;
  const status = opts.status && ["completed", "failed", "processing"].includes(opts.status) ? opts.status : undefined;
  const limit = Math.max(1, Math.min(50, opts.limit ?? 10));
  const tasks = await listRecentTasks(limit, { type, status });
  if (!tasks.length) return { text: "📚 لا توجد وسائط مخزنة بعد حسب الفلاتر المطلوبة." };
  return { text: formatList(tasks) };
}
