#!/usr/bin/env python3
# -*- coding: utf-8 -*-
"""اختبار الدمج عبر خدمة الدمج الإنتاجية الحية (dmg1.vercel.app) — معيار القبول رقم 8 بحقنه."""
import json
import sys
import time
import urllib.request
import urllib.error

BASE = "http://127.0.0.1:3000"
results = []

def check(name, cond, extra=""):
    results.append((name, bool(cond), extra))
    print(("✔" if cond else "✘") + f" {name}" + (f" — {extra}" if extra else ""), flush=True)

def rpc(session_id, id_, method, params=None, timeout=330):
    body = {"jsonrpc": "2.0", "id": id_, "method": method}
    if params is not None:
        body["params"] = params
    data = json.dumps(body).encode()
    req = urllib.request.Request(f"{BASE}/mcp", data=data, method="POST")
    req.add_header("Content-Type", "application/json")
    req.add_header("Accept", "application/json, text/event-stream")
    if session_id:
        req.add_header("mcp-session-id", session_id)
    try:
        r = urllib.request.urlopen(req, timeout=timeout)
        hdr = dict(r.headers)
        resp = r.read().decode()
    except urllib.error.HTTPError as e:
        hdr = dict(e.headers or {})
        resp = e.read().decode()
    final = None
    for block in (resp or "").split("\n\n"):
        d = None
        for line in block.split("\n"):
            if line.startswith("data:"):
                d = line[5:].strip()
        if d:
            try:
                j = json.loads(d)
                if "result" in j or "error" in j:
                    final = j
            except Exception:
                pass
    return hdr, final

def tool_text(final):
    try:
        return final["result"]["content"][0]["text"]
    except Exception:
        return None

hdr, resp = rpc(None, 1, "initialize", {
    "protocolVersion": "2025-03-26", "capabilities": {},
    "clientInfo": {"name": "live-merge-test", "version": "1.0"},
})
sid = hdr.get("mcp-session-id")
rpc(sid, None, "notifications/initialized")

print("--- دمج حقيقي عبر الخدمة الإنتاجية dmg1.vercel.app ---", flush=True)
hdr, resp = rpc(sid, 2, "tools/call", {
    "name": "merge_videos",
    "arguments": {
        "urls": [
            "https://test-videos.co.uk/vids/bigbuckbunny/mp4/h264/360/Big_Buck_Bunny_360_10s_1MB.mp4",
            "https://test-videos.co.uk/vids/bigbuckbunny/mp4/h264/720/Big_Buck_Bunny_720_10s_2MB.mp4",
        ],
        "wait_seconds": 200,
    },
}, timeout=330)
txt = tool_text(resp) or ""
if "قيد المعالجة" in txt and "task_id: " in txt:
    mtid = txt.split("task_id: ")[-1].split()[0].strip()
    for i in range(30):
        time.sleep(10)
        hdr, resp = rpc(sid, 10 + i, "tools/call", {"name": "get_task", "arguments": {"task_id": mtid}}, timeout=90)
        txt = tool_text(resp) or ""
        print(f"[poll {i+1}] {txt[:120]}", flush=True)
        if "تم دمج المقاطع بنجاح" in txt or "فشلت المهمة" in txt:
            break

check("اكتمل الدمج بنجاح عبر الخدمة الحية", "تم دمج المقاطع بنجاح" in txt, txt[:130].replace("\n", " "))
check("تحذير 24 ساعة موجود", "24 ساعة" in txt, "")
url = None
if "الروابط المباشرة:" in txt:
    url = txt.split("الروابط المباشرة:")[1].strip().splitlines()[0].strip(" -")
check("الرابط على نطاق الخدمة الإنتاجية العام (لا نطاقات داخلية)", bool(url) and "dmg1.vercel.app" in url and "localhost" not in url and "127.0.0.1" not in url, url or "")
if url:
    try:
        r = urllib.request.urlopen(urllib.request.Request(url, method="HEAD"), timeout=30)
        check("رابط MP4 النهائي يعمل ويُشغَّل", r.status == 200 and "video" in r.headers.get("Content-Type", ""),
              f"status={r.status} type={r.headers.get('Content-Type')}")
    except Exception as e:
        check("رابط MP4 النهائي يعمل ويُشغَّل", False, str(e))

ok = sum(1 for _, c, _ in results if c)
print(f"\n===== ناجح {ok}/{len(results)} =====")
sys.exit(0 if ok == len(results) else 1)
