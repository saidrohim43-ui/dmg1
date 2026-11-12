/**
 * صياغة الردود العربية لأدوات MCP — التسميات التقنية وأسماء الأدوات تبقى بالإنجليزية.
 */
import type { MediaTask } from "./turso";

export function formatTask(task: MediaTask): string {
  if (task.status === "completed") return formatCompleted(task);
  if (task.status === "failed") return formatFailed(task);
  return formatProcessing(task);
}

function formatCompleted(task: MediaTask): string {
  const urls = task.result_urls.length ? task.result_urls : [];
  if (!urls.length) return `✅ اكتملت المهمة دون روابط ناتجة — task_id: ${task.id}`;

  if (task.type === "image") {
    return `✅ تم توليد الصورة بنجاح\n\n![image](${urls[0]})\n\nالرابط المباشر: ${urls[0]}`;
  }
  if (task.type === "merge") {
    const links = urls.map((u) => `- ${u}`).join("\n");
    return `✅ تم دمج المقاطع بنجاح\n\nالروابط المباشرة:\n${links}\n\n⚠️ ملف الدمج يُحذف من خدمة الدمج بعد ~24 ساعة — شاهده/نزّله سريعًا.`;
  }
  // فيديو
  const links = urls.map((u) => `- ${u}`).join("\n");
  return `✅ تم توليد الفيديو بنجاح\n\nالروابط المباشرة:\n${links}`;
}

function formatProcessing(task: MediaTask): string {
  const pct = task.progress > 0 && task.progress < 100 ? ` (${task.progress}%)` : "";
  return `⏳ المهمة قيد المعالجة${pct} — task_id: ${task.id}\n\nتابع بـ get_task كل ~10 ثوانٍ حتى تكتمل.`;
}

function formatFailed(task: MediaTask): string {
  return `❌ فشلت المهمة: ${task.error_message || "سبب غير معروف"}`;
}

export function formatList(tasks: MediaTask[]): string {
  const lines = tasks.map((t, i) => {
    const statusAr =
      t.status === "completed" ? "مكتملة" : t.status === "failed" ? "فاشلة" : "جارية";
    const typeAr = t.type === "image" ? "صورة" : t.type === "video" ? "فيديو" : "دمج";
    const head = `${i + 1}. [${typeAr} · ${statusAr}] ${t.model} — ${t.created_at} (task_id: ${t.id})`;
    if (t.status === "completed" && t.result_urls.length) {
      return `${head}\n   الروابط: ${t.result_urls.join(" ، ")}`;
    }
    if (t.status === "failed") {
      return `${head}\n   السبب: ${t.error_message ?? "غير معروف"}`;
    }
    return `${head}\n   الحالة: قيد المعالجة (${t.progress}%) — تابِعها بـ get_task`;
  });
  return `📚 أحدث الوسائط المخزنة (${tasks.length}):\n\n${lines.join("\n\n")}`;
}
