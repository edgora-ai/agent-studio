#!/usr/bin/env python3
"""OFFLINE ACP PROTOCOL TEST PEER. NOT a coding CLI; no model or network.

Exercises the real client's stdio, blocking requests and typed answers. It can
only create a new, bounded JSON receipt in its assigned cwd after allow-once.
"""
import hashlib
import json
import os
import re
import select
import signal
import sys
import time
import uuid

LABEL = "OFFLINE ACP PROTOCOL PEER — NOT A CODING CLI"
session_id = "peer-" + str(uuid.uuid4())
pending = None
buffer = b""
fragment = False


def send(frame):
    data = (json.dumps({"jsonrpc": "2.0", **frame}, ensure_ascii=False, separators=(",", ":")) + "\n").encode()
    if fragment:
        for at in range(0, len(data), 7):
            os.write(1, data[at:at + 7])
    else:
        os.write(1, data)


def response(request_id, result):
    send({"id": request_id, "result": result})


def update(text):
    send({"method": "session/update", "params": {"sessionId": session_id, "update": {"sessionUpdate": "agent_message_chunk", "content": {"type": "text", "text": text}}}})


def finish(reason="end_turn"):
    global pending
    if pending is not None:
        response(pending["id"], {"stopReason": reason})
        pending = None


def permission():
    case = pending["spec"].get("case", "approve")
    pending["phase"] = "permission"
    params = {"sessionId": session_id if case != "wrong-session" else "wrong-session", "toolCall": {"toolCallId": "peer-write-1", "title": LABEL + ": write " + pending["output"], "kind": "edit", "status": "pending"}, "options": [{"optionId": "only-this-write", "name": "Allow this write once", "kind": "allow_once"}, {"optionId": "never-this-write", "name": "Reject this write once", "kind": "reject_once"}, {"optionId": "must-not-select-always", "name": "Always (unsupported by client)", "kind": "allow_always"}]}
    send({"id": "peer-permission-1", "method": "session/request_permission", "params": params})


def form():
    pending["phase"] = "form"
    send({"id": "peer-form-1", "method": "elicitation/create", "params": {"mode": "form", "sessionId": session_id, "toolCallId": "peer-write-1", "message": "Choose the actual values to write into the peer receipt.", "requestedSchema": {"type": "object", "properties": {"color": {"type": "string", "enum": ["blue", "green"]}, "count": {"type": "integer", "minimum": 1, "maximum": 9}, "enabled": {"type": "boolean"}, "note": {"type": "string", "minLength": 1, "maxLength": 120}}, "required": ["color", "count", "enabled", "note"]}}})


def write_receipt(content):
    if pending["selected"] != "only-this-write":
        raise ValueError("unapproved write")
    receipt = {"kind": LABEL, "session_id": session_id, "prompt_rpc_id": pending["id"], "permission_rpc_id": "peer-permission-1", "selected_option": pending["selected"], "answer": content, "marker": pending["spec"].get("marker", "offline"), "pid": os.getpid(), "start_ticks": open("/proc/self/stat", encoding="utf-8").read().split(") ")[1].split()[19], "cwd": os.getcwd(), "home": os.environ["HOME"], "environment_keys": sorted(os.environ), "credential_present": "ACP_TEST_KEY" in os.environ}
    data = (json.dumps(receipt, ensure_ascii=False, sort_keys=True, indent=2) + "\n").encode()
    fd = os.open(pending["output"], os.O_CREAT | os.O_EXCL | os.O_WRONLY | os.O_NOFOLLOW, 0o600)
    with os.fdopen(fd, "wb") as stream:
        stream.write(data)
        stream.flush()
        os.fsync(stream.fileno())
    update(json.dumps({"receipt": pending["output"], "sha256": hashlib.sha256(data).hexdigest(), "bytes": len(data), "answer_used": content}, ensure_ascii=False))
    finish()


