"""Read a git tree diff for the pure release-candidate checks.

The snapshot is built from git objects. It does not query Actions check
runs and it does not merge.
"""

from __future__ import annotations

import hashlib
import os
import subprocess

import release_candidate as candidate

MANIFEST = candidate.MANIFEST
EVIDENCE = candidate.EVIDENCE
MAX_BYTES = candidate.MAX_BYTES
ReleaseCheckError = candidate.ReleaseCheckError


def _git(repo: str, args: list[str], timeout: int = 60) -> subprocess.CompletedProcess:
    env = os.environ.copy()
    env["GIT_TERMINAL_PROMPT"] = "0"
    try:
        return subprocess.run(
            ["git", "-C", repo, *args],
            check=False,
            capture_output=True,
            timeout=timeout,
            env=env,
        )
    except subprocess.TimeoutExpired:
        raise ReleaseCheckError("git read timed out.") from None


def _git_ok(repo: str, args: list[str], timeout: int = 60) -> bytes:
    proc = _git(repo, args, timeout=timeout)
    if proc.returncode != 0:
        raise ReleaseCheckError("git read failed.")
    return proc.stdout


def have_commit(repo: str, sha: str) -> bool:
    if candidate._SHA.fullmatch(sha) is None:
        return False
    proc = _git(repo, ["cat-file", "-e", sha + "^{commit}"])
    return proc.returncode == 0


def ensure_commit(repo: str, sha: str) -> None:
    """Fetch one commit from origin when the local object store lacks it."""
    if candidate._SHA.fullmatch(sha) is None:
        raise ReleaseCheckError("release commit SHA is missing.")
    if have_commit(repo, sha):
        return
    proc = _git(
        repo,
        [
            "fetch",
            "--no-tags",
            "--depth=1",
            "origin",
            sha + ":refs/release-check/" + sha,
        ],
        timeout=120,
    )
    if proc.returncode != 0 or not have_commit(repo, sha):
        raise ReleaseCheckError("could not read a release pull request commit.")


def _ls_tree(repo: str, sha: str) -> list[str]:
    raw = _git_ok(repo, ["ls-tree", "-r", "-z", "--name-only", sha])
    paths = []
    seen = set()
    for part in raw.split(b"\0"):
        if part == b"":
            continue
        try:
            path = part.decode("utf-8")
        except UnicodeError:
            raise ReleaseCheckError("git tree has a non-UTF-8 path.") from None
        if not candidate.safe_rel_path(path):
            raise ReleaseCheckError("git tree has an unsafe path.")
        if path in seen:
            raise ReleaseCheckError(f"git tree lists {path} twice.")
        seen.add(path)
        paths.append(path)
    if not paths:
        raise ReleaseCheckError("git tree is empty.")
    return paths


def _blob_bytes(repo: str, sha: str, path: str) -> bytes:
    if not candidate.safe_rel_path(path):
        raise ReleaseCheckError("refusing an unsafe path.")
    proc = _git(repo, ["cat-file", "blob", sha + ":" + path])
    if proc.returncode != 0:
        raise ReleaseCheckError(f"missing git blob {path}.")
    if len(proc.stdout) > MAX_BYTES:
        raise ReleaseCheckError(f"{path} is too large.")
    return proc.stdout


def _text_blob(repo: str, sha: str, path: str) -> str:
    raw = _blob_bytes(repo, sha, path)
    if b"\0" in raw or b"\r" in raw:
        raise ReleaseCheckError(f"{path} is not plain LF text.")
    try:
        return raw.decode("utf-8")
    except UnicodeError:
        raise ReleaseCheckError(f"{path} is not UTF-8.") from None


def _stat_blob(repo: str, sha: str, path: str) -> dict:
    raw = _blob_bytes(repo, sha, path)
    return {"sha256": hashlib.sha256(raw).hexdigest(), "size": len(raw)}


