/**
 * تدفق الدمج (runMerge + refreshMergeTask) — قسم 7.3 من المواصفة.
 * 1) تحقق صارم: ≥2 مقاطع و ≤10 وكلها روابط http/https مباشرة عامة.
 * 2) تسجيل المهمة في Turso أولًا (type=merge, provider=merger, model=video-merger).
 * 3) POST /api/jobs ثم تنفيذ process مرة واحدة فقط بقفل في الذاكرة.
 * 4) استعلام كل 3 ثوان مع بث تقدم وكتابة الحالة في Turso فورًا.
 * 5) قاعدة حتمية: أي خطأ معلن من الخدمة (4xx/5xx بجسم error) = فشل نهائي فوري — لا إعادة محاولة؛
 *    أخطاء شبكتنا نحن = مؤقتة وتستمر بالاستعلام.
 */
import { randomUUID } from "node:crypto";
import { insertTask, getTask, updateTask, ensureSchema, type MediaTask } from "./turso";
import { formatTask } from "./format";
import { mergerConfigured, mergerCreateJob, mergerGetStatus, mergerProcess } from "./merger";
import { ProviderError } from "./errors";
import type { Notify, RunResult } from "./toolTypes";

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

const g = globalThis as unknown as { __mgProcessInFlight?: Set<string> };
/** قفل الذاكرة يمنع تنفيذ process المتزامن مع get_task لنفس المهمة */
const processInFlight: Set<string> = (g.__mgProcessInFlight ??= new Set());

function isPublicHttpUrl(u: string): boolean {
  try {
    const url = new URL(u);
    if (!/^https?:$/.test(url.protocol)) return false;
    const h = url.hostname.toLowerCase();
    if (!h || h === "localhost" || h.endsWith(".local") || h.endsWith(".internal")) return false;
    if (/^127\./.test(h) || /^10\./.test(h) || /^192\.168\./.test(h) || /^169\.254\./.test(h)) return false;
    if (/^172\.(1[6-9]|2\d|3[01])\./.test(h)) return false;
    if (h === "0.0.0.0" || h === "[::1]") return false;
    return true;
  } catch {
    return false;
  }
}

export async function runMerge(args: {
  urls?: string[];
  task_ids?: string[];
  waitSeconds: number;
  notify?: Notify;
}): Promise<RunResult> {
  await ensureSchema();
  if (!mergerConfigured()) {
    return {
      text: "❌ خدمة الدمج غير مضبوطة: عيّن متغير البيئة MERGER_API_base ثم أعد المحاولة.".replace("MERGER_API_base", "MERGER_API_BASE"),
      isError: true,
    };
  }

  // ===== حل task_ids (روابط المهام المكتملة بالترتيب) =====
  const details: string[] = [];
  const resolved: string[] = [];
  for (const tid of args.task_ids ?? []) {
    const t = await getTask(String(tid).trim());
    if (!t) {
      details.push(`- ${tid}: المهمة غير موجودة في قاعدة البيانات`);
      continue;
    }
    if (t.status !== "completed" || !t.result_urls.length) {
      const ar = t.status === "processing" ? "جارية" : t.status === "failed" ? "فاشلة" : t.status;
      details.push(`- ${tid}: الحالة «${ar}» — تُقبل فقط المهام المكتملة ذات روابط نتائج`);
      continue;
    }
    resolved.push(t.result_urls[0]);
  }
  if (details.length) {
    return {
      text: `❌ لا يمكن الدمج — تفاصيل المعرفات غير الصالحة:\n${details.join("\n")}\n\nالدمج يحتاج مقطعَين على الأقل. مرّر urls (روابط مباشرة) أو task_ids لمهام مكتملة.`,
      isError: true,
    };
  }

  // الترتيب: روابط task_ids أولًا ثم urls المباشرة بنفس ترتيبها
  const all = [...resolved, ...(args.urls ?? []).map((u) => String(u).trim())].filter(Boolean);
  if (all.length < 2) {
    return {
      text: "❌ الدمج يحتاج مقطعَين على الأقل. مرّر urls (روابط مباشرة) أو task_ids لمهام مكتملة.",
      isError: true,
    };
  }
  if (all.length > 10) {
    return {
      text: "❌ أقصى عدد مقاطع للدمج هو 10 (خدمة الدمج تقبل 10 مقاطع كحد أقصى).",
      isError: true,
    };
  }
  for (const u of all) {
    if (!isPublicHttpUrl(u)) {
      return {
        text: `❌ رابط غير صالح أو غير عام: ${u} — يجب أن يكون رابط فيديو مباشرًا عبر http/https وعامًا.`,
        isError: true,
      };
    }
  }

  // سجّل مهمة الدمج في قاعدة البيانات أولًا
  const task = await insertTask({
    id: randomUUID(),
    type: "merge",
    model: "video-merger",
    prompt: `دمج ${all.length} مقاطع بالترتيب المعطى`,
    params_json: JSON.stringify({ videos: all }),
    provider: "merger",
    status: "processing",
  });
  return driveMerge(task.id, { waitSeconds: args.waitSeconds, notify: args.notify });
}

