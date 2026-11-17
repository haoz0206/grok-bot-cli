"""Pure checks for a Changesets release candidate.

`evaluate_version_diff` is the content rule used by the publish job and by
Package CI on `changeset-release/main`. It reads only the snapshot it is
given.

`evaluate_release_identity` checks repository, branch, open state, and that
the head and base SHAs are the ones the caller just observed.

`evaluate_release_pr` adds the Actions check-run rule. No workflow calls it.
A later merge job may call it only after the complete latest check-run set
for that exact head SHA has finished. It does not merge.

`compiler.project.modelDigest` and `compiler.project.revision` are accepted
as 64-hex aggregates. This module does not recompute agent-bundle's
aggregate algorithm. Every listed manifest and compile-evidence file hash
is bound to the blob sha256 in the snapshot. `npm run validate:artifact`
in the publish job remains the build-system check of those aggregates.
"""

from __future__ import annotations

import json
import re

PACKAGE = "@haoz0206/grok-bot-cli"
REPOSITORY = "haoz0206/grok-bot-cli"
HEAD_REF = "changeset-release/main"
BASE_REF = "main"
MANIFEST = "artifact/agent-bundle.manifest.json"
EVIDENCE = "artifact/agent-bundle.compile-evidence.json"
# Byte cap above the largest committed bundle (mcp-grok-bot-*.mjs is about 3.4MB).
MAX_BYTES = 8_000_000

# Paths whose 0.12.8 release diff was only the package version token.
# compile-evidence and the manifest are checked separately because their
# hashes move with the file bytes. A path not listed here fails even if the
# only byte change is the version token.
VERSION_ECHO_EXACT = frozenset(
    {
        ".claude-plugin/marketplace.json",
        "artifact/.claude-plugin/marketplace.json",
        "artifact/.claude-plugin/plugin.json",
        "artifact/.codex-plugin/plugin.json",
        "artifact/.cursor-plugin/plugin.json",
        "artifact/INSTALL.md",
        "artifact/bin/gbot-flight.mjs",
        "artifact/bin/gbot.mjs",
        "artifact/install.mjs",
        "artifact/plugin.json",
        "artifact/scripts/gbot-relay.mjs",
    }
)
_ECHO_PATTERNS = (
    re.compile(r"artifact/mcp/mcp-grok-bot-[0-9a-f]{8,64}-flight\.mjs\Z"),
    re.compile(r"artifact/mcp/mcp-grok-bot-[0-9a-f]{8,64}\.mjs\Z"),
)
_CHANGESET_PATH = re.compile(r"\.changeset/(?!README\.md\Z)[A-Za-z0-9][A-Za-z0-9_-]{0,80}\.md\Z")
_CHANGESET_BODY = re.compile(
    r'\A---\n"@haoz0206/grok-bot-cli": (patch|minor|major)\n---\n\n(.+)\n\Z',
    re.DOTALL,
)
_VERSION = re.compile(r"\A(0|[1-9][0-9]{0,5})\.(0|[1-9][0-9]{0,5})\.(0|[1-9][0-9]{0,5})\Z")
_SHA = re.compile(r"\A[0-9a-f]{40}\Z")
_HEX64 = re.compile(r"\A[0-9a-f]{64}\Z")
_CHANGELOG_HEADER = "# grok-bot-cli\n\n"
_BUMP_RANK = {"patch": 1, "minor": 2, "major": 3}
_BUMP_HEADING = {"patch": "Patch", "minor": "Minor", "major": "Major"}

# Job names from ci.yml and changeset.yml. Exact set, observed on release
# PR 4 head 869ea7fc1a49ac0617cdbc9e417540a57c93ccca. An extra or missing
# name fails closed; this list has to change with those job names.
REQUIRED_CHECKS = (
    "package",
    "platform (ubuntu-26.04)",
    "platform (macos-15-intel)",
    "platform (windows-2025)",
    "Changeset present",
)


