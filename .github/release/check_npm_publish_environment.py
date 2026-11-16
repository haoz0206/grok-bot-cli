"""Fail closed unless npm-publish is protected for haoz0206 on main only.

Reads GH_TOKEN and NPM_PUBLISH_REPOSITORY. Prints neither the token nor
response headers. A missing rule is a failure; this script does not create
or modify the environment.
"""

from __future__ import annotations

import json
import os
import sys
import urllib.error
import urllib.request

ENVIRONMENT = "npm-publish"
REVIEWER_LOGIN = "haoz0206"
REVIEWER_ID = 236642726
BRANCH = "main"


class EnvironmentCheckError(Exception):
    """Failure whose message is safe to print."""


def evaluate(environment: dict, policies: dict) -> None:
    if not isinstance(environment, dict) or environment.get("name") != ENVIRONMENT:
        raise EnvironmentCheckError(
            f"GitHub environment {ENVIRONMENT} was not found."
        )
    policy = environment.get("deployment_branch_policy")
    if (
        not isinstance(policy, dict)
        or policy.get("protected_branches") is not False
        or policy.get("custom_branch_policies") is not True
    ):
        raise EnvironmentCheckError(
            f"{ENVIRONMENT} must use a custom branch policy for {BRANCH} only. "
            "Protected-branches-only does not match this repository, because main "
            "is not a protected branch."
        )
    rules = environment.get("protection_rules")
    if not isinstance(rules, list):
        raise EnvironmentCheckError(
            f"{ENVIRONMENT} did not include protection_rules."
        )
    reviewer_rules = [
        rule
        for rule in rules
        if isinstance(rule, dict) and rule.get("type") == "required_reviewers"
    ]
    if len(reviewer_rules) != 1:
        raise EnvironmentCheckError(
            f"{ENVIRONMENT} needs exactly one required_reviewers rule."
        )
    rule = reviewer_rules[0]
    if rule.get("prevent_self_review") is not False:
        raise EnvironmentCheckError(
            "prevent_self_review must be false so haoz0206 can approve a "
            "deployment that haoz0206 triggered."
        )
    reviewers = rule.get("reviewers")
    if not isinstance(reviewers, list) or not reviewers:
        raise EnvironmentCheckError(
            f"{ENVIRONMENT} has no required reviewers, so it is not an approval gate."
        )
    matched = False
    for entry in reviewers:
        if not isinstance(entry, dict):
            continue
        person = entry.get("reviewer")
        if (
            entry.get("type") == "User"
            and isinstance(person, dict)
            and person.get("login") == REVIEWER_LOGIN
            and person.get("id") == REVIEWER_ID
        ):
            matched = True
    if not matched:
        raise EnvironmentCheckError(
            f"{ENVIRONMENT} required reviewers must include {REVIEWER_LOGIN} "
            f"(id {REVIEWER_ID})."
        )
    entries = policies.get("branch_policies") if isinstance(policies, dict) else None
    if not isinstance(entries, list):
        raise EnvironmentCheckError(
            f"{ENVIRONMENT} deployment branch policies were not readable."
        )
    names = [
        item.get("name")
        for item in entries
        if isinstance(item, dict) and item.get("type") == "branch"
    ]
    if names != [BRANCH]:
        raise EnvironmentCheckError(
            f"{ENVIRONMENT} deployment branches must be exactly [{BRANCH}]."
        )


def _get_json(url: str, token: str, opener) -> dict:
    request = urllib.request.Request(
        url,
        headers={
            "Accept": "application/json",
            "Authorization": "Bearer " + token,
            "User-Agent": "grok-bot-cli-release-check",
        },
    )
    try:
        with opener.open(request, timeout=20) as response:
            status = getattr(response, "status", None) or response.getcode()
            raw = response.read()
    except urllib.error.HTTPError as exc:
        raise EnvironmentCheckError(
            f"GitHub environment lookup failed (HTTP {exc.code})."
        ) from None
    except urllib.error.URLError:
        raise EnvironmentCheckError(
            "GitHub environment lookup failed before a response."
        ) from None
    if status != 200:
        raise EnvironmentCheckError(
            f"GitHub environment lookup failed (HTTP {status})."
        )
    try:
        payload = json.loads(raw.decode("utf-8"))
    except (UnicodeError, json.JSONDecodeError):
        raise EnvironmentCheckError(
            "GitHub environment lookup returned unreadable JSON."
        ) from None
    if not isinstance(payload, dict):
        raise EnvironmentCheckError(
            "GitHub environment lookup did not return an object."
        )
    return payload


def check(repository: str, token: str, opener=None) -> str:
    if repository != "haoz0206/grok-bot-cli":
        raise EnvironmentCheckError(
            "npm-publish checks only haoz0206/grok-bot-cli."
        )
    if not isinstance(token, str) or token.strip() == "" or token != token.strip():
        raise EnvironmentCheckError("GH_TOKEN is missing.")
    client = opener or urllib.request.build_opener()
    base = "https://api.github.com/repos/haoz0206/grok-bot-cli/environments/npm-publish"
    environment = _get_json(base, token, client)
    policies = _get_json(base + "/deployment-branch-policies", token, client)
    evaluate(environment, policies)
    return (
        "npm-publish protection is present for haoz0206 "
        f"(id {REVIEWER_ID}) on branch {BRANCH}; prevent_self_review is false."
    )


def main(environ=None) -> str:
    env = os.environ if environ is None else environ
    return check(env.get("NPM_PUBLISH_REPOSITORY", ""), env.get("GH_TOKEN", ""))


if __name__ == "__main__":
    try:
        print(main(), flush=True)
    except EnvironmentCheckError as exc:
        print("npm-publish check: " + str(exc), file=sys.stderr)
        raise SystemExit(1)
