import assert from "node:assert/strict";
import { execFileSync, spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import test from "node:test";

const script = fileURLToPath(new URL("../scripts/check-artifact.mjs", import.meta.url));
const sha256 = (text) => createHash("sha256").update(text).digest("hex");

test("check-artifact flags files that changed or were added after the last build", (t) => {
  const repo = mkdtempSync(join(tmpdir(), "check-artifact-"));
  t.after(() => rmSync(repo, { force: true, recursive: true }));
  const git = (...args) =>
    execFileSync("git", ["-c", "user.name=t", "-c", "user.email=t@example.com", "-c", "core.autocrlf=false", ...args], { cwd: repo });
  const commit = (path, text) => {
    writeFileSync(join(repo, path), text);
    git("add", "--all");
    git("commit", "--quiet", "--message", path);
  };
  const check = () => spawnSync(process.execPath, [script], { cwd: repo, encoding: "utf8" });

  git("init", "--quiet");
  mkdirSync(join(repo, "artifact"));
  writeFileSync(join(repo, "README.md"), "one\n");
  const manifest = { compiler: { project: { sourceInputs: [{ executable: false, path: "README.md", sha256: sha256("one\n") }] } } };
  commit("artifact/agent-bundle.manifest.json", JSON.stringify(manifest));
  assert.equal(check().status, 0);

  commit("README.md", "two\n");
  let result = check();
  assert.equal(result.status, 1);
  assert.match(result.stderr, /README\.md \(changed\)/);

  commit("README.md", "one\n");
  commit("NOTES.md", "new\n");
  result = check();
  assert.equal(result.status, 1);
  assert.match(result.stderr, /NOTES\.md \(added\)/);
  assert.doesNotMatch(result.stderr, /README\.md/);
});
