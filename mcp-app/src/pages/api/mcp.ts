/**
 * خادم MCP على المسار /mcp — نقل Streamable HTTP حسب مواصفات MCP، عبر SDK الرسمي
 * (McpServer + StreamableHTTPServerTransport) — بلا JSON-RPC يدوي.
 *
 * قرار موثّق: نستخدم Pages API route (src/pages/api) بدل App Router لنقطة /mcp فقط،
 * لأن StreamableHTTPServerTransport يتطلب كائنات Node (IncomingMessage/ServerResponse)
 * مباشرة، وPages API يوفرها أصليًا — النمط الأكثر موثوقية ومجربًا على Vercel.
 * بقية المسارات (الواجهة و /api/*) على App Router كما في المواصفة.
 *
 * الجلسات: خريطة في الذاكرة على globalThis (تبقى عبر النداءات الدافئة على Vercel؛
 * والعميل يُعاد تهيئته تلقائيًا عند فقد الجلسة حسب بروتوكول Streamable HTTP).
 */
import type { NextApiRequest, NextApiResponse } from "next";
import { randomUUID } from "node:crypto";
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StreamableHTTPServerTransport } from "@modelcontextprotocol/sdk/server/streamableHttp.js";
import { z } from "zod";
import { runGeneration, refreshTask, runMerge, listMedia, type RunResult } from "@/lib/orchestrator";
import type { Notify } from "@/lib/toolTypes";

export const config = {
  api: { bodyParser: false },
  maxDuration: 300,
};

export const SERVER_INFO = { name: "media-generator-mcp", version: "1.2.0" };

const SERVER_INSTRUCTIONS = `AI media generation server (kie.ai + CometAPI with automatic sequential multi-key failover, plus video merging).
Workflow: call generate_image or generate_video. If the response contains finished URLs, show them to the user.
If it returns a task_id with status PROCESSING, call get_task with that task_id every ~10 seconds until status is completed (show the URL) or failed (explain why).
IMPORTANT: the server automatically switches API keys in strict order on any failure (exhausted balance, invalid key, rate limits) and continues the SAME task under the same task_id — you will never encounter key/balance errors. Never stop or warn the user about keys or balances; just keep polling get_task until the result appears.
To concatenate several finished clips into one video, call merge_videos with 'urls' (direct links) or 'task_ids' (completed video tasks, in merge order); track it with get_task the same way. Note: the merged file is stored on the merging service for ~24 hours only — tell the user to watch/download it promptly.
Use list_media to recall previously generated media from the database.`;

/* ============ سجل الجلسات ============ */

interface SessionEntry {
  server: McpServer;
  transport: StreamableHTTPServerTransport;
}

const g = globalThis as unknown as { __mgMcpSessions?: Map<string, SessionEntry> };
const sessions: Map<string, SessionEntry> = (g.__mgMcpSessions ??= new Map());

/* ============ أدوات مساعدة ============ */

function toolResult(res: RunResult) {
  return { content: [{ type: "text" as const, text: res.text }], isError: !!res.isError };
}

/** يبث progress notifications للعميل إذا زوّد الطلب بـ _meta.progressToken */
function makeNotifier(extra: unknown): Notify | undefined {
  const ex = extra as {
    _meta?: { progressToken?: string | number };
    sendNotification?: (notification: unknown) => Promise<void>;
  };
  const token = ex?._meta?.progressToken;
  if (token === undefined || typeof ex.sendNotification !== "function") return undefined;
  return async (progress, total, message) => {
    try {
      await ex.sendNotification!({
        method: "notifications/progress",
        params: { progressToken: token, progress, total, message },
      });
    } catch {
      /* تجاهل فشل الإشعار — لا يوقف المهمة */
    }
  };
}

