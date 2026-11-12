/**
 * PATCH /api/keys/{id} — تعطيل/تنشيط يدوي للمفتاح.
 * DELETE /api/keys/{id} — حذف المفتاح.
 */
import { NextResponse } from "next/server";
import { updateKey, deleteKey, getKey } from "@/lib/turso";
import { publicKey } from "@/lib/keys";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export async function PATCH(req: Request, ctx: { params: Promise<{ id: string }> }) {
  const { id } = await ctx.params;
  let body: { action?: string; status?: string };
  try {
    body = await req.json();
  } catch {
    return NextResponse.json({ error: "جسم الطلب ليس JSON صالحًا" }, { status: 400 });
  }
  const action = String(body.action ?? body.status ?? "").toLowerCase();
  if (!["disable", "disabled", "enable", "active"].includes(action)) {
    return NextResponse.json({ error: "القيمة المسموحة: enable أو disable" }, { status: 400 });
  }
  const status = action === "enable" || action === "active" ? "active" : "disabled";
  const updated = await updateKey(id, { status });
  if (!updated) return NextResponse.json({ error: "المفتاح غير موجود" }, { status: 404 });
  return NextResponse.json({ key: publicKey(updated) });
}

export async function DELETE(_req: Request, ctx: { params: Promise<{ id: string }> }) {
  const { id } = await ctx.params;
  const existing = await getKey(id);
  if (!existing) return NextResponse.json({ error: "المفتاح غير موجود" }, { status: 404 });
  await deleteKey(id);
  return NextResponse.json({ ok: true });
}
