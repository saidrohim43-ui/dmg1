/**
 * عميل خدمة دمج الفيديو — Video Merger API v2.
 * بلا مفاتيح أو توثيق. العنوان من MERGER_API_BASE. المخرجات MP4 (H.264 + AAC) حتى 1080p.
 * القيود: 10 مقاطع كحد أقصى، 200MB لكل مصدر، 150MB للناتج، 600 ثانية مجموع المدد،
 * وكل الملفات تُحذف تلقائيًا بعد 24 ساعة.
 * تحليل الحالة دفاعي: قد يرد الجسم فيه error بدون status → نعاملها failed فورًا.
 */
import { ProviderError } from "./errors";

const BASE = (process.env.MERGER_API_BASE || "").trim().replace(/\/+$/, "");

export function mergerConfigured(): boolean {
  return BASE.length > 0;
}

export function mergerBase(): string {
  return BASE;
}

async function mFetch(
  path: string,
  init: RequestInit | undefined,
  timeoutMs: number
): Promise<{ status: number; json: Record<string, unknown> | null }> {
  if (!BASE) throw new ProviderError(500, "خدمة الدمج غير مضبوطة: MERGER_API_BASE مفقود");
  let res: Response;
  try {
    res = await fetch(`${BASE}${path}`, { ...init, signal: AbortSignal.timeout(timeoutMs) });
  } catch (e) {
    // انقطاع شبكتنا نحن — مؤقت (لا يُعد فشلًا حتميًا)
    throw new ProviderError(0, `تعذر الوصول إلى خدمة الدمج: ${(e as Error).message}`);
  }
  const raw = await res.text();
  let json: Record<string, unknown> | null = null;
  try {
    json = raw ? (JSON.parse(raw) as Record<string, unknown>) : null;
  } catch {
    /* جسم غير JSON */
  }
  return { status: res.status, json };
}

export interface MergerJob {
  jobId: string;
  status: string;
  statusUrl?: string;
  processUrl?: string;
  expiresAt?: string;
}

/** POST /api/jobs — إنشاء مهمة دمج من روابط مباشرة */
export async function mergerCreateJob(videos: string[]): Promise<MergerJob> {
  const { status, json } = await mFetch(
    "/api/jobs",
    {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ videos }),
    },
    30000
  );
  const jobId = json?.jobId;
  if (status < 200 || status >= 300 || !jobId) {
    // 4xx/5xx بجسم error من الخدمة = فشل معلن (حتمي في سياق الإنشاء الأولي)
    throw new ProviderError(status || 500, String(json?.error ?? `خدمة الدمج ردّت بحالة ${status}`));
  }
  return {
    jobId: String(jobId),
    status: String(json?.status ?? "queued"),
    statusUrl: json?.statusUrl ? String(json.statusUrl) : undefined,
    processUrl: json?.processUrl ? String(json.processUrl) : undefined,
    expiresAt: json?.expiresAt ? String(json.expiresAt) : undefined,
  };
}

/** POST /api/jobs/{id}/process — تنفيذ الدمج (متزامن، ~10–15 ثانية) */
export async function mergerProcess(jobId: string): Promise<{ status: number; json: Record<string, unknown> | null }> {
  return mFetch(`/api/jobs/${encodeURIComponent(jobId)}/process`, { method: "POST" }, 240000);
}

const DONE_SET = new Set(["done", "completed", "complete", "success", "succeeded", "finished"]);
const FAILED_SET = new Set(["error", "failed", "failure", "cancelled", "canceled"]);

export interface MergerStatus {
  done: boolean;
  failed: boolean;
  processing: boolean;
  queued: boolean;
  progress: number; // 0..100 صحيح
  videoUrl?: string;
  downloadUrl?: string;
  error?: string;
}

/** GET /api/jobs/{id} — تحليل دفاعي للحالة */
export async function mergerGetStatus(jobId: string): Promise<MergerStatus> {
  const { status: http, json } = await mFetch(`/api/jobs/${encodeURIComponent(jobId)}`, { method: "GET" }, 20000);
  if (http === 404) {
    // حذفت المهمة من الخدمة أو انتهت صلاحيتها — فشل نهائي فوري
    throw new ProviderError(404, "مهمة الدمج غير موجودة في الخدمة (حُذفت أو انتهت صلاحيتها بعد 24 ساعة)");
  }
  if (http >= 400) {
    throw new ProviderError(http, String(json?.error ?? `خدمة الدمج ردّت بحالة ${http}`));
  }
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const body = (json ?? {}) as any;
  const rawStatus = String(body.status ?? "").toLowerCase();

  const error = body.error ? String(body.error) : undefined;
  // error بدون status → failed فورًا
  const failed = FAILED_SET.has(rawStatus) || (!rawStatus && !!error);
  const done = !failed && (DONE_SET.has(rawStatus) || (!!body.videoUrl && rawStatus !== "queued" && rawStatus !== "processing"));

  let progress = Number(body.progress ?? 0);
  if (!Number.isFinite(progress)) progress = 0;
  // التقدم قد يأتي كسرًا 0..1 → اضربه في 100
  if (progress > 0 && progress <= 1 && !Number.isInteger(progress)) progress = progress * 100;
  progress = Math.max(0, Math.min(100, Math.round(progress)));

  // رابط النتيجة: فضّل videoUrl ثم downloadUrl ثم الرابط الافتراضي من jobId
  const videoUrl = body.videoUrl ? String(body.videoUrl) : `${BASE}/api/jobs/${encodeURIComponent(jobId)}/video`;
  const downloadUrl = body.downloadUrl ? String(body.downloadUrl) : `${videoUrl}${videoUrl.includes("?") ? "&" : "?"}download=1`;

  return {
    done: done && !!videoUrl,
    failed,
    processing: !done && !failed,
    queued: rawStatus === "queued" || rawStatus === "uploading",
    progress: done ? 100 : failed ? progress : Math.max(5, progress),
    videoUrl,
    downloadUrl,
    error,
  };
}

/** DELETE /api/jobs/{id} — تنظيف اختياري */
export async function mergerDeleteJob(jobId: string): Promise<void> {
  await mFetch(`/api/jobs/${encodeURIComponent(jobId)}`, { method: "DELETE" }, 15000);
}

/** GET /api/config — فحص جهوزية خدمة الدمج بمهلة 4 ثوانٍ */
export async function mergerHealthy(): Promise<boolean> {
  if (!BASE) return false;
  try {
    const { status } = await mFetch("/api/config", { method: "GET" }, 4000);
    return status >= 200 && status < 300;
  } catch {
    return false;
  }
}