function buildServer(): McpServer {
  const server = new McpServer(SERVER_INFO, { instructions: SERVER_INSTRUCTIONS });

  // 1) generate_image
  server.registerTool(
    "generate_image",
    {
      title: "Generate Image",
      description:
        "Generate an image with gpt-image-2-6/flare-text-to-image (automatic failover across all active API keys in strict order). " +
        "Returns the ready image URL if it completes within the wait window; otherwise returns a task_id — " +
        "call get_task with it every ~10 seconds until status is completed, then show the URL and stop.",
      inputSchema: {
        prompt: z.string().min(1).describe("What to draw. Detailed prompts give better results."),
        model: z
          .enum(["gpt-image-2-6/flare-text-to-image", "gpt-image-2.6/flare-text-to-image"])
          .default("gpt-image-2-6/flare-text-to-image"),
        aspect_ratio: z
          .enum(["auto", "1:1", "3:2", "2:3", "4:3", "3:4", "5:4", "4:5", "16:9", "9:16", "2:1", "1:2", "21:9", "9:21", "3:1", "1:3"])
          .default("auto"),
        resolution: z.enum(["1K", "2K", "4K"]).default("1K"),
        background: z.enum(["auto", "transparent", "opaque"]).default("auto").describe("Only applied at 1K."),
        output_format: z.enum(["png", "jpeg", "webp", "gif"]).default("png"),
        wait_seconds: z.number().int().min(0).max(240).default(90),
      },
    },
    async (args, extra) => {
      try {
        const a = args as {
          prompt: string;
          model: string;
          aspect_ratio: string;
          resolution: string;
          background: string;
          output_format: string;
          wait_seconds: number;
        };
        const res = await runGeneration({
          type: "image",
          model: a.model,
          params: {
            prompt: a.prompt,
            aspect_ratio: a.aspect_ratio,
            resolution: a.resolution,
            background: a.background,
            output_format: a.output_format,
          },
          waitSeconds: a.wait_seconds,
          notify: makeNotifier(extra),
        });
        return toolResult(res);
      } catch (e) {
        return toolResult({ text: `❌ حدث خطأ داخلي: ${(e as Error).message}`, isError: true });
      }
    }
  );

  // 2) generate_video
  server.registerTool(
    "generate_video",
    {
      title: "Generate Video",
      description:
        "Generate a video with grok-imagine-video-1-5-preview (native synchronized audio — dialogue in the prompt is spoken in the video; " +
        "optional image-to-video via image_url). Video generation takes minutes: a short wait with live progress streaming, " +
        "then a task_id is returned — track it with get_task every ~10 seconds until completed, then show the URL and stop.",
      inputSchema: {
        prompt: z.string().max(4096).describe("Scene description. Dialogue in the prompt is spoken in the video."),
        image_url: z.string().optional().describe("Optional public image URL as the first frame (image-to-video)."),
        model: z
          .enum(["grok-imagine-video-1-5-preview", "grok-imagine-video-1.5-preview"])
          .default("grok-imagine-video-1-5-preview"),
        aspect_ratio: z.enum(["auto", "1:1", "16:9", "9:16", "3:2", "2:3"]).default("auto"),
        resolution: z.enum(["480p", "720p", "1080p"]).default("480p"),
        enable_audio: z.boolean().default(true),
        duration: z.number().int().min(1).max(15).default(8).describe("Duration in seconds."),
        wait_seconds: z.number().int().min(0).max(240).default(25),
      },
    },
    async (args, extra) => {
      try {
        const a = args as {
          prompt: string;
          image_url?: string;
          model: string;
          aspect_ratio: string;
          resolution: string;
          enable_audio: boolean;
          duration: number;
          wait_seconds: number;
        };
        const res = await runGeneration({
          type: "video",
          model: a.model,
          params: {
            prompt: a.prompt,
            image_url: a.image_url,
            aspect_ratio: a.aspect_ratio,
            resolution: a.resolution,
            enable_audio: a.enable_audio,
            duration: a.duration,
          },
          waitSeconds: a.wait_seconds,
          notify: makeNotifier(extra),
        });
        return toolResult(res);
      } catch (e) {
        return toolResult({ text: `❌ حدث خطأ داخلي: ${(e as Error).message}`, isError: true });
      }
    }
  );

  // 3) merge_videos
  // قرار موثّق: المصفوفات مرنة في المخطط وتحقق الأعمال يدوي داخل الأداة —
  // لضمان رسائل الرفض العربية الصحيحة (مقطع واحد، أكثر من 10، معرفات غير صالحة)
  // بدل رسائل التحقق الإنجليزية على مستوى SDK. حد 10 موثق في الوصف ومطبق فعليًا.
  server.registerTool(
    "merge_videos",
    {
      title: "Merge Videos",
      description:
        "Merge several clips into ONE final video in the given order. Pass 'urls' (public direct video URLs in merge order — " +
        "the first clip starts the final video) or 'task_ids' (task IDs of COMPLETED video generation tasks — their result URLs " +
        "are merged in this order; task_ids URLs come first, then direct urls in their own order). " +
        "Merging is usually fast: a short wait with live progress streaming, then a merge task_id — track it with get_task. " +
        "Minimum 2 clips and maximum 10 clips (the merging service accepts at most 10 clips). " +
        "Note: the merged file is stored on the merging service for ~24 hours only — tell the user to watch/download it promptly.",
      inputSchema: {
        urls: z.array(z.string()).optional(),
        task_ids: z.array(z.string()).optional(),
        wait_seconds: z.number().int().min(0).max(240).default(60),
      },
    },
    async (args, extra) => {
      try {
        const a = args as { urls?: string[]; task_ids?: string[]; wait_seconds: number };
        const res = await runMerge({
          urls: a.urls,
          task_ids: a.task_ids,
          waitSeconds: a.wait_seconds,
          notify: makeNotifier(extra),
        });
        return toolResult(res);
      } catch (e) {
        return toolResult({ text: `❌ حدث خطأ داخلي: ${(e as Error).message}`, isError: true });
      }
    }
  );

  // 4) get_task
  server.registerTool(
    "get_task",
    {
      title: "Get Task",
      description:
        "Track any task by its ID — image/video generation AND merging (reads the database and live-refreshes from the provider " +
        "or the merging service while in progress). Poll every ~10 seconds; when completed you will find the result URLs — " +
        "show them to the user and stop polling.",
      inputSchema: {
        task_id: z.string(),
      },
    },
    async (args, extra) => {
      try {
        const a = args as { task_id: string };
        const res = await refreshTask(String(a.task_id).trim(), makeNotifier(extra));
        return toolResult(res);
      } catch (e) {
        return toolResult({ text: `❌ حدث خطأ داخلي: ${(e as Error).message}`, isError: true });
      }
    }
  );

  // 5) list_media
  server.registerTool(
    "list_media",
    {
      title: "List Media",
      description:
        "Latest stored images/videos/merges with their result URLs from the database (no regeneration) — recall previous results.",
      inputSchema: {
        type: z.enum(["image", "video", "merge"]).optional(),
        status: z.enum(["completed", "failed", "processing"]).optional(),
        limit: z.number().int().min(1).max(50).default(10),
      },
    },
    async (args) => {
      try {
        const a = args as { type?: "image" | "video" | "merge"; status?: "completed" | "failed" | "processing"; limit: number };
        const res = await listMedia({ type: a.type, status: a.status, limit: a.limit });
        return toolResult(res);
      } catch (e) {
        return toolResult({ text: `❌ حدث خطأ داخلي: ${(e as Error).message}`, isError: true });
      }
    }
  );

  return server;
}

