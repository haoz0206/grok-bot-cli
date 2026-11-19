"""Offline checks for release diff rules, plus the published 0.12.8 commit.

The 0.12.8 commit is local when this repo has that history. A shallow
checkout fetches the two known commits from the public repository.
"""

from __future__ import annotations

import hashlib
import io
import json
import os
import shutil
import subprocess
import tempfile
import unittest
import urllib.error
from pathlib import Path

HERE = Path(__file__).resolve().parent
ROOT = HERE.parents[1]
import check_publish_commit as publish  # noqa: E402
import check_release_candidate_gate as gate  # noqa: E402
import check_release_pull_request as pull  # noqa: E402
import release_candidate as candidate  # noqa: E402
import release_diff  # noqa: E402

OLD = "0.12.7"
NEW = "0.12.8"
SHA_A = "aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa"
SHA_B = "bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb"
SHA_C = "cccccccccccccccccccccccccccccccccccccccc"
PKG_BEFORE = (
    '{\n  "name": "@haoz0206/grok-bot-cli",\n  "version": "0.12.7",\n'
    '  "dependencies": {\n    "zod": "4.6.7"\n  }\n}\n'
)
PKG_AFTER = PKG_BEFORE.replace(OLD, NEW)
CHANGELOG_BEFORE = "# grok-bot-cli\n\n## 0.12.7\n\n### Patch Changes\n\n- aaaaaaa: Previous.\n"
CHANGELOG_AFTER = (
    "# grok-bot-cli\n\n## 0.12.8\n\n### Patch Changes\n\n- bbbbbbb: Ship it.\n\n"
    + CHANGELOG_BEFORE[len("# grok-bot-cli\n\n") :]
)
CHANGESET = '---\n"@haoz0206/grok-bot-cli": patch\n---\n\nShip it.\n'
ECHO_PATH = "artifact/install.mjs"
ECHO = 'const pluginVersion = "0.12.7";\n'
ECHO_AFTER = 'const pluginVersion = "0.12.8";\n'
RELEASE_COMMIT = "9190012a1d0d94f43b74dace96b7bf269afdc957"
RELEASE_PARENT = "9b5c621b7ba7313a0ab55c923f78d240f3a77c18"
PUBLIC_REPO = "https://github.com/haoz0206/grok-bot-cli.git"


def _stat(text: str) -> dict:
    raw = text.encode("utf-8")
    return {"sha256": hashlib.sha256(raw).hexdigest(), "size": len(raw)}


def _manifest(version, inputs, files, digest):
    return json.dumps(
        {
            "application": {"name": "gbot", "version": version},
            "compiler": {
                "project": {
                    "packageVersion": version,
                    "modelDigest": digest,
                    "revision": digest,
                    "sourceInputs": inputs,
                }
            },
            "files": files,
        }
    )


def _base_files():
    return [
        {
            "path": "package.json",
            "status": "modified",
            "before": PKG_BEFORE,
            "after": PKG_AFTER,
        },
        {
            "path": "CHANGELOG.md",
            "status": "modified",
            "before": CHANGELOG_BEFORE,
            "after": CHANGELOG_AFTER,
        },
        {
            "path": ".changeset/sunny-day.md",
            "status": "removed",
            "before": CHANGESET,
            "after": None,
        },
        {
            "path": ECHO_PATH,
            "status": "modified",
            "before": ECHO,
            "after": ECHO_AFTER,
        },
    ]


def _parent_paths():
    return [
        "package.json",
        "CHANGELOG.md",
        ".changeset/sunny-day.md",
        ECHO_PATH,
        "src/index.ts",
    ]


def _diff(**overrides):
    snapshot = {
        "base_sha": SHA_A,
        "head_sha": SHA_B,
        "files": _base_files(),
        "parent_paths": _parent_paths(),
        "version_echo_before": {ECHO_PATH: ECHO},
        "blobs": {},
        "manifest_before": None,
        "manifest_after": None,
        "evidence_before": None,
        "evidence_after": None,
    }
    snapshot.update(overrides)
    return snapshot