class ReleaseCheckError(Exception):
    """Failure whose message is safe to print."""


def is_version_echo(path: str) -> bool:
    return path in VERSION_ECHO_EXACT or any(
        pattern.fullmatch(path) for pattern in _ECHO_PATTERNS
    )


def safe_rel_path(path: str) -> bool:
    if not isinstance(path, str) or path == "" or path != path.strip():
        return False
    if "\\" in path or path.startswith("/") or ":" in path or "\0" in path:
        return False
    return all(part not in {"", ".", ".."} for part in path.split("/"))


def parse_name_status_z(raw: bytes) -> list[tuple[str, tuple[str, ...]]]:
    """Parse `git diff-tree -z --name-status` records."""
    if raw == b"":
        return []
    parts = raw.split(b"\0")
    if parts[-1] == b"":
        parts.pop()
    records = []
    index = 0
    while index < len(parts):
        try:
            status = parts[index].decode("utf-8")
        except UnicodeError:
            raise ReleaseCheckError("git diff has a non-UTF-8 status.") from None
        index += 1
        width = 2 if status[:1] in {"R", "C"} else 1
        if index + width > len(parts):
            raise ReleaseCheckError("git diff records are truncated.")
        try:
            paths = tuple(part.decode("utf-8") for part in parts[index : index + width])
        except UnicodeError:
            raise ReleaseCheckError("git diff has a non-UTF-8 path.") from None
        index += width
        records.append((status, paths))
    return records


def _json_object(text: str, label: str):
    def pairs(items):
        obj = {}
        for key, value in items:
            if key in obj:
                raise ReleaseCheckError(f"{label} JSON has a duplicate key.")
            obj[key] = value
        return obj

    try:
        value = json.loads(text, object_pairs_hook=pairs)
    except json.JSONDecodeError:
        raise ReleaseCheckError(f"{label} JSON is unreadable.") from None
    if not isinstance(value, dict):
        raise ReleaseCheckError(f"{label} JSON is not an object.")
    return value


def _version_parts(value: str) -> tuple[int, int, int]:
    match = _VERSION.fullmatch(value)
    if match is None:
        raise ReleaseCheckError(f"version {value!r} is not MAJOR.MINOR.PATCH.")
    return tuple(int(part) for part in match.groups())


def bump_kind(old: str, new: str) -> str:
    previous = _version_parts(old)
    current = _version_parts(new)
    if current == (previous[0], previous[1], previous[2] + 1):
        return "patch"
    if current == (previous[0], previous[1] + 1, 0):
        return "minor"
    if current == (previous[0] + 1, 0, 0):
        return "major"
    raise ReleaseCheckError(
        f"version {old} -> {new} is not a single patch, minor, or major bump."
    )


def _replace_version(text: str, old: str, new: str) -> tuple[str, int]:
    pattern = re.compile(r"(?<![\d.])" + re.escape(old) + r"(?![\d.])")
    count = 0

    def _sub(_match):
        nonlocal count
        count += 1
        return new

    return pattern.sub(_sub, text), count


def _require_text(value, label: str) -> str:
    if not isinstance(value, str):
        raise ReleaseCheckError(f"{label} is missing.")
    if len(value.encode("utf-8")) > MAX_BYTES:
        raise ReleaseCheckError(f"{label} is too large.")
    if "\0" in value or "\r" in value:
        raise ReleaseCheckError(f"{label} is not plain LF text.")
    return value


def _index_files(files) -> dict[str, dict]:
    if not isinstance(files, list) or not files:
        raise ReleaseCheckError("release diff is empty.")
    indexed = {}
    for item in files:
        if not isinstance(item, dict):
            raise ReleaseCheckError("release diff entry is not an object.")
        path = item.get("path")
        status = item.get("status")
        if not safe_rel_path(path):
            raise ReleaseCheckError("release diff has an unsafe path.")
        if path in indexed:
            raise ReleaseCheckError(f"release diff lists {path} twice.")
        if status not in {"modified", "removed"}:
            raise ReleaseCheckError(f"unexpected change type for {path}.")
        before = _require_text(item.get("before"), path)
        after = item.get("after")
        if status == "removed":
            if after is not None:
                raise ReleaseCheckError(f"removed file {path} still has content.")
        else:
            after = _require_text(after, path)
            if after == before:
                raise ReleaseCheckError(f"{path} is marked modified but is unchanged.")
        indexed[path] = {"path": path, "status": status, "before": before, "after": after}
    return indexed


