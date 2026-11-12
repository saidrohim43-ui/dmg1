"use client";

/**
 * لوحة الإدارة العربية (RTL) — ثلاث بطاقات:
 * أ) مدير المفاتيح  ب) لوحة المهام (تحديث تلقائي كل ~5 ثوانٍ)  ج) ربط السيرفر
 */

import { useCallback, useEffect, useMemo, useState } from "react";

/* ============ الأنواع ============ */

interface Health {
  ok: boolean;
  database: string;
  mcpEndpoint: string;
  models: { canonical: string; type: string; providers: string[] }[];
  merger: { base: string; healthy: boolean };
  authRequired: boolean;
}

interface KeyRow {
  id: string;
  provider: string;
  label: string;
  masked: string;
  status: string;
  usage_count: number;
  success_count: number;
  fail_count: number;
  last_used_at: string | null;
  last_error: string | null;
  created_at: string;
}

interface TaskRow {
  id: string;
  type: string;
  model: string;
  provider: string | null;
  status: string;
  progress: number;
  prompt: string;
  result_urls: string[];
  error_message: string | null;
  attempts: number;
  created_at: string;
}

interface Stats {
  total: number;
  completed: number;
  failed: number;
  processing: number;
}

/* ============ ثوابت ============ */

const PROVIDERS = [
  { value: "kie", label: "kie.ai" },
  { value: "cometapi", label: "CometAPI" },
];

const TOOL_CHIPS: { name: string; desc: string }[] = [
  { name: "generate_image", desc: "توليد صورة من وصف نصي مع تبديل تلقائي عبر المفاتيح" },
  { name: "generate_video", desc: "توليد فيديو بصوت متزامن أصلي (image-to-video اختياري)" },
  { name: "merge_videos", desc: "دمج 2–10 مقاطع في فيديو واحد بالترتيب المطلوب" },
  { name: "get_task", desc: "متابعة أي مهمة (توليد أو دمج) بمعرّفها حتى الاكتمال" },
  { name: "list_media", desc: "استرجاع أحدث الوسائط المخزنة بروابطها" },
];

/* ============ أدوات مساعدة ============ */

function fmtTime(iso: string | null): string {
  if (!iso) return "—";
  const d = new Date(iso.includes("T") ? iso : `${iso.replace(" ", "T")}Z`);
  if (Number.isNaN(d.getTime())) return iso;
  const diff = Math.floor((Date.now() - d.getTime()) / 1000);
  if (diff < 60) return "قبل لحظات";
  if (diff < 3600) return `منذ ${Math.floor(diff / 60)} دقيقة`;
  if (diff < 86400) return `منذ ${Math.floor(diff / 3600)} ساعة`;
  return d.toLocaleString("ar", { hour12: false });
}

/* ============ المكونات ============ */

function StatusBadge({ status }: { status: string }) {
  const map: Record<string, string> = {
    active: "bg-emerald-500/15 text-emerald-300 border-emerald-500/30",
    exhausted: "bg-amber-500/15 text-amber-300 border-amber-500/30",
    disabled: "bg-slate-500/15 text-slate-400 border-slate-500/30",
    completed: "bg-emerald-500/15 text-emerald-300 border-emerald-500/30",
    failed: "bg-rose-500/15 text-rose-300 border-rose-500/30",
    processing: "bg-amber-500/15 text-amber-300 border-amber-500/30",
    pending: "bg-slate-500/15 text-slate-400 border-slate-500/30",
  };
  const labels: Record<string, string> = {
    active: "نشط",
    exhausted: "مستنزف",
    disabled: "معطّل",
    completed: "مكتملة",
    failed: "فاشلة",
    processing: "جارية",
    pending: "معلّقة",
  };
  return (
    <span className={`inline-block rounded-full border px-2 py-0.5 text-xs font-semibold ${map[status] ?? map.pending}`}>
      {labels[status] ?? status}
    </span>
  );
}

