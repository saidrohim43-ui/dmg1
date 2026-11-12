#!/usr/bin/env python3
# -*- coding: utf-8 -*-
"""اختبارات الدمج: الرفض العربي (مقطع واحد/أكثر من 10/معرفات غير صالحة) + دمج e2e حقيقي."""
import json
import sys
import urllib.request
import urllib.error

BASE = "http://127.0.0.1:3000"
results = []

def check(name, cond, extra=""):
    results.append((name, bool(cond), extra))
    print(("✔" if cond else "✘") + f" {name}" + (f" — {extra}" if extra else ""), flush=True)

def http(method, url, body=None, headers=None, timeout=300):
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

def rpc(session_id, id_, method, params=None, timeout=300):
    body = {"jsonrpc": "2.0", "id": id_, "method": method}
    if params is not None:
        body["params"] = params
    st, hdr, resp = http("POST", f"{BASE}/mcp", body,
                         {"mcp-session-id": session_id} if session_id else {}, timeout=timeout)
    final = None
    for block in (resp or "").split("\n\n"):
        data = None
        for line in block.split("\n"):
            if line.startswith("data:"):
                data = line[5:].strip()
        if data:
            try:
                j = json.loads(data)
                if "result" in j or "error" in j:
                    final = j
            except Exception:
                pass
    return st, hdr, final

def tool_text(final):
    try:
        return final["result"]["content"][0]["text"]
    except Exception:
        return None

st, hdr, resp = rpc(None, 1, "initialize", {
    "protocolVersion": "2025-03-26", "capabilities": {},
    "clientInfo": {"name": "merge-e2e", "version": "1.0"},
})
sid = hdr.get("mcp-session-id") or hdr.get("MCP-Session-Id") or hdr.get("MCP-Session-Id")
rpc(sid, None, "notifications/initialized")

# 1) مقطع واحد → رفض عربي
st, hdr, resp = rpc(sid, 2, "tools/call", {"name": "merge_videos", "arguments": {"urls": ["https://test-videos.co.uk/vids/bigbuckbunny/mp4/h264/360/Big_Buck_Bunny_360_10s_1MB.mp4"]}})
txt = tool_text(resp) or ""
check("رفض مقطع واحد برسالة عربية صحيحة", "الدمج يحتاج مقطعَين على الأقل" in txt and resp.get("result", {}).get("isError") is True, txt[:100])

# 2) أكثر من 10 → رفض عربي
eleven = [f"https://example.com/clip{i}.mp4" for i in range(11)]
st, hdr, resp = rpc(sid, 3, "tools/call", {"name": "merge_videos", "arguments": {"urls": eleven}})
txt = tool_text(resp) or ""
check("رفض 11 مقطعًا برسالة عربية صحيحة", "أقصى عدد مقاطع للدمج هو 10" in txt, txt[:100])

# 3) معرف مهمة غير موجود → تفاصيل عربية
st, hdr, resp = rpc(sid, 4, "tools/call", {"name": "merge_videos", "arguments": {"task_ids": ["nonexistent-task-id"]}})
txt = tool_text(resp) or ""
check("تفاصيل المعرف غير الصالح بالعربية", "المهمة غير موجودة" in txt and "nonexistent-task-id" in txt and (resp.get("result", {}).get("isError") is True), repr(txt[:160]))

# 4) رابط غير عام → رفض
st, hdr, resp = rpc(sid, 5, "tools/call", {"name": "merge_videos", "arguments": {"urls": ["http://localhost/clip.mp4", "https://test-videos.co.uk/vids/bigbuckbunny/mp4/h264/360/Big_Buck_Bunny_360_10s_1MB.mp4"]}})
txt = tool_text(resp) or ""
check("رفض رابط غير عام", "غير صالح أو غير عام" in txt, txt[:100])

# 5) دمج حقيقي: مقطع مولّد عبر task_ids + رابط عام مباشر (حل الروابط بالترتيب)
print("--- بدء الدمج الحقيقي (قد يستغرق حتى ~200 ثانية) ---", flush=True)
video_task_id = None
st, _, body = http("GET", f"{BASE}/api/tasks?limit=10")
for t in (json.loads(body).get("tasks", []) if body else []):
    if t["type"] == "video" and t["status"] == "completed" and t["result_urls"]:
        video_task_id = t["id"]
        break
args_merge = {
    "urls": ["https://test-videos.co.uk/vids/bigbuckbunny/mp4/h264/720/Big_Buck_Bunny_720_10s_2MB.mp4"],
    "wait_seconds": 200,
}
if video_task_id:
    args_merge["task_ids"] = [video_task_id]
    print(f"اختبار حل task_ids: {video_task_id}", flush=True)
st, hdr, resp = rpc(sid, 6, "tools/call", {
    "name": "merge_videos",
    "arguments": args_merge,
    "_meta": {"progressToken": "tok-merge-1"},
}, timeout=330)
txt = tool_text(resp) or ""
# إن لم يكتمل داخل النافذة نتابع بـ get_task مثل أي عميل حقيقي
if "قيد المعالجة" in txt and "task_id: " in txt:
    mtid = txt.split("task_id: ")[-1].split()[0].strip()
    import time as _t
    for i in range(30):
        _t.sleep(10)
        st, hdr, resp = rpc(sid, 60 + i, "tools/call", {"name": "get_task", "arguments": {"task_id": mtid}}, timeout=90)
        txt = tool_text(resp) or ""
        print(f"[merge poll {i+1}] {txt[:110]}", flush=True)
        if "تم دمج المقاطع بنجاح" in txt or "فشلت المهمة" in txt:
            break
check("اكتمل الدمج بنجاح", "تم دمج المقاطع بنجاح" in txt, txt[:150].replace("\n", " "))
check("تحذير 24 ساعة موجود", "24 ساعة" in txt and "شاهده/نزّله سريعًا" in txt, "")
merge_url = None
if "الروابط المباشرة:" in txt:
    merge_url = txt.split("الروابط المباشرة:")[1].strip().splitlines()[0].strip(" -")
check("رابط الناتج على نطاق خدمة الدمج (لا نطاقات داخلية)", bool(merge_url) and "localhost" not in merge_url and "127.0.0.1" not in merge_url, merge_url or "")
if merge_url:
    try:
        r = urllib.request.urlopen(urllib.request.Request(merge_url, method="HEAD"), timeout=30)
        ctype = r.headers.get("Content-Type", "")
        check("رابط MP4 النهائي يعمل", r.status == 200 and "video" in ctype, f"status={r.status} type={ctype}")
    except Exception as e:
        check("رابط MP4 النهائي يعمل", False, str(e))

# 6) list_media يعرض المهام مرتبة من الأحدث
st, hdr, resp = rpc(sid, 7, "tools/call", {"name": "list_media", "arguments": {"limit": 10}})
txt = tool_text(resp) or ""
check("list_media يعيد المهام بروابطها", "أحدث الوسائط المخزنة" in txt and (merge_url in txt if merge_url else True), txt[:100])

ok = sum(1 for _, c, _ in results if c)
print(f"\n===== الملخص: ناجح {ok}/{len(results)} =====")
for name, cond, extra in results:
    if not cond:
        print(f"  FAILED: {name} {extra}")
sys.exit(0 if ok == len(results) else 1)