def _evaluate(diff):
    return candidate.evaluate_version_diff(
        files=diff["files"],
        parent_paths=diff["parent_paths"],
        version_echo_before=diff["version_echo_before"],
        blobs=diff["blobs"],
        manifest_before=diff["manifest_before"],
        manifest_after=diff["manifest_after"],
        evidence_before=diff["evidence_before"],
        evidence_after=diff["evidence_after"],
    )


def _with_manifest(diff):
    digest_old = "a" * 64
    digest_new = "b" * 64
    old_inputs = [
        {
            "executable": False,
            "path": "package.json",
            "sha256": _stat(PKG_BEFORE)["sha256"],
        },
        {
            "executable": False,
            "path": ".changeset/sunny-day.md",
            "sha256": _stat(CHANGESET)["sha256"],
        },
    ]
    new_inputs = [
        {
            "executable": False,
            "path": "package.json",
            "sha256": _stat(PKG_AFTER)["sha256"],
        }
    ]
    old_files = [
        {
            "bytes": _stat(ECHO)["size"],
            "kind": "generated",
            "path": "install.mjs",
            "sha256": _stat(ECHO)["sha256"],
        }
    ]
    new_files = [
        {
            "bytes": _stat(ECHO_AFTER)["size"],
            "kind": "generated",
            "path": "install.mjs",
            "sha256": _stat(ECHO_AFTER)["sha256"],
        }
    ]
    diff["manifest_before"] = _manifest(OLD, old_inputs, old_files, digest_old)
    diff["manifest_after"] = _manifest(NEW, new_inputs, new_files, digest_new)
    diff["files"] = list(diff["files"]) + [
        {
            "path": candidate.MANIFEST,
            "status": "modified",
            "before": diff["manifest_before"],
            "after": diff["manifest_after"],
        }
    ]
    diff["parent_paths"] = list(diff["parent_paths"]) + [candidate.MANIFEST]
    diff["blobs"] = {
        "package.json": _stat(PKG_AFTER),
        "artifact/install.mjs": _stat(ECHO_AFTER),
    }
    return diff


def _identity(**overrides):
    snapshot = {
        "repository": candidate.REPOSITORY,
        "base_ref": "main",
        "base_sha": SHA_A,
        "base_repo": candidate.REPOSITORY,
        "head_ref": candidate.HEAD_REF,
        "head_sha": SHA_B,
        "head_repo": candidate.REPOSITORY,
        "observed_base_sha": SHA_A,
        "observed_head_sha": SHA_B,
        "state": "open",
        "draft": False,
        "merged": False,
    }
    snapshot.update(overrides)
    return snapshot


def _checks(head=SHA_B, conclusion="success", sha=None):
    bound = head if sha is None else sha
    return [
        {
            "name": name,
            "head_sha": bound,
            "status": "completed",
            "conclusion": conclusion,
        }
        for name in candidate.REQUIRED_CHECKS
    ]


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

    def open(self, request, timeout=None):
        self.urls.append(request.full_url)
        self.headers.append(dict(request.header_items()))
        result = self.responses.pop(0)
        if isinstance(result, BaseException):
            raise result
        return result


def _git(repo, *args):
    env = os.environ.copy()
    env.update(
        {
            "GIT_AUTHOR_NAME": "release-test",
            "GIT_AUTHOR_EMAIL": "release-test@example.com",
            "GIT_COMMITTER_NAME": "release-test",
            "GIT_COMMITTER_EMAIL": "release-test@example.com",
            "GIT_TERMINAL_PROMPT": "0",
        }
    )
    subprocess.run(
        ["git", "-C", repo, *args],
        check=True,
        capture_output=True,
        env=env,
    )


def _commit_tree(repo, files):
    for name, text in files.items():
        path = Path(repo) / name
        path.parent.mkdir(parents=True, exist_ok=True)
        path.write_text(text, encoding="utf-8")
    _git(repo, "add", "-A")
    _git(repo, "commit", "-m", "snapshot")
    return subprocess.check_output(
        ["git", "-C", repo, "rev-parse", "HEAD"], text=True
    ).strip()