def _require_parent_paths(parent_paths) -> list[str]:
    if not isinstance(parent_paths, list) or not parent_paths:
        raise ReleaseCheckError("base tree file list is missing.")
    seen = set()
    for path in parent_paths:
        if not safe_rel_path(path):
            raise ReleaseCheckError("base tree has an unsafe path.")
        if path in seen:
            raise ReleaseCheckError(f"base tree lists {path} twice.")
        seen.add(path)
    return parent_paths


def _blob(blobs, path: str) -> dict:
    if not isinstance(blobs, dict) or path not in blobs:
        raise ReleaseCheckError(f"missing blob sha256 for {path}.")
    stat = blobs[path]
    if (
        not isinstance(stat, dict)
        or not isinstance(stat.get("size"), int)
        or isinstance(stat.get("size"), bool)
        or stat["size"] < 0
        or stat["size"] > MAX_BYTES
        or not isinstance(stat.get("sha256"), str)
        or _HEX64.fullmatch(stat["sha256"]) is None
    ):
        raise ReleaseCheckError(f"blob sha256 for {path} is unusable.")
    return stat


def _artifact_path(relative: str) -> str:
    if not safe_rel_path(relative):
        raise ReleaseCheckError("manifest or evidence path is unsafe.")
    return "artifact/" + relative


def _package_change(files: dict[str, dict]) -> tuple[str, str, str, dict]:
    change = files.get("package.json")
    if change is None or change["status"] != "modified":
        raise ReleaseCheckError("package.json must be a version-only modification.")
    before = _json_object(change["before"], "package.json")
    after = _json_object(change["after"], "package.json")
    if before.get("name") != PACKAGE or after.get("name") != PACKAGE:
        raise ReleaseCheckError("package name must stay @haoz0206/grok-bot-cli.")
    old = before.get("version")
    new = after.get("version")
    if not isinstance(old, str) or not isinstance(new, str):
        raise ReleaseCheckError("package.json version must be a string.")
    kind = bump_kind(old, new)
    before_rest = dict(before)
    after_rest = dict(after)
    before_rest.pop("version", None)
    after_rest.pop("version", None)
    if before_rest != after_rest:
        raise ReleaseCheckError("package.json changed more than the version.")
    replaced, count = _replace_version(change["before"], old, new)
    if count < 1 or replaced != change["after"]:
        raise ReleaseCheckError("package.json is not a version-token substitution.")
    return old, new, kind, after


def _changelog(files, old: str, new: str, kind: str) -> None:
    change = files.get("CHANGELOG.md")
    if change is None or change["status"] != "modified":
        raise ReleaseCheckError("CHANGELOG.md must add the new version section.")
    before = change["before"]
    after = change["after"]
    if not before.startswith(_CHANGELOG_HEADER) or not after.startswith(_CHANGELOG_HEADER):
        raise ReleaseCheckError("CHANGELOG.md must start with the grok-bot-cli title.")
    old_body = before[len(_CHANGELOG_HEADER) :]
    new_body = after[len(_CHANGELOG_HEADER) :]
    if not old_body.startswith(f"## {old}\n"):
        raise ReleaseCheckError("CHANGELOG.md history does not start at the previous version.")
    if not new_body.endswith(old_body):
        raise ReleaseCheckError("CHANGELOG.md changed text below the new version section.")
    insertion = new_body[: len(new_body) - len(old_body)]
    heading = _BUMP_HEADING[kind]
    prefix = f"## {new}\n\n### {heading} Changes\n\n"
    if not insertion.startswith(prefix) or not insertion.endswith("\n\n"):
        raise ReleaseCheckError("CHANGELOG.md new section does not match the bump.")
    bullet_text = insertion[len(prefix) : -1]
    lines = bullet_text.split("\n")
    if not lines or lines[-1] != "":
        raise ReleaseCheckError("CHANGELOG.md new section is not a bullet list.")
    lines = lines[:-1]
    seen = False
    for line in lines:
        if line.startswith("- "):
            if line.strip() == "-":
                raise ReleaseCheckError("CHANGELOG.md has an empty bullet.")
            seen = True
        elif line.startswith("  ") and seen:
            continue
        else:
            raise ReleaseCheckError("CHANGELOG.md new section has a non-bullet line.")
    if not seen:
        raise ReleaseCheckError("CHANGELOG.md new section has no bullets.")


