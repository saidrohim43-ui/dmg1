/**
 * طبقة قاعدة البيانات — Turso (libSQL) عبر HTTP.
 * قرار موثّق: نستخدم @libsql/client عبر HTTP وليس SQLite محليًا — إلزامي للتوافق مع Vercel (لا ملفات محلية).
 * المخطط يُنشأ عند أول وصول بـ CREATE TABLE IF NOT EXISTS — لا حاجة لأداة migrations.
 */
import { createClient, type Client, type InValue } from "@libsql/client";

let client: Client | null = null;

export function turso(): Client {
  if (!client) {
    const url = process.env.TURSO_DATABASE_URL;
    const token = process.env.TURSO_AUTH_TOKEN;
    if (!url || !token) {
      throw new Error("متغيرات Turso غير مضبوطة: TURSO_DATABASE_URL و TURSO_AUTH_TOKEN مطلوبان");
    }
    client = createClient({ url, authToken: token });
  }
  return client;
}

let schemaPromise: Promise<void> | null = null;
export function ensureSchema(): Promise<void> {
  schemaPromise ??= (async () => {
    const db = turso();
    await db.batch(
      [
        {
          sql: `CREATE TABLE IF NOT EXISTS tasks (
            id TEXT PRIMARY KEY,
            provider TEXT,
            provider_task_id TEXT,
            key_id TEXT,
            model TEXT NOT NULL,
            type TEXT NOT NULL,
            prompt TEXT DEFAULT '',
            params_json TEXT DEFAULT '{}',
            status TEXT NOT NULL,
            progress INTEGER DEFAULT 0,
            result_urls_json TEXT,
            error_message TEXT,
            attempts_json TEXT DEFAULT '[]',
            created_at TEXT DEFAULT (datetime('now')),
            updated_at TEXT DEFAULT (datetime('now')),
            completed_at TEXT
          )`,
          args: [],
        },
        {
          sql: `CREATE TABLE IF NOT EXISTS api_keys (
            id TEXT PRIMARY KEY,
            provider TEXT NOT NULL,
            label TEXT DEFAULT '',
            api_key TEXT NOT NULL,
            status TEXT DEFAULT 'active',
            usage_count INTEGER DEFAULT 0,
            success_count INTEGER DEFAULT 0,
            fail_count INTEGER DEFAULT 0,
            last_used_at TEXT,
            last_checked_at TEXT,
            last_error TEXT,
            created_at TEXT DEFAULT (datetime('now'))
          )`,
          args: [],
        },
        { sql: `CREATE INDEX IF NOT EXISTS idx_tasks_created ON tasks (created_at DESC)`, args: [] },
        { sql: `CREATE INDEX IF NOT EXISTS idx_keys_provider ON api_keys (provider, created_at)`, args: [] },
      ],
      "write"
    );
  })();
  return schemaPromise;
}

export async function dbHealthy(): Promise<boolean> {
  try {
    await turso().execute("SELECT 1");
    return true;
  } catch {
    return false;
  }
}

/* ============ الأنواع ============ */

export type TaskStatus = "pending" | "processing" | "completed" | "failed";

export interface TaskAttempt {
  provider?: string;
  keyId?: string;
  keyLabel?: string;
  ok: boolean;
  errorClass?: string;
  error?: string;
  at: string;
}

export interface MediaTask {
  id: string;
  provider: string | null;
  provider_task_id: string | null;
  key_id: string | null;
  model: string;
  type: string; // image | video | merge
  prompt: string;
  params_json: string;
  status: TaskStatus;
  progress: number;
  result_urls: string[];
  error_message: string | null;
  attempts: TaskAttempt[];
  created_at: string;
  updated_at: string;
  completed_at: string | null;
}

export interface ApiKeyRow {
  id: string;
  provider: string; // kie | cometapi
  label: string;
  api_key: string;
  status: "active" | "exhausted" | "disabled";
  usage_count: number;
  success_count: number;
  fail_count: number;
  last_used_at: string | null;
  last_checked_at: string | null;
  last_error: string | null;
  created_at: string;
}

