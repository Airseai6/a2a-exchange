#!/usr/bin/env python3
"""A2A Exchange 轻客户端（纯标准库，Python 3.8+）。

不需要克隆 a2a-exchange 仓库，只需要能访问 Hub 的 HTTP 接口。
所有输出都是紧凑 JSON，方便 agent 直接读。

用法示例：
  python a2a_client.py register --agent-id w1 --name "W1 · 工作站" --skill "generic:通用协作"
  python a2a_client.py join --room lobby
  python a2a_client.py read --room lobby --since 0
  python a2a_client.py send --room lobby --text "@w1 你好"
  python a2a_client.py pending --room lobby
  python a2a_client.py watch --room lobby --timeout 120
"""

import argparse
import json
import os
import sys
import time
import urllib.error
import urllib.parse
import urllib.request

DEFAULT_HUB = os.environ.get("A2A_HUB", "http://10.1.109.206:8787")
DEFAULT_STATE = os.environ.get(
    "A2A_STATE", os.path.join(os.getcwd(), ".a2a-exchange", "agent.json")
)
TIMEOUT = float(os.environ.get("A2A_TIMEOUT", "20"))

# 统一按 UTF-8 输出，避免 Windows 控制台 GBK 把中文/JSON 弄成乱码
for _stream in (sys.stdout, sys.stderr):
    try:
        _stream.reconfigure(encoding="utf-8")
    except Exception:  # pragma: no cover - 老版本或非标准流
        pass


# ---------------------------------------------------------------- HTTP helpers
def _request(method, url, body=None, headers=None, timeout=None):
    data = None
    hdrs = {"accept": "application/json"}
    if body is not None:
        data = json.dumps(body, ensure_ascii=False).encode("utf-8")
        hdrs["content-type"] = "application/json; charset=utf-8"
    if headers:
        hdrs.update(headers)
    req = urllib.request.Request(url, data=data, headers=hdrs, method=method)
    try:
        with urllib.request.urlopen(req, timeout=timeout or TIMEOUT) as resp:
            raw = resp.read().decode("utf-8", "replace")
            return resp.status, (json.loads(raw) if raw.strip() else {})
    except urllib.error.HTTPError as exc:
        raw = exc.read().decode("utf-8", "replace")
        try:
            return exc.code, json.loads(raw)
        except ValueError:
            return exc.code, {"raw": raw}


def _rpc(hub, method, params, token=None):
    headers = {}
    if token:
        headers["authorization"] = "Bearer " + token
    status, payload = _request(
        "POST", hub.rstrip("/") + "/a2a",
        {"jsonrpc": "2.0", "id": 1, "method": method, "params": params}, headers,
    )
    if status != 200:
        raise SystemExit("hub HTTP %s: %s" % (status, json.dumps(payload, ensure_ascii=False)))
    if "error" in payload:
        raise SystemExit("hub error: " + json.dumps(payload["error"], ensure_ascii=False))
    return payload.get("result")


def _agent_headers(state):
    token = state.get("token")
    headers = {"x-agent-token": token} if token else {}
    return headers


def _api(state, method, path, body=None):
    hub = state.get("hub") or DEFAULT_HUB
    status, payload = _request(
        method, hub.rstrip("/") + path, body, _agent_headers(state)
    )
    if status == 401:
        raise SystemExit(
            "401 Unauthenticated：agent token 无效或 Hub 设置了 A2A_TOKEN。"
            "请重新 register（并确认 --hub 与本机 state 文件一致）。"
        )
    if status >= 400:
        raise SystemExit("hub HTTP %s: %s" % (status, json.dumps(payload, ensure_ascii=False)))
    return payload


# ---------------------------------------------------------------- state
def load_state(path, hub=None, agent_id=None):
    state = {"hub": hub or DEFAULT_HUB, "agentId": agent_id, "token": None}
    if path and os.path.isfile(path):
        try:
            with open(path, "r", encoding="utf-8") as fh:
                state.update(json.load(fh) or {})
        except ValueError:
            pass
    if hub:
        state["hub"] = hub
    if agent_id:
        state["agentId"] = agent_id
    return state


def save_state(path, state):
    directory = os.path.dirname(os.path.abspath(path))
    if directory:
        os.makedirs(directory, exist_ok=True)
    with open(path, "w", encoding="utf-8") as fh:
        json.dump(state, fh, ensure_ascii=False, indent=2)
    return path


def require_agent(state):
    if not state.get("agentId"):
        raise SystemExit("当前 state 里没有 agentId，先运行 register。")
    return state["agentId"]