def _changesets(files, kind: str) -> tuple[str, ...]:
    consumed = []
    ranks = []
    for path, change in files.items():
        if not path.startswith(".changeset/"):
            continue
        if change["status"] != "removed" or _CHANGESET_PATH.fullmatch(path) is None:
            raise ReleaseCheckError(f"unexpected changeset path {path}.")
        match = _CHANGESET_BODY.fullmatch(change["before"])
        if match is None or "\n---\n" in match.group(2):
            raise ReleaseCheckError(f"{path} is not a single-package changeset.")
        summary = match.group(2).strip()
        if summary == "":
            raise ReleaseCheckError(f"{path} has an empty summary.")
        ranks.append(_BUMP_RANK[match.group(1)])
        consumed.append(path)
    if not consumed:
        raise ReleaseCheckError("release diff did not consume a changeset.")
    expected = max(ranks)
    if _BUMP_RANK[kind] != expected:
        raise ReleaseCheckError(
            "package.json bump does not match the consumed changesets."
        )
    return tuple(sorted(consumed))


def _echo_files(files, parent_paths, echo_before, old: str, new: str) -> None:
    if not isinstance(echo_before, dict):
        raise ReleaseCheckError("version echo snapshot is missing.")
    expected = [path for path in parent_paths if is_version_echo(path)]
    if set(echo_before) != set(expected):
        raise ReleaseCheckError("version echo snapshot does not match the base tree.")
    for path in expected:
        before = _require_text(echo_before[path], path)
        replaced, count = _replace_version(before, old, new)
        change = files.get(path)
        if count == 0:
            if change is not None:
                raise ReleaseCheckError(
                    f"{path} changed without a package version token."
                )
            continue
        if change is None or change["status"] != "modified":
            raise ReleaseCheckError(f"{path} still contains version {old}.")
        if change["before"] != before or change["after"] != replaced:
            raise ReleaseCheckError(
                f"{path} is not a pure version-token substitution."
            )


def _manifest(before_text, after_text, blobs, consumed, new: str) -> None:
    if before_text is None:
        if after_text is not None:
            raise ReleaseCheckError("manifest appeared without a base copy.")
        return
    if after_text is None:
        raise ReleaseCheckError("manifest was removed.")
    before = _json_object(_require_text(before_text, MANIFEST), MANIFEST)
    after = _json_object(_require_text(after_text, MANIFEST), MANIFEST)

    def peel(doc):
        copy = json.loads(json.dumps(doc))
        try:
            app_version = copy["application"].pop("version")
            project = copy["compiler"]["project"]
            package_version = project.pop("packageVersion")
            model = project.pop("modelDigest")
            revision = project.pop("revision")
            inputs = project.pop("sourceInputs")
            listed = copy.pop("files")
        except (KeyError, TypeError):
            raise ReleaseCheckError("manifest is missing a required field.") from None
        return copy, app_version, package_version, model, revision, inputs, listed

    before_rest, old_app, old_pkg, _old_model, _old_rev, old_inputs, old_files = peel(before)
    after_rest, new_app, new_pkg, new_model, new_rev, new_inputs, new_files = peel(after)
    if before_rest != after_rest:
        raise ReleaseCheckError("manifest changed a field other than version, inputs, or hashes.")
    if new_app != new or new_pkg != new or old_app == new or old_pkg == new:
        raise ReleaseCheckError("manifest version fields do not match package.json.")
    if _HEX64.fullmatch(str(new_model)) is None or _HEX64.fullmatch(str(new_rev)) is None:
        raise ReleaseCheckError("manifest modelDigest and revision must be 64 hex chars.")
    _inputs(old_inputs, new_inputs, blobs, consumed)
    _manifest_files(old_files, new_files, blobs)