/* ============ محولات الصفوف ============ */

// eslint-disable-next-line @typescript-eslint/no-explicit-any
function mapTask(row: any): MediaTask {
  const parse = (s: unknown, fallback: unknown) => {
    try {
      return s ? JSON.parse(String(s)) : fallback;
    } catch {
      return fallback;
    }
  };
  return {
    id: String(row.id),
    provider: row.provider ?? null,
    provider_task_id: row.provider_task_id ?? null,
    key_id: row.key_id ?? null,
    model: String(row.model),
    type: String(row.type),
    prompt: String(row.prompt ?? ""),
    params_json: String(row.params_json ?? "{}"),
    status: String(row.status) as TaskStatus,
    progress: Math.max(0, Math.min(100, Number(row.progress ?? 0))),
    result_urls: parse(row.result_urls_json, []) as string[],
    error_message: row.error_message ?? null,
    attempts: parse(row.attempts_json, []) as TaskAttempt[],
    created_at: String(row.created_at ?? ""),
    updated_at: String(row.updated_at ?? ""),
    completed_at: row.completed_at ?? null,
  };
}

// eslint-disable-next-line @typescript-eslint/no-explicit-any
function mapKey(row: any): ApiKeyRow {
  return {
    id: String(row.id),
    provider: String(row.provider),
    label: String(row.label ?? ""),
    api_key: String(row.api_key),
    status: (String(row.status ?? "active") as ApiKeyRow["status"]) ?? "active",
    usage_count: Number(row.usage_count ?? 0),
    success_count: Number(row.success_count ?? 0),
    fail_count: Number(row.fail_count ?? 0),
    last_used_at: row.last_used_at ?? null,
    last_checked_at: row.last_checked_at ?? null,
    last_error: row.last_error ?? null,
    created_at: String(row.created_at ?? ""),
  };
}

/* ============ عمليات المهام ============ */

export interface NewTask {
  id: string;
  type: string;
  model: string;
  prompt: string;
  params_json: string;
  provider?: string;
  status?: TaskStatus;
}

export async function insertTask(t: NewTask): Promise<MediaTask> {
  await ensureSchema();
  await turso().execute({
    sql: `INSERT INTO tasks (id, provider, model, type, prompt, params_json, status, progress, attempts_json)
          VALUES (?, ?, ?, ?, ?, ?, ?, 0, '[]')`,
    args: [t.id, t.provider ?? null, t.model, t.type, t.prompt, t.params_json, t.status ?? "processing"],
  });
  return (await getTask(t.id))!;
}

export async function getTask(id: string): Promise<MediaTask | null> {
  await ensureSchema();
  const res = await turso().execute({ sql: `SELECT * FROM tasks WHERE id = ?`, args: [id] });
  return res.rows.length ? mapTask(res.rows[0]) : null;
}

export async function getTaskByProviderTaskId(providerTaskId: string, provider?: string): Promise<MediaTask | null> {
  await ensureSchema();
  const res = await turso().execute({
    sql: provider
      ? `SELECT * FROM tasks WHERE provider_task_id = ? AND provider = ? ORDER BY created_at DESC LIMIT 1`
      : `SELECT * FROM tasks WHERE provider_task_id = ? ORDER BY created_at DESC LIMIT 1`,
    args: provider ? [providerTaskId, provider] : [providerTaskId],
  });
  return res.rows.length ? mapTask(res.rows[0]) : null;
}

export interface TaskPatch {
  provider?: string | null;
  provider_task_id?: string | null;
  key_id?: string | null;
  status?: TaskStatus;
  progress?: number;
  result_urls?: string[];
  error_message?: string | null;
  appendAttempt?: TaskAttempt;
}

