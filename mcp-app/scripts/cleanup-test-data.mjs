/**
 * تنظيف آثار الاختبار: حذف كل مهام الاختبار من جدول tasks، حذف المفتاح الخاطئ،
 * وتفريغ جداول خدمة الدمج الاختبارية الأربعة. يُحتفظ بالمفتاح الحقيقي (kie.ai الرئيسي).
 * التشغيل: node scripts/cleanup-test-data.mjs (من جذر المشروع)
 */
import { createClient } from "@libsql/client";

const url = process.env.TURSO_DATABASE_URL;
const token = process.env.TURSO_AUTH_TOKEN;
if (!url || !token) {
  console.error("متغيرات Turso مطلوبة (TURSO_DATABASE_URL / TURSO_AUTH_TOKEN)");
  process.exit(1);
}
const db = createClient({ url, authToken: token });

const t1 = await db.execute("SELECT COUNT(*) AS c FROM tasks");
const t2 = await db.execute("SELECT id, label, status FROM api_keys");
console.log("المهام قبل التنظيف:", t1.rows[0].c);
console.log("المفاتيح:", t2.rows.map((r) => `${r.label}(${r.status})`).join(" ، "));

await db.execute("DELETE FROM tasks");
await db.execute("DELETE FROM api_keys WHERE label = 'مفتاح اختبار خاطئ'");
await db.execute("DELETE FROM api_keys WHERE label LIKE 'تكرار%'");

// جداول خدمة الدمج (بيانات اختبار فقط)
for (const table of ["jobs", "sources", "source_chunks", "output_chunks"]) {
  try {
    const r = await db.execute(`DELETE FROM ${table}`);
    console.log(`تم تفريغ ${table}:`, r.rowsAffected, "صفًا");
  } catch (e) {
    console.log(`تجاهل ${table}:`, e.message?.slice(0, 60));
  }
}

const after = await db.execute("SELECT COUNT(*) AS c FROM tasks");
const keys = await db.execute("SELECT COUNT(*) AS c FROM api_keys");
console.log("المهام بعد التنظيف:", after.rows[0].c, "| المفاتيح المتبقية:", keys.rows[0].c);