def _init_release_repo(second_files):
    repo = tempfile.mkdtemp(prefix="release-diff-")
    _git(repo, "init", "-b", "main")
    _commit_tree(
        repo,
        {
            "package.json": PKG_BEFORE,
            "CHANGELOG.md": CHANGELOG_BEFORE,
            ".changeset/sunny-day.md": CHANGESET,
            ECHO_PATH: ECHO,
            "src/index.ts": "export const value = 1;\n",
        },
    )
    for name, text in second_files.items():
        path = Path(repo) / name
        if text is None:
            path.unlink()
        else:
            path.parent.mkdir(parents=True, exist_ok=True)
            path.write_text(text, encoding="utf-8")
    _git(repo, "add", "-A")
    _git(repo, "commit", "-m", "version")
    head = subprocess.check_output(
        ["git", "-C", repo, "rev-parse", "HEAD"], text=True
    ).strip()
    parent = subprocess.check_output(
        ["git", "-C", repo, "rev-parse", "HEAD^1"], text=True
    ).strip()
    return repo, parent, head


def _publish_env(sha):
    return {
        "NPM_PUBLISH_REPOSITORY": candidate.REPOSITORY,
        "GH_TOKEN": "ghp_example_token_do_not_print",
        "PUBLISH_RUN_ATTEMPT": "1",
        "PUBLISH_GITHUB_REF": "refs/heads/main",
        "PUBLISH_GITHUB_SHA": sha,
    }


def _tip(sha):
    return {
        "ref": "refs/heads/main",
        "object": {"type": "commit", "sha": sha},
    }


def _release_env(base, head):
    return {
        "RELEASE_REPOSITORY": candidate.REPOSITORY,
        "RELEASE_BASE_REF": "main",
        "RELEASE_BASE_SHA": base,
        "RELEASE_BASE_REPO": candidate.REPOSITORY,
        "RELEASE_HEAD_REF": candidate.HEAD_REF,
        "RELEASE_HEAD_SHA": head,
        "RELEASE_HEAD_REPO": candidate.REPOSITORY,
        "RELEASE_PR_STATE": "open",
        "RELEASE_PR_DRAFT": "false",
        "RELEASE_PR_MERGED": "false",
    }


