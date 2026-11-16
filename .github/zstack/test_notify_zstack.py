"""Offline checks for the zstack main-push sender. Does not call the webhook."""

from __future__ import annotations

import http.server
import io
import json
import os
import re
import subprocess
import sys
import threading
import unittest
import urllib.error
import urllib.request
from pathlib import Path

HERE = Path(__file__).resolve().parent
ROOT = HERE.parents[1]
sys.path.insert(0, str(HERE))

import notify_zstack as notify  # noqa: E402

SHA = "0123456789abcdef0123456789abcdef01234567"
REPO = "haoz0206/grok-bot-cli"
REF = "refs/heads/main"
URL = "https://api2.cursor.sh/automations/webhook/example-webhook-id"
KEY = "test-sender-key-do-not-log"
URL_TOKEN = "UniqueUrlTokenDoNotLog"
KEY_TOKEN = "UniqueKeyTokenDoNotLog"
BODY_TOKEN = "response-body-do-not-log"
WORKFLOW = ROOT / ".github" / "workflows" / "zstack-main-push.yml"


class FakeResponse:
    def __init__(self, status=200):
        self.status = status
        self.code = status
        self.read_called = False

    def read(self, *args, **kwargs):
        self.read_called = True
        return BODY_TOKEN.encode("ascii")

    def getcode(self):
        return self.status

    def close(self):
        return None

    def __enter__(self):
        return self

    def __exit__(self, exc_type, exc, tb):
        return False


class FakeOpener:
    def __init__(self, result):
        self.result = result
        self.calls = 0
        self.request = None
        self.timeout = None

    def open(self, request, timeout=None):
        self.calls += 1
        self.request = request
        self.timeout = timeout
        if isinstance(self.result, BaseException):
            raise self.result
        return self.result


class QuietHandler(http.server.BaseHTTPRequestHandler):
    protocol_version = "HTTP/1.1"

    def _read(self):
        length = int(self.headers.get("Content-Length", "0") or "0")
        return self.rfile.read(length) if length else b""

    def _record(self, method, body):
        self.server.hits.append(
            {
                "method": method,
                "path": self.path,
                "body": body,
                "authorization": self.headers.get("Authorization"),
                "automation_key": self.headers.get("X-Automation-Key"),
                "content_type": self.headers.get("Content-Type"),
            }
        )

    def do_POST(self):
        body = self._read()
        self._record("POST", body)
        self._reply()

    def do_GET(self):
        self._record("GET", b"")
        self._reply()

    def _reply(self):
        spec = self.server.spec
        payload = spec.get("payload", b"")
        self.send_response(spec["code"])
        location = spec.get("location")
        if location:
            self.send_header("Location", location)
        self.send_header("Content-Type", "text/plain")
        self.send_header("Content-Length", str(len(payload)))
        self.send_header("Connection", "close")
        self.end_headers()
        if payload:
            self.wfile.write(payload)

    def log_message(self, fmt, *args):
        return None


class LocalWebhook(threading.Thread):
    def __init__(self, code, payload=b"", location_path=None):
        super().__init__(daemon=True)
        self.server = http.server.ThreadingHTTPServer(("127.0.0.1", 0), QuietHandler)
        self.server.daemon_threads = True
        self.server.hits = []
        port = self.server.server_address[1]
        spec = {"code": code, "payload": payload}
        if location_path:
            spec["location"] = f"http://127.0.0.1:{port}{location_path}"
        self.server.spec = spec
        self.url = f"http://127.0.0.1:{port}/wake"

    def run(self):
        self.server.serve_forever()

    def close(self):
        self.server.shutdown()
        self.server.server_close()


def event_env(**overrides):
    env = {
        "ZSTACK_WEBHOOK_URL": URL,
        "ZSTACK_WEBHOOK_KEY": KEY,
        "ZSTACK_REPOSITORY": REPO,
        "ZSTACK_REF": REF,
        "ZSTACK_SHA": SHA,
    }
    env.update(overrides)
    return env


