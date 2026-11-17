#!/usr/bin/env python3
"""Private, on-demand GitHub Actions trigger for Mi Cartera.

Run this only behind Tailscale Serve (not Funnel). It listens on loopback,
requires a Tailscale-injected identity header and a known browser origin,
and keeps the GitHub token exclusively on the Raspberry Pi.
"""

import json
import os
import stat
import threading
import time
import urllib.error
import urllib.request
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
from pathlib import Path


PORT = 8790
REPO = "Juanmaeven/mi-cartera-tickrmeter"
WORKFLOW = "update.yml"
API = f"https://api.github.com/repos/{REPO}/actions/workflows/{WORKFLOW}/dispatches"
ORIGIN = os.environ.get("CARTERA_PWA_ORIGIN", "https://juanmaeven.github.io").rstrip("/")
TAILSCALE_LOGIN = os.environ.get("CARTERA_TAILSCALE_LOGIN", "").strip().lower()
TOKEN_PATH = Path(os.environ.get("CARTERA_TOKEN_FILE", str(Path.home() / "cartera-trigger" / "github_token")))
COOLDOWN_SECONDS = 90

dispatch_lock = threading.Lock()
last_dispatch = 0.0


def read_token():
    """Reject tokens readable by other Unix users."""
    mode = stat.S_IMODE(TOKEN_PATH.stat().st_mode)
    if mode & 0o077:
        raise RuntimeError("El archivo del token debe tener permisos 600.")
    token = TOKEN_PATH.read_text(encoding="utf-8").strip()
    if not token:
        raise RuntimeError("El archivo del token está vacío.")
    return token


class Handler(BaseHTTPRequestHandler):
    server_version = "CarteraTrigger"
    sys_version = ""

    def _json(self, code, payload, cors=False):
        body = json.dumps(payload, ensure_ascii=False).encode("utf-8")
        self.send_response(code)
        self.send_header("Content-Type", "application/json; charset=utf-8")
        self.send_header("Cache-Control", "no-store")
        self.send_header("Content-Length", str(len(body)))
        if cors:
            self.send_header("Access-Control-Allow-Origin", ORIGIN)
            self.send_header("Vary", "Origin")
        self.end_headers()
        self.wfile.write(body)

    def _from_pwa(self):
        return self.headers.get("Origin", "") == ORIGIN

    def do_OPTIONS(self):
        if self.path != "/trigger" or not self._from_pwa():
            self._json(403, {"error": "Acceso denegado"})
            return
        self.send_response(204)
        self.send_header("Access-Control-Allow-Origin", ORIGIN)
        self.send_header("Access-Control-Allow-Methods", "POST, OPTIONS")
        self.send_header("Access-Control-Allow-Headers", "Content-Type, X-Cartera-Request")
        self.send_header("Access-Control-Max-Age", "300")
        self.send_header("Vary", "Origin")
        self.send_header("Cache-Control", "no-store")
        self.end_headers()

    def do_GET(self):
        if self.path == "/health":
            self._json(200, {"ready": True})
        else:
            self._json(404, {"error": "No encontrado"})

    def do_POST(self):
        global last_dispatch
        if self.path != "/trigger":
            self._json(404, {"error": "No encontrado"})
            return
        if not self._from_pwa():
            self._json(403, {"error": "Origen no autorizado"})
            return
        # Tailscale Serve strips spoofed identity headers and injects its own.
        # Requests arriving through public Funnel do NOT receive this header.
        login = self.headers.get("Tailscale-User-Login", "").strip().lower()
        if not login or login != TAILSCALE_LOGIN:
            self._json(403, {"error": "Dispositivo no autorizado"}, cors=True)
            return
        if self.headers.get("X-Cartera-Request") != "1":
            self._json(400, {"error": "Solicitud no válida"}, cors=True)
            return
        if self.headers.get("Content-Type", "").split(";")[0].strip() != "application/json":
            self._json(415, {"error": "Formato no válido"}, cors=True)
            return
        try:
            length = int(self.headers.get("Content-Length", "-1"))
        except ValueError:
            length = -1
        if length < 0 or length > 64:
            self._json(413, {"error": "Solicitud demasiado grande"}, cors=True)
            return
        try:
            if json.loads(self.rfile.read(length)) != {}:
                raise ValueError("unexpected payload")
        except (ValueError, UnicodeDecodeError):
            self._json(400, {"error": "Solicitud no válida"}, cors=True)
            return

        if not dispatch_lock.acquire(blocking=False):
            self._json(429, {"error": "Ya hay una solicitud en curso"}, cors=True)
            return
        try:
            now = time.monotonic()
            if now - last_dispatch < COOLDOWN_SECONDS:
                self._json(429, {"error": "Espera un poco antes de repetir"}, cors=True)
                return
            try:
                req = urllib.request.Request(
                    API,
                    data=b'{"ref":"main"}',
                    headers={
                        "Authorization": f"Bearer {read_token()}",
                        "Accept": "application/vnd.github+json",
                        "Content-Type": "application/json",
                        "User-Agent": "mi-cartera-private-trigger",
                        "X-GitHub-Api-Version": "2022-11-28",
                    },
                    method="POST",
                )
                with urllib.request.urlopen(req, timeout=15) as response:
                    if response.status != 204:
                        raise RuntimeError(f"Respuesta inesperada de GitHub: {response.status}")
                last_dispatch = time.monotonic()
            except (OSError, urllib.error.URLError, RuntimeError) as exc:
                # Never include the token or GitHub's error body in a response.
                print(f"No se pudo activar GitHub Actions: {type(exc).__name__}", flush=True)
                self._json(502, {"error": "GitHub no ha aceptado la solicitud"}, cors=True)
                return
            self._json(202, {"status": "accepted"}, cors=True)
        finally:
            dispatch_lock.release()


def main():
    if not TAILSCALE_LOGIN:
        raise SystemExit("Configura CARTERA_TAILSCALE_LOGIN antes de arrancar.")
    read_token()  # Fail fast if the token is missing or insecurely stored.
    httpd = ThreadingHTTPServer(("127.0.0.1", PORT), Handler)
    print(f"Cartera Trigger en 127.0.0.1:{PORT} (solo Tailscale Serve privado)", flush=True)
    httpd.serve_forever()


if __name__ == "__main__":
    main()
