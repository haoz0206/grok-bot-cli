"""Fail closed immediately before npm publish.

Reads NPM_PUBLISH_REPOSITORY, GH_TOKEN, PUBLISH_GITHUB_SHA,
PUBLISH_RUN_ATTEMPT, and PUBLISH_GITHUB_REF. Prints neither the token nor
response bodies. Does not create a workflow run and does not revoke a
GitHub environment approval.

The main-tip read is one GET of refs/heads/main. A push can still land
after that read and before npm publish; cancel-in-progress is not an
atomic lock with the registry.
"""

from __future__ import annotations

import json
import os
import sys
import urllib.error
import urllib.request

import release_candidate as candidate
import release_diff

API_VERSION = "2022-11-28"
ReleaseCheckError = candidate.ReleaseCheckError


def _precheck(env: dict) -> dict:
    repository = env.get("NPM_PUBLISH_REPOSITORY", "")
    if repository != candidate.REPOSITORY:
        raise ReleaseCheckError("npm publish checks only haoz0206/grok-bot-cli.")
    token = env.get("GH_TOKEN", "")
    if not isinstance(token, str) or token.strip() == "" or token != token.strip():
        raise ReleaseCheckError("GH_TOKEN is missing.")
    attempt = env.get("PUBLISH_RUN_ATTEMPT", "")
    if attempt != "1":
        raise ReleaseCheckError(
            f"publish refuses run_attempt {attempt!r}; only a new workflow run "
            "on attempt 1 may publish. This check does not revoke a GitHub "
            "environment approval."
        )
    ref = env.get("PUBLISH_GITHUB_REF", "")
    if ref != "refs/heads/main":
        raise ReleaseCheckError("publish is limited to refs/heads/main.")
    sha = env.get("PUBLISH_GITHUB_SHA", "")
    if not isinstance(sha, str) or candidate._SHA.fullmatch(sha) is None:
        raise ReleaseCheckError("PUBLISH_GITHUB_SHA is not a commit SHA.")
    return {"token": token, "sha": sha, "ref": ref, "attempt": attempt}


def _get_json(url: str, token: str, opener) -> dict:
    request = urllib.request.Request(
        url,
        headers={
            "Accept": "application/vnd.github+json",
            "Authorization": "Bearer " + token,
            "User-Agent": "grok-bot-cli-release-check",
            "X-GitHub-Api-Version": API_VERSION,
        },
    )
    try:
        with opener.open(request, timeout=20) as response:
            status = getattr(response, "status", None) or response.getcode()
            raw = response.read()
    except urllib.error.HTTPError as exc:
        raise ReleaseCheckError(f"GitHub ref lookup failed (HTTP {exc.code}).") from None
    except urllib.error.URLError:
        raise ReleaseCheckError("GitHub ref lookup failed before a response.") from None
    if status != 200:
        raise ReleaseCheckError(f"GitHub ref lookup failed (HTTP {status}).")
    try:
        payload = json.loads(raw.decode("utf-8"))
    except (UnicodeError, json.JSONDecodeError):
        raise ReleaseCheckError("GitHub ref lookup returned unreadable JSON.") from None
    if not isinstance(payload, dict):
        raise ReleaseCheckError("GitHub ref lookup did not return an object.")
    return payload


def fetch_main_tip(token: str, opener=None) -> str:
    client = opener or urllib.request.build_opener()
    payload = _get_json(
        "https://api.github.com/repos/haoz0206/grok-bot-cli/git/ref/heads/main",
        token,
        client,
    )
    ref = payload.get("ref")
    obj = payload.get("object")
    sha = obj.get("sha") if isinstance(obj, dict) else None
    kind = obj.get("type") if isinstance(obj, dict) else None
    if ref != "refs/heads/main" or kind != "commit" or not isinstance(sha, str):
        raise ReleaseCheckError("GitHub ref lookup did not return the main commit.")
    if candidate._SHA.fullmatch(sha) is None:
        raise ReleaseCheckError("GitHub ref lookup returned an unusable SHA.")
    return sha


def _head_and_parent(repo: str, sha: str) -> tuple[str, str]:
    head = release_diff._git_ok(repo, ["rev-parse", "--verify", "HEAD"]).decode("utf-8").strip()
    if head != sha:
        raise ReleaseCheckError("checkout HEAD is not github.sha.")
    parent_proc = release_diff._git(repo, ["rev-parse", "--verify", sha + "^1"])
    if parent_proc.returncode != 0:
        raise ReleaseCheckError("publish commit has no first parent.")
    parent = parent_proc.stdout.decode("utf-8").strip()
    if candidate._SHA.fullmatch(parent) is None:
        raise ReleaseCheckError("publish commit first parent is not a SHA.")
    return head, parent


def _worktree_package(repo: str) -> str:
    path = os.path.join(repo, "package.json")
    try:
        with open(path, "rb") as handle:
            raw = handle.read()
    except OSError:
        raise ReleaseCheckError("worktree package.json is missing.") from None
    if len(raw) > candidate.MAX_BYTES or b"\0" in raw or b"\r" in raw:
        raise ReleaseCheckError("worktree package.json is not plain LF text.")
    try:
        return raw.decode("utf-8")
    except UnicodeError:
        raise ReleaseCheckError("worktree package.json is not UTF-8.") from None


def check(env, opener=None, repo=None, loader=None) -> str:
    pre = _precheck(env)
    tip = fetch_main_tip(pre["token"], opener)
    if tip != pre["sha"]:
        raise ReleaseCheckError(
            "github.sha "
            + pre["sha"]
            + " is not the remote main tip "
            + tip
            + " at check time. This read is not an atomic lock with npm publish."
        )
    root = repo or os.getcwd()
    _head, parent = _head_and_parent(root, pre["sha"])
    diff = (loader or release_diff.load_tree_diff)(root, parent, pre["sha"])
    package_blob = release_diff._text_blob(root, pre["sha"], "package.json")
    result = candidate.evaluate_publish_gate(
        {
            "run_attempt": pre["attempt"],
            "github_ref": pre["ref"],
            "github_sha": pre["sha"],
            "checkout_sha": pre["sha"],
            "remote_main_sha": tip,
            "parent_sha": parent,
            "package_text": _worktree_package(root),
            "package_blob": package_blob,
            "diff": diff,
        }
    )
    return (
        "publish candidate "
        + result["name"]
        + "@"
        + result["version"]
        + " at "
        + result["sha"]
        + " matches the remote main tip at check time; run_attempt is 1. "
        + "This read is not an atomic lock with npm publish."
    )


def main(environ=None) -> str:
    env = os.environ if environ is None else environ
    return check(env)


if __name__ == "__main__":
    try:
        print(main(), flush=True)
    except ReleaseCheckError as exc:
        print("publish check: " + str(exc), file=sys.stderr)
        raise SystemExit(1)