def _inputs(old_inputs, new_inputs, blobs, consumed) -> None:
    if not isinstance(old_inputs, list) or not isinstance(new_inputs, list):
        raise ReleaseCheckError("manifest sourceInputs is not a list.")

    def by_path(items, label):
        mapping = {}
        order = []
        for item in items:
            if not isinstance(item, dict) or not safe_rel_path(item.get("path")):
                raise ReleaseCheckError(f"{label} source input is unusable.")
            path = item["path"]
            if path in mapping:
                raise ReleaseCheckError(f"manifest lists {path} twice.")
            mapping[path] = item
            order.append(path)
        return mapping, order

    old_map, old_order = by_path(old_inputs, "base")
    new_map, new_order = by_path(new_inputs, "head")
    removed = [path for path in old_order if path not in new_map]
    added = [path for path in new_order if path not in old_map]
    if added:
        raise ReleaseCheckError("manifest sourceInputs added a path.")
    if set(removed) - set(consumed):
        raise ReleaseCheckError("manifest sourceInputs removed a file that is not a consumed changeset.")
    for path in consumed:
        if path in old_map and path not in set(removed):
            raise ReleaseCheckError(f"manifest still lists consumed changeset {path}.")
    if new_order != [path for path in old_order if path not in set(removed)]:
        raise ReleaseCheckError("manifest sourceInputs were reordered.")
    for path, item in new_map.items():
        previous = old_map[path]
        stat = _blob(blobs, path)
        if item.get("sha256") != stat["sha256"]:
            raise ReleaseCheckError(f"manifest source hash for {path} does not match the blob.")
        for key in set(item) | set(previous):
            if key == "sha256":
                continue
            if item.get(key) != previous.get(key):
                raise ReleaseCheckError(f"manifest source input {path} changed {key}.")


def _manifest_files(old_files, new_files, blobs) -> None:
    if not isinstance(old_files, list) or not isinstance(new_files, list):
        raise ReleaseCheckError("manifest files list is missing.")
    if [item.get("path") if isinstance(item, dict) else None for item in old_files] != [
        item.get("path") if isinstance(item, dict) else None for item in new_files
    ]:
        raise ReleaseCheckError("manifest file list changed paths or order.")
    for previous, item in zip(old_files, new_files):
        if not isinstance(previous, dict) or not isinstance(item, dict):
            raise ReleaseCheckError("manifest file entry is not an object.")
        relative = item.get("path")
        repo_path = _artifact_path(relative)
        stat = _blob(blobs, repo_path)
        if item.get("sha256") != stat["sha256"] or item.get("bytes") != stat["size"]:
            raise ReleaseCheckError(f"manifest hash for {repo_path} does not match the blob.")
        for key in set(item) | set(previous):
            if key in {"sha256", "bytes"}:
                continue
            if item.get(key) != previous.get(key):
                raise ReleaseCheckError(f"manifest file {relative} changed {key}.")