class VersionDiffTests(unittest.TestCase):
    def test_allowed_version_update(self):
        result = _evaluate(_diff())
        self.assertEqual(result["name"], "@haoz0206/grok-bot-cli")
        self.assertEqual(result["version"], NEW)
        self.assertEqual(result["previous_version"], OLD)
        self.assertEqual(result["bump"], "patch")
        self.assertEqual(result["consumed_changesets"], (".changeset/sunny-day.md",))

    def test_manifest_hash_must_match_blob(self):
        result = _evaluate(_with_manifest(_diff()))
        self.assertEqual(result["version"], NEW)
        broken = _with_manifest(_diff())
        broken["blobs"]["artifact/install.mjs"] = _stat("nope\n")
        with self.assertRaises(candidate.ReleaseCheckError) as caught:
            _evaluate(broken)
        self.assertIn("does not match the blob", str(caught.exception))

    def test_manifest_rejects_added_source_input(self):
        diff = _with_manifest(_diff())
        after = json.loads(diff["manifest_after"])
        after["compiler"]["project"]["sourceInputs"].append(
            {
                "executable": False,
                "path": "src/evil.js",
                "sha256": "c" * 64,
            }
        )
        diff["manifest_after"] = json.dumps(after)
        diff["files"][-1]["after"] = diff["manifest_after"]
        with self.assertRaises(candidate.ReleaseCheckError) as caught:
            _evaluate(diff)
        self.assertIn("sourceInputs", str(caught.exception))

    def test_evidence_hash_must_match_and_other_fields_stay(self):
        before = json.dumps(
            {
                "policy": {"ok": True},
                "assets": [
                    {"path": "install.mjs", "sha256": _stat(ECHO)["sha256"]}
                ],
            }
        )
        after = before.replace(_stat(ECHO)["sha256"], _stat(ECHO_AFTER)["sha256"])
        diff = _diff(
            evidence_before=before,
            evidence_after=after,
            blobs={"artifact/install.mjs": _stat(ECHO_AFTER)},
        )
        diff["parent_paths"] = _parent_paths() + [candidate.EVIDENCE]
        diff["files"] = _base_files() + [
            {
                "path": candidate.EVIDENCE,
                "status": "modified",
                "before": before,
                "after": after,
            }
        ]
        self.assertEqual(_evaluate(diff)["version"], NEW)
        tampered = json.loads(after)
        tampered["policy"] = {"ok": False}
        diff["evidence_after"] = json.dumps(tampered)
        diff["files"][-1]["after"] = diff["evidence_after"]
        with self.assertRaises(candidate.ReleaseCheckError) as caught:
            _evaluate(diff)
        self.assertIn("compile evidence", str(caught.exception))

    def test_version_echo_path_rejects_non_version_edits(self):
        diff = _diff()
        diff["files"][3]["after"] = ECHO_AFTER + "eval(1);\n"
        with self.assertRaises(candidate.ReleaseCheckError) as caught:
            _evaluate(diff)
        self.assertIn("not a pure version-token substitution", str(caught.exception))

    def test_source_workflow_and_dependency_changes_fail(self):
        source = _diff()
        source["files"] = _base_files() + [
            {
                "path": "src/index.ts",
                "status": "modified",
                "before": "export const value = 1;\n",
                "after": "export const value = 2;\n",
            }
        ]
        with self.assertRaises(candidate.ReleaseCheckError) as caught:
            _evaluate(source)
        self.assertIn("unexpected release diff path", str(caught.exception))

        workflow = _diff()
        workflow["files"] = _base_files() + [
            {
                "path": ".github/workflows/release.yml",
                "status": "modified",
                "before": 'version: "0.12.7"\n',
                "after": 'version: "0.12.8"\n',
            }
        ]
        workflow["parent_paths"] = _parent_paths() + [".github/workflows/release.yml"]
        with self.assertRaises(candidate.ReleaseCheckError) as caught:
            _evaluate(workflow)
        self.assertIn("release.yml", str(caught.exception))

        dependency = _diff()
        dependency["files"][0]["after"] = PKG_AFTER.replace('"zod": "4.6.7"', '"zod": "9.9.9"')
        with self.assertRaises(candidate.ReleaseCheckError) as caught:
            _evaluate(dependency)
        self.assertIn("package.json", str(caught.exception))

    def test_changelog_history_rewrite_fails(self):
        diff = _diff()
        diff["files"][1]["after"] = CHANGELOG_AFTER.replace("Previous.", "Rewritten.")
        with self.assertRaises(candidate.ReleaseCheckError) as caught:
            _evaluate(diff)
        self.assertIn("CHANGELOG.md", str(caught.exception))

    def test_changeset_bump_must_match_version(self):
        diff = _diff()
        diff["files"][2]["before"] = CHANGESET.replace("patch", "major")
        with self.assertRaises(candidate.ReleaseCheckError) as caught:
            _evaluate(diff)
        self.assertIn("does not match the consumed changesets", str(caught.exception))


