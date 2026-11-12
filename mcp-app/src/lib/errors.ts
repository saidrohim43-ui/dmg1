/**
 * تصنيف أخطاء المزودين — دالة موحدة (جدول 4.2 في المواصفة).
 * القاعدة الذهبية: نفاد الرصيد يُفحص قبل 400 لأن بعض المزودين يرسلونه بحالة 400.
 */

export type ErrorClass = "disabled" | "exhausted" | "provider" | "params" | "temporary";

export class ProviderError extends Error {
  constructor(
    public status: number,
    message: string,
    public provider?: string
  ) {
    super(message);
    this.name = "ProviderError";
  }
}

/** خطأ معطيات من العميل نفسه (موديل مجهول، روابط ناقصة...) — فشل فوري بلا فائدة من تبديل المفاتيح */
export class ParamsError extends Error {}

// أنماط نفاد الرصيد (تشمل رسائل المزودين الصينية)
const EXHAUSTED_RE = /insufficient|quota|balance|credit|out of credits|exhausted|充值|余额/i;
// أنماط المفتاح المرفوض
const DISABLED_RE = /invalid api key|invalid_api_key|api key not valid|unauthorized|forbidden|authentication|authentication failed|incorrect api key/i;
// أنماط موديل غير مدعوم لدى المزود
const PROVIDER_RE = /model not found|unsupported model|no such model|unknown model|model does not exist/i;

/**
 * نمط أخطاء المفتاح/الرصيد في منتصف المهمة — عند ظهوره نعيد إنشاء نفس المهمة
 * بنفس task_id على المفتاح التالي دون علم العميل (قسم 4.3.2).
 */
const KEYISH_RE = /insufficient|balance|credit|quota|402|401|unauthorized|exhausted|invalid api key/i;

export function looksLikeKeyOrBalanceError(msg: string): boolean {
  return KEYISH_RE.test(msg);
}

export function classifyProviderError(e: unknown): { cls: ErrorClass; detail: string } {
  const status = typeof e === "object" && e !== null ? Number((e as { status?: number }).status) || 0 : 0;
  const msg = e instanceof Error ? e.message : String(e ?? "");

  // 1) نفاد الرصيد — برسالة أو بحالة 402 (فُحص قبل 400 عمدًا)
  if (status === 402 || EXHAUSTED_RE.test(msg)) return { cls: "exhausted", detail: msg };
  // 2) مفتاح مرفوض
  if (status === 401 || status === 403 || DISABLED_RE.test(msg)) return { cls: "disabled", detail: msg };
  // 3) موديل غير مدعوم لدى هذا المزود
  if (PROVIDER_RE.test(msg) && [400, 404, 422].includes(status)) return { cls: "provider", detail: msg };
  // 4) معطيات الطلب خاطئة — التبديل لن يحلها
  if (status === 400 || status === 422) return { cls: "params", detail: msg };
  // 5) 429 / 5xx / انقطاع شبكة / timeout / مجهول → مؤقت
  return { cls: "temporary", detail: msg };
}
