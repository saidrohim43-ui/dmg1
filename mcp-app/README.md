# MCP Media Generator — خادم MCP لتوليد الصور والفيديو ودمج المقاطع

خادم **MCP** (Model Context Protocol) يجمع ثلاث قدرات في أداة واحدة، مع **لوحة إدارة عربية RTL**:

1. **توليد صور** من وصف نصي — الموديل المدمج: `gpt-image-2-6/flare-text-to-image`
2. **توليد فيديو** مع صوت متزامن أصلي (حوار/مؤثرات/موسيقى) — الموديل المدمج: `grok-imagine-video-1-5-preview`
3. **دمج عدة مقاطع فيديو** في مقطع واحد عالي الجودة وبالترتيب المطلوب — عبر خدمة الدمج المنشورة في هذا المستودع (`dmg1.vercel.app`)

هذا المجلد (`mcp-app/`) هو التطبيق الرئيسي (Next.js). **خدمة دمج الفيديو** موجودة في جذر المستودع وهي منشورة حيًّا على Vercel.

## القواعد الجوهرية المطبَّقة

- **روابط فقط** — لا يُنزَّل أي ملف وسائط على السيرفر إطلاقًا؛ تُخزَّن روابط النتائج فقط في قاعدة البيانات.
- **تبديل مفاتيح تسلسلي صارم** حسب ترتيب الإضافة (`created_at ASC, id ASC`) — ليس round-robin: أول مفتاح أُضيف يُجرَّب أولًا، وعند أي خطأ أو نفاد رصيد ينتقل فورًا للمفتاح التالي **دون توقف المهمة**، وتُستأنف نفس المهمة بنفس `task_id`.
- **نموذج الذكاء الاصطناعي لا يرى أخطاء المفاتيح أو الرصيد أبدًا** — التبديل صامت تمامًا من وجهة نظره.
- مهمة فشل إنشاؤها على كل المفاتيح تبقى `processing` وتُعاد محاولتها تلقائيًا مع كل `get_task` (بتهدئة ~45 ثانية).
- المفتاح المستنزف (`exhausted`) يبقى في القاعدة ويُعاد تجريبه؛ الوحيد المستبعد نهائيًا هو المعطّل يدويًا (`disabled`).
- إخفاء المفاتيح إلزامي في كل الاستجابات والسجلات (`maskKey`).
- أخطاء خدمة الدمج المعلنة (HTTP 4xx/5xx) = فشل حتمي فوري؛ أخطاء الشبكة = مؤقتة وتستمر بالاستعلام.
- ملفات الدمج تُحذف من خدمة الدمج بعد ~24 ساعة (مذكورة في وصف الأداة وفي تعليمات السيرفر).

## الأدوات الخمس على /mcp

| الأداة | الوظيفة |
|---|---|
| `generate_image` | توليد صورة بـ `gpt-image-2-6/flare-text-to-image` — تعيد الرابط جاهزًا إن اكتملت خلال نافذة الانتظار وإلا `task_id` |
| `generate_video` | توليد فيديو بـ `grok-imagine-video-1-5-preview` بصوت متزامن (image-to-video اختياري) — تعيد `task_id` بعد انتظار قصير مع بث تقدم |
| `merge_videos` | دمج 2–10 مقاطع بالترتيب عبر `urls` (روابط مباشرة) أو `task_ids` (مهام مكتملة تُحل من قاعدة البيانات) |
| `get_task` | متابعة أي مهمة (توليد أو دمج) بمعرّفها — تحديث حي من المزود/الخدمة |
| `list_media` | أحدث الوسائط المخزنة بروابطها (بدون إعادة توليد) |

الردود كلها بالعربية، وبث التقدم (Progress notifications) يعمل كل ~3 ثوانٍ عندما يزوّد العميل `_meta.progressToken`.

## البنية

```
mcp-app/
├── src/app/                  الواجهة العربية (Dashboard) + /api/health و /api/keys و /api/tasks
├── src/pages/api/mcp.ts      خادم MCP على /mcp (عبر rewrite) — Pages API لكائنات Node الأصلية
├── src/lib/
│   ├── turso.ts              طبقة قاعدة البيانات (Turso عبر HTTP — متوافق مع Vercel)
│   ├── errors.ts             تصنيف أخطاء المزودين (disabled / exhausted / provider / params / temporary)
│   ├── keys.ts               إخفاء المفاتيح (maskKey)
│   ├── models.ts             سجل الموديلات + الصيغ البديلة + تجاوز بمتغيرات البيئة
│   ├── providers/            مزودا kie.ai (Jobs API) و CometAPI (متوافق OpenAI)
│   ├── orchestrator.ts       منسّق التوليد بالتبديل التسلسلي + get_task + list_media
│   ├── merger.ts             عميل خدمة الدمج (Video Merger API v2)
│   ├── mergeRunner.ts        تدفق الدمج (حدود صارمة + قفل process + فشل حتمي معلن)
│   └── format.ts             صياغة الردود العربية
└── scripts/                  سكربتات الاختبار e2e والتنظيف
```

## إنشاء قاعدة Turso (مجاني)

