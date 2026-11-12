#!/usr/bin/env python3
# -*- coding: utf-8 -*-
"""اختبار e2e لتوليد الفيديو: إنشاء → task_id → متابعة get_task كل 10 ثوانٍ حتى الاكتمال."""
import json
import sys
import time
import urllib.request
import urllib.error

BASE = "http://127.0.0.1:3000"
OUT = "/tmp/video-e2e.json"

def http(method, url, body=None, headers=None, timeout=320):
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

def rpc(session_id, id_, method, params=None, timeout=320):
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
    "clientInfo": {"name": "video-e2e", "version": "1.0"},
})
sid = hdr.get("mcp-session-id") or hdr.get("Mcp-Session-Id") or hdr.get("MCP-Session-Id")
rpc(sid, None, "notifications/initialized")

st, hdr, resp = rpc(sid, 2, "tools/call", {
    "name": "generate_video",
    "arguments": {"prompt": "a red balloon floating up into a clear blue sky, gentle breeze, cinematic", "duration": 8, "wait_seconds": 25},
    "_meta": {"progressToken": "tok-video-1"},
}, timeout=120)
txt = tool_text(resp) or ""
print("الرد الأول:", txt[:200], flush=True)

task_id = None
if "task_id: " in txt:
    task_id = txt.split("task_id: ")[-1].split()[0].strip()

url = None
ok = False
deadline = time.time() + 600
polls = 0
while time.time() < deadline:
    if "تم توليد الفيديو بنجاح" in txt:
        ok = True
        if "الروابط المباشرة:" in txt:
            url = txt.split("الروابط المباشرة:")[1].strip().splitlines()[0].strip(" -")
        break
    if "فشلت المهمة" in txt:
        break
    if not task_id and "task_id: " in txt:
        task_id = txt.split("task_id: ")[-1].split()[0].strip()
    if not task_id:
        break
    time.sleep(10)
    polls += 1
    st, hdr, resp = rpc(sid, 10 + polls, "tools/call", {"name": "get_task", "arguments": {"task_id": task_id}}, timeout=90)
    txt = tool_text(resp) or ""
    print(f"[poll {polls}] {txt[:150]}", flush=True)

result = {"ok": ok, "task_id": task_id, "url": url, "text": txt, "polls": polls}
with open(OUT, "w") as f:
    json.dump(result, f, ensure_ascii=False)
print("النتيجة:", json.dumps(result, ensure_ascii=False)[:400], flush=True)