def _evidence(before_text, after_text, blobs) -> None:
    if before_text is None:
        if after_text is not None:
            raise ReleaseCheckError("compile evidence appeared without a base copy.")
        return
    if after_text is None:
        raise ReleaseCheckError("compile evidence was removed.")
    before_text = _require_text(before_text, EVIDENCE)
    after_text = _require_text(after_text, EVIDENCE)
    before = _json_object(before_text, EVIDENCE)
    after = _json_object(after_text, EVIDENCE)

    def strip(doc):
        copy = json.loads(json.dumps(doc))
        assets = copy.get("assets")
        if not isinstance(assets, list):
            raise ReleaseCheckError("compile evidence assets list is missing.")
        for asset in assets:
            if not isinstance(asset, dict) or "sha256" not in asset:
                raise ReleaseCheckError("compile evidence asset is unusable.")
            asset["sha256"] = None
        return copy

    if strip(before) != strip(after):
        raise ReleaseCheckError("compile evidence changed more than asset sha256 values.")
    raw = before_text
    for previous, asset in zip(before["assets"], after["assets"]):
        old_hash = previous.get("sha256")
        new_hash = asset.get("sha256")
        if not isinstance(old_hash, str) or _HEX64.fullmatch(str(new_hash) if isinstance(new_hash, str) else "") is None:
            raise ReleaseCheckError("compile evidence sha256 is not 64 hex chars.")
        stat = _blob(blobs, _artifact_path(asset.get("path")))
        if new_hash != stat["sha256"]:
            raise ReleaseCheckError(
                f"compile evidence hash for {asset.get('path')} does not match the blob."
            )
        if old_hash == new_hash:
            continue
        if _HEX64.fullmatch(old_hash) is None or raw.count(old_hash) != 1:
            raise ReleaseCheckError("compile evidence hash substitution is ambiguous.")
        raw = raw.replace(old_hash, new_hash, 1)
    if raw != after_text:
        raise ReleaseCheckError("compile evidence bytes changed outside sha256 values.")


def _special_text(files, path: str):
    change = files.get(path)
    if change is None:
        return None, None, False
    if change["status"] != "modified":
        raise ReleaseCheckError(f"{path} cannot be added or removed in a version diff.")
    return change["before"], change["after"], True


def evaluate_version_diff(
    *,
    files,
    parent_paths,
    version_echo_before,
    blobs,
    manifest_before=None,
    manifest_after=None,
    evidence_before=None,
    evidence_after=None,
) -> dict:
    """Accept one pure version diff. Reject source, workflow, and dependency edits."""
    paths = _require_parent_paths(parent_paths)
    indexed = _index_files(files)
    for path in indexed:
        if path not in paths:
            raise ReleaseCheckError(f"{path} is not in the base tree.")
    old, new, kind, _package = _package_change(indexed)
    _changelog(indexed, old, new, kind)
    consumed = _changesets(indexed, kind)
    _echo_files(indexed, paths, version_echo_before, old, new)

    manifest_in_diff_before, manifest_in_diff_after, manifest_in_diff = _special_text(
        indexed, MANIFEST
    )
    evidence_in_diff_before, evidence_in_diff_after, evidence_in_diff = _special_text(
        indexed, EVIDENCE
    )
    if MANIFEST in paths:
        manifest_before = manifest_in_diff_before if manifest_in_diff else manifest_before
        manifest_after = manifest_in_diff_after if manifest_in_diff else manifest_after
        if not isinstance(manifest_before, str) or not isinstance(manifest_after, str):
            raise ReleaseCheckError("manifest snapshot is missing.")
    elif manifest_before is not None or manifest_after is not None or manifest_in_diff:
        raise ReleaseCheckError("manifest snapshot does not match the base tree.")
    if EVIDENCE in paths:
        evidence_before = evidence_in_diff_before if evidence_in_diff else evidence_before
        evidence_after = evidence_in_diff_after if evidence_in_diff else evidence_after
        if not isinstance(evidence_before, str) or not isinstance(evidence_after, str):
            raise ReleaseCheckError("compile evidence snapshot is missing.")
    elif evidence_before is not None or evidence_after is not None or evidence_in_diff:
        raise ReleaseCheckError("compile evidence snapshot does not match the base tree.")

    _manifest(manifest_before, manifest_after, blobs, consumed, new)
    _evidence(evidence_before, evidence_after, blobs)

    allowed = {"package.json", "CHANGELOG.md", *consumed}
    allowed.update(path for path in paths if is_version_echo(path))
    if manifest_in_diff:
        allowed.add(MANIFEST)
    if evidence_in_diff:
        allowed.add(EVIDENCE)
    unknown = [path for path in indexed if path not in allowed]
    if unknown:
        raise ReleaseCheckError("unexpected release diff path: " + ", ".join(sorted(unknown)))
    return {
        "name": PACKAGE,
        "version": new,
        "previous_version": old,
        "bump": kind,
        "consumed_changesets": consumed,
    }


