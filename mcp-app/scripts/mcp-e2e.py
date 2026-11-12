#!/usr/bin/env python3
# -*- coding: utf-8 -*-
"""اختبار e2e متكامل لمسار MCP: تهيئة جلسة → أدوات → مفاتيح (خاطئ ثم صحيح) → توليد صورة حقيقي."""
import json
import sys
import time
import urllib.request
import urllib.error

BASE = "http://127.0.0.1:3000"
FAKE_KEY = "kie_fake_invalid_0000000000000000"
REAL_KEY = "b92ca211e63b9f3c4ec4ce05ffc1e636"

results = []

def check(name, cond, extra=""):
    results.append((name, bool(cond), extra))
    print(("✔" if cond else "✘") + f" {name}" + (f" — {extra}" if extra else ""), flush=True)

def http(method, url, body=None, headers=None, timeout=60):
    data = json.dumps(body).encode() if body is not None else None
    req = urllib.request.Request(url, data=data, method=method)
    req.add_header("Content-Type", "application/json")
    req.add_header("Accept", "application/json, text/event-stream")
    for k, v in (headers or {}).items():
        req.add_header(k, v)
    try:
        with urllib.request.urlopen(req, timeout=timeout) as r:
            return r.status, dict(r.headers), r.read().decode()
    except urllib.error.HTTPError as e:
        return e.code, dict(e.headers or {}), e.read().decode()

def extract_jsonrpc(resp_text):
    """يستخرج كائن JSON-RPC النهائي (يعمل مع JSON الخام أو SSE)"""
    if not resp_text:
        return None
    # محاولة JSON خام أولًا
    try:
        j = json.loads(resp_text)
        if isinstance(j, dict) and ("result" in j or "error" in j or j.get("method")):
            return j
    except Exception:
        pass
    # تحليل SSE: آخر حدث message يحمل result
    final = None
    notifications = []
    for block in resp_text.split("\n\n"):
        data = None
        for line in block.split("\n"):
            if line.startswith("data:"):
                data = line[5:].strip()
        if not data:
            continue
        try:
            j = json.loads(data)
        except Exception:
            continue
        if "result" in j or "error" in j:
            final = j
        elif j.get("method"):
            notifications.append(j)
    return {"final": final, "notifications": notifications} if (final or notifications) else None

def rpc(session_id, id_, method, params=None, timeout=300):
    body = {"jsonrpc": "2.0", "id": id_, "method": method}
    if params is not None:
        body["params"] = params
    st, hdr, resp = http("POST", f"{BASE}/mcp", body,
                         {"mcp-session-id": session_id} if session_id else {}, timeout=timeout)
    parsed = extract_jsonrpc(resp)
    final = parsed.get("final") if isinstance(parsed, dict) and "final" in parsed else (parsed if isinstance(parsed, dict) else None)
    notifs = parsed.get("notifications", []) if isinstance(parsed, dict) and "notifications" in parsed else []
    return st, hdr, final, notifs

def tool_text(final):
    try:
        return final["result"]["content"][0]["text"]
    except Exception:
        return None

# ===== 1) تهيئة الجلسة =====
st, hdr, resp, _ = rpc(None, 1, "initialize", {
    "protocolVersion": "2025-03-26",
    "capabilities": {},
    "clientInfo": {"name": "e2e-test", "version": "1.0"},
})
sid = hdr.get("mcp-session-id") or hdr.get("Mcp-Session-Id") or hdr.get("MCP-Session-Id")
server_name = None
try:
    server_name = resp["result"]["serverInfo"]["name"]
except Exception:
    pass
check("initialize يرد بنجاح مع serverInfo", st == 200 and server_name == "media-generator-mcp", f"status={st} name={server_name}")
check("يُصدر mcp-session-id", bool(sid), sid or "")
rpc(sid, None, "notifications/initialized")

# ===== 2) قائمة الأدوات =====
st, hdr, resp, _ = rpc(sid, 2, "tools/list")
tools = []
try:
    tools = resp["result"]["tools"]
except Exception:
    pass
names = sorted(t["name"] for t in tools)
check("tools/list يعرض الأدوات الخمس",
      names == ["generate_image", "generate_video", "get_task", "list_media", "merge_videos"], str(names))
merge_schema = next((t["inputSchema"] for t in tools if t["name"] == "merge_videos"), {})
mprops = merge_schema.get("properties", {})
check("merge بدون resolution/fps", "resolution" not in mprops and "fps" not in mprops, str(list(mprops.keys())))
check("merge_schema يحتاج wait_seconds الافتراضي 60", merge_schema.get("properties", {}).get("wait_seconds", {}).get("default") == 60, "")
gi = next((t for t in tools if t["name"] == "generate_image"), None)
check("generate_image الإعدادات الافتراضية صحيحة (1K/90 ث)",
      bool(gi) and gi["inputSchema"]["properties"]["wait_seconds"]["default"] == 90, "")