class ReleasePullRequestTests(unittest.TestCase):
    def test_checks_record_exact_head_sha(self):
        diff = _diff()
        result = candidate.evaluate_release_pr(
            {
                **_identity(),
                "diff": diff,
                "checks": _checks(),
                "check_total": len(candidate.REQUIRED_CHECKS),
            }
        )
        self.assertEqual(result["validated_sha"], SHA_B)
        self.assertEqual(result["checks"], candidate.REQUIRED_CHECKS)
        self.assertEqual(
            candidate.REQUIRED_CHECKS,
            (
                "package",
                "platform (ubuntu-26.04)",
                "platform (macos-15-intel)",
                "platform (windows-2025)",
                "Changeset present",
            ),
        )

    def test_head_change_failed_check_and_wrong_sha_fail(self):
        diff = _diff()
        with self.assertRaises(candidate.ReleaseCheckError) as caught:
            candidate.evaluate_release_identity(_identity(observed_head_sha=SHA_C))
        self.assertIn("candidate head changed", str(caught.exception))
        with self.assertRaises(candidate.ReleaseCheckError) as caught:
            candidate.evaluate_release_identity(_identity(observed_base_sha=SHA_C))
        self.assertIn("candidate base changed", str(caught.exception))
        with self.assertRaises(candidate.ReleaseCheckError) as caught:
            candidate.evaluate_checks(_checks(conclusion="failure"), 5, SHA_B)
        self.assertIn("did not succeed", str(caught.exception))
        with self.assertRaises(candidate.ReleaseCheckError) as caught:
            candidate.evaluate_checks(_checks(sha=SHA_A), 5, SHA_B)
        self.assertIn("not for the candidate head", str(caught.exception))
        partial = _checks()[:-1]
        with self.assertRaises(candidate.ReleaseCheckError):
            candidate.evaluate_checks(partial, len(partial), SHA_B)

    def test_fork_and_wrong_branch_fail(self):
        with self.assertRaises(candidate.ReleaseCheckError):
            candidate.evaluate_release_identity(_identity(head_repo="someone/grok-bot-cli"))
        with self.assertRaises(candidate.ReleaseCheckError):
            candidate.evaluate_release_identity(_identity(head_ref="feature"))

    def test_pull_request_entry_does_not_read_checks_or_merge(self):
        source = (HERE / "check_release_pull_request.py").read_text(encoding="utf-8")
        self.assertNotIn("evaluate_release_pr(", source)
        self.assertIn("evaluate_release_identity", source)
        self.assertIn("evaluate_version_diff", source)
        workflow = (ROOT / ".github/workflows/ci.yml").read_text(encoding="utf-8")
        release = (ROOT / ".github/workflows/release.yml").read_text(encoding="utf-8")
        self.assertIn("check_release_pull_request.py", workflow)
        self.assertNotIn("check_release_pull_request.py", release)
        self.assertNotIn("gh pr merge", release)
        self.assertNotIn("evaluate_release_pr", release)


class PublishGateTests(unittest.TestCase):
    def _observation(self, **overrides):
        diff = _diff()
        observation = {
            "run_attempt": "1",
            "github_ref": "refs/heads/main",
            "github_sha": SHA_B,
            "checkout_sha": SHA_B,
            "remote_main_sha": SHA_B,
            "parent_sha": SHA_A,
            "package_text": PKG_AFTER,
            "package_blob": PKG_AFTER,
            "diff": diff,
        }
        observation.update(overrides)
        return observation

    def test_stale_main_version_mismatch_and_rerun_fail(self):
        with self.assertRaises(candidate.ReleaseCheckError) as caught:
            candidate.evaluate_publish_gate(
                self._observation(remote_main_sha=SHA_C)
            )
        self.assertIn("not the remote main tip", str(caught.exception))
        self.assertIn("not an atomic lock", str(caught.exception))
        with self.assertRaises(candidate.ReleaseCheckError) as caught:
            candidate.evaluate_publish_gate(
                self._observation(package_text=PKG_BEFORE)
            )
        self.assertIn("does not match the validated candidate", str(caught.exception))
        with self.assertRaises(candidate.ReleaseCheckError) as caught:
            candidate.evaluate_publish_gate(self._observation(run_attempt="2"))
        text = str(caught.exception)
        self.assertIn("run_attempt", text)
        self.assertIn("does not revoke", text)
        self.assertNotIn("revoked the", text)

    def test_attempt_two_does_not_call_github(self):
        opener = FakeOpener([])
        env = _publish_env(SHA_B)
        env["PUBLISH_RUN_ATTEMPT"] = "2"
        with self.assertRaises(publish.ReleaseCheckError):
            publish.check(env, opener=opener, repo=ROOT)
        self.assertEqual(opener.urls, [])

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
        env = _publish_env(SHA_B)
        env["GH_TOKEN"] = token
        with self.assertRaises(publish.ReleaseCheckError) as caught:
            publish.fetch_main_tip(token, opener)
        self.assertIn("HTTP 403", str(caught.exception))
        self.assertNotIn(token, str(caught.exception))
        self.assertNotIn("secret-body", str(caught.exception))
        called = publish.fetch_main_tip(token, FakeOpener([FakeResponse(_tip(SHA_B))]))
        self.assertEqual(called, SHA_B)