def evaluate_release_identity(snapshot: dict) -> None:
    """Same repository, release branch, and the head/base SHAs just observed."""
    if not isinstance(snapshot, dict):
        raise ReleaseCheckError("release pull request snapshot is missing.")
    if snapshot.get("repository") != REPOSITORY:
        raise ReleaseCheckError("release checks only haoz0206/grok-bot-cli.")
    if snapshot.get("head_repo") != REPOSITORY or snapshot.get("base_repo") != REPOSITORY:
        raise ReleaseCheckError("release pull request must come from this repository.")
    if snapshot.get("head_ref") != HEAD_REF:
        raise ReleaseCheckError("release pull request head must be changeset-release/main.")
    if snapshot.get("base_ref") != BASE_REF:
        raise ReleaseCheckError("release pull request base must be main.")
    if snapshot.get("state") != "open":
        raise ReleaseCheckError("release pull request is not open.")
    if snapshot.get("draft") is not False or snapshot.get("merged") is not False:
        raise ReleaseCheckError("release pull request must be open, not draft or merged.")
    head = snapshot.get("head_sha")
    base = snapshot.get("base_sha")
    if not isinstance(head, str) or _SHA.fullmatch(head) is None:
        raise ReleaseCheckError("release pull request head SHA is missing.")
    if not isinstance(base, str) or _SHA.fullmatch(base) is None:
        raise ReleaseCheckError("release pull request base SHA is missing.")
    if head == base:
        raise ReleaseCheckError("release pull request head is not a change.")
    if snapshot.get("observed_head_sha") != head:
        raise ReleaseCheckError("candidate head changed.")
    if snapshot.get("observed_base_sha") != base:
        raise ReleaseCheckError("candidate base changed.")


def evaluate_checks(checks, check_total, head_sha: str) -> tuple[str, ...]:
    """Require the exact successful check set on this head SHA.

    `check_total` is the API `total_count` for `filter=latest` on that SHA.
    The caller must pass every run in that response. This function cannot
    detect a caller that drops a failed run and lies about the total.
    """
    if not isinstance(head_sha, str) or _SHA.fullmatch(head_sha) is None:
        raise ReleaseCheckError("check head SHA is missing.")
    if not isinstance(check_total, int) or isinstance(check_total, bool):
        raise ReleaseCheckError("check total is missing.")
    if not isinstance(checks, list) or check_total != len(checks):
        raise ReleaseCheckError("check list is not the complete latest set.")
    seen = set()
    for check in checks:
        if not isinstance(check, dict):
            raise ReleaseCheckError("check run is not an object.")
        name = check.get("name")
        if not isinstance(name, str) or name in seen:
            raise ReleaseCheckError("check run name is missing or duplicated.")
        seen.add(name)
        if check.get("head_sha") != head_sha:
            raise ReleaseCheckError(f"check {name} is not for the candidate head.")
        if check.get("status") != "completed" or check.get("conclusion") != "success":
            raise ReleaseCheckError(f"check {name} did not succeed.")
    if tuple(sorted(seen)) != tuple(sorted(REQUIRED_CHECKS)):
        raise ReleaseCheckError("required checks are missing or unexpected checks are present.")
    return REQUIRED_CHECKS


