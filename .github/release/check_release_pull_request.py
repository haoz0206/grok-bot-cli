"""Fail a changeset-release/main pull request whose diff is not a pure version diff.

Reads RELEASE_REPOSITORY, RELEASE_BASE_REF, RELEASE_BASE_SHA, RELEASE_BASE_REPO,
RELEASE_HEAD_REF, RELEASE_HEAD_SHA, RELEASE_HEAD_REPO, RELEASE_PR_STATE,
RELEASE_PR_DRAFT, and RELEASE_PR_MERGED. Those values come from the workflow
event. This script does not read Actions check runs, does not merge, and
does not call evaluate_release_pr.

Package CI runs this only for an open release pull request. Other pull
requests skip the step. Sibling jobs may still be running, so check-run
success is not available here.
"""

from __future__ import annotations

import os
import sys

import release_candidate as candidate
import release_diff

ReleaseCheckError = candidate.ReleaseCheckError


def _bool_false(value, label: str) -> bool:
    if value != "false":
        raise ReleaseCheckError(f"{label} must be false.")
    return False


def identity_from_env(env: dict) -> dict:
    return {
        "repository": env.get("RELEASE_REPOSITORY", ""),
        "base_ref": env.get("RELEASE_BASE_REF", ""),
        "base_sha": env.get("RELEASE_BASE_SHA", ""),
        "base_repo": env.get("RELEASE_BASE_REPO", ""),
        "head_ref": env.get("RELEASE_HEAD_REF", ""),
        "head_sha": env.get("RELEASE_HEAD_SHA", ""),
        "head_repo": env.get("RELEASE_HEAD_REPO", ""),
        "observed_base_sha": env.get("RELEASE_BASE_SHA", ""),
        "observed_head_sha": env.get("RELEASE_HEAD_SHA", ""),
        "state": env.get("RELEASE_PR_STATE", ""),
        "draft": _bool_false(env.get("RELEASE_PR_DRAFT", ""), "RELEASE_PR_DRAFT"),
        "merged": _bool_false(env.get("RELEASE_PR_MERGED", ""), "RELEASE_PR_MERGED"),
    }


def check(env, repo=None, loader=None, fetcher=None) -> str:
    identity = identity_from_env(env)
    candidate.evaluate_release_identity(identity)
    root = repo or os.getcwd()
    fetch = fetcher or release_diff.ensure_commit
    fetch(root, identity["base_sha"])
    fetch(root, identity["head_sha"])
    diff = (loader or release_diff.load_tree_diff)(
        root, identity["base_sha"], identity["head_sha"]
    )
    if diff.get("base_sha") != identity["base_sha"] or diff.get("head_sha") != identity["head_sha"]:
        raise ReleaseCheckError("release diff is not for the current head and base.")
    result = candidate.evaluate_version_diff(
        files=diff.get("files"),
        parent_paths=diff.get("parent_paths"),
        version_echo_before=diff.get("version_echo_before"),
        blobs=diff.get("blobs"),
        manifest_before=diff.get("manifest_before"),
        manifest_after=diff.get("manifest_after"),
        evidence_before=diff.get("evidence_before"),
        evidence_after=diff.get("evidence_after"),
    )
    return (
        "release pull request "
        + result["name"]
        + "@"
        + result["version"]
        + " at "
        + identity["head_sha"]
        + " is a pure version diff. This does not merge and does not read "
        + "Actions check runs."
    )


def main(environ=None) -> str:
    env = os.environ if environ is None else environ
    return check(env)


if __name__ == "__main__":
    try:
        print(main(), flush=True)
    except ReleaseCheckError as exc:
        print("release pull request check: " + str(exc), file=sys.stderr)
        raise SystemExit(1)
