import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { defaultPaths, installDesktopShim, renderEnvScript, renderPlist, renderWrapperScript, uninstallDesktopShim } from "../src/core/desktop-shim.js";

function fixture(t, initial = {}) {
  const home = mkdtempSync(join(tmpdir(), "gbot-shim-safe-"));
  t.after(() => rmSync(home, { recursive: true, force: true }));
  const env = { HOME: home, CODEX_HOME: join(home, ".codex") };
  const paths = defaultPaths({ env, home });
  const gui = new Map(Object.entries(initial));
  const calls = [];
  const runner = (file, args) => {
    assert.equal(file, "launchctl");
    calls.push(args);
    const [action, key, value] = args;
    if (action === "setenv") gui.set(key, value);
    if (action === "unsetenv") gui.delete(key);
    return { status: 0, stdout: action === "getenv" ? (gui.get(key) ?? "") + "\n" : "" };
  };
  return { home, env, paths, gui, calls, options: { home, env, platform: "darwin", runner } };
}

test("uninstall without a recognized installation leaves GUI values and launch agents alone", t => {
  const f = fixture(t, { CODEX_CLI_PATH: "/operator/codex", CODEX_HOME: "/operator/home", CODEX_APP_SERVER_USE_LOCAL_DAEMON: "custom", CODEX_APP_SERVER_WS_URL: "ws://operator" });
  const before = new Map(f.gui);
  const result = uninstallDesktopShim(f.options);
  assert.deepEqual(f.gui, before);
  assert.deepEqual(f.calls, []);
  assert.deepEqual(result.removed, []);
  assert.equal(result.plistRemoved, false);
});

test("owned uninstall clears matching CLI and daemon values, preserving HOME and WS", t => {
  const f = fixture(t);
  installDesktopShim(f.options);
  f.gui.set("CODEX_HOME", f.paths.codexHome);
  f.gui.set("CODEX_APP_SERVER_WS_URL", "ws://operator");
  f.calls.length = 0;
  const result = uninstallDesktopShim(f.options);
  assert.equal(f.gui.has("CODEX_CLI_PATH"), false);
  assert.equal(f.gui.has("CODEX_APP_SERVER_USE_LOCAL_DAEMON"), false);
  assert.equal(f.gui.get("CODEX_HOME"), f.paths.codexHome);
  assert.equal(f.gui.get("CODEX_APP_SERVER_WS_URL"), "ws://operator");
  assert.deepEqual(result.removed.sort(), [f.paths.wrapperPath, f.paths.bridgePath, f.paths.envScriptPath].sort());
  assert.equal(result.plistRemoved, true);
  assert.equal(f.calls.filter(([action]) => action === "bootout").length, typeof process.getuid === "function" ? 1 : 0);
  const after = new Map(f.gui);
  f.calls.length = 0;
  uninstallDesktopShim(f.options);
  assert.deepEqual(f.gui, after);
  assert.deepEqual(f.calls, []);
});

for (const foreign of ["CLI", "daemon"]) test(`uninstall preserves a foreign current ${foreign} value`, t => {
  const f = fixture(t);
  installDesktopShim(f.options);
  f.gui.set("CODEX_HOME", "/operator/home");
  f.gui.set("CODEX_APP_SERVER_WS_URL", "ws://operator");
  f.gui.set(foreign === "CLI" ? "CODEX_CLI_PATH" : "CODEX_APP_SERVER_USE_LOCAL_DAEMON", "/operator/value");
  uninstallDesktopShim(f.options);
  assert.equal(f.gui.get("CODEX_HOME"), "/operator/home");
  assert.equal(f.gui.get("CODEX_APP_SERVER_WS_URL"), "ws://operator");
  if (foreign === "CLI") {
    assert.equal(f.gui.get("CODEX_CLI_PATH"), "/operator/value");
    assert.equal(f.gui.get("CODEX_APP_SERVER_USE_LOCAL_DAEMON"), "1");
  } else {
    assert.equal(f.gui.has("CODEX_CLI_PATH"), false);
    assert.equal(f.gui.get("CODEX_APP_SERVER_USE_LOCAL_DAEMON"), "/operator/value");
  }
});

test("modified artifacts survive uninstall and an unowned plist is never booted out", t => {
  const f = fixture(t);
  installDesktopShim(f.options);
  const wrapper = readFileSync(f.paths.wrapperPath, "utf8") + "\n# operator change\n";
  const plist = readFileSync(f.paths.plistPath, "utf8") + "\n<!-- operator change -->\n";
  writeFileSync(f.paths.wrapperPath, wrapper);
  writeFileSync(f.paths.plistPath, plist);
  f.calls.length = 0;
  const result = uninstallDesktopShim(f.options);
  assert.equal(readFileSync(f.paths.wrapperPath, "utf8"), wrapper);
  assert.equal(readFileSync(f.paths.plistPath, "utf8"), plist);
  assert.equal(f.calls.some(([action]) => action === "bootout" || action === "unsetenv"), false);
  assert.ok(result.warnings.some(w => w.includes(f.paths.wrapperPath)));
  assert.ok(result.warnings.some(w => w.includes(f.paths.plistPath)));
});