/** تنفيذ process مرة واحدة لكل مهمة — محمي بقفل الذاكرة */
async function triggerProcessOnce(jobId: string, taskId: string): Promise<void> {
  if (processInFlight.has(jobId)) return;
  processInFlight.add(jobId);
  try {
    const { status, json } = await mergerProcess(jobId);
    if (status >= 400) {
      // خطأ معلن من خدمة الدمج = فشل نهائي فوري — لا إعادة محاولة
      await updateTask(taskId, {
        status: "failed",
        error_message: String(json?.error ?? `خدمة الدمج ردّت بحالة ${status}`),
      });
    } else if (json?.status === "done" && json?.videoUrl) {
      await updateTask(taskId, { status: "completed", result_urls: [String(json.videoUrl)] });
    }
  } catch {
    // خطأ شبكتنا نحن — مؤقت: الاستعلام التالي سيعيد المحاولة
  } finally {
    processInFlight.delete(jobId);
  }
}

interface DriveMergeOptions {
  waitSeconds: number;
  notify?: Notify;
}

async function driveMerge(taskId: string, opts: DriveMergeOptions): Promise<RunResult> {
  const deadline = Date.now() + Math.max(0, opts.waitSeconds) * 1000;

  while (true) {
    const task = await getTask(taskId);
    if (!task) return { text: `❌ المهمة غير موجودة: ${taskId}`, isError: true };
    if (task.status === "completed" || task.status === "failed") {
      return { text: formatTask(task), isError: task.status === "failed", taskId };
    }

    if (!task.provider_task_id) {
      // لم تُنشأ مهمة الخدمة بعد (أول مرة، أو إعادة بعد انقطاع شبكتنا) — بتهدئة 15 ثانية
      const lastMs = Date.parse(`${task.updated_at.replace(" ", "T")}Z`);
      const cooled = Number.isNaN(lastMs) || Date.now() - lastMs >= 15_000;
      if (!cooled) return { text: formatTask(task), taskId };
      try {
        const params = JSON.parse(task.params_json || "{}") as { videos?: string[] };
        const job = await mergerCreateJob(params.videos ?? []);
        await updateTask(task.id, { provider_task_id: job.jobId, progress: 5, error_message: null });
      } catch (e) {
        const detail = e instanceof Error ? e.message : String(e);
        await updateTask(task.id, {
          error_message: `تعذر إنشاء مهمة الدمج لدى الخدمة — تُعاد المحاولة تلقائيًا (${detail})`,
        });
      }
    } else {
      try {
        const st = await mergerGetStatus(task.provider_task_id);
        if (st.failed) {
          // فشل معلن من الخدمة — نهائي فوري
          await updateTask(task.id, { status: "failed", error_message: st.error ?? "فشل الدمج لدى الخدمة" });
          const t2 = await getTask(task.id);
          return { text: formatTask(t2!), isError: true, taskId };
        }
        if (st.done) {
          await updateTask(task.id, { status: "completed", result_urls: [st.videoUrl!], progress: 100 });
          const t2 = await getTask(task.id);
          return { text: formatTask(t2!), taskId };
        }
        if (st.queued) {
          // بدء process خلفيًا وبمرة واحدة فقط (القفل يمنع التزامن)
          void triggerProcessOnce(task.provider_task_id, task.id);
        }
        await updateTask(task.id, { progress: st.progress });
        await opts.notify?.(st.progress, 100, `قيد الدمج… ${st.progress}%`);
      } catch (e) {
        if (e instanceof ProviderError && e.status === 404) {
          // مهمة الدمج غير موجودة في الخدمة — فشل نهائي (حُذفت أو انتهت صلاحيتها بعد 24 ساعة)
          await updateTask(task.id, { status: "failed", error_message: e.message });
          const t2 = await getTask(task.id);
          return { text: formatTask(t2!), isError: true, taskId };
        }
        // خطأ شبكتنا نحن — مؤقت: واصل الاستعلام حتى نهاية النافذة
      }
    }

    if (Date.now() >= deadline) {
      const t2 = await getTask(taskId);
      return { text: formatTask(t2!), taskId };
    }
    await sleep(3000);
  }
}

/** get_task لمهمة دمج — تحديث حي بنافذة قصيرة */
export async function refreshMergeTask(task: MediaTask, notify?: Notify): Promise<RunResult> {
  if (task.status === "completed" || task.status === "failed") {
    return { text: formatTask(task), isError: task.status === "failed", taskId: task.id };
  }
  return driveMerge(task.id, { waitSeconds: 20, notify });
}
