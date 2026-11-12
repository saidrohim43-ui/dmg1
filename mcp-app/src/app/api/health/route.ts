/**
 * GET /api/health — حالة النظام: قاعدة البيانات، نقطة MCP، الموديلات، خدمة الدمج، الحماية.
 */
import { NextResponse } from "next/server";
import { ensureSchema, dbHealthy } from "@/lib/turso";
import { MODELS } from "@/lib/models";
import { mergerHealthy, mergerBase } from "@/lib/merger";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";
export const maxDuration = 60;

export async function GET() {
  let database = "turso-disconnected";
  try {
    await ensureSchema();
    database = (await dbHealthy()) ? "turso-connected" : "turso-disconnected";
  } catch {
    database = "turso-disconnected";
  }

  const merger = { base: mergerBase() || "غير مضبوطة", healthy: false };
  try {
    merger.healthy = await mergerHealthy();
  } catch {
    merger.healthy = false;
  }

  return NextResponse.json({
    ok: database === "turso-connected",
    database,
    mcpEndpoint: "/mcp",
    models: MODELS.map((m) => ({ canonical: m.canonical, type: m.type, providers: m.providers })),
    merger,
    authRequired: !!(process.env.MCP_ACCESS_TOKEN || "").trim(),
  });
}