# ---------------------------------------------------------------- commands
def cmd_register(args, state):
    skills = []
    for entry in args.skill or []:
        sid, _, desc = entry.partition(":")
        skills.append({"id": (sid or "generic").strip(), "name": (desc or sid).strip(),
                       "description": (desc or sid).strip()})
    agent_id = getattr(args, "reg_agent_id", None) or args.agent_id
    if not agent_id:
        raise SystemExit("register 需要 --agent-id（例如 --agent-id w1）")
    params = {
        "agentId": agent_id,
        "name": args.name or agent_id,
        "description": args.description or "A2A Exchange LAN agent",
        "skills": skills or [{"id": "generic", "name": "通用协作", "description": "通用协作"}],
    }
    if args.workspace:
        params["workspace"] = args.workspace
    if args.session:
        params["sessionId"] = args.session
    hub = args.hub or DEFAULT_HUB
    result = _rpc(hub, "exchange/register", params)
    state.update({
        "hub": hub, "agentId": result["agentId"],
        "token": result.get("token"), "name": params["name"],
    })
    path = save_state(args.state, state)
    return {"ok": True, "agentId": state["agentId"], "hub": state["hub"],
            "state": path, "tokenSaved": bool(state["token"])}


def cmd_whoami(args, state):
    return {"hub": state.get("hub"), "agentId": state.get("agentId"),
            "hasToken": bool(state.get("token")), "state": os.path.abspath(args.state)}


def cmd_room_create(args, state):
    body = {"roomId": args.room, "name": args.name or args.room, "description": args.description or ""}
    payload = _api(state, "POST", "/api/rooms", body)
    room = payload.get("room") or {}
    return {"ok": True, "roomId": room.get("id"), "name": room.get("name")}


def cmd_join(args, state):
    agent_id = require_agent(state)
    payload = _api(state, "POST", "/api/rooms/%s/join" % urllib.parse.quote(args.room),
                   {"agentId": agent_id})
    # 进房即回放最近消息：Hub 没有推送，不主动读就等于没进房间
    room = payload.get("room", {})
    history = _api(state, "GET", "/api/rooms/%s?since=0&limit=%d" % (
        urllib.parse.quote(args.room), args.limit))
    recent = []
    for msg in history.get("messages") or []:
        sender = msg.get("sender") or {}
        recent.append({
            "seq": msg.get("seq"),
            "from": sender.get("name") or sender.get("agentId") or sender.get("kind"),
            "kind": sender.get("kind"),
            "text": msg.get("text"),
            "time": msg.get("time"),
        })
    return {"ok": True, "room": args.room, "roomName": room.get("name"),
            "agentId": agent_id, "lastSeq": history.get("lastSeq"),
            "historyCount": len(recent), "history": recent,
            "next": "之后用 read --since <lastSeq> 或 watch 继续拉取；Hub 不会推送"}


def cmd_read(args, state):
    query = "?since=%d&limit=%d" % (args.since or 0, args.limit or 200)
    payload = _api(state, "GET", "/api/rooms/%s%s" % (urllib.parse.quote(args.room), query))
    messages = payload.get("messages") or []
    agent_id = state.get("agentId") or ""
    out = []
    for msg in messages:
        sender = msg.get("sender") or {}
        text = msg.get("text") or ""
        if args.mentions and agent_id and ("@" + agent_id) not in text:
            continue
        out.append({
            "seq": msg.get("seq"),
            "from": sender.get("name") or sender.get("agentId") or sender.get("kind"),
            "kind": sender.get("kind"),
            "type": msg.get("type"),
            "text": text,
            "time": msg.get("time"),
        })
    if args.json:
        return payload
    return {"room": args.room, "lastSeq": payload.get("lastSeq"),
            "count": len(out), "messages": out}


def cmd_send(args, state):
    agent_id = require_agent(state)
    body = {"agentId": agent_id, "text": args.text, "type": args.type or "chat"}
    payload = _api(state, "POST", "/api/rooms/%s/agent-messages" % urllib.parse.quote(args.room), body)
    message = payload.get("message") or {}
    return {"ok": True, "room": args.room, "seq": message.get("seq"), "from": agent_id}


def cmd_pending(args, state):
    agent_id = require_agent(state)
    path = "/api/rooms/%s/pending?agentId=%s" % (
        urllib.parse.quote(args.room), urllib.parse.quote(agent_id))
    return _api(state, "GET", path)


def cmd_ack(args, state):
    agent_id = require_agent(state)
    body = {"agentId": agent_id}
    if args.seq is not None:
        body["seq"] = args.seq
    return _api(state, "POST", "/api/rooms/%s/ack" % urllib.parse.quote(args.room), body)


def cmd_watch(args, state):
    agent_id = require_agent(state)
    deadline = time.time() + (args.timeout or 120)
    while True:
        pending = cmd_pending(args, state)
        if pending.get("pendingCount"):
            return {"room": args.room, "agentId": agent_id,
                    "pendingCount": pending.get("pendingCount"),
                    "pendingForMe": pending.get("pendingForMe"), "lastSeq": pending.get("lastSeq")}
        if time.time() >= deadline:
            return {"room": args.room, "agentId": agent_id, "timeout": True,
                    "waitedSeconds": args.timeout}
        time.sleep(max(1.0, float(args.interval or 5)))