/** تحديث جزئي للمهمة — يضيف المحاولات ويضبط completed_at تلقائيًا عند الاكتمال، ويحدّث updated_at دائمًا */
export async function updateTask(id: string, patch: TaskPatch): Promise<MediaTask | null> {
  await ensureSchema();
  const cur = await getTask(id);
  if (!cur) return null;

  const attempts = patch.appendAttempt ? [...cur.attempts, patch.appendAttempt] : cur.attempts;
  const status = patch.status ?? cur.status;
  const completedAt =
    status === "completed" && !cur.completed_at ? new Date().toISOString() : cur.completed_at;
  const progress =
    patch.progress !== undefined
      ? Math.max(0, Math.min(100, Math.round(patch.progress)))
      : status === "completed"
        ? 100
        : cur.progress;
  const provider = patch.provider !== undefined ? patch.provider : cur.provider;
  const providerTaskId = patch.provider_task_id !== undefined ? patch.provider_task_id : cur.provider_task_id;
  const keyId = patch.key_id !== undefined ? patch.key_id : cur.key_id;
  const resultUrls = patch.result_urls !== undefined ? patch.result_urls : cur.result_urls;
  const errorMessage = patch.error_message !== undefined ? patch.error_message : cur.error_message;

  await turso().execute({
    sql: `UPDATE tasks SET provider=?, provider_task_id=?, key_id=?, status=?, progress=?,
          result_urls_json=?, error_message=?, attempts_json=?, completed_at=?, updated_at=datetime('now')
          WHERE id=?`,
    args: [
      provider,
      providerTaskId,
      keyId,
      status,
      progress,
      JSON.stringify(resultUrls),
      errorMessage,
      JSON.stringify(attempts),
      completedAt,
      id,
    ] as InValue[],
  });
  return getTask(id);
}

export async function listRecentTasks(
  limit: number,
  filters?: { type?: string; status?: string }
): Promise<MediaTask[]> {
  await ensureSchema();
  const where: string[] = [];
  const args: InValue[] = [];
  if (filters?.type) {
    where.push("type = ?");
    args.push(filters.type);
  }
  if (filters?.status) {
    where.push("status = ?");
    args.push(filters.status);
  }
  const sql = `SELECT * FROM tasks ${where.length ? "WHERE " + where.join(" AND ") : ""}
               ORDER BY created_at DESC, id DESC LIMIT ?`;
  args.push(Math.max(1, Math.min(50, limit)));
  const res = await turso().execute({ sql, args });
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  return res.rows.map((r: any) => mapTask(r));
}

export interface TaskStats {
  total: number;
  completed: number;
  failed: number;
  processing: number;
}

export async function taskStats(): Promise<TaskStats> {
  await ensureSchema();
  const res = await turso().execute(`SELECT status, COUNT(*) AS c FROM tasks GROUP BY status`);
  const stats: TaskStats = { total: 0, completed: 0, failed: 0, processing: 0 };
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  for (const row of res.rows as any[]) {
    const c = Number(row.c ?? 0);
    stats.total += c;
    if (row.status === "completed") stats.completed = c;
    else if (row.status === "failed") stats.failed = c;
    else if (row.status === "processing" || row.status === "pending") stats.processing += c;
  }
  return stats;
}

/* ============ عمليات المفاتيح ============ */

/**
 * تجمع المفاتيح بترتيب تسلسلي صارم حسب الإضافة (created_at ASC, id ASC):
 * أول مفتاح أُضيف يُجرَّب أولًا — ليست round-robin وليست «الأقل استخدامًا أولًا».
 * المفتاح المستنزف (exhausted) يبقى في القائمة — الاستثناء الوحيد هو التعطيل اليدوي (disabled).
 */
export async function getKeyPool(providers: string[]): Promise<ApiKeyRow[]> {
  await ensureSchema();
  const placeholders = providers.map(() => "?").join(", ");
  const res = await turso().execute({
    sql: `SELECT * FROM api_keys
          WHERE status != 'disabled' AND provider IN (${placeholders})
          ORDER BY created_at ASC, id ASC`,
    args: providers as InValue[],
  });
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  return res.rows.map((r: any) => mapKey(r));
}