function CopyButton({ text, small }: { text: string; small?: boolean }) {
  const [copied, setCopied] = useState(false);
  return (
    <button
      type="button"
      onClick={async () => {
        try {
          await navigator.clipboard.writeText(text);
          setCopied(true);
          setTimeout(() => setCopied(false), 1500);
        } catch {
          /* تجاهل */
        }
      }}
      className={`shrink-0 rounded-lg border border-slate-600 bg-slate-800 font-medium text-slate-200 transition hover:bg-slate-700 ${
        small ? "px-2 py-1 text-xs" : "px-3 py-1.5 text-sm"
      }`}
    >
      {copied ? "✓ تم النسخ" : "نسخ"}
    </button>
  );
}

/* ============ البطاقات ============ */

function KeysCard({ keys, reload }: { keys: KeyRow[]; reload: () => Promise<void> }) {
  const [provider, setProvider] = useState("kie");
  const [label, setLabel] = useState("");
  const [apiKey, setApiKey] = useState("");
  const [msg, setMsg] = useState<{ kind: "ok" | "err"; text: string } | null>(null);
  const [busy, setBusy] = useState(false);

  const addKey = async () => {
    setBusy(true);
    setMsg(null);
    try {
      const r = await fetch("/api/keys", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ provider, api_key: apiKey.trim(), label: label.trim() }),
      });
      const j = await r.json();
      if (!r.ok) {
        setMsg({ kind: "err", text: j.error ?? "فشل إضافة المفتاح" });
      } else {
        setMsg({ kind: "ok", text: "تمت إضافة المفتاح بنجاح — سيُجرَّب أولًا في الترتيب التسلسلي" });
        setLabel("");
        setApiKey("");
        await reload();
      }
    } catch {
      setMsg({ kind: "err", text: "تعذر الاتصال بالخادم" });
    } finally {
      setBusy(false);
    }
  };

  const patchKey = async (id: string, action: "enable" | "disable") => {
    await fetch(`/api/keys/${id}`, {
      method: "PATCH",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ action }),
    });
    await reload();
  };

  const removeKey = async (id: string) => {
    if (!confirm("هل تريد حذف هذا المفتاح نهائيًا؟")) return;
    await fetch(`/api/keys/${id}`, { method: "DELETE" });
    await reload();
  };

  return (
    <section className="rounded-2xl border border-slate-800 bg-slate-900 p-4 sm:p-6" aria-label="مدير المفاتيح">
      <h2 className="mb-1 text-lg font-bold">مدير المفاتيح</h2>
      <p className="mb-4 text-sm leading-6 text-slate-400">
        أضف عدة مفاتيح لكل مزود — التجربة تسلسلية (أول مفتاح ثم التالي ثم التالي) مع تبديل فوري تلقائي عند أي خطأ أو نفاد
        رصيد دون توقف.
      </p>

      {/* نموذج الإضافة */}
      <div className="mb-4 grid gap-2 sm:grid-cols-5">
        <select
          value={provider}
          onChange={(e) => setProvider(e.target.value)}
          className="rounded-lg border border-slate-700 bg-slate-800 px-3 py-2 text-sm"
          aria-label="المزود"
        >
          {PROVIDERS.map((p) => (
            <option key={p.value} value={p.value}>
              {p.label}
            </option>
          ))}
        </select>
        <input
          value={label}
          onChange={(e) => setLabel(e.target.value)}
          placeholder="تسمية اختيارية"
          className="rounded-lg border border-slate-700 bg-slate-800 px-3 py-2 text-sm placeholder:text-slate-500"
        />
        <input
          value={apiKey}
          onChange={(e) => setApiKey(e.target.value)}
          placeholder="مفتاح API الكامل"
          type="password"
          className="rounded-lg border border-slate-700 bg-slate-800 px-3 py-2 text-sm placeholder:text-slate-500 sm:col-span-2"
          dir="ltr"
        />
        <button
          type="button"
          onClick={addKey}
          disabled={busy || !apiKey.trim()}
          className="rounded-lg bg-emerald-600 px-4 py-2 text-sm font-bold text-white transition hover:bg-emerald-500 disabled:opacity-50"
        >
          {busy ? "جارٍ الإضافة…" : "إضافة مفتاح"}
        </button>
      </div>
      {msg && (
        <p className={`mb-4 rounded-lg px-3 py-2 text-sm ${msg.kind === "ok" ? "bg-emerald-500/10 text-emerald-300" : "bg-rose-500/10 text-rose-300"}`}>
          {msg.text}
        </p>
      )}

      {/* القائمة */}
      <div className="max-h-96 overflow-y-auto">
        {keys.length === 0 ? (
          <p className="rounded-lg border border-dashed border-slate-700 p-4 text-center text-sm text-slate-500">
            لا توجد مفاتيح بعد — أضف أول مفتاح من النموذج أعلاه
          </p>
        ) : (
          <ul className="space-y-2">
            {keys.map((k, i) => (
              <li key={k.id} className="rounded-xl border border-slate-800 bg-slate-950/60 p-3">
                <div className="flex flex-wrap items-center gap-2">
                  <span className="rounded bg-slate-800 px-2 py-0.5 text-xs text-slate-400">#{i + 1}</span>
                  <span className="text-sm font-bold">{k.provider === "kie" ? "kie.ai" : "CometAPI"}</span>
                  <StatusBadge status={k.status} />
                  <code className="rounded bg-slate-800/70 px-2 py-0.5 text-xs text-slate-300" dir="ltr">
                    {k.masked}
                  </code>
                  {k.label && <span className="text-xs text-slate-400">{k.label}</span>}
                  <span className="ms-auto flex gap-1.5">
                    {k.status === "disabled" ? (
                      <button
                        onClick={() => patchKey(k.id, "enable")}
                        className="rounded-lg border border-emerald-600/40 bg-emerald-600/10 px-2 py-1 text-xs text-emerald-300 hover:bg-emerald-600/20"
                      >
                        تنشيط
                      </button>
                    ) : (
                      <button
                        onClick={() => patchKey(k.id, "disable")}
                        className="rounded-lg border border-slate-600 bg-slate-800 px-2 py-1 text-xs text-slate-300 hover:bg-slate-700"
                      >
                        تعطيل
                      </button>
                    )}
                    <button
                      onClick={() => removeKey(k.id)}
                      className="rounded-lg border border-rose-600/40 bg-rose-600/10 px-2 py-1 text-xs text-rose-300 hover:bg-rose-600/20"
                    >
                      حذف
                    </button>
                  </span>
                </div>
                <div className="mt-2 flex flex-wrap gap-x-4 gap-y-1 text-xs text-slate-500">
                  <span>استخدام: {k.usage_count}</span>
                  <span className="text-emerald-400">نجاح: {k.success_count}</span>
                  <span className="text-rose-400">فشل: {k.fail_count}</span>
                  <span>آخر استخدام: {fmtTime(k.last_used_at)}</span>
                  {k.last_error && (
                    <span className="w-full truncate text-rose-400/80" dir="ltr" title={k.last_error}>
                      آخر خطأ: {k.last_error}
                    </span>
                  )}
                </div>
              </li>
            ))}
          </ul>
        )}
      </div>
    </section>
  );
}