test("partial owned installs remove only generated files and never boot out a missing plist", t => {
  const f = fixture(t);
  mkdirSync(f.paths.binDir, { recursive: true });
  writeFileSync(f.paths.wrapperPath, renderWrapperScript(f.paths));
  writeFileSync(f.paths.envScriptPath, "#!/bin/bash\n# operator script\n");
  f.gui.set("CODEX_CLI_PATH", f.paths.wrapperPath);
  f.gui.set("CODEX_APP_SERVER_USE_LOCAL_DAEMON", "1");
  const result = uninstallDesktopShim(f.options);
  assert.deepEqual(result.removed, [f.paths.wrapperPath]);
  assert.equal(existsSync(f.paths.envScriptPath), true);
  assert.equal(f.calls.some(([action]) => action === "bootout"), false);
  assert.equal(f.gui.has("CODEX_CLI_PATH"), false);
  assert.equal(f.gui.has("CODEX_APP_SERVER_USE_LOCAL_DAEMON"), false);
});

test("a symlink at an artifact path is preserved with its target", { skip: process.platform === "win32" }, t => {
  const f = fixture(t);
  mkdirSync(f.paths.binDir, { recursive: true });
  const target = join(f.home, "operator-wrapper");
  writeFileSync(target, renderWrapperScript(f.paths));
  symlinkSync(target, f.paths.wrapperPath);
  const result = uninstallDesktopShim(f.options);
  assert.equal(existsSync(f.paths.wrapperPath), true);
  assert.equal(existsSync(target), true);
  assert.deepEqual(result.removed, []);
  assert.deepEqual(f.calls, []);
  assert.ok(result.warnings.some(w => w.includes(f.paths.wrapperPath)));
});

test("generated shell defaults are literal paths and runtime overrides still work", { skip: process.platform === "win32" }, t => {
  const f = fixture(t);
  const dir = join(f.home, "literal $(touch substitution) `touch backtick` ' \" \\ &<>");
  mkdirSync(dir);
  const paths = defaultPaths({ home: f.home, env: { HOME: f.home, CODEX_HOME: dir } });
  mkdirSync(paths.binDir);
  mkdirSync(join(dir, "packages", "standalone", "current", "bin"), { recursive: true });
  writeFileSync(paths.realPath, '#!/bin/bash\nprintf "%s\\n" "$CODEX_HOME" "$@"\n', { mode: 0o755 });
  writeFileSync(paths.wrapperPath, renderWrapperScript(paths), { mode: 0o755 });
  const shellEnv = { PATH: process.env.PATH, HOME: f.home };
  const args = ["--version", "a 'quoted' $literal \\ argument"];
  const run = env => spawnSync("bash", [paths.wrapperPath, ...args], { cwd: f.home, env, encoding: "utf8" });
  const out = run(shellEnv);
  assert.equal(out.status, 0, out.stderr);
  assert.equal(out.stdout, [dir, ...args, ""].join("\n"));
  const override = join(f.home, "override");
  writeFileSync(override, '#!/bin/bash\nprintf "OVERRIDE %s\\n" "$CODEX_HOME"\n', { mode: 0o755 });
  assert.equal(run({ ...shellEnv, CODEX_DESKTOP_WRAPPER_REAL: override, CODEX_HOME: "/runtime/home" }).stdout, "OVERRIDE /runtime/home\n");
  const fakeBin = join(f.home, "fake-bin");
  mkdirSync(fakeBin);
  writeFileSync(join(fakeBin, "launchctl"), '#!/bin/bash\nprintf "%s\\0" "$@" >>"$CALLS"\n', { mode: 0o755 });
  writeFileSync(paths.envScriptPath, renderEnvScript(paths));
  const callsPath = join(f.home, "launchctl-calls");
  const login = spawnSync("bash", [paths.envScriptPath], { cwd: f.home, env: { ...shellEnv, PATH: fakeBin + ":" + shellEnv.PATH, CALLS: callsPath }, encoding: "utf8" });
  assert.equal(login.status, 0, login.stderr);
  assert.ok(readFileSync(callsPath, "utf8").includes("CODEX_HOME\0" + dir + "\0"));
  assert.equal(existsSync(join(f.home, "substitution")), false);
  assert.equal(existsSync(join(f.home, "backtick")), false);
});

test("generated plist escapes paths as XML text", { skip: process.platform === "win32" }, () => {
  const envScriptPath = '/literal & <path> "quoted" \'single\'/env.sh';
  const label = 'label & <value> "quoted"';
  const out = spawnSync("python3", ["-c", "import json,plistlib,sys; p=plistlib.loads(sys.stdin.buffer.read()); print(json.dumps([p['Label'],p['ProgramArguments'][1]]))"], { input: renderPlist({ envScriptPath, label }), encoding: "utf8" });
  assert.equal(out.status, 0, out.stderr);
  assert.deepEqual(JSON.parse(out.stdout), [label, envScriptPath]);
});
