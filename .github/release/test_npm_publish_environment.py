"""Offline checks for the npm-publish protection gate. Does not call GitHub."""

from __future__ import annotations

import io
import json
import unittest
import urllib.error
from pathlib import Path

HERE = Path(__file__).resolve().parent
import check_npm_publish_environment as gate  # noqa: E402


def environment(prevent_self_review=False, reviewers=None):
    if reviewers is None:
        reviewers = [
            {
                "type": "User",
                "reviewer": {"login": "haoz0206", "id": 236642726},
            }
        ]
    return {
        "name": "npm-publish",
        "protection_rules": [
            {
                "type": "required_reviewers",
                "prevent_self_review": prevent_self_review,
                "reviewers": reviewers,
            },
            {"type": "branch_policy"},
        ],
        "deployment_branch_policy": {
            "protected_branches": False,
            "custom_branch_policies": True,
        },
    }


def policies(names=("main",)):
    return {
        "total_count": len(names),
        "branch_policies": [{"name": name, "type": "branch"} for name in names],
    }


class FakeResponse:
    def __init__(self, payload, status=200):
        self.status = status
        self.payload = payload

    def read(self):
        return json.dumps(self.payload).encode("utf-8")

    def getcode(self):
        return self.status

    def __enter__(self):
        return self

    def __exit__(self, exc_type, exc, tb):
        return False


class FakeOpener:
    def __init__(self, responses):
        self.responses = list(responses)
        self.urls = []
        self.headers = []
        self.calls = 0

    def open(self, request, timeout=None):
        self.calls += 1
        self.urls.append(request.full_url)
        self.headers.append(dict(request.header_items()))
        result = self.responses.pop(0)
        if isinstance(result, BaseException):
            raise result
        return result


class EnvironmentGateTests(unittest.TestCase):
    def test_valid_protection_passes(self):
        gate.evaluate(environment(), policies())

    def test_missing_reviewers_fail(self):
        with self.assertRaises(gate.EnvironmentCheckError) as caught:
            gate.evaluate(environment(reviewers=[]), policies())
        self.assertIn("no required reviewers", str(caught.exception))

    def test_self_review_block_fails(self):
        with self.assertRaises(gate.EnvironmentCheckError) as caught:
            gate.evaluate(environment(prevent_self_review=True), policies())
        self.assertIn("prevent_self_review must be false", str(caught.exception))

    def test_wrong_user_fails(self):
        payload = environment(
            reviewers=[{"type": "User", "reviewer": {"login": "someone", "id": 1}}]
        )
        with self.assertRaises(gate.EnvironmentCheckError) as caught:
            gate.evaluate(payload, policies())
        self.assertIn("236642726", str(caught.exception))

    def test_branch_policy_must_be_main_only(self):
        with self.assertRaises(gate.EnvironmentCheckError):
            gate.evaluate(environment(), policies(("main", "release")))
        payload = environment()
        payload["deployment_branch_policy"] = {
            "protected_branches": True,
            "custom_branch_policies": False,
        }
        with self.assertRaises(gate.EnvironmentCheckError) as caught:
            gate.evaluate(payload, policies())
        self.assertIn("custom branch policy", str(caught.exception))

    def test_http_error_hides_token(self):
        token = "ghp_example_token_do_not_print"
        opener = FakeOpener(
            [
                urllib.error.HTTPError(
                    "https://api.github.com/hidden",
                    403,
                    "nope",
                    hdrs=None,
                    fp=io.BytesIO(b'{"token":"secret-body"}'),
                )
            ]
        )
        with self.assertRaises(gate.EnvironmentCheckError) as caught:
            gate.check("haoz0206/grok-bot-cli", token, opener=opener)
        text = str(caught.exception)
        self.assertIn("HTTP 403", text)
        self.assertNotIn(token, text)
        self.assertNotIn("secret-body", text)
        self.assertEqual(opener.calls, 1)

    def test_live_lookup_sends_token_only_as_header(self):
        token = "ghp_example_token_do_not_print"
        opener = FakeOpener([FakeResponse(environment()), FakeResponse(policies())])
        message = gate.check("haoz0206/grok-bot-cli", token, opener=opener)
        self.assertIn("haoz0206", message)
        self.assertNotIn(token, message)
        self.assertEqual(len(opener.urls), 2)
        self.assertTrue(opener.urls[0].endswith("/environments/npm-publish"))
        self.assertTrue(opener.urls[1].endswith("/deployment-branch-policies"))
        for headers in opener.headers:
            self.assertEqual(headers.get("Authorization"), "Bearer " + token)
            self.assertEqual(headers.get("X-github-api-version"), "2022-11-28")
            self.assertEqual(
                headers.get("Accept"), "application/vnd.github+json"
            )

    def test_missing_policy_type_fails_closed(self):
        with self.assertRaises(gate.EnvironmentCheckError) as caught:
            gate.evaluate(
                environment(),
                {"branch_policies": [{"name": "main"}]},
            )
        self.assertIn("2022-11-28", str(caught.exception))

    def test_missing_token_does_not_open(self):
        opener = FakeOpener([])
        with self.assertRaises(gate.EnvironmentCheckError):
            gate.check("haoz0206/grok-bot-cli", "  ", opener=opener)
        self.assertEqual(opener.urls, [])


if __name__ == "__main__":
    unittest.main()
