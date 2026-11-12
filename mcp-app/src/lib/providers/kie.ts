/**
 * مزود kie.ai — Jobs API الموحد (المزود الأساسي).
 * الشكل المقاس فعليًا وموثق من docs.kie.ai:
 *   POST /api/v1/jobs/createTask  → {"code":200,"msg":"success","data":{"taskId":"..."}}
 *   GET  /api/v1/jobs/recordInfo?taskId= → {"code":200,"data":{"state":"waiting|queuing|generating|success|fail",
 *          "resultJson":"{\"resultUrls\":[\"...\"]}" (نص JSON داخل JSON — يحتاج JSON.parse ثانيًا), "failMsg":"..."}}
 * ملاحظة: بعض الأخطاء تعود داخل HTTP 200 بحقل code ≠ 200 — نفحص الحقلين معًا.
 */
import { ProviderError } from "../errors";
import type { ProviderAdapter, ProviderCheck, ProviderTaskHandle } from "./types";

const BASE = "https://api.kie.ai/api/v1/jobs";

function authHeaders(apiKey: string): Record<string, string> {
  return { Authorization: `Bearer ${apiKey}` };
}

async function kieFetch(url: string, init: RequestInit, timeoutMs = 30000): Promise<Record<string, unknown>> {
  let res: Response;
  try {
    res = await fetch(url, { ...init, signal: AbortSignal.timeout(timeoutMs) });
  } catch (e) {
    // انقطاع شبكة/timeout → مؤقت (يُصنَّف temporary افتراضيًا)
    throw new ProviderError(0, `kie: تعذر الوصول إلى المزود (${(e as Error).message})`, "kie");
  }
  let body: Record<string, unknown> = {};
  try {
    body = (await res.json()) as Record<string, unknown>;
  } catch {
    /* جسم غير JSON */
  }
  const code = typeof body.code === "number" ? body.code : res.status;
  // فحص الحالة HTTP وحقل code الداخلي معًا
  if (!res.ok || (typeof body.code === "number" && body.code !== 200)) {
    const msg = String(body.msg ?? body.message ?? `kie HTTP ${res.status}`);
    throw new ProviderError(code || res.status, msg, "kie");
  }
  return body;
}

export const kieAdapter: ProviderAdapter = {
  async createTask(apiKey, providerModel, input): Promise<ProviderTaskHandle> {
    const body = await kieFetch(`${BASE}/createTask`, {
      method: "POST",
      headers: { ...authHeaders(apiKey), "Content-Type": "application/json" },
      body: JSON.stringify({ model: providerModel, input }),
    });
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const taskId = (body.data as any)?.taskId;
    if (!taskId) throw new ProviderError(500, "kie: لم يُعد المزود معرف المهمة", "kie");
    return { providerTaskId: String(taskId) };
  },

  async checkTask(apiKey, providerTaskId): Promise<ProviderCheck> {
    const body = await kieFetch(
      `${BASE}/recordInfo?taskId=${encodeURIComponent(providerTaskId)}`,
      { method: "GET", headers: authHeaders(apiKey) }
    );
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const d = (body.data ?? {}) as any;
    const state = String(d.state ?? "").toLowerCase();

    let urls: string[] = [];
    try {
      // resultJson نص JSON داخل JSON — تحليل ثانٍ
      const inner = typeof d.resultJson === "string" ? JSON.parse(d.resultJson) : d.resultJson;
      if (Array.isArray(inner?.resultUrls)) urls = inner.resultUrls.map(String);
    } catch {
      /* تجاهل — نحاول الحقل البديل */
    }
    // احتياط إذا غيّر المزود الشكل: حقل response.resultUrls المحلَّل جاهزًا
    if (!urls.length && Array.isArray(d.response?.resultUrls)) {
      urls = d.response.resultUrls.map(String);
    }

    if (state === "success") return { status: "completed", urls };
    if (state === "fail") {
      return { status: "failed", error: String(d.failMsg || d.failCode || "فشل التوليد لدى المزود") };
    }
    // تقدير تقريبي للتقدم: انتظار/طابور ~15%، توليد فعلي ~50%
    return { status: "processing", progress: state === "generating" ? 50 : 15 };
  },
};
