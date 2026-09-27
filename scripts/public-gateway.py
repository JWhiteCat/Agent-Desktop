#!/usr/bin/env python3
"""HTTP gateway that shares one public port across Agent Desktop computers.

Listens on TCP and proxies `/c/<client-id>/...` to the Unix socket
`/run/agent-desktop/<client-id>` created by that computer's SSH reverse tunnel.
"""

from __future__ import annotations

import argparse
import os
import re
import socket
import socketserver
import sys
from http.server import BaseHTTPRequestHandler
from urllib.parse import urlsplit

CLIENT_ID = re.compile(r"^[a-f0-9]{16}$")
ROUTE = re.compile(r"^/c/([a-f0-9]{16})(/.*)?$")
MAX_BODY = 20 * 1024 * 1024
HOP = {
    "host",
    "connection",
    "keep-alive",
    "proxy-connection",
    "transfer-encoding",
    "te",
    "trailer",
    "upgrade",
    "x-agent-desktop-prefix",
}


def load_map(raw: str) -> dict[str, tuple[str, int]]:
    found: dict[str, tuple[str, int]] = {}
    for part in raw.split(","):
        part = part.strip()
        if not part:
            continue
        client_id, addr = part.split("=", 1)
        host, port = addr.rsplit(":", 1)
        if not CLIENT_ID.fullmatch(client_id):
            raise SystemExit(f"无效的电脑标识：{client_id}")
        found[client_id] = (host, int(port))
    return found


class GatewayServer(socketserver.ThreadingMixIn, socketserver.TCPServer):
    allow_reuse_address = True
    daemon_threads = True
    socket_dir = "/run/agent-desktop"
    upstream_map: dict[str, tuple[str, int]] = {}


class Handler(BaseHTTPRequestHandler):
    server: GatewayServer
    protocol_version = "HTTP/1.1"

    def do_GET(self) -> None:
        self._proxy()

    def do_POST(self) -> None:
        self._proxy()

    def do_HEAD(self) -> None:
        self._proxy()

    def _text(self, status: int, message: str) -> None:
        data = message.encode("utf-8")
        self.close_connection = True
        self.send_response(status)
        self.send_header("Content-Type", "text/plain; charset=utf-8")
        self.send_header("Content-Length", str(len(data)))
        self.send_header("Cache-Control", "no-store")
        self.send_header("Connection", "close")
        self.end_headers()
        if self.command != "HEAD":
            self.wfile.write(data)

    def _proxy(self) -> None:
        self.close_connection = True
        parsed = urlsplit(self.path)
        match = ROUTE.fullmatch(parsed.path)
        if not match:
            self._text(404, "请使用这台电脑给出的完整公网链接")
            return
        client_id, rest = match.group(1), match.group(2)
        if not rest:
            location = f"/c/{client_id}/"
            if parsed.query:
                location += "?" + parsed.query
            self.send_response(302)
            self.send_header("Location", location)
            self.send_header("Content-Length", "0")
            self.send_header("Cache-Control", "no-store")
            self.send_header("Connection", "close")
            self.end_headers()
            return

        upstream = rest if rest.startswith("/") else "/" + rest
        if parsed.query:
            upstream += "?" + parsed.query

        try:
            length = int(self.headers.get("Content-Length", "0") or "0")
        except ValueError:
            self._text(400, "Content-Length 无效")
            return
        if length < 0 or length > MAX_BODY:
            self._text(413, "请求体过大")
            return
        body = self.rfile.read(length) if length else b""

        try:
            sock = self._connect(client_id)
        except OSError:
            self._text(502, "这台电脑的公网隧道不在线")
            return

        try:
            sock.sendall(self._request(client_id, upstream) + body)
            while True:
                chunk = sock.recv(65536)
                if not chunk:
                    break
                self.wfile.write(chunk)
                self.wfile.flush()
        except (BrokenPipeError, ConnectionResetError, TimeoutError, OSError):
            pass
        finally:
            sock.close()

    def _connect(self, client_id: str) -> socket.socket:
        mapped = self.server.upstream_map.get(client_id)
        if mapped:
            host, port = mapped
            sock = socket.create_connection((host, port), timeout=5)
            sock.settimeout(None)
            return sock
        path = os.path.join(self.server.socket_dir, client_id)
        if not CLIENT_ID.fullmatch(os.path.basename(path)) or not os.path.exists(path):
            raise OSError("tunnel socket is not ready")
        sock = socket.socket(socket.AF_UNIX, socket.SOCK_STREAM)
        sock.settimeout(5)
        sock.connect(path)
        sock.settimeout(None)
        return sock

    def _request(self, client_id: str, upstream: str) -> bytes:
        lines = [
            f"{self.command} {upstream} HTTP/1.1",
            "Host: 127.0.0.1",
            "Connection: close",
            f"X-Agent-Desktop-Prefix: /c/{client_id}",
        ]
        for key in self.headers:
            if key.lower() in HOP:
                continue
            for value in self.headers.get_all(key) or []:
                lines.append(f"{key}: {value}")
        return ("\r\n".join(lines) + "\r\n\r\n").encode("iso-8859-1", "surrogateescape")

    def log_message(self, fmt: str, *args) -> None:
        sys.stderr.write("%s - %s\n" % (self.address_string(), fmt % args))


def main() -> None:
    parser = argparse.ArgumentParser()
    parser.add_argument("--port", type=int, required=True)
    parser.add_argument("--socket-dir", default="/run/agent-desktop")
    args = parser.parse_args()
    testing = os.environ.get("AGENT_DESKTOP_GATEWAY_TEST") == "1"
    if args.port == 0 and not testing:
        raise SystemExit("公网端口需在 1–65535 之间，且不能是 22")
    if not (0 <= args.port <= 65535) or args.port == 22:
        raise SystemExit("公网端口需在 1–65535 之间，且不能是 22")
    os.makedirs(args.socket_dir, exist_ok=True)
    try:
        os.chmod(args.socket_dir, 0o1777)
    except OSError:
        pass
    host = "127.0.0.1" if os.environ.get("AGENT_DESKTOP_GATEWAY_TEST") == "1" else "0.0.0.0"
    GatewayServer.socket_dir = args.socket_dir
    server = GatewayServer((host, args.port), Handler)
    server.upstream_map = load_map(os.environ.get("AGENT_DESKTOP_GATEWAY_MAP", ""))
    print(f"PORT {server.server_address[1]}", flush=True)
    try:
        server.serve_forever()
    except KeyboardInterrupt:
        server.shutdown()


if __name__ == "__main__":
    main()
