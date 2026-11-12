/**
 * أدوات المفاتيح للعرض — إخفاء المفتاح إلزامي في كل الاستجابات والسجلات.
 * المفتاح الكامل لا يُعاد في أي استجابة API إطلاقًا.
 */
import type { ApiKeyRow } from "./turso";

export function maskKey(key: string): string {
  const k = (key || "").trim();
  if (k.length > 12) return `${k.slice(0, 7)}••••••••${k.slice(-4)}`;
  if (k.length > 3) return `${k.slice(0, 3)}••••`;
  return "••••";
}

export function publicKey(row: ApiKeyRow): Omit<ApiKeyRow, "api_key"> & { masked: string } {
  const { api_key, ...rest } = row;
  return { ...rest, masked: maskKey(api_key) };
}

export const PROVIDER_LABELS: Record<string, string> = {
  kie: "kie.ai",
  cometapi: "CometAPI",
};