class GitEntryTests(unittest.TestCase):
    def tearDown(self):
        repo = getattr(self, "repo", None)
        if repo:
            shutil.rmtree(repo, ignore_errors=True)

    def test_publish_entry_accepts_a_real_git_version_commit(self):
        self.repo, _parent, head = _init_release_repo(
            {
                "package.json": PKG_AFTER,
                "CHANGELOG.md": CHANGELOG_AFTER,
                ".changeset/sunny-day.md": None,
                ECHO_PATH: ECHO_AFTER,
            }
        )
        opener = FakeOpener([FakeResponse(_tip(head))])
        message = publish.check(_publish_env(head), opener=opener, repo=self.repo)
        self.assertIn("@0.12.8", message)
        self.assertIn(head, message)
        self.assertIn("not an atomic lock", message)
        self.assertNotIn("ghp_example_token_do_not_print", message)

    def test_publish_entry_rejects_stale_tip_and_source_edits(self):
        self.repo, _parent, head = _init_release_repo(
            {
                "package.json": PKG_AFTER,
                "CHANGELOG.md": CHANGELOG_AFTER,
                ".changeset/sunny-day.md": None,
                ECHO_PATH: ECHO_AFTER,
            }
        )
        opener = FakeOpener([FakeResponse(_tip(SHA_C))])
        with self.assertRaises(publish.ReleaseCheckError) as caught:
            publish.check(_publish_env(head), opener=opener, repo=self.repo)
        self.assertIn("not the remote main tip", str(caught.exception))
        shutil.rmtree(self.repo, ignore_errors=True)
        self.repo, _parent, moved = _init_release_repo(
            {
                "package.json": PKG_AFTER,
                "CHANGELOG.md": CHANGELOG_AFTER,
                ".changeset/sunny-day.md": None,
                ECHO_PATH: ECHO_AFTER,
                "src/index.ts": "export const value = 2;\n",
            }
        )
        opener = FakeOpener([FakeResponse(_tip(moved))])
        with self.assertRaises(publish.ReleaseCheckError) as caught:
            publish.check(_publish_env(moved), opener=opener, repo=self.repo)
        self.assertIn("unexpected release diff path", str(caught.exception))

    def test_pull_request_entry_accepts_and_rejects(self):
        self.repo, base, head = _init_release_repo(
            {
                "package.json": PKG_AFTER,
                "CHANGELOG.md": CHANGELOG_AFTER,
                ".changeset/sunny-day.md": None,
                ECHO_PATH: ECHO_AFTER,
            }
        )
        message = pull.check(_release_env(base, head), repo=self.repo, fetcher=lambda *_args: None)
        self.assertIn("pure version diff", message)
        self.assertIn("does not merge", message)
        self.assertNotIn("check runs succeeded", message)
        _git(self.repo, "commit", "--allow-empty", "-m", "empty")
        # A workflow file change on top of the version commit.
        workflow = Path(self.repo) / ".github/workflows/release.yml"
        workflow.parent.mkdir(parents=True, exist_ok=True)
        workflow.write_text("name: Release\n", encoding="utf-8")
        _git(self.repo, "add", "-A")
        _git(self.repo, "commit", "-m", "workflow")
        # Diff from the original base now includes the workflow file.
        with self.assertRaises(pull.ReleaseCheckError):
            pull.check(
                _release_env(base, subprocess.check_output(
                    ["git", "-C", self.repo, "rev-parse", "HEAD"], text=True
                ).strip()),
                repo=self.repo,
                fetcher=lambda *_args: None,
            )