def cmd_doctor(args, state):
    """连接自检：Hub 可达? state 完整? token 有效? 房间可用? 一次说清。"""
    hub = state.get("hub") or DEFAULT_HUB
    checks = []
    result = {"hub": hub, "checks": checks}

    try:
        status, hz = _request("GET", hub.rstrip("/") + "/healthz")
        good = status == 200 and bool(hz.get("ok"))
        checks.append({"check": "hub-reachable", "ok": good, "status": status,
                       "version": hz.get("version"), "protocol": hz.get("protocolVersion")})
        if not good:
            result["verdict"] = "hub-unreachable"
            return result
    except Exception as exc:  # noqa: BLE001 - 网络层什么都可能抛
        checks.append({"check": "hub-reachable", "ok": False, "error": str(exc)[:200]})
        result["verdict"] = "hub-unreachable"
        return result

    agent_id = state.get("agentId")
    checks.append({"check": "state", "ok": bool(agent_id and state.get("token")),
                   "agentId": agent_id, "hasToken": bool(state.get("token")),
                   "state": os.path.abspath(args.state)})
    if not (agent_id and state.get("token")):
        result["verdict"] = "register-needed"
        return result

    try:
        hb = _rpc(hub, "exchange/heartbeat", {"agentId": agent_id}, state.get("token"))
        checks.append({"check": "agent-token", "ok": True,
                       "status": hb.get("status"), "expiresAt": hb.get("expiresAt")})
    except SystemExit as exc:
        checks.append({"check": "agent-token", "ok": False, "error": str(exc)[:200]})
        result["verdict"] = "token-invalid"
        return result

    if args.room:
        path = "/api/rooms/%s/pending?agentId=%s" % (
            urllib.parse.quote(args.room), urllib.parse.quote(agent_id))
        try:
            pend = _api(state, "GET", path)
            checks.append({"check": "room", "ok": True, "room": args.room,
                           "lastSeq": pend.get("lastSeq"), "pendingCount": pend.get("pendingCount"),
                           "lastAckSeq": pend.get("lastAckSeq")})
            result["next"] = args.client_cmd + " --room %s read --since %s" % (
                args.room, pend.get("since") or 0)
        except SystemExit as exc:
            checks.append({"check": "room", "ok": False, "room": args.room, "error": str(exc)[:200]})
            result["verdict"] = "room-failed"
            return result

    result["verdict"] = "ok"
    return result


def cmd_heartbeat(args, state):
    agent_id = require_agent(state)
    hub = state.get("hub") or DEFAULT_HUB
    return _rpc(hub, "exchange/heartbeat", {"agentId": agent_id}, state.get("token"))


def cmd_tasks(args, state):
    payload = _api(state, "GET", "/api/rooms/%s/tasks" % urllib.parse.quote(args.room))
    tasks = []
    for task in payload.get("tasks") or []:
        tasks.append({k: task.get(k) for k in
                      ("taskId", "title", "status", "assignee", "verifier", "branch", "commit", "summary")})
    return {"room": args.room, "tasks": tasks}


def cmd_task_create(args, state):
    body = {"title": args.title, "detail": args.detail or "", "acceptance": args.acceptance or "",
            "assignee": args.assignee, "verifier": args.verifier,
            "branch": args.branch, "commit": args.commit, "summary": args.summary}
    body = {k: v for k, v in body.items() if v}
    payload = _api(state, "POST", "/api/rooms/%s/tasks" % urllib.parse.quote(args.room), body)
    task = payload.get("task") or {}
    return {"ok": True, "taskId": task.get("taskId"), "title": task.get("title"),
            "status": task.get("status"), "assignee": task.get("assignee")}


def cmd_task_action(args, state):
    body = {}
    if args.note:
        body["note"] = args.note
    if args.pass_flag:
        body["pass"] = True
    if args.fail_flag:
        body["pass"] = False
    path = "/api/rooms/%s/tasks/%s/%s" % (
        urllib.parse.quote(args.room), urllib.parse.quote(args.task), urllib.parse.quote(args.action))
    payload = _api(state, "POST", path, body)
    task = payload.get("task") or {}
    return {"ok": True, "taskId": task.get("taskId"), "status": task.get("status")}


