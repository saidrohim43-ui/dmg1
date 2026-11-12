/**
 * GET /api/keys — قائمة المفاتيح كاملة مع الإخفاء الدائم (maskKey).
 * POST /api/keys — إضافة مفتاح مع رفض التكرار لنفس المزود.
 */
import { NextResponse } from "next/server";
import { listKeys, insertKey, findDuplicateKey } from "@/lib/turso";
import { publicKey } from "@/lib/keys";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

const VALID_PROVIDERS = new Set(["kie", "cometapi"]);

export async function GET() {
  const keys = await listKeys();
  return NextResponse.json({ keys: keys.map(publicKey) });
}

export async function POST(req: Request) {
  let body: { provider?: string; api_key?: string; label?: string };
  try {
    body = await req.json();
  } catch {
    return NextResponse.json({ error: "جسم الطلب ليس JSON صالحًا" }, { status: 400 });
  }
  const provider = String(body.provider ?? "").trim();
  const apiKey = String(body.api_key ?? "").trim();
  const label = String(body.label ?? "").trim().slice(0, 120);

  if (!VALID_PROVIDERS.has(provider)) {
    return NextResponse.json({ error: "المزود غير صالح: القيم المقبولة kie أو cometapi" }, { status: 400 });
  }
  if (apiKey.length < 8) {
    return NextResponse.json({ error: "المفتاح قصير جدًا — أدخل مفتاح API صحيحًا" }, { status: 400 });
  }
  const dup = await findDuplicateKey(provider, apiKey);
  if (dup) {
    return NextResponse.json(
      { error: "هذا المفتاح مضاف مسبقًا لنفس المزود — رفض التكرار" },
      { status: 409 }
    );
  }
  const created = await insertKey({ provider, api_key: apiKey, label });
  return NextResponse.json({ key: publicKey(created) }, { status: 201 });
}