/* ============ المعالج ============ */

const MAX_BODY_BYTES = 2 * 1024 * 1024;

function readBody(req: NextApiRequest): Promise<unknown> {
  return new Promise((resolve, reject) => {
    const chunks: Buffer[] = [];
    let size = 0;
    req.on("data", (c: Buffer) => {
      size += c.length;
      if (size > MAX_BODY_BYTES) {
        reject(new Error("جسم الطلب أكبر من الحد المسموح"));
        req.destroy();
        return;
      }
      chunks.push(c);
    });
    req.on("end", () => {
      const raw = Buffer.concat(chunks).toString("utf8");
      if (!raw.trim()) return resolve(undefined);
      try {
        resolve(JSON.parse(raw));
      } catch (e) {
        reject(e);
      }
    });
    req.on("error", reject);
  });
}

function setCors(res: NextApiResponse): void {
  res.setHeader("Access-Control-Allow-Origin", "*");
  res.setHeader("Access-Control-Allow-Methods", "GET, POST, DELETE, OPTIONS");
  res.setHeader(
    "Access-Control-Allow-Headers",
    "content-type, authorization, mcp-session-id, last-event-id, accept, mcp-protocol-version"
  );
}

function unauthorized(res: NextApiResponse): void {
  res.status(401).json({ error: "unauthorized — مطلوب ترويسة Authorization: Bearer <MCP_ACCESS_TOKEN>" });
}

export default async function handler(req: NextApiRequest, res: NextApiResponse) {
  setCors(res);

  if (req.method === "OPTIONS") {
    res.status(204).end();
    return;
  }

  // حماية اختيارية: إن ضُبط MCP_ACCESS_TOKEN يُطلب Bearer token على /mcp
  const token = (process.env.MCP_ACCESS_TOKEN || "").trim();
  if (token) {
    const auth = String(req.headers.authorization ?? "");
    if (auth !== `Bearer ${token}`) {
      unauthorized(res);
      return;
    }
  }

  if (req.method === "GET") {
    // لا نقدم SSE listen مستقل — العميل يتابع عبر استدعاءات الأدوات (مسموح بروتوكوليًا)
    res.status(405).json({ error: "method not allowed — استخدم POST لرسائل JSON-RPC و DELETE لإنهاء الجلسة" });
    return;
  }

  if (req.method !== "POST" && req.method !== "DELETE") {
    res.status(405).json({ error: "method not allowed" });
    return;
  }

  let body: unknown;
  if (req.method === "POST") {
    try {
      body = await readBody(req);
    } catch (e) {
      res
        .status(400)
        .json({ jsonrpc: "2.0", id: null, error: { code: -32700, message: `Parse error: ${(e as Error).message}` } });
      return;
    }
  }

  const sid = typeof req.headers["mcp-session-id"] === "string" ? (req.headers["mcp-session-id"] as string) : undefined;
  const entry = sid ? sessions.get(sid) : undefined;

  if (sid && !entry) {
    // جلسة غير معروفة (فُقدت مع إعادة تدوير الدالة) — العميل ملزم بإعادة التهيئة حسب البروتوكول
    res.status(404).json({
      jsonrpc: "2.0",
      id: null,
      error: { code: -32001, message: "Session not found — أعد إرسال initialize لإنشاء جلسة جديدة" },
    });
    return;
  }

  if (entry) {
    await entry.transport.handleRequest(req, res, body);
    return;
  }

  // جلسة جديدة (تهيئة أولى)
  const server = buildServer();
  const transport = new StreamableHTTPServerTransport({
    sessionIdGenerator: () => randomUUID(),
    onsessioninitialized: (newSid) => {
      sessions.set(newSid, { server, transport });
    },
    onsessionclosed: (closedSid) => {
      sessions.delete(closedSid);
    },
  });
  await server.connect(transport);
  await transport.handleRequest(req, res, body);
}
