"""OSCP 靶機作戰台 — 帶 SQLite 的自架伺服器。

只用 Python 標準庫（http.server + sqlite3），沒有任何 pip 依賴。
同時提供 web/ 靜態檔與 /api/state 讀寫，進度存進 SQLite。前端偵測到
這個 API 就會自動改用伺服器同步，換瀏覽器、清快取都不影響。
"""
import json
import mimetypes
import os
import sqlite3
import threading
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
from pathlib import Path
from urllib.parse import parse_qs, urlparse

WEB = Path(os.environ.get("OSCP_WEB", Path(__file__).resolve().parent.parent / "web"))
DB_PATH = os.environ.get("OSCP_DB", str(Path(__file__).resolve().parent / "data" / "oscp.db"))
TOKEN = os.environ.get("OSCP_TOKEN", "")
PORT = int(os.environ.get("PORT", "8731"))
MAX_BODY = 5 * 1024 * 1024

_lock = threading.Lock()
mimetypes.add_type("application/javascript", ".js")
mimetypes.add_type("application/json", ".json")


def init_db():
    Path(DB_PATH).parent.mkdir(parents=True, exist_ok=True)
    with sqlite3.connect(DB_PATH) as conn:
        conn.execute(
            "CREATE TABLE IF NOT EXISTS state ("
            "profile TEXT PRIMARY KEY, data TEXT NOT NULL, updated_at TEXT)"
        )


def read_state(profile):
    with sqlite3.connect(DB_PATH) as conn:
        row = conn.execute("SELECT data FROM state WHERE profile=?", (profile,)).fetchone()
    return json.loads(row[0]) if row else None


def write_state(profile, data):
    payload = json.dumps(data, ensure_ascii=False)
    updated = data.get("updatedAt", "") if isinstance(data, dict) else ""
    with _lock, sqlite3.connect(DB_PATH) as conn:
        conn.execute(
            "INSERT INTO state (profile, data, updated_at) VALUES (?, ?, ?) "
            "ON CONFLICT(profile) DO UPDATE SET data=excluded.data, updated_at=excluded.updated_at",
            (profile, payload, updated),
        )
    return updated


def safe_path(url_path):
    """把 URL 對映到 web/ 底下，擋掉路徑穿越。"""
    rel = urlparse(url_path).path.lstrip("/")
    if not rel:
        rel = "index.html"
    target = (WEB / rel).resolve()
    if WEB.resolve() not in target.parents and target != WEB.resolve():
        return None
    return target


class Handler(BaseHTTPRequestHandler):
    server_version = "oscp-tracker"

    def log_message(self, *args):
        pass

    def _json(self, code, obj):
        body = json.dumps(obj, ensure_ascii=False).encode("utf-8")
        self.send_response(code)
        self.send_header("Content-Type", "application/json; charset=utf-8")
        self.send_header("Content-Length", str(len(body)))
        self.end_headers()
        self.wfile.write(body)

    def _profile(self, parsed):
        q = parse_qs(parsed.query)
        return (q.get("profile", ["default"])[0] or "default")[:64]

    def _authed(self, parsed):
        if not TOKEN:
            return True
        header = self.headers.get("Authorization", "")
        if header == f"Bearer {TOKEN}":
            return True
        q = parse_qs(parsed.query)
        return q.get("token", [""])[0] == TOKEN

    def do_GET(self):
        parsed = urlparse(self.path)
        if parsed.path == "/api/health":
            return self._json(200, {"ok": True, "db": True})
        if parsed.path == "/api/state":
            if not self._authed(parsed):
                return self._json(401, {"error": "unauthorized"})
            try:
                return self._json(200, {"state": read_state(self._profile(parsed))})
            except Exception as exc:  # noqa: BLE001
                return self._json(500, {"error": str(exc)})
        return self._serve_static(parsed)

    def do_PUT(self):
        parsed = urlparse(self.path)
        if parsed.path != "/api/state":
            return self._json(404, {"error": "not found"})
        if not self._authed(parsed):
            return self._json(401, {"error": "unauthorized"})
        length = int(self.headers.get("Content-Length", "0"))
        if length <= 0 or length > MAX_BODY:
            return self._json(400, {"error": "bad body size"})
        try:
            data = json.loads(self.rfile.read(length))
            if not isinstance(data, dict) or "entries" not in data:
                raise ValueError("state 格式不符")
            updated = write_state(self._profile(parsed), data)
            return self._json(200, {"ok": True, "updatedAt": updated})
        except Exception as exc:  # noqa: BLE001
            return self._json(400, {"error": str(exc)})

    def _serve_static(self, parsed):
        target = safe_path(parsed.path)
        if target is None:
            return self._json(403, {"error": "forbidden"})
        if not target.exists() or target.is_dir():
            target = WEB / "index.html"  # SPA fallback
        try:
            body = target.read_bytes()
        except OSError:
            return self._json(404, {"error": "not found"})
        ctype = mimetypes.guess_type(str(target))[0] or "application/octet-stream"
        self.send_response(200)
        self.send_header("Content-Type", ctype)
        self.send_header("Content-Length", str(len(body)))
        if target.name == "data.js":
            self.send_header("Cache-Control", "public, max-age=86400")
        else:
            self.send_header("Cache-Control", "no-cache")
        self.end_headers()
        self.wfile.write(body)


def main():
    init_db()
    server = ThreadingHTTPServer(("0.0.0.0", PORT), Handler)
    print(f"OSCP 靶機作戰台 serving {WEB} on :{PORT} · db={DB_PATH}"
          + (" · token 已啟用" if TOKEN else ""))
    try:
        server.serve_forever()
    except KeyboardInterrupt:
        server.shutdown()


if __name__ == "__main__":
    main()
