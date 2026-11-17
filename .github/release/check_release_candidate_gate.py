"""Decide whether this main commit may ask for the npm-publish Environment.

Read-only. No token, no OIDC, no npm. `publish` means the first-parent diff
is a pure version candidate and this workflow attempt is 1. `skip` means
the commit does not touch release files, so the publish job must not start.
A commit that touches release files but fails the pure-version checker is
an invalid candidate: this process exits 1 and does not report success.

`evaluate_release_pr` is not used. Check-run success is a later merge gate.
The post-approval tip and attempt checks in check_publish_commit.py still
run inside the publish job; this gate does not replace them.

A skip or a failure both avoid the Environment. Only `publish` lets that
job start. Passing here is not an atomic lock with npm.
"""

from __future__ import annotations

import os
import sys

import release_candidate as candidate
import release_diff

ReleaseCheckError = candidate.ReleaseCheckError
DECISION_PUBLISH = "publish"
DECISION_SKIP = "skip"


def is_release_surface(status: str, path: str) -> bool:
    """True when this change is shaped like a release, not an ordinary push.

    Adding a `.changeset/*.md` is how feature commits record a future
    release. Deleting one is changeset consumption and is release-shaped.
    """
    # Manifest and compile-evidence hashes move when any tracked source file
    # changes. That snapshot update is not itself a release. They are still
    # checked strictly once a version, changelog, consumed changeset, or
    # version-echo file shows this commit is trying to publish.
    if path in {"package.json", "CHANGELOG.md"}:
        return True
    if candidate.is_version_echo(path):
        return True
    if status == "D" and path.startswith(".changeset/") and path.endswith(".md"):
        return path != ".changeset/README.md"
    return False


def decide_release_candidate(repo: str, attempt: str = "1", commit: str | None = None) -> str:
    if commit is None:
        head_raw = release_diff._git_ok(repo, ["rev-parse", "--verify", "HEAD"])
        head = head_raw.decode("utf-8").strip()
    else:
        head = commit
    if candidate._SHA.fullmatch(head) is None:
        raise ReleaseCheckError("HEAD is not a commit SHA.")
    parent_proc = release_diff._git(repo, ["rev-parse", "--verify", head + "^1"])
    if parent_proc.returncode != 0:
        raise ReleaseCheckError("release candidate commit has no first parent.")
    parent = parent_proc.stdout.decode("utf-8").strip()
    if candidate._SHA.fullmatch(parent) is None:
        raise ReleaseCheckError("release candidate first parent is not a SHA.")
    changed = release_diff.list_changed_paths(repo, parent, head)
    if not any(is_release_surface(status, path) for status, path in changed):
        return DECISION_SKIP
    try:
        diff = release_diff.load_tree_diff(repo, parent, head)
        candidate.evaluate_version_diff(
            files=diff.get("files"),
            parent_paths=diff.get("parent_paths"),
            version_echo_before=diff.get("version_echo_before"),
            blobs=diff.get("blobs"),
            manifest_before=diff.get("manifest_before"),
            manifest_after=diff.get("manifest_after"),
            evidence_before=diff.get("evidence_before"),
            evidence_after=diff.get("evidence_after"),
        )
    except ReleaseCheckError as exc:
        raise ReleaseCheckError("invalid release candidate: " + str(exc)) from None
    if attempt != "1":
        raise ReleaseCheckError(
            f"publish refuses run_attempt {attempt!r}; only a new workflow run "
            "on attempt 1 may publish. This check does not revoke a GitHub "
            "environment approval."
        )
    return DECISION_PUBLISH


def _emit(decision: str) -> None:
    if decision not in {DECISION_PUBLISH, DECISION_SKIP}:
        raise ReleaseCheckError("release candidate decision is not publish or skip.")
    output = os.environ.get("GITHUB_OUTPUT")
    if output:
        with open(output, "a", encoding="utf-8") as handle:
            handle.write("decision=" + decision + "\n")


def main(environ=None, repo=None) -> str:
    env = os.environ if environ is None else environ
    root = repo or os.getcwd()
    decision = decide_release_candidate(root, env.get("PUBLISH_RUN_ATTEMPT", "1"))
    _emit(decision)
    if decision == DECISION_SKIP:
        return (
            "release candidate decision: skip. This commit does not touch "
            "release files, so npm-publish is not requested."
        )
    return (
        "release candidate decision: publish. npm-publish may be requested. "
        "Post-approval checks still have to pass, and this is not an atomic "
        "lock with npm."
    )


if __name__ == "__main__":
    try:
        print(main(), flush=True)
    except ReleaseCheckError as exc:
        print("release candidate gate: " + str(exc), file=sys.stderr)
        raise SystemExit(1)