# ---------------------------------------------------------------- CLI
def build_parser():
    parser = argparse.ArgumentParser(description="A2A Exchange LAN client (stdlib only)")
    parser.add_argument("--hub", default=None, help="Hub base URL，默认 %s" % DEFAULT_HUB)
    parser.add_argument("--state", default=DEFAULT_STATE, help="state 文件，默认 %s" % DEFAULT_STATE)
    parser.add_argument("--agent-id", default=None, help="覆盖 state 里的 agentId")
    sub = parser.add_subparsers(dest="command", required=True)

    p = sub.add_parser("register", help="注册本 agent（会打印/保存 token）")
    p.add_argument("--agent-id", dest="reg_agent_id", default=None)
    p.add_argument("--name", default=None)
    p.add_argument("--description", default=None)
    p.add_argument("--skill", action="append", help="id:说明，可重复")
    p.add_argument("--workspace", default=None)
    p.add_argument("--session", default=None)
    p.set_defaults(func=cmd_register)

    p = sub.add_parser("whoami", help="查看当前 state")
    p.set_defaults(func=cmd_whoami)

    p = sub.add_parser("room-create", help="新建房间（id 只能是 a-z0-9._-，显示名可中文）")
    p.add_argument("--room", dest="room", default="lobby", help="房间 id，小写字母/数字/._-")
    p.add_argument("--name", default=None, help="显示名，可中文")
    p.add_argument("--description", default=None)
    p.set_defaults(func=cmd_room_create)

    p = sub.add_parser("join", help="加入房间（会顺带回放最近消息）")
    p.add_argument("--room", default="lobby")
    p.add_argument("--limit", type=int, default=20, help="回放最近多少条，默认 20")
    p.set_defaults(func=cmd_join)

    p = sub.add_parser("read", help="读房间消息")
    p.add_argument("--room", default="lobby")
    p.add_argument("--since", type=int, default=0)
    p.add_argument("--limit", type=int, default=50)
    p.add_argument("--mentions", action="store_true", help="只看 @ 我的")
    p.add_argument("--json", action="store_true", help="输出原始 JSON")
    p.set_defaults(func=cmd_read)

    p = sub.add_parser("send", help="在房间发言")
    p.add_argument("--room", default="lobby")
    p.add_argument("--text", required=True)
    p.add_argument("--type", default="chat", choices=["chat", "progress", "verify"])
    p.set_defaults(func=cmd_send)

    p = sub.add_parser("pending", help="@ 我但未读的消息")
    p.add_argument("--room", default="lobby")
    p.set_defaults(func=cmd_pending)

    p = sub.add_parser("ack", help="标记已读")
    p.add_argument("--room", default="lobby")
    p.add_argument("--seq", type=int, default=None)
    p.set_defaults(func=cmd_ack)

    p = sub.add_parser("watch", help="阻塞等待 @ 我的消息（轮询）")
    p.add_argument("--room", default="lobby")
    p.add_argument("--timeout", type=int, default=120)
    p.add_argument("--interval", type=float, default=5)
    p.set_defaults(func=cmd_watch)

    p = sub.add_parser("doctor", help="连接自检：Hub 可达 / token 有效 / 房间可用")
    p.add_argument("--room", default=None, help="可选：顺便检查这个房间")
    p.set_defaults(func=cmd_doctor)

    p = sub.add_parser("heartbeat", help="心跳，保持在线")
    p.set_defaults(func=cmd_heartbeat)

    p = sub.add_parser("tasks", help="任务板列表")
    p.add_argument("--room", default="lobby")
    p.set_defaults(func=cmd_tasks)

    p = sub.add_parser("task-create", help="新建任务卡")
    p.add_argument("--room", default="lobby")
    p.add_argument("--title", required=True)
    p.add_argument("--detail", default=None)
    p.add_argument("--acceptance", default=None)
    p.add_argument("--assignee", default=None)
    p.add_argument("--verifier", default=None)
    p.add_argument("--branch", default=None)
    p.add_argument("--commit", default=None)
    p.add_argument("--summary", default=None)
    p.set_defaults(func=cmd_task_create)

    p = sub.add_parser("task-action", help="推进任务状态")
    p.add_argument("--room", default="lobby")
    p.add_argument("--task", required=True)
    p.add_argument("--action", required=True,
                   choices=["claim", "resolve", "verify", "reopen", "close", "assign", "update"])
    p.add_argument("--note", default=None)
    p.add_argument("--pass", dest="pass_flag", action="store_true")
    p.add_argument("--fail", dest="fail_flag", action="store_true")
    p.set_defaults(func=cmd_task_action)

    return parser


def main(argv=None):
    args = build_parser().parse_args(argv)
    state = load_state(args.state, hub=args.hub, agent_id=args.agent_id)
    args.client_cmd = "python " + os.path.basename(sys.argv[0] or "a2a_client.py")
    result = args.func(args, state)
    sys.stdout.write(json.dumps(result, ensure_ascii=False) + "\n")
    return 0


if __name__ == "__main__":
    sys.exit(main())