function TasksCard({ stats, tasks }: { stats: Stats; tasks: TaskRow[] }) {
  return (
    <section className="rounded-2xl border border-slate-800 bg-slate-900 p-4 sm:p-6" aria-label="لوحة المهام">
      <div className="mb-4 flex flex-wrap items-center justify-between gap-2">
        <h2 className="text-lg font-bold">لوحة المهام</h2>
        <span className="text-xs text-slate-500">تحديث تلقائي كل 5 ثوانٍ</span>
      </div>

      {/* شرائح الإحصائيات */}
      <div className="mb-4 grid grid-cols-2 gap-2 sm:grid-cols-4">
        {[
          { label: "إجمالي", value: stats.total, cls: "text-slate-200" },
          { label: "مكتملة", value: stats.completed, cls: "text-emerald-300" },
          { label: "فاشلة", value: stats.failed, cls: "text-rose-300" },
          { label: "جارية", value: stats.processing, cls: "text-amber-300" },
        ].map((s) => (
          <div key={s.label} className="rounded-xl border border-slate-800 bg-slate-950/60 p-3 text-center">
            <div className={`text-2xl font-black ${s.cls}`}>{s.value}</div>
            <div className="text-xs text-slate-500">{s.label}</div>
          </div>
        ))}
      </div>

      {/* قائمة المهام */}
      <div className="max-h-96 overflow-y-auto">
        {tasks.length === 0 ? (
          <p className="rounded-lg border border-dashed border-slate-700 p-4 text-center text-sm text-slate-500">
            لا توجد مهام بعد — ستظهر هنا تلقائيًا فور أول توليد أو دمج
          </p>
        ) : (
          <ul className="space-y-2">
            {tasks.map((t) => (
              <li key={t.id} className="rounded-xl border border-slate-800 bg-slate-950/60 p-3">
                <div className="flex flex-wrap items-center gap-2">
                  <span className="rounded bg-slate-800 px-2 py-0.5 text-xs font-semibold text-slate-300">
                    {t.type === "image" ? "🖼 صورة" : t.type === "video" ? "🎬 فيديو" : "🎞 دمج"}
                  </span>
                  <StatusBadge status={t.status} />
                  <code className="rounded bg-slate-800/70 px-2 py-0.5 text-xs text-slate-400" dir="ltr">
                    {t.model}
                  </code>
                  <span className="text-xs text-slate-500">{fmtTime(t.created_at)}</span>
                  {t.attempts > 0 && (
                    <span className="rounded bg-slate-800 px-2 py-0.5 text-xs text-slate-400">محاولات: {t.attempts}</span>
                  )}
                  {t.status === "completed" && t.result_urls.length > 0 && (
                    <a
                      href={t.result_urls[0]}
                      target="_blank"
                      rel="noreferrer"
                      className="ms-auto rounded-lg border border-emerald-600/40 bg-emerald-600/10 px-2 py-1 text-xs font-semibold text-emerald-300 hover:bg-emerald-600/20"
                    >
                      فتح الرابط ↗
                    </a>
                  )}
                </div>
                {t.prompt && <p className="mt-1.5 truncate text-sm text-slate-300">{t.prompt}</p>}
                {t.status === "processing" && (
                  <div className="mt-2 h-1.5 w-full overflow-hidden rounded-full bg-slate-800">
                    <div
                      className="h-full rounded-full bg-amber-400 transition-all"
                      style={{ width: `${Math.max(3, t.progress)}%` }}
                    />
                  </div>
                )}
                {t.status === "failed" && t.error_message && (
                  <p className="mt-1.5 text-xs text-rose-300">❌ {t.error_message}</p>
                )}
                {t.status === "processing" && (
                  <p className="mt-1 text-xs text-slate-500" dir="ltr">
                    task_id: {t.id}
                  </p>
                )}
              </li>
            ))}
          </ul>
        )}
      </div>
    </section>
  );
}