```bash
# ثبّت CLI (أو أنشئ القاعدة من لوحة app.turso.io)
turso auth login
turso db create media-generator

# اجلب الرابط والتوكن
turso db show media-generator --url        # ← TURSO_DATABASE_URL
turso db tokens create media-generator     # ← TURSO_AUTH_TOKEN
```

المخطط يُنشأ تلقائيًا عند أول وصول (`CREATE TABLE IF NOT EXISTS`) — لا حاجة لأي أداة migrations.

## التشغيل محليًا

```bash
cd mcp-app
npm install
cp .env.example .env.local        # ثم عبّئ القيم الحقيقية
npm run dev                       # http://localhost:3000
```

اختبارات جاهزة (تحتاج خادمًا عاملًا ومفاتيح حقيقية):

```bash
python3 scripts/mcp-e2e.py          # تهيئة جلسة → أدوات → مفاتيح → توليد صورة حقيقي مع تبديل مفاتيح
python3 scripts/mcp-video-e2e.py    # توليد فيديو ومتابعته بـ get_task حتى الرابط
python3 scripts/mcp-live-merge.py   # دمج حقيقي عبر الخدمة الإنتاجية
python3 scripts/cleanup-test-data.mjs  # تنظيف آثار الاختبار من قاعدة البيانات
```

## النشر على Vercel

1. ارفع المستودع، ثم في Vercel: **Add New → Project** واختر هذا المستودع.
2. اضبط **Root Directory = `mcp-app`** (مهم — الجذر مشغول بخدمة الدمج الحية).
3. أضف متغيرات البيئة (Production + Preview):
   - `TURSO_DATABASE_URL` = رابط قاعدة Turso
   - `TURSO_AUTH_TOKEN` = توكن قاعدة Turso
   - `MERGER_API_BASE` = `https://dmg1.vercel.app` (خدمة الدمج الحية في هذا المستودع)
   - اختياري: `MCP_ACCESS_TOKEN` لحماية `/mcp`، ومتغيرات تجاوز الموديلات
4. **Deploy** — كل شيء يعمل عبر HTTP (libSQL) ولا يعتمد على أي ملف محلي.

## ربط العملاء

اللوحة تعرض JSON جاهزًا للنسخ لكل عميل بعد النشر (بطاقة «ربط السيرفر»):

- **ChatGPT**: Settings → Connectors → Create → Custom MCP server → ضع `https://<app>.vercel.app/mcp` في Server URL.
- **Claude Desktop**: ملف `claude_desktop_config.json` بصيغة `"type": "http"`.
- **Cursor / Windsurf / Cline**: نفس الصيغة في `mcp.json`.

مثال:

```json
{
  "mcpServers": {
    "media-generator": {
      "url": "https://<app>.vercel.app/mcp"
    }
  }
}
```

إن ضُبط `MCP_ACCESS_TOKEN` أضف `"headers": { "Authorization": "Bearer <TOKEN>" }`.

اختبار سريع بعد النشر:

```bash
# تهيئة جلسة MCP
curl -s -X POST https://<app>.vercel.app/mcp \
  -H 'Content-Type: application/json' \
  -H 'Accept: application/json, text/event-stream' \
  -d '{"jsonrpc":"2.0","id":1,"method":"initialize","params":{"protocolVersion":"2025-03-26","capabilities":{},"clientInfo":{"name":"curl","version":"1.0"}}}'

# قائمة الأدوات (مع mcp-session-id من استجابة التهيئة)
curl -s -X POST https://<app>.vercel.app/mcp \
  -H 'Content-Type: application/json' -H 'Accept: application/json, text/event-stream' \
  -H 'mcp-session-id: <المعرف>' \
  -d '{"jsonrpc":"2.0","id":2,"method":"tools/list"}'
```

## متغيرات البيئة

| المتغير | إلزامي | الوصف |
|---|---|---|
| `TURSO_DATABASE_URL` | نعم | رابط قاعدة Turso (`libsql://...`) |
| `TURSO_AUTH_TOKEN` | نعم | توكن Turso بصلاحيات كتابة |
| `MERGER_API_BASE` | للدمج | عنوان خدمة الدمج (`https://dmg1.vercel.app`) |
| `MCP_ACCESS_TOKEN` | لا | حماية `/mcp` بـ Bearer token |
| `KIE_IMAGE_MODEL` / `KIE_VIDEO_MODEL` | لا | تجاوز أسماء الموديلات لدى kie.ai |
| `COMETAPI_IMAGE_MODEL` / `COMETAPI_VIDEO_MODEL` | لا | تجاوز أسماء الموديلات لدى CometAPI |

## الأمان

- `.env*` مستثنى من Git — لا أسرار في المستودع إطلاقًا.
- المفاتيح تُخزَّن في قاعدة البيانات وتُعرض مقنّعة فقط (`ABCD123••••••••WXYZ`) ولا يُعاد المفتاح الكامل في أي استجابة.

## حدود خدمة الدمج (المستخدمة عبر MERGER_API_BASE)

- 10 مقاطع كحد أقصى، 200MB لكل رابط مصدر، 150MB لحجم الناتج، 600 ثانية مجموع المدد.
- الناتج MP4 (H.264 + AAC) حتى 1080p بجودة CRF 18.
- كل الملفات تُحذف تلقائيًا بعد 24 ساعة — نزّل الناتج سريعًا.