def handle(frame):
    global pending, fragment
    method = frame.get("method")
    params = frame.get("params", {})
    if method == "initialize":
        caps = params.get("clientCapabilities", {})
        if caps.get("terminal") or caps.get("fs", {}).get("readTextFile") or caps.get("fs", {}).get("writeTextFile"):
            raise ValueError("unexpected advertised callbacks")
        response(frame["id"], {"protocolVersion": 1, "agentCapabilities": {"loadSession": False, "promptCapabilities": {"image": False, "audio": False, "embeddedContext": False}}, "agentInfo": {"name": "offline-acp-protocol-peer", "version": "1.0.0"}, "authMethods": []})
    elif method == "session/new":
        if params.get("cwd") != os.getcwd() or params.get("mcpServers") != []:
            raise ValueError("binding cwd mismatch")
        response(frame["id"], {"sessionId": session_id})
    elif method == "session/prompt":
        if pending is not None or params.get("sessionId") != session_id:
            raise ValueError("session busy or mismatched")
        prompt = "".join(part["text"] for part in params["prompt"] if part["type"] == "text")
        spec = json.loads(prompt)
        output = spec.get("output", "receipt-" + str(uuid.uuid4()) + ".json")
        if not re.fullmatch(r"[a-z0-9-]{1,120}\.json", output):
            raise ValueError("output outside bounded receipt namespace")
        pending = {"id": frame["id"], "spec": spec, "output": output}
        case = spec.get("case", "approve")
        fragment = case == "fragmented"
        update(LABEL + " · running · UTF-8 分帧")
        if case == "malformed":
            os.write(1, b"{not-json}\n")
        elif case == "eof-fragment":
            os.write(1, b'{"jsonrpc":"2.0"')
            sys.exit(0)
        elif case == "exit-error":
            sys.exit(23)
        elif case == "unsupported":
            pending["phase"] = "unsupported"
            send({"id": "unsupported-fs", "method": "fs/write_text_file", "params": {"sessionId": session_id, "path": os.path.join(os.getcwd(), output), "content": "MUST NOT WRITE"}})
        elif case == "cancel":
            pending["phase"] = "waiting-cancel"
        else:
            permission()
    elif method == "session/cancel":
        if params.get("sessionId") == session_id:
            update("Peer received session/cancel; no further work.")
            finish("cancelled")
    elif method == "$/cancel_request":
        finish("cancelled")
    elif method is not None:
        send({"id": frame.get("id"), "error": {"code": -32601, "message": "Offline peer does not implement this method"}})
    elif pending is not None:
        phase = pending.get("phase")
        if phase == "unsupported":
            update("Unsupported callback response: " + json.dumps(frame.get("error")))
            finish()
        elif phase == "permission" and frame.get("id") == "peer-permission-1":
            selected = frame.get("result", {}).get("outcome", {}).get("optionId")
            pending["selected"] = selected
            update("Permission response received: " + json.dumps(frame))
            if selected != "only-this-write":
                finish("refusal")
            elif pending["spec"].get("case") == "form":
                form()
            else:
                write_receipt(None)
        elif phase == "form" and frame.get("id") == "peer-form-1":
            result = frame.get("result", {})
            if result.get("action") != "accept":
                finish("refusal")
            else:
                content = result["content"]
                if set(content) != {"color", "count", "enabled", "note"} or content["color"] not in ["blue", "green"] or type(content["count"]) is not int or not 1 <= content["count"] <= 9 or type(content["enabled"]) is not bool or not isinstance(content["note"], str) or not 1 <= len(content["note"]) <= 120:
                    raise ValueError("typed form mismatch")
                write_receipt(content)


def main():
    global buffer
    signal.alarm(170)
    deadline = time.monotonic() + 165
    while time.monotonic() < deadline:
        readable, _, _ = select.select([0], [], [], min(1, max(0, deadline - time.monotonic())))
        if not readable:
            continue
        chunk = os.read(0, 65536)
        if not chunk:
            return
        buffer += chunk
        if len(buffer) > 131072:
            raise ValueError("input bound")
        while b"\n" in buffer:
            line, buffer = buffer.split(b"\n", 1)
            handle(json.loads(line))
    raise TimeoutError("offline peer lifetime exceeded")


if __name__ == "__main__":
    try:
        main()
    except Exception as error:
        sys.stderr.write("OFFLINE_PEER_FAILED:" + type(error).__name__ + "\n")
        sys.exit(65)