function ConnectCard({ origin, authRequired }: { origin: string; authRequired: boolean }) {
  const [tab, setTab] = useState<"chatgpt" | "claude" | "cursor">("chatgpt");
  const mcpUrl = origin ? `${origin}/mcp` : "/mcp";

  const authLine = authRequired ? `, "headers": { "Authorization": "Bearer <MCP_ACCESS_TOKEN>" }` : "";
  const jsons = useMemo(
    () => ({
      chatgpt: `{\n  "mcpServers": {\n    "media-generator": {\n      "url": "${mcpUrl}"${authLine}\n    }\n  }\n}`,
      claude: `{\n  "mcpServers": {\n    "media-generator": {\n      "type": "http",\n      "url": "${mcpUrl}"${authLine}\n    }\n  }\n}`,
      cursor: `{\n  "mcpServers": {\n    "media-generator": {\n      "url": "${mcpUrl}"${authLine}\n    }\n  }\n}`,
    }),
    [mcpUrl, authLine]
  );

  const tabs = [
    { id: "chatgpt", label: "ChatGPT / GPT Agents" },
    { id: "claude", label: "Claude Desktop" },
    { id: "cursor", label: "Cursor / Windsurf / Cline" },
  ] as const;

  return (
    <section className="rounded-2xl border border-slate-800 bg-slate-900 p-4 sm:p-6" aria-label="ربط السيرفر">
      <h2 className="mb-4 text-lg font-bold">ربط السيرفر</h2>

      {/* رابط MCP */}
      <div className="mb-4 flex items-center gap-2">
        <code className="flex-1 truncate rounded-lg border border-slate-700 bg-slate-800 px-3 py-2 text-sm text-emerald-300" dir="ltr">
          {mcpUrl}
        </code>
        <CopyButton text={mcpUrl} />
      </div>

      {/* تبويبات JSON */}
      <div className="mb-2 flex flex-wrap gap-1.5">
        {tabs.map((t) => (
          <button
            key={t.id}
            type="button"
            onClick={() => setTab(t.id)}
            className={`rounded-lg px-3 py-1.5 text-xs font-semibold transition ${
              tab === t.id ? "bg-emerald-600 text-white" : "bg-slate-800 text-slate-300 hover:bg-slate-700"
            }`}
          >
            {t.label}
          </button>
        ))}
      </div>
      <div className="relative">
        <pre className="max-h-64 overflow-auto rounded-xl border border-slate-800 bg-slate-950 p-4 text-xs leading-5 text-slate-300" dir="ltr">
          {jsons[tab]}
        </pre>
        <span className="absolute left-2 top-2">
          <CopyButton text={jsons[tab]} small />
        </span>
      </div>
      {tab === "chatgpt" && (
        <p className="mt-2 text-xs text-slate-400">
          في ChatGPT: Settings → Connectors → Create → Custom MCP server — وضع الرابط في «Server URL».
        </p>
      )}
      {tab === "claude" && <p className="mt-2 text-xs text-slate-400">ضع المحتوى في ملف claude_desktop_config.json ثم أعد تشغيل التطبيق.</p>}
      {tab === "cursor" && <p className="mt-2 text-xs text-slate-400">ضع المحتوى في mcp.json ثم أعد تحميل المحرر.</p>}
      {authRequired && (
        <p className="mt-2 text-xs text-amber-300">
          الحماية مفعّلة (MCP_ACCESS_TOKEN) — استبدل <code dir="ltr">&lt;MCP_ACCESS_TOKEN&gt;</code> بالتوكن الحقيقي.
        </p>
      )}

      {/* رقائق الأدوات */}
      <div className="mt-5">
        <h3 className="mb-2 text-sm font-bold text-slate-300">الأدوات الخمس</h3>
        <div className="flex flex-wrap gap-2">
          {TOOL_CHIPS.map((t) => (
            <span key={t.name} className="inline-flex max-w-full flex-wrap items-center gap-1.5 rounded-full border border-slate-700 bg-slate-950/60 px-3 py-1 text-xs">
              <code className="font-bold text-emerald-300" dir="ltr">
                {t.name}
              </code>
              <span className="text-slate-400">{t.desc}</span>
            </span>
          ))}
        </div>
      </div>

      {/* ملاحظة كهرمانية */}
      <div className="mt-5 rounded-xl border border-amber-500/30 bg-amber-500/10 p-3 text-sm leading-6 text-amber-200">
        الفيديو يحتاج دقائق: يعيد السيرفر task_id فورًا، ويتابَع تلقائيًا بـ get_task كل 10 ثوانٍ — وعند اكتمال المهمة
        يُعرض الرابط في الدردشة ويتوقف. أثناء الانتظار يُبَث تقدم حي (Progress notifications) حتى لا تنقطع العملية.
      </div>
    </section>
  );
}

