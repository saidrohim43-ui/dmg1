/**
 * GET /api/tasks?type=&status=&limit= — لوحة المهام: إحصائيات + أحدث المهام.
 */
import { NextResponse } from "next/server";
import { listRecentTasks, taskStats } from "@/lib/turso";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export async function GET(req: Request) {
  const url = new URL(req.url);
  const type = url.searchParams.get("type") ?? undefined;
  const status = url.searchParams.get("status") ?? undefined;
  const limit = Number(url.searchParams.get("limit") ?? 20);

  const [stats, tasks] = await Promise.all([
    taskStats(),
    listRecentTasks(Number.isFinite(limit) ? limit : 20, {
      type: ["image", "video", "merge"].includes(type ?? "") ? type : undefined,
      status: ["completed", "failed", "processing", "pending"].includes(status ?? "") ? status : undefined,
    }),
  ]);

  return NextResponse.json({
    stats,
    tasks: tasks.map((t) => ({
      id: t.id,
      type: t.type,
      model: t.model,
      provider: t.provider,
      status: t.status,
      progress: t.progress,
      prompt: t.prompt.slice(0, 160),
      result_urls: t.result_urls,
      error_message: t.error_message,
      attempts: t.attempts.length,
      created_at: t.created_at,
      completed_at: t.completed_at,
    })),
  });
}
