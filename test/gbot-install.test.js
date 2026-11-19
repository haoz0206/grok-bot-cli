import assert from "node:assert/strict";
import { fileURLToPath } from "node:url";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { spawnSync } from "node:child_process";
import test from "node:test";

const CLI = fileURLToPath(new URL("../dist/bin/gbot-install.js", import.meta.url));

const runInstaller = (home, args) => {
  const result = spawnSync(process.execPath, [CLI, ...args, "--json"], {
    encoding: "utf8",
    env: {
      ...process.env,
      HOME: home,
      USERPROFILE: home,
      XDG_CONFIG_HOME: join(home, ".config"),
      APPDATA: join(home, "AppData/Roaming"),
      GROK_BOT_SIDELOAD: "0",
      GROK_BOT_TEST: "1",
    },
    timeout: 30_000,
    windowsHide: true,
  });
  assert.equal(result.status, 0, result.stderr);
  return JSON.parse(result.stdout);
};

test("gbot-install stages, repeats, diagnoses, and uninstalls a Grok Bot bundle", () => {
  const home = mkdtempSync(join(tmpdir(), "gbot-install-home-"));
  try {
    const installed = runInstaller(home, ["install", "grokbot"]);
    assert.equal(installed.host, "grokbot");
    assert.equal(installed.state, "staged");
    assert.equal(installed.plugin, "gbot");

    const repeated = runInstaller(home, ["install", "grokbot"]);
    assert.equal(repeated.state, "already-installed");
    assert.equal(repeated.receipt, installed.receipt);

    const doctor = runInstaller(home, ["doctor", "--host", "grokbot"]);
    const host = doctor.hosts.find(({ host: name }) => name === "grokbot");
    assert.equal(doctor.summary.errors, 0);
    assert.equal(host.bundle.name, "gbot");
    assert.equal(host.receipts[0].state, "consistent");

    const uninstalled = runInstaller(home, ["uninstall", "grokbot"]);
    assert.equal(uninstalled.state, "uninstalled");
    assert.equal(uninstalled.receipt.status, "consumed");
    assert.ok(uninstalled.removed.files.some((path) => path.endsWith("gbot.marketplace.json")));
  } finally {
    rmSync(home, { recursive: true, force: true });
  }
});