/* ============ اللوحة الرئيسية ============ */

export default function Dashboard() {
  const [health, setHealth] = useState<Health | null>(null);
  const [keys, setKeys] = useState<KeyRow[]>([]);
  const [stats, setStats] = useState<Stats>({ total: 0, completed: 0, failed: 0, processing: 0 });
  const [tasks, setTasks] = useState<TaskRow[]>([]);
  const [origin, setOrigin] = useState("");

  const loadHealth = useCallback(async () => {
    try {
      const r = await fetch("/api/health");
      setHealth(await r.json());
    } catch {
      setHealth(null);
    }
  }, []);

  const loadKeys = useCallback(async () => {
    try {
      const r = await fetch("/api/keys");
      const j = await r.json();
      setKeys(j.keys ?? []);
    } catch {
      /* تجاهل */
    }
  }, []);

  const loadTasks = useCallback(async () => {
    try {
      const r = await fetch("/api/tasks?limit=25");
      const j = await r.json();
      setStats(j.stats ?? { total: 0, completed: 0, failed: 0, processing: 0 });
      setTasks(j.tasks ?? []);
    } catch {
      /* تجاهل */
    }
  }, []);

  useEffect(() => {
    setOrigin(window.location.origin);
    loadHealth();
    loadKeys();
    loadTasks();
    const t = setInterval(loadTasks, 5000);
    const h = setInterval(loadHealth, 20000);
    return () => {
      clearInterval(t);
      clearInterval(h);
    };
  }, [loadHealth, loadKeys, loadTasks]);

  const dbOk = health?.database === "turso-connected";

  return (
    <main className="mx-auto flex min-h-screen max-w-5xl flex-col gap-5 px-4 py-6">
      {/* الهيدر */}
      <header className="flex flex-wrap items-center justify-between gap-3">
        <div>
          <h1 className="text-xl font-black sm:text-2xl">MCP Media Generator — لوحة الإدارة</h1>
          <p className="text-sm text-slate-400">توليد الصور والفيديو بالذكاء الاصطناعي ودمج المقاطع عبر بروتوكول MCP</p>
        </div>
        <div className="flex items-center gap-2">
          <span
            className={`inline-flex items-center gap-1.5 rounded-full border px-3 py-1.5 text-sm font-semibold ${
              dbOk
                ? "border-emerald-500/40 bg-emerald-500/10 text-emerald-300"
                : "border-rose-500/40 bg-rose-500/10 text-rose-300"
            }`}
          >
            <span className={`inline-block h-2 w-2 rounded-full ${dbOk ? "bg-emerald-400" : "bg-rose-400"}`} />
            {dbOk ? "Turso متصل" : "غير متصل"}
          </span>
          {health && (
            <span
              className={`inline-flex items-center gap-1.5 rounded-full border px-3 py-1.5 text-xs font-semibold ${
                health.merger.healthy
                  ? "border-emerald-500/40 bg-emerald-500/10 text-emerald-300"
                  : "border-slate-600 bg-slate-800 text-slate-400"
              }`}
            >
              خدمة الدمج: {health.merger.healthy ? "جاهزة" : "غير مضبوطة"}
            </span>
          )}
        </div>
      </header>

      <KeysCard keys={keys} reload={loadKeys} />
      <TasksCard stats={stats} tasks={tasks} />
      <ConnectCard origin={origin} authRequired={health?.authRequired ?? false} />

      <footer className="mt-auto pt-4 text-center text-xs text-slate-600">
        روابط فقط — لا يُنزَّل أي ملف وسائط على السيرفر · المفاتيح مخفية دائمًا · التبديل التسلسلي صامت تمامًا
      </footer>
    </main>
  );
}
