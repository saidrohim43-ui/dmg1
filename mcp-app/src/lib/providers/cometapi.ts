/**
 * مزود CometAPI — متوافق مع OpenAI (base: https://api.cometapi.com).
 * - الصور: متزامنة عبر نقطة images المتوافقة مع OpenAI تعيد الرابط أو b64_json فورًا.
 * - الفيديو: غير متزامن بنمط إنشاء مهمة ثم استعلام (نفس نمط create/check) — اتبع التوثيق الحالي
 *   في api.cometapi.com عند تغيّر الأشكال، والتحليل هنا دفاعي يقبل أكثر من تسمية شائعة.
 */
import { ProviderError } from "../errors";
import type { ProviderAdapter, ProviderTaskHandle } from "./types";

const BASE = "https://api.cometapi.com";
const MAX_B64_BYTES = 1_000_000; // حد أمان لتحويل b64 إلى Data URI داخل قاعدة النتائج

function headers(apiKey: string): Record<string, string> {
  return { Authorization: `Bearer ${apiKey}`, "Content-Type": "application/json" };
}

async function cometFetch(url: string, init: RequestInit, timeoutMs = 45000): Promise<{ status: number; body: Record<string, unknown> }> {
  let res: Response;
  try {
    res = await fetch(url, { ...init, signal: AbortSignal.timeout(timeoutMs) });
  } catch (e) {
    throw new ProviderError(0, `cometapi: تعذر الوصول إلى المزود (${(e as Error).message})`, "cometapi");
  }
  let body: Record<string, unknown> = {};
  try {
    body = (await res.json()) as Record<string, unknown>;
  } catch {
    /* جسم غير JSON */
  }
  if (!res.ok) {
    // الشكل المتوافق مع OpenAI: {"error":{"message":"..."}}
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const errObj = (body.error ?? {}) as any;
    const msg = String(errObj?.message ?? body.message ?? body.error ?? `cometapi HTTP ${res.status}`);
    throw new ProviderError(res.status, msg, "cometapi");
  }
  return { status: res.status, body };
}

function extractId(body: Record<string, unknown>): string | null {
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const b = body as any;
  const id = b.id ?? b.taskId ?? b.task_id ?? b.data?.id ?? b.data?.taskId ?? b.data?.task_id;
  return id ? String(id) : null;
}

export const cometapiAdapter: ProviderAdapter = {
  /** صور متزامنة — تعيد الروابط مباشرة دون مهمة غير متزامنة */
  async createTask(apiKey, providerModel, input): Promise<ProviderTaskHandle> {
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const inp = input as any;
    const payload: Record<string, unknown> = {
      model: providerModel,
      prompt: inp.prompt,
      n: 1,
    };
    if (inp.aspect_ratio && inp.aspect_ratio !== "auto") payload.aspect_ratio = inp.aspect_ratio;
    if (inp.resolution) payload.resolution = inp.resolution;
    if (inp.background && inp.background !== "auto") payload.background = inp.background;
    if (inp.output_format) payload.output_format = inp.output_format;

    const { body } = await cometFetch(`${BASE}/v1/images/generations`, {
      method: "POST",
      headers: headers(apiKey),
      body: JSON.stringify(payload),
    });
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const data = ((body as any).data ?? []) as any[];
    const first = Array.isArray(data) ? data[0] : undefined;
    if (first?.url) return { providerTaskId: "", syncUrls: [String(first.url)] };
    if (first?.b64_json) {
      const b64 = String(first.b64_json);
      // نتعامل مع b64 كـ Data URI فقط إن كان ضمن حدود آمنة للتخزين النصي — لا ننزل ملفات أبدًا
      if (b64.length <= MAX_B64_BYTES) {
        return { providerTaskId: "", syncUrls: [`data:image/png;base64,${b64}`] };
      }
      throw new ProviderError(500, "cometapi: الناتج b64 أكبر من الحد المدعوم للروابط", "cometapi");
    }
    throw new ProviderError(500, "cometapi: لم يُعد المزود رابط صورة", "cometapi");
  },

  async checkTask(apiKey, providerTaskId) {
    // الشكل الشائع عند المجمعين: GET /v1/video/generations?generation_id= أو /{id} — التحليل دفاعي
    let body: Record<string, unknown>;
    try {
      const r1 = await cometFetch(
        `${BASE}/v1/video/generations?generation_id=${encodeURIComponent(providerTaskId)}`,
        { method: "GET", headers: headers(apiKey) }
      );
      body = r1.body;
    } catch {
      const r2 = await cometFetch(`${BASE}/v1/video/generations/${encodeURIComponent(providerTaskId)}`, {
        method: "GET",
        headers: headers(apiKey),
      });
      body = r2.body;
    }
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const b = body as any;
    const status = String(b.status ?? b.data?.status ?? "").toLowerCase();
    const url =
      b.video?.url ?? b.video_url ?? b.videoUrl ?? b.data?.video?.url ?? b.data?.video_url ?? b.resultUrl;
    const error = b.error?.message ?? b.error ?? b.data?.error;

    if (status === "completed" || status === "succeeded" || (status && url)) {
      const urls = url ? [String(url)] : [];
      if (!urls.length) return { status: "failed", error: "cometapi: اكتملت المهمة دون رابط ناتج" };
      return { status: "completed", urls };
    }
    if (status === "error" || status === "failed" || status === "cancelled") {
      return { status: "failed", error: String(error ?? "فشل التوليد لدى المزود") };
    }
    return { status: "processing", progress: status === "generating" ? 50 : 15 };
  },
};