class CandidateGateTests(unittest.TestCase):
    def tearDown(self):
        repo = getattr(self, "repo", None)
        if repo:
            shutil.rmtree(repo, ignore_errors=True)

    def test_source_and_workflow_push_skips_environment(self):
        self.repo = tempfile.mkdtemp(prefix="release-gate-")
        _git(self.repo, "init", "-b", "main")
        _commit_tree(
            self.repo,
            {
                "package.json": PKG_BEFORE,
                "src/index.ts": "export const value = 1;\n",
                ".github/workflows/release.yml": "name: Release\n",
            },
        )
        path = Path(self.repo) / "src" / "index.ts"
        path.write_text("export const value = 2;\n", encoding="utf-8")
        workflow = Path(self.repo) / ".github" / "workflows" / "ci.yml"
        workflow.parent.mkdir(parents=True, exist_ok=True)
        workflow.write_text("name: Package CI\n", encoding="utf-8")
        _git(self.repo, "add", "-A")
        _git(self.repo, "commit", "-m", "infra")
        self.assertEqual(gate.decide_release_candidate(self.repo, "1"), "skip")
        self.assertEqual(gate.decide_release_candidate(self.repo, "2"), "skip")

    def test_manifest_snapshot_with_added_files_skips(self):
        self.repo = tempfile.mkdtemp(prefix="release-gate-")
        _git(self.repo, "init", "-b", "main")
        _commit_tree(
            self.repo,
            {
                "package.json": PKG_BEFORE,
                candidate.MANIFEST: '{"files":[]}\n',
            },
        )
        added = Path(self.repo) / ".github" / "release" / "check_publish_commit.py"
        added.parent.mkdir(parents=True, exist_ok=True)
        added.write_text("print('gate')\n", encoding="utf-8")
        manifest = Path(self.repo) / candidate.MANIFEST
        manifest.write_text('{"files":["check_publish_commit.py"]}\n', encoding="utf-8")
        _git(self.repo, "add", "-A")
        _git(self.repo, "commit", "-m", "snapshot")
        self.assertEqual(gate.decide_release_candidate(self.repo, "1"), "skip")

    def test_version_echo_without_a_clean_release_fails(self):
        self.repo = tempfile.mkdtemp(prefix="release-gate-")
        _git(self.repo, "init", "-b", "main")
        _commit_tree(self.repo, {ECHO_PATH: ECHO, "package.json": PKG_BEFORE})
        echo = Path(self.repo) / ECHO_PATH
        echo.write_text(ECHO_AFTER + "eval(1);\n", encoding="utf-8")
        _git(self.repo, "add", "-A")
        _git(self.repo, "commit", "-m", "tamper")
        with self.assertRaises(gate.ReleaseCheckError) as caught:
            gate.decide_release_candidate(self.repo, "1")
        self.assertIn("invalid release candidate", str(caught.exception))

    def test_added_changeset_is_not_a_release_attempt(self):
        self.repo = tempfile.mkdtemp(prefix="release-gate-")
        _git(self.repo, "init", "-b", "main")
        _commit_tree(self.repo, {"package.json": PKG_BEFORE, "src/index.ts": "export const value = 1;\n"})
        added = Path(self.repo) / ".changeset" / "new-feature.md"
        added.parent.mkdir(parents=True, exist_ok=True)
        added.write_text(CHANGESET, encoding="utf-8")
        _git(self.repo, "add", "-A")
        _git(self.repo, "commit", "-m", "feature")
        self.assertEqual(gate.decide_release_candidate(self.repo, "1"), "skip")

    def test_package_metadata_change_with_added_changeset_is_not_a_release_attempt(self):
        self.repo = tempfile.mkdtemp(prefix="release-gate-")
        _git(self.repo, "init", "-b", "main")
        _commit_tree(self.repo, {"package.json": PKG_BEFORE, "src/index.ts": "export const value = 1;\n"})
        package = Path(self.repo) / "package.json"
        package.write_text(
            PKG_BEFORE.replace(
                '  "dependencies": {',
                '  "bin": {\n    "gbot": "dist/bin/gbot.mjs"\n  },\n'
                '  "dependencies": {',
            ),
            encoding="utf-8",
        )
        added = Path(self.repo) / ".changeset" / "new-feature.md"
        added.parent.mkdir(parents=True, exist_ok=True)
        added.write_text(CHANGESET, encoding="utf-8")
        _git(self.repo, "add", "-A")
        _git(self.repo, "commit", "-m", "package metadata")
        self.assertEqual(gate.decide_release_candidate(self.repo, "1"), "skip")

    def test_valid_version_merge_requests_publish(self):
        self.repo, _base, _head = _init_release_repo(
            {
                "package.json": PKG_AFTER,
                "CHANGELOG.md": CHANGELOG_AFTER,
                ".changeset/sunny-day.md": None,
                ECHO_PATH: ECHO_AFTER,
            }
        )
        self.assertEqual(gate.decide_release_candidate(self.repo, "1"), "publish")

    def test_invalid_candidate_and_rerun_fail_closed(self):
        self.repo, _base, _head = _init_release_repo(
            {
                "package.json": PKG_AFTER,
                "CHANGELOG.md": CHANGELOG_AFTER,
                ".changeset/sunny-day.md": None,
                ECHO_PATH: ECHO_AFTER,
                "src/index.ts": "export const value = 2;\n",
            }
        )
        with self.assertRaises(gate.ReleaseCheckError) as caught:
            gate.decide_release_candidate(self.repo, "1")
        self.assertIn("invalid release candidate", str(caught.exception))
        shutil.rmtree(self.repo, ignore_errors=True)
        self.repo, _base, _head = _init_release_repo(
            {
                "package.json": PKG_AFTER,
                "CHANGELOG.md": CHANGELOG_AFTER,
                ".changeset/sunny-day.md": None,
                ECHO_PATH: ECHO_AFTER,
            }
        )
        with self.assertRaises(gate.ReleaseCheckError) as caught:
            gate.decide_release_candidate(self.repo, "2")
        self.assertIn("run_attempt", str(caught.exception))
        self.assertIn("does not revoke", str(caught.exception))

    def test_gate_is_not_the_future_merge_checker(self):
        source = (HERE / "check_release_candidate_gate.py").read_text(encoding="utf-8")
        self.assertNotIn("evaluate_release_pr(", source)
        self.assertNotIn("npm run release", source)
        workflow = (ROOT / ".github/workflows/release.yml").read_text(encoding="utf-8")
        self.assertIn("needs.release-candidate.outputs.decision == 'publish'", workflow)
        self.assertIn("id-token: none", workflow)