def _manifest_blob_paths(text: str) -> set[str]:
    doc = candidate._json_object(text, MANIFEST)
    paths = set()
    try:
        inputs = doc["compiler"]["project"]["sourceInputs"]
        listed = doc["files"]
    except (KeyError, TypeError):
        raise ReleaseCheckError("manifest is missing a required field.") from None
    if not isinstance(inputs, list) or not isinstance(listed, list):
        raise ReleaseCheckError("manifest lists are unusable.")
    for item in inputs:
        if not isinstance(item, dict) or not candidate.safe_rel_path(item.get("path")):
            raise ReleaseCheckError("manifest source input is unusable.")
        paths.add(item["path"])
    for item in listed:
        if not isinstance(item, dict):
            raise ReleaseCheckError("manifest file entry is not an object.")
        paths.add(candidate._artifact_path(item.get("path")))
    return paths


def _evidence_blob_paths(text: str) -> set[str]:
    doc = candidate._json_object(text, EVIDENCE)
    assets = doc.get("assets")
    if not isinstance(assets, list):
        raise ReleaseCheckError("compile evidence assets list is missing.")
    paths = set()
    for asset in assets:
        if not isinstance(asset, dict):
            raise ReleaseCheckError("compile evidence asset is unusable.")
        paths.add(candidate._artifact_path(asset.get("path")))
    return paths


def load_tree_diff(repo: str, base_sha: str, head_sha: str) -> dict:
    """Tree diff of two commits. Both commits must already be local."""
    if candidate._SHA.fullmatch(base_sha) is None or candidate._SHA.fullmatch(head_sha) is None:
        raise ReleaseCheckError("diff SHA is not a commit SHA.")
    if not have_commit(repo, base_sha) or not have_commit(repo, head_sha):
        raise ReleaseCheckError("release diff commit is not in the local git store.")
    parent_paths = _ls_tree(repo, base_sha)
    head_paths = set(_ls_tree(repo, head_sha))
    raw = _git_ok(
        repo,
        [
            "diff-tree",
            "-z",
            "-r",
            "--no-commit-id",
            "--name-status",
            base_sha,
            head_sha,
        ],
    )
    files = []
    for status, paths in candidate.parse_name_status_z(raw):
        if status == "A":
            raise ReleaseCheckError("unexpected added file " + paths[0] + ".")
        if status not in {"M", "D"}:
            raise ReleaseCheckError("unexpected git change " + status + " in a release diff.")
        path = paths[0]
        if not candidate.safe_rel_path(path):
            raise ReleaseCheckError("refusing an unsafe path.")
        if path not in parent_paths:
            raise ReleaseCheckError(f"{path} is not in the base tree.")
        before = _text_blob(repo, base_sha, path)
        if status == "D":
            files.append(
                {"path": path, "status": "removed", "before": before, "after": None}
            )
            continue
        files.append(
            {
                "path": path,
                "status": "modified",
                "before": before,
                "after": _text_blob(repo, head_sha, path),
            }
        )
    by_path = {item["path"]: item for item in files}
    echo_before = {
        path: _text_blob(repo, base_sha, path)
        for path in parent_paths
        if candidate.is_version_echo(path)
    }

    def special(path: str):
        if path in by_path:
            change = by_path[path]
            return change["before"], change["after"]
        if path not in parent_paths:
            return None, None
        if path not in head_paths:
            return _text_blob(repo, base_sha, path), None
        return _text_blob(repo, base_sha, path), _text_blob(repo, head_sha, path)

    manifest_before, manifest_after = special(MANIFEST)
    evidence_before, evidence_after = special(EVIDENCE)
    # Hash the head tree. Paths that the diff deleted are not in that tree;
    # the candidate check rejects them without a head blob.
    blob_paths = set()
    if isinstance(manifest_after, str):
        blob_paths.update(_manifest_blob_paths(manifest_after))
    if isinstance(evidence_after, str):
        blob_paths.update(_evidence_blob_paths(evidence_after))
    blobs = {path: _stat_blob(repo, head_sha, path) for path in sorted(blob_paths)}
    return {
        "base_sha": base_sha,
        "head_sha": head_sha,
        "files": files,
        "parent_paths": parent_paths,
        "version_echo_before": echo_before,
        "blobs": blobs,
        "manifest_before": manifest_before,
        "manifest_after": manifest_after,
        "evidence_before": evidence_before,
        "evidence_after": evidence_after,
    }