export async function listKeys(): Promise<ApiKeyRow[]> {
  await ensureSchema();
  const res = await turso().execute({
    sql: `SELECT * FROM api_keys ORDER BY created_at ASC, id ASC`,
    args: [],
  });
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  return res.rows.map((r: any) => mapKey(r));
}

export async function getKey(id: string): Promise<ApiKeyRow | null> {
  await ensureSchema();
  const res = await turso().execute({ sql: `SELECT * FROM api_keys WHERE id = ?`, args: [id] });
  return res.rows.length ? mapKey(res.rows[0]) : null;
}

export async function findDuplicateKey(provider: string, apiKey: string): Promise<ApiKeyRow | null> {
  await ensureSchema();
  const res = await turso().execute({
    sql: `SELECT * FROM api_keys WHERE provider = ? AND api_key = ? LIMIT 1`,
    args: [provider, apiKey],
  });
  return res.rows.length ? mapKey(res.rows[0]) : null;
}

export async function insertKey(input: {
  provider: string;
  api_key: string;
  label?: string;
}): Promise<ApiKeyRow> {
  await ensureSchema();
  const id = crypto.randomUUID();
  await turso().execute({
    sql: `INSERT INTO api_keys (id, provider, label, api_key, status) VALUES (?, ?, ?, ?, 'active')`,
    args: [id, input.provider, input.label ?? "", input.api_key],
  });
  return (await getKey(id))!;
}

export interface KeyPatch {
  status?: ApiKeyRow["status"];
  label?: string;
}

export async function updateKey(id: string, patch: KeyPatch): Promise<ApiKeyRow | null> {
  await ensureSchema();
  const cur = await getKey(id);
  if (!cur) return null;
  const status = patch.status ?? cur.status;
  const label = patch.label !== undefined ? patch.label : cur.label;
  await turso().execute({
    sql: `UPDATE api_keys SET status = ?, label = ? WHERE id = ?`,
    args: [status, label, id],
  });
  return getKey(id);
}

export async function deleteKey(id: string): Promise<boolean> {
  await ensureSchema();
  const res = await turso().execute({ sql: `DELETE FROM api_keys WHERE id = ?`, args: [id] });
  return res.rowsAffected > 0;
}

/**
 * تحديث عدّادات المفتاح بعد كل محاولة (تُحدَّث دائمًا):
 * - فئة disabled → تعطيل تلقائي للمفتاح المرفوض
 * - فئة exhausted → تعليمه مستنزفًا (يبقى في القاعدة ويُعاد تجريبه — قد يشحن المستخدم رصيده)
 * - نجاح → إعادة تنشيط تلقائية إن كان مستنزفًا
 */
export async function bumpKeyStats(
  id: string,
  opts: { ok: boolean; errorClass?: string; error?: string }
): Promise<void> {
  await ensureSchema();
  const now = new Date().toISOString();
  const cur = await getKey(id);
  if (!cur) return;
  let status = cur.status;
  if (opts.ok) status = "active";
  else if (opts.errorClass === "disabled") status = "disabled";
  else if (opts.errorClass === "exhausted") status = "exhausted";
  await turso().execute({
    sql: `UPDATE api_keys SET
            usage_count = usage_count + 1,
            success_count = success_count + ?,
            fail_count = fail_count + ?,
            status = ?,
            last_used_at = ?,
            last_checked_at = ?,
            last_error = ?
          WHERE id = ?`,
    args: [
      opts.ok ? 1 : 0,
      opts.ok ? 0 : 1,
      status,
      now,
      now,
      opts.ok ? null : (opts.error ?? cur.last_error ?? null),
      id,
    ] as InValue[],
  });
}

/* ============ التنظيف ============ */

export async function deleteTaskById(id: string): Promise<boolean> {
  await ensureSchema();
  const res = await turso().execute({ sql: `DELETE FROM tasks WHERE id = ?`, args: [id] });
  return res.rowsAffected > 0;
}