def embedded_workflow_script(text):
    match = re.search(r"<<'PY'\n(.*)\n[ \t]*PY\n", text, re.S)
    if match is None:
        raise AssertionError("quoted Python heredoc not found")
    lines = match.group(1).split("\n")
    indents = [
        len(line) - len(line.lstrip(" "))
        for line in lines
        if line.strip() != ""
    ]
    indent = min(indents) if indents else 0
    dedented = []
    for line in lines:
        if line.strip() == "":
            dedented.append("")
            continue
        if not line.startswith(" " * indent):
            raise AssertionError("heredoc indentation is inconsistent")
        dedented.append(line[indent:])
    return "\n".join(dedented) + "\n"


class NotifyTests(unittest.TestCase):
    def test_serialization_is_exact_object(self):
        body = notify.build_body(REPO, REF, SHA)
        self.assertEqual(
            body,
            (
                '{"repository":"haoz0206/grok-bot-cli","ref":"refs/heads/main",'
                '"sha":"0123456789abcdef0123456789abcdef01234567"}'
            ).encode("ascii"),
        )
        self.assertEqual(
            list(json.loads(body.decode("ascii"))),
            ["repository", "ref", "sha"],
        )

    def test_event_fields_reject_unexpected_values_without_echoing_them(self):
        secretish = "X-Token-do-not-echo"
        with self.assertRaises(notify.NotifyError) as caught:
            notify.build_body("owner/name\n" + secretish, REF, SHA)
        self.assertNotIn(secretish, str(caught.exception))
        with self.assertRaises(notify.NotifyError) as caught:
            notify.build_body(REPO, "refs/heads/other", SHA)
        self.assertNotIn("other", str(caught.exception))
        with self.assertRaises(notify.NotifyError):
            notify.build_body(REPO, REF, "A" * 40)
        with self.assertRaises(notify.NotifyError):
            notify.build_body(REPO, REF, SHA + "aa")

    def test_all_zero_sha_is_rejected_before_send(self):
        zeros = "0" * 40
        with self.assertRaises(notify.NotifyError) as caught:
            notify.build_body(REPO, REF, zeros)
        self.assertIn("40 zeros", str(caught.exception))
        opener = FakeOpener(FakeResponse())
        with self.assertRaises(notify.NotifyError) as caught:
            notify.send(REPO, REF, zeros, URL, KEY, opener=opener)
        self.assertIn("40 zeros", str(caught.exception))
        self.assertEqual(opener.calls, 0)

    def test_allowed_urls(self):
        samples = [
            URL,
            "https://api2.cursor.sh/automations/webhook/"
            "01234567-89ab-4cde-8fab-0123456789ab",
            "https://api2.cursor.sh/automations/webhook/Abc_123-xyz",
        ]
        for sample in samples:
            self.assertEqual(notify.validate_webhook_url(sample), sample)

    def test_rejected_urls_do_not_echo_the_value(self):
        samples = [
            "",
            "   ",
            "http://api2.cursor.sh/automations/webhook/example-webhook-id",
            "https://api2.cursor.sh.evil.example/automations/webhook/example-webhook-id",
            "https://evil.example/automations/webhook/example-webhook-id",
            "https://user:pass@api2.cursor.sh/automations/webhook/example-webhook-id",
            "https://api2.cursor.sh:443/automations/webhook/example-webhook-id",
            URL + "?x=1",
            URL + "#frag",
            URL + "/extra",
            URL + "/",
            "https://api2.cursor.sh/automations/webhook/abc%2e123",
            "https://api2.cursor.sh/automations/webhook/../example-webhook-id",
            "https://API2.cursor.sh/automations/webhook/example-webhook-id",
            "file:///etc/passwd",
            "https://127.0.0.1/automations/webhook/example-webhook-id",
            URL + "\nhttps://evil.example",
            "https://api2.cursor.sh/automations/other/example-webhook-id",
            "https://" + URL_TOKEN + ".example/automations/webhook/abc",
        ]
        for sample in samples:
            with self.assertRaises(notify.NotifyError) as caught:
                notify.validate_webhook_url(sample)
            text = str(caught.exception)
            self.assertNotIn(URL_TOKEN, text)
            self.assertNotIn("pass@", text)
            if sample.strip():
                self.assertNotIn(sample.strip(), text)

    def test_missing_env_names_the_gap_and_hides_the_key(self):
        env = event_env()
        del env["ZSTACK_WEBHOOK_URL"]
        env["ZSTACK_WEBHOOK_KEY"] = KEY_TOKEN
        with self.assertRaises(notify.NotifyError) as caught:
            notify.main(env, opener=FakeOpener(FakeResponse()))
        text = str(caught.exception)
        self.assertIn("ZSTACK_WEBHOOK_URL", text)
        self.assertIn("Settings", text)
        self.assertIn("grok-bot-cli-main-sync", text)
        self.assertNotIn("skills-main-sync", text)
        self.assertNotIn(KEY_TOKEN, text)

        with self.assertRaises(notify.NotifyError) as caught:
            notify.main({}, opener=FakeOpener(FakeResponse()))
        text = str(caught.exception)
        for name in (
            "ZSTACK_WEBHOOK_URL",
            "ZSTACK_WEBHOOK_KEY",
            "ZSTACK_REPOSITORY",
            "ZSTACK_REF",
            "ZSTACK_SHA",
        ):
            self.assertIn(name, text)
        self.assertNotIn(KEY_TOKEN, text)

    def test_blank_key_is_rejected_without_echo(self):
        with self.assertRaises(notify.NotifyError) as caught:
            notify.validate_key("  " + KEY_TOKEN + "\n")
        self.assertNotIn(KEY_TOKEN, str(caught.exception))
        with self.assertRaises(notify.NotifyError):
            notify.validate_key("")

    def test_success_posts_once_with_both_headers_and_no_body_read(self):
        response = FakeResponse(200)
        opener = FakeOpener(response)
        message = notify.main(event_env(), opener=opener)
        self.assertEqual(opener.calls, 1)
        self.assertEqual(opener.timeout, 8)
        self.assertFalse(response.read_called)
        self.assertNotIn(KEY, message)
        self.assertNotIn("example-webhook-id", message)
        self.assertIn("HTTP 200", message)
        self.assertIn("not completed synchronization", message)
        request = opener.request
        self.assertEqual(request.get_method(), "POST")
        self.assertEqual(request.full_url, URL)
        self.assertEqual(request.data, notify.build_body(REPO, REF, SHA))
        self.assertEqual(request.get_header("Content-type"), "application/json")
        self.assertEqual(request.get_header("Authorization"), "Bearer " + KEY)
        self.assertEqual(request.get_header("X-automation-key"), KEY)

    def test_non_200_and_http_error_do_not_retry_or_log_secrets(self):
        response = FakeResponse(503)
        opener = FakeOpener(response)
        with self.assertRaises(notify.NotifyError) as caught:
            notify.send(REPO, REF, SHA, URL, KEY_TOKEN, opener=opener)
        self.assertEqual(opener.calls, 1)
        self.assertFalse(response.read_called)
        self.assertIn("HTTP 503", str(caught.exception))
        self.assertIn("not retried", str(caught.exception))
        self.assertNotIn(KEY_TOKEN, str(caught.exception))

        error = urllib.error.HTTPError(
            URL,
            401,
            BODY_TOKEN,
            hdrs=None,
            fp=io.BytesIO(BODY_TOKEN.encode("ascii")),
        )
        opener = FakeOpener(error)
        with self.assertRaises(notify.NotifyError) as caught:
            notify.send(REPO, REF, SHA, URL, KEY_TOKEN, opener=opener)
        self.assertEqual(opener.calls, 1)
        text = str(caught.exception)
        self.assertIn("HTTP 401", text)
        self.assertNotIn(BODY_TOKEN, text)
        self.assertNotIn(KEY_TOKEN, text)
        self.assertNotIn("example-webhook-id", text)

    def test_timeout_and_transport_error_do_not_retry_or_log_target(self):
        opener = FakeOpener(
            urllib.error.URLError(TimeoutError("slow-" + URL_TOKEN))
        )
        with self.assertRaises(notify.NotifyError) as caught:
            notify.send(REPO, REF, SHA, URL, KEY_TOKEN, opener=opener)
        self.assertEqual(opener.calls, 1)
        self.assertEqual(opener.timeout, 8)
        text = str(caught.exception)
        self.assertIn("timed out after 8 seconds", text)
        self.assertIn("not retried", text)
        self.assertNotIn(URL_TOKEN, text)
        self.assertNotIn(KEY_TOKEN, text)

        opener = FakeOpener(urllib.error.URLError(OSError("dns-" + URL_TOKEN)))
        with self.assertRaises(notify.NotifyError) as caught:
            notify.send(REPO, REF, SHA, URL, KEY, opener=opener)
        self.assertEqual(opener.calls, 1)
        self.assertNotIn(URL_TOKEN, str(caught.exception))
        self.assertIn("failed before a response", str(caught.exception))

    def test_disallowed_url_does_not_open(self):
        opener = FakeOpener(FakeResponse())
        with self.assertRaises(notify.NotifyError):
            notify.send(
                REPO,
                REF,
                SHA,
                "http://127.0.0.1:9/wake",
                KEY,
                opener=opener,
            )
        self.assertEqual(opener.calls, 0)

    def test_opener_disables_proxy_redirect_and_local_schemes(self):
        previous = {name: os.environ.get(name) for name in ("https_proxy", "HTTPS_PROXY")}
        os.environ["https_proxy"] = "http://proxy.example:8080"
        os.environ["HTTPS_PROXY"] = "http://proxy.example:8080"
        try:
            opener = notify.build_opener()
            default = urllib.request.build_opener()
        finally:
            for name, value in previous.items():
                if value is None:
                    os.environ.pop(name, None)
                else:
                    os.environ[name] = value
        kinds = {type(handler) for handler in opener.handlers}
        self.assertIn(notify._RejectNon200, kinds)
        self.assertIn(notify._NoRedirect, kinds)
        self.assertNotIn(urllib.request.HTTPRedirectHandler, kinds)
        self.assertNotIn(urllib.request.HTTPErrorProcessor, kinds)
        self.assertIn(notify._NoFile, kinds)
        self.assertIn(notify._NoFTP, kinds)
        self.assertIn(notify._NoData, kinds)
        self.assertFalse(
            any(isinstance(handler, urllib.request.ProxyHandler) for handler in opener.handlers)
        )
        self.assertTrue(
            any(
                isinstance(handler, urllib.request.ProxyHandler) and handler.proxies
                for handler in default.handlers
            )
        )
        source = (HERE / "notify_zstack.py").read_text(encoding="utf-8")
        self.assertNotIn("ssl._create_unverified_context", source)
        self.assertNotIn("CERT_NONE", source)

    def test_redirect_handler_hides_location(self):
        handler = notify._NoRedirect()
        with self.assertRaises(notify.NotifyError) as caught:
            handler.redirect_request(
                None,
                None,
                302,
                "Found",
                {"Location": "http://" + URL_TOKEN + "/steal"},
                "http://" + URL_TOKEN + "/steal",
            )
        self.assertNotIn(URL_TOKEN, str(caught.exception))
        self.assertIn("redirect refused", str(caught.exception))

    def test_local_redirect_is_not_followed_and_not_retried(self):
        for code in (302, 307):
            with self.subTest(code=code):
                server = LocalWebhook(
                    code,
                    payload=BODY_TOKEN.encode("ascii"),
                    location_path="/followed",
                )
                server.start()
                try:
                    with self.assertRaises(notify.NotifyError) as caught:
                        notify._deliver(
                            server.url,
                            KEY_TOKEN,
                            notify.build_body(REPO, REF, SHA),
                            notify.build_opener(),
                        )
                finally:
                    server.close()
                text = str(caught.exception)
                self.assertNotIn(KEY_TOKEN, text)
                self.assertNotIn(BODY_TOKEN, text)
                self.assertNotIn("/followed", text)
                self.assertEqual(len(server.server.hits), 1)
                self.assertEqual(server.server.hits[0]["path"], "/wake")
                self.assertEqual(server.server.hits[0]["method"], "POST")

    def test_local_non_200_is_single_attempt_without_body_logging(self):
        server = LocalWebhook(500, payload=BODY_TOKEN.encode("ascii"))
        server.start()
        try:
            with self.assertRaises(notify.NotifyError) as caught:
                notify._deliver(
                    server.url,
                    KEY_TOKEN,
                    b"{}",
                    notify.build_opener(),
                )
        finally:
            server.close()
        text = str(caught.exception)
        self.assertIn("HTTP 500", text)
        self.assertIn("not retried", text)
        self.assertNotIn(BODY_TOKEN, text)
        self.assertNotIn(KEY_TOKEN, text)
        self.assertEqual(len(server.server.hits), 1)

    def test_local_200_sends_json_and_both_headers_once(self):
        server = LocalWebhook(200, payload=BODY_TOKEN.encode("ascii"))
        server.start()
        body = notify.build_body(REPO, REF, SHA)
        try:
            notify._deliver(server.url, KEY_TOKEN, body, notify.build_opener())
        finally:
            server.close()
        self.assertEqual(len(server.server.hits), 1)
        hit = server.server.hits[0]
        self.assertEqual(hit["method"], "POST")
        self.assertEqual(hit["body"], body)
        self.assertEqual(hit["content_type"], "application/json")
        self.assertEqual(hit["authorization"], "Bearer " + KEY_TOKEN)
        self.assertEqual(hit["automation_key"], KEY_TOKEN)

    def test_process_exit_hides_key_when_url_is_missing(self):
        env = os.environ.copy()
        for name in (
            "ZSTACK_WEBHOOK_URL",
            "ZSTACK_WEBHOOK_KEY",
            "ZSTACK_REPOSITORY",
            "ZSTACK_REF",
            "ZSTACK_SHA",
            "HTTP_PROXY",
            "HTTPS_PROXY",
            "http_proxy",
            "https_proxy",
            "ALL_PROXY",
            "all_proxy",
        ):
            env.pop(name, None)
        env.update(
            {
                "ZSTACK_WEBHOOK_KEY": KEY_TOKEN,
                "ZSTACK_REPOSITORY": REPO,
                "ZSTACK_REF": REF,
                "ZSTACK_SHA": SHA,
            }
        )
        completed = subprocess.run(
            [sys.executable, "-I", str(HERE / "notify_zstack.py")],
            env=env,
            capture_output=True,
            text=True,
            check=False,
        )
        self.assertEqual(completed.returncode, 1)
        combined = completed.stdout + completed.stderr
        self.assertIn("ZSTACK_WEBHOOK_URL", combined)
        self.assertNotIn(KEY_TOKEN, combined)
        self.assertNotIn("Traceback", combined)

    def test_workflow_embeds_sender_and_stays_minimal(self):
        text = WORKFLOW.read_text(encoding="utf-8")
        script = (HERE / "notify_zstack.py").read_text(encoding="utf-8")
        self.assertEqual(embedded_workflow_script(text), script)
        compile(script, str(HERE / "notify_zstack.py"), "exec")
        self.assertIn("permissions: {}", text)
        self.assertEqual(text.count("permissions: {}"), 2)
        self.assertRegex(text, r"on:\n  push:\n    branches:\n      - main\n")
        self.assertNotIn("pull_request", text)
        self.assertNotIn("workflow_dispatch", text)
        self.assertNotIn("cancel-in-progress", text)
        self.assertNotIn("actions/checkout", text)
        self.assertNotIn("uses:", text)
        self.assertNotIn("contents:", text)
        self.assertNotIn("set -x", text)
        self.assertNotIn("bash -x", text)
        self.assertNotIn("curl", text)
        self.assertNotIn("wget", text)
        self.assertNotIn("github.event", text)
        self.assertNotIn("github.token", text)
        self.assertNotIn("secrets.GITHUB_TOKEN", text)
        self.assertNotIn("skills-main-sync", text)
        self.assertNotIn("skills-main-sync", script)
        self.assertIn("grok-bot-cli-main-sync", script)
        self.assertNotIn("changesets/action", text)
        self.assertNotIn("npm run release", text)
        self.assertIn("<<'PY'", text)
        self.assertIn("python3 -I", text)
        self.assertIn("set +x", text)
        secrets = re.findall(r"secrets\.[A-Z0-9_]+", text)
        self.assertEqual(
            secrets,
            ["secrets.ZSTACK_WEBHOOK_URL", "secrets.ZSTACK_WEBHOOK_KEY"],
        )
        for name in ("github.repository", "github.ref", "github.sha"):
            self.assertIn(name, text)
        run = text.split("run: |", 1)[1]
        self.assertNotIn("${{", run)
        self.assertNotIn("$ZSTACK", run)
        self.assertNotIn("toJson", text)


if __name__ == "__main__":
    unittest.main()