def evaluate_release_pr(snapshot: dict) -> dict:
    """Standby merge gate. No workflow calls this, and it does not merge."""
    evaluate_release_identity(snapshot)
    diff = snapshot.get("diff")
    if not isinstance(diff, dict):
        raise ReleaseCheckError("release diff is missing.")
    if diff.get("head_sha") != snapshot["head_sha"] or diff.get("base_sha") != snapshot["base_sha"]:
        raise ReleaseCheckError("release diff is not for the current head and base.")
    result = evaluate_version_diff(
        files=diff.get("files"),
        parent_paths=diff.get("parent_paths"),
        version_echo_before=diff.get("version_echo_before"),
        blobs=diff.get("blobs"),
        manifest_before=diff.get("manifest_before"),
        manifest_after=diff.get("manifest_after"),
        evidence_before=diff.get("evidence_before"),
        evidence_after=diff.get("evidence_after"),
    )
    checks = evaluate_checks(
        snapshot.get("checks"), snapshot.get("check_total"), snapshot["head_sha"]
    )
    result["validated_sha"] = snapshot["head_sha"]
    result["base_sha"] = snapshot["base_sha"]
    result["checks"] = checks
    return result


def evaluate_publish_gate(observation: dict) -> dict:
    """Fail closed immediately before npm publish. Does not revoke an approval."""
    if not isinstance(observation, dict):
        raise ReleaseCheckError("publish observation is missing.")
    attempt = observation.get("run_attempt")
    if attempt != "1":
        raise ReleaseCheckError(
            f"publish refuses run_attempt {attempt!r}; only a new workflow run "
            "on attempt 1 may publish. This check does not revoke a GitHub "
            "environment approval."
        )
    if observation.get("github_ref") != "refs/heads/main":
        raise ReleaseCheckError("publish is limited to refs/heads/main.")
    shas = {}
    for name in ("github_sha", "checkout_sha", "remote_main_sha", "parent_sha"):
        value = observation.get(name)
        if not isinstance(value, str) or _SHA.fullmatch(value) is None:
            raise ReleaseCheckError(f"{name} is not a commit SHA.")
        shas[name] = value
    if shas["checkout_sha"] != shas["github_sha"]:
        raise ReleaseCheckError("checkout HEAD is not github.sha.")
    if shas["remote_main_sha"] != shas["github_sha"]:
        raise ReleaseCheckError(
            "github.sha "
            + shas["github_sha"]
            + " is not the remote main tip "
            + shas["remote_main_sha"]
            + " at check time. This read is not an atomic lock with npm publish."
        )
    package_text = observation.get("package_text")
    package_blob = observation.get("package_blob")
    if package_text != package_blob:
        raise ReleaseCheckError(
            "intended package.json does not match the validated candidate commit."
        )
    diff = observation.get("diff")
    if not isinstance(diff, dict) or diff.get("head_sha") != shas["github_sha"]:
        raise ReleaseCheckError("publish diff is not for github.sha.")
    if diff.get("base_sha") != shas["parent_sha"]:
        raise ReleaseCheckError("publish diff is not against the first parent.")
    result = evaluate_version_diff(
        files=diff.get("files"),
        parent_paths=diff.get("parent_paths"),
        version_echo_before=diff.get("version_echo_before"),
        blobs=diff.get("blobs"),
        manifest_before=diff.get("manifest_before"),
        manifest_after=diff.get("manifest_after"),
        evidence_before=diff.get("evidence_before"),
        evidence_after=diff.get("evidence_after"),
    )
    parsed = _json_object(_require_text(package_text, "package.json"), "package.json")
    if parsed.get("name") != result["name"] or parsed.get("version") != result["version"]:
        raise ReleaseCheckError(
            "intended package.json does not match the validated candidate commit."
        )
    result["sha"] = shas["github_sha"]
    result["parent_sha"] = shas["parent_sha"]
    result["run_attempt"] = "1"
    return result