# ===== 3) list_media قبل أي شيء =====
st, hdr, resp, _ = rpc(sid, 3, "tools/call", {"name": "list_media", "arguments": {}})
txt = tool_text(resp)
check("list_media يعمل برد عربي", bool(txt), (txt or "")[:80])

# ===== 4) تنظيف مفاتيح الاختبار السابقة ثم إضافة خاطئ أولًا ثم الصحيح (الترتيب التسلسلي) =====
st, _, body = http("GET", f"{BASE}/api/keys")
for k in (json.loads(body).get("keys", []) if body else []):
    if k["label"] in ("مفتاح اختبار خاطئ", "kie.ai الرئيسي"):
        http("DELETE", f"{BASE}/api/keys/{k['id']}")
st, _, body = http("POST", f"{BASE}/api/keys", {"provider": "kie", "api_key": FAKE_KEY, "label": "مفتاح اختبار خاطئ"})
check("إضافة المفتاح الخاطئ (201)", st == 201, f"status={st} {body[:80]}")
st, _, body = http("POST", f"{BASE}/api/keys", {"provider": "kie", "api_key": REAL_KEY, "label": "kie.ai الرئيسي"})
check("إضافة المفتاح الصحيح (201)", st == 201, f"status={st}")
st, _, body = http("POST", f"{BASE}/api/keys", {"provider": "kie", "api_key": REAL_KEY, "label": "تكرار"})
check("رفض التكرار (409)", st == 409, f"status={st} {body[:80]}")

# ===== 5) توليد صورة حقيقي — التبديل التسلسلي يعمل بصمت =====
print("--- بدء توليد الصورة (قد يستغرق حتى ~2 دقيقة) ---", flush=True)
st, hdr, resp, notifs = rpc(sid, 4, "tools/call",
    {"name": "generate_image", "arguments": {"prompt": "a tiny wooden cabin on a green hill at sunset, cozy, warm light", "wait_seconds": 120}, "_meta": {"progressToken": "tok-e2e-1"}})
txt = tool_text(resp)
progress_count = sum(1 for n in notifs if n.get("method") == "notifications/progress")
check("generate_image اكتمل برابط صورة",
      txt and "تم توليد الصورة بنجاح" in txt and "![image](" in txt, (txt or "")[:120].replace("\n", " "))
check("لم يصل العميل أي ذكر للمفاتيح أو الرصيد", txt and "مفتاح" not in txt and "رصيد" not in txt, "")
img_url = None
if txt and "الرابط المباشر: " in txt:
    img_url = txt.split("الرابط المباشر: ")[-1].strip()
if img_url:
    try:
        r = urllib.request.urlopen(urllib.request.Request(img_url, method="HEAD"), timeout=30)
        check("رابط الصورة يعمل (HEAD 200)", r.status == 200, f"status={r.status}")
    except Exception as e:
        check("رابط الصورة يعمل (HEAD 200)", False, str(e))
else:
    check("رابط الصورة يعمل (HEAD 200)", False, "لا رابط في الرد")

# ===== 6) المفتاح الخاطئ صار disabled والمحاولات مسجلة =====
st, _, body = http("GET", f"{BASE}/api/keys")
keys = json.loads(body).get("keys", []) if body else []
fake = [k for k in keys if k["label"] == "مفتاح اختبار خاطئ"]
real = [k for k in keys if k["label"] == "kie.ai الرئيسي"]
check("المفتاح الخاطئ أصبح disabled تلقائيًا", bool(fake) and fake[0]["status"] == "disabled", fake[0]["status"] if fake else "غير موجود")
check("المفتاح الصحيح نشط ونجاح ≥ 1", bool(real) and real[0]["status"] == "active" and real[0]["success_count"] >= 1, "")
check("المفاتيح مقنّعة ولا يُعاد المفتاح الكامل إطلاقًا",
      bool(keys) and all("••••" in k["masked"] for k in keys) and all("api_key" not in k for k in keys),
      str([k["masked"] for k in keys]))
st, _, body = http("GET", f"{BASE}/api/tasks?limit=5")
tasks = json.loads(body).get("tasks", [])
img_task = tasks[0] if tasks else {}
check("سجل المحاولات يوثق فشل المفتاح الخاطئ ثم النجاح", img_task.get("attempts", 0) >= 2, f"attempts={img_task.get('attempts')}")
check("بث التقدم وصل أثناء النافذة (progress notifications)", progress_count > 0, f"{progress_count} إشعار")

# ===== ملخص =====
print("\n===== الملخص =====")
ok = sum(1 for _, c, _ in results if c)
print(f"ناجح {ok}/{len(results)}")
for name, cond, extra in results:
    if not cond:
        print(f"  FAILED: {name} {extra}")
sys.exit(0 if ok == len(results) else 1)