class PublishedCommitTests(unittest.TestCase):
    def tearDown(self):
        repo = getattr(self, "fetched", None)
        if repo:
            shutil.rmtree(repo, ignore_errors=True)

    def test_published_0128_commit_is_a_pure_version_diff(self):
        repo = _repo_with_release_commits()
        if repo != str(ROOT):
            self.fetched = repo
        diff = release_diff.load_tree_diff(repo, RELEASE_PARENT, RELEASE_COMMIT)
        result = _evaluate(diff)
        self.assertEqual(result["version"], "0.12.8")
        self.assertEqual(result["previous_version"], "0.12.7")
        self.assertEqual(result["bump"], "patch")
        self.assertIn(".changeset/release-approval-gate.md", result["consumed_changesets"])
        self.assertEqual(
            gate.decide_release_candidate(repo, "1", RELEASE_COMMIT),
            "publish",
        )


def _repo_with_release_commits() -> str:
    if release_diff.have_commit(str(ROOT), RELEASE_COMMIT) and release_diff.have_commit(
        str(ROOT), RELEASE_PARENT
    ):
        return str(ROOT)
    repo = tempfile.mkdtemp(prefix="release-0128-")
    env = os.environ.copy()
    env["GIT_TERMINAL_PROMPT"] = "0"
    subprocess.run(["git", "-C", repo, "init", "-b", "main"], check=True, env=env)
    # Depth 2 keeps the merge commit's first parent. Depth 1 hides that
    # parent, and `rev-parse <sha>^1` then fails even if the parent object
    # was fetched separately.
    proc = subprocess.run(
        [
            "git",
            "-C",
            repo,
            "fetch",
            "--no-tags",
            "--depth=2",
            PUBLIC_REPO,
            RELEASE_COMMIT + ":refs/release-check/" + RELEASE_COMMIT,
        ],
        check=False,
        capture_output=True,
        timeout=180,
        env=env,
    )
    if (
        proc.returncode != 0
        or not release_diff.have_commit(repo, RELEASE_COMMIT)
        or not release_diff.have_commit(repo, RELEASE_PARENT)
    ):
        raise AssertionError("could not fetch the published 0.12.8 commits")
    return repo


if __name__ == "__main__":
    unittest.main()
