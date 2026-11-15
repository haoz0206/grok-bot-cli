import { spawnSync } from "node:child_process";
import { chmodSync, lstatSync, mkdirSync, readFileSync, rmSync, statSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";

import { BRIDGE_SOURCE } from "./desktop-shim-bridge.js";

/**
 * ChatGPT Desktop -> managed Codex daemon shim (CODEX_CLI_PATH bridge).
 *
 * Desktop injects `codex_app` overrides so CODEX_APP_SERVER_USE_LOCAL_DAEMON=1
 * alone cannot select the managed daemon, and stock `codex app-server proxy`
 * hangs for Desktop stdio. The winning path is a wrapper on CODEX_CLI_PATH
 * that rewrites Desktop's `codex ... app-server` spawn into the stdio<->WS
 * bridge (desktop-shim-bridge.js) onto the managed control socket.
 * Provenance: uploads/codex-desktop-to-daemon + codex-desktop-shared-daemon-env.sh.
 *
 * Fail-open is the hard rule: the wrapper execs the real standalone `codex`
 * for non-app-server spawns and whenever the bridge/python/socket side is
 * missing or broken. Never touches Desktop binaries, /tmp/codex-browser-use/,
 * or CODEX_APP_TOOLS_PIPE_PATH. No protocol change: gbot already speaks the
 * managed control socket.
 */

export const SHIM_LABEL = "com.zackjackson.codex-desktop-shared-daemon";
const WRAPPER_FILENAME = "codex-desktop-to-daemon";
const BRIDGE_FILENAME = "codex-stdio-to-daemon-ws.py";
const ENV_SCRIPT_FILENAME = "codex-desktop-shared-daemon-env.sh";
const BRIDGE_LOG_FILENAME = "codex-stdio-to-daemon-ws.log";
const WRAPPER_LOG_FILENAME = "codex-desktop-to-daemon.log";
const ENV_LOG_FILENAME = "codex-desktop-shared-daemon-env.log";
const STANDALONE_REAL_SUFFIX = join("packages", "standalone", "current", "bin", "codex");

function userHomeDir(env = process.env) {
  return env.HOME || homedir();
}

export function defaultPaths({ env = process.env, home = userHomeDir(env) } = {}) {
  const codexHome = env.CODEX_HOME || join(home, ".codex");
  const binDir = join(codexHome, "bin");
  return {
    binDir,
    bridgeLogPath: join(binDir, BRIDGE_LOG_FILENAME),
    bridgePath: join(binDir, BRIDGE_FILENAME),
    codexHome,
    envLogPath: join(binDir, ENV_LOG_FILENAME),
    envScriptPath: join(binDir, ENV_SCRIPT_FILENAME),
    label: SHIM_LABEL,
    launchAgentsDir: join(home, "Library", "LaunchAgents"),
    plistPath: join(home, "Library", "LaunchAgents", `${SHIM_LABEL}.plist`),
    realPath: join(codexHome, STANDALONE_REAL_SUFFIX),
    socketPath: join(codexHome, "app-server-control", "app-server-control.sock"),
    wrapperLogPath: join(binDir, WRAPPER_LOG_FILENAME),
    wrapperPath: join(binDir, WRAPPER_FILENAME),
  };
}

/**
 * Pure passthrough decision, mirroring the wrapper's argv scan. True only for
 * a bare `app-server` spawn: Desktop's private-stdio case. `daemon`, `proxy`,
 * schema generations, and one-shot startup/help/version requests exec real Codex.
 */
export function shouldBridge(argv) {
  let appServer = false;
  let daemon = false;
  let proxy = false;
  let generate = false;
  let oneShot = false;
  for (const arg of argv ?? []) {
    if (["--print-startup-config", "--startup-sign-out", "help", "--help", "-h", "--version", "-V"].includes(arg)) oneShot = true;
    if (arg === "app-server") appServer = true;
    else if (arg === "daemon") daemon = true;
    else if (arg === "proxy") proxy = true;
    else if (arg === "generate-ts" || arg === "generate-json-schema") generate = true;
  }
  return appServer && !daemon && !proxy && !generate && !oneShot;
}

const shellQuote = value => `'${value.replaceAll("'", "'\\''")}'`;
const xmlText = value => value.replaceAll("&", "&amp;").replaceAll("<", "&lt;").replaceAll(">", "&gt;").replaceAll('"', "&quot;").replaceAll("'", "&apos;");
const shellDefault = (name, override, value, exported = false) => `DEFAULT_${name}=${shellQuote(value)}\n${exported ? "export " : ""}${name}="\${${override}:-$DEFAULT_${name}}"`;
const legacyShellDefault = (name, override, value, exported = false) => `${exported ? "export " : ""}${name}="\${${override}:-${value}}"`;

export function renderWrapperScript(paths) {
  return wrapperScript(paths, shellDefault);
}

function wrapperScript({ realPath, bridgePath, wrapperLogPath, codexHome, bridgeLogPath }, defaultPath) {
  return `#!/bin/bash
# Installed by \`gbot codex desktop-shim install\`. Rewrites ChatGPT Desktop's
# \`codex ... app-server\` spawn into a stdio<->WebSocket bridge onto the managed
# daemon's control socket. Reversible: \`gbot codex desktop-shim uninstall\`.
# Startup configuration, sign-out, help and version requests use the real CLI.
# The daemon is kept up by the LaunchAgent login script, not here: this hot path
# never starts the daemon itself, so a wedged daemon lock cannot hang
# Desktop. Fail-open runs ONLY while stdio is still pristine (no stdin
# consumed, no stdout written): an absent socket fails the preflight and a
# pre-session bridge failure (exit 1) falls through
# to the real standalone codex on pristine stdio. A mid-session bridge failure
# (exit 2+) exits promptly so Desktop reconnects; the fallback never runs on
# half-consumed stdin or dirty stdout. Bridge exit 0 means it served the session. Never touches
# Desktop binaries or its private tool pipe.
set -u
${defaultPath("REAL", "CODEX_DESKTOP_WRAPPER_REAL", realPath)}
${defaultPath("BRIDGE", "CODEX_DESKTOP_BRIDGE", bridgePath)}
${defaultPath("CODEX_HOME", "CODEX_HOME", codexHome, true)}
SOCK="\${CODEX_APP_SERVER_SOCK:-$CODEX_HOME/app-server-control/app-server-control.sock}"
${defaultPath("BRIDGE_LOG", "CODEX_STDIO_BRIDGE_LOG", bridgeLogPath)}
${defaultPath("LOG", "CODEX_DESKTOP_WRAPPER_LOG", wrapperLogPath)}
export CODEX_APP_SERVER_SOCK="$SOCK"
export CODEX_STDIO_BRIDGE_LOG="$BRIDGE_LOG"
ts() { date -u +%Y-%m-%dT%H:%M:%SZ; }
echo "$(ts) argv: $*" >>"$LOG" 2>/dev/null || true

if [[ ! -x "$REAL" ]]; then
  FALLBACK="$(command -v codex 2>/dev/null || true)"
  if [[ -n "$FALLBACK" && -x "$FALLBACK" ]]; then
    if [[ "$FALLBACK" -ef "$0" ]] 2>/dev/null || { [[ -n "\${CODEX_CLI_PATH:-}" ]] && [[ "$FALLBACK" -ef "\${CODEX_CLI_PATH}" ]] 2>/dev/null; }; then
      echo "$(ts) refusing self fallback $FALLBACK" >>"$LOG" 2>/dev/null || true
    else
      REAL="$FALLBACK"
    fi
  fi
fi

has_app_server=0; has_daemon=0; has_proxy=0; has_generate=0; has_one_shot=0
for a in "$@"; do
  case "$a" in
    --print-startup-config|--startup-sign-out|help|--help|-h|--version|-V) has_one_shot=1 ;;
    app-server) has_app_server=1 ;;
    daemon) has_daemon=1 ;;
    proxy) has_proxy=1 ;;
    generate-ts|generate-json-schema) has_generate=1 ;;
  esac
done

# Preflight the daemon socket with a short deadline: a refused/absent socket
# means starting the bridge could never succeed, so skip straight to real codex.
preflight() {
  python3 -c 'import os,socket,sys; s=socket.socket(socket.AF_UNIX,socket.SOCK_STREAM); s.settimeout(float(os.environ.get("CODEX_DESKTOP_PREFLIGHT_TIMEOUT","3"))); s.connect(sys.argv[1]); s.close()' "$SOCK" 2>/dev/null
}

if [[ "$has_app_server" -eq 1 && "$has_daemon" -eq 0 && "$has_proxy" -eq 0 && "$has_generate" -eq 0 && "$has_one_shot" -eq 0 ]]; then
  if [[ -f "$BRIDGE" ]] && command -v python3 >/dev/null 2>&1; then
    if preflight; then
      echo "$(ts) rewrite -> stdio-ws bridge" >>"$LOG" 2>/dev/null || true
      python3 "$BRIDGE"
      rc=$?
      case "$rc" in
        0)
          echo "$(ts) bridge served session" >>"$LOG" 2>/dev/null || true
          exit 0
          ;;
        1)
          echo "$(ts) bridge failed before session start, falling through to real codex" >>"$LOG" 2>/dev/null || true
          ;;
        *)
          echo "$(ts) bridge failed mid-session (rc=$rc); exiting so Desktop reconnects" >>"$LOG" 2>/dev/null || true
          exit "$rc"
          ;;
      esac
    else
      echo "$(ts) daemon socket unreachable, passthrough to real codex" >>"$LOG" 2>/dev/null || true
    fi
  else
    echo "$(ts) bridge unavailable, passthrough to real codex" >>"$LOG" 2>/dev/null || true
  fi
fi
if [[ -x "$REAL" ]]; then
  exec "$REAL" "$@"
fi
echo "codex-desktop-to-daemon: no runnable codex found" >&2
exit 1
`;
}

export function renderEnvScript(paths) {
  return envScript(paths, shellQuote);
}

function envScript({ wrapperPath, realPath, envLogPath, codexHome }, quote) {
  return `#!/bin/bash
# Installed by \`gbot codex desktop-shim install\`. Re-applies the GUI-domain env
# so ChatGPT.app inherits CODEX_CLI_PATH after login, then best-effort starts the
# managed daemon (this login script — never Desktop's spawn hot path — owns
# daemon upkeep). No -e: every step is best-effort so login never breaks.
# Revert: \`gbot codex desktop-shim uninstall\`.
set -u
WRAPPER=${quote(wrapperPath)}
REAL=${quote(realPath)}
LOG=${quote(envLogPath)}
CODEX_HOME_DIR=${quote(codexHome)}
# One CODEX_HOME for the GUI domain and this script's own daemon start, so the
# daemon that is kept up is the one the wrapper bridges to.
export CODEX_HOME="$CODEX_HOME_DIR"
ts() { date -u +%Y-%m-%dT%H:%M:%SZ; }
{
  echo "$(ts) start"
  if [[ ! -x "$WRAPPER" ]]; then
    echo "$(ts) missing wrapper: $WRAPPER"
    exit 0
  fi
  # GUI domain setenv so ChatGPT.app inherits CODEX_CLI_PATH after login
  launchctl setenv CODEX_CLI_PATH "$WRAPPER"
  launchctl setenv CODEX_HOME "$CODEX_HOME_DIR"
  launchctl setenv CODEX_APP_SERVER_USE_LOCAL_DAEMON 1
  launchctl unsetenv CODEX_APP_SERVER_WS_URL 2>/dev/null || true
  echo "$(ts) CODEX_CLI_PATH=$(launchctl getenv CODEX_CLI_PATH)"
  if [[ -x "$REAL" ]]; then
    # launchd gives login jobs a 256-file soft limit; a busy daemon (many threads, shell pipes,
    # sqlite handles) exhausts it ("Too many open files") and turns fail. Raise it before the
    # daemon starts: it inherits this limit.
    ulimit -n 65536 2>/dev/null || ulimit -n 10240 2>/dev/null || ulimit -n "$(ulimit -Hn)" 2>/dev/null || true
    echo "$(ts) open-file limit $(ulimit -n)"
    "$REAL" app-server daemon start >/dev/null 2>&1 || true
    echo "$(ts) daemon start attempted"
  fi
  echo "$(ts) done"
} >>"$LOG" 2>&1
`;
}

export function renderPlist(paths) {
  return plist(paths, xmlText);
}

function plist({ envScriptPath, label = SHIM_LABEL }, text) {
  return `<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0">
<dict>
\t<key>Label</key>
\t<string>${text(label)}</string>
\t<key>ProgramArguments</key>
\t<array>
\t\t<string>/bin/bash</string>
\t\t<string>${text(envScriptPath)}</string>
\t</array>
\t<key>RunAtLoad</key>
\t<true/>
\t<key>LimitLoadToSessionType</key>
\t<string>Aqua</string>
</dict>
</plist>
`;
}

const defaultRunner = (file, args) => {
  try {
    return spawnSync(file, args, { encoding: "utf8", timeout: 15000 });
  } catch (error) {
    return { error, status: null };
  }
};

function runBestEffort(runner, warnings, what, file, args) {
  const out = runner(file, args);
  if (out && (out.error || (typeof out.status === "number" && out.status !== 0))) {
    const detail = (out.error && out.error.message) || (out.stderr && String(out.stderr).trim()) || `exit ${out.status}`;
    warnings.push(`${what} failed (${detail}); continuing`);
  }
  return out;
}

function writeExecutable(path, content) {
  writeFileSync(path, content, { mode: 0o755 });
  chmodSync(path, 0o755);
}

function isExecutable(path) {
  try {
    return (statSync(path).mode & 0o111) !== 0;
  } catch {
    return false;
  }
}

function fileExists(path) {
  try {
    statSync(path);
    return true;
  } catch {
    return false;
  }
}

/**
 * Copy the wrapper + bridge + login env script out of the package into durable
 * ~/.codex paths (never a git checkout), then persist CODEX_CLI_PATH for the
 * macOS Aqua session via LaunchAgent. Idempotent.
 */
export function installDesktopShim({
  env = process.env,
  home = userHomeDir(env),
  platform = process.platform,
  runner = defaultRunner,
} = {}) {
  const paths = defaultPaths({ env, home });
  const warnings = [];
  mkdirSync(paths.binDir, { recursive: true });
  writeExecutable(paths.wrapperPath, renderWrapperScript(paths));
  writeFileSync(paths.bridgePath, BRIDGE_SOURCE.endsWith("\n") ? BRIDGE_SOURCE : `${BRIDGE_SOURCE}\n`, { mode: 0o644 });
  writeExecutable(paths.envScriptPath, renderEnvScript(paths));

  let persisted = false;
  if (platform === "darwin") {
    mkdirSync(paths.launchAgentsDir, { recursive: true });
    writeFileSync(paths.plistPath, renderPlist({ envScriptPath: paths.envScriptPath }), { mode: 0o644 });
    const uid = typeof process.getuid === "function" ? process.getuid() : null;
    if (uid === null || uid === undefined) {
      warnings.push("could not determine uid; LaunchAgent file written but not bootstrapped — log out/in or bootstrap it manually");
    } else {
      const target = `gui/${uid}/${paths.label}`;
      runBestEffort(runner, warnings, "launchctl bootout (previous agent)", "launchctl", ["bootout", target]);
      runBestEffort(runner, warnings, "launchctl bootstrap", "launchctl", ["bootstrap", `gui/${uid}`, paths.plistPath]);
    }
    runBestEffort(runner, warnings, "launchctl setenv CODEX_CLI_PATH", "launchctl", ["setenv", "CODEX_CLI_PATH", paths.wrapperPath]);
    runBestEffort(runner, warnings, "launchctl setenv CODEX_APP_SERVER_USE_LOCAL_DAEMON", "launchctl", [
      "setenv",
      "CODEX_APP_SERVER_USE_LOCAL_DAEMON",
      "1",
    ]);
    runBestEffort(runner, warnings, "launchctl unsetenv CODEX_APP_SERVER_WS_URL", "launchctl", [
      "unsetenv",
      "CODEX_APP_SERVER_WS_URL",
    ]);
    persisted = true;
  } else {
    warnings.push("LaunchAgent persistence is macOS-only; wrapper and bridge installed — export CODEX_CLI_PATH manually");
  }

  if (isExecutable(paths.realPath)) {
    runBestEffort(runner, warnings, "codex app-server daemon start", paths.realPath, ["app-server", "daemon", "start"]);
  } else {
    warnings.push(`managed daemon not started: no executable at ${paths.realPath}`);
  }

  return {
    action: "install",
    bridgePath: paths.bridgePath,
    envScriptPath: paths.envScriptPath,
    exitCode: 0,
    persisted,
    plistPath: platform === "darwin" ? paths.plistPath : null,
    realPath: paths.realPath,
    warnings,
    wrapperPath: paths.wrapperPath,
  };
}

/** Remove recognized generated files and GUI values still owned by the shim. */
export function uninstallDesktopShim({
  env = process.env,
  home = userHomeDir(env),
  platform = process.platform,
  runner = defaultRunner,
} = {}) {
  const paths = defaultPaths({ env, home });
  const warnings = [];
  const removed = [];
  const artifacts = [
    [paths.wrapperPath, [renderWrapperScript(paths), wrapperScript(paths, legacyShellDefault)]],
    [paths.bridgePath, [BRIDGE_SOURCE.endsWith("\n") ? BRIDGE_SOURCE : `${BRIDGE_SOURCE}\n`]],
    [paths.envScriptPath, [renderEnvScript(paths), envScript(paths, value => `"${value}"`)]],
    ...(platform === "darwin" ? [[paths.plistPath, [renderPlist(paths), plist(paths, value => value)]]] : []),
  ];
  const owned = new Set();
  for (const [path, contents] of artifacts) {
    try {
      if (lstatSync(path).isFile() && contents.includes(readFileSync(path, "utf8"))) owned.add(path);
      else warnings.push(`preserving unrecognized or modified artifact ${path}`);
    } catch (error) {
      if (error.code !== "ENOENT") warnings.push(`could not inspect ${path} (${error instanceof Error ? error.message : String(error)}); preserving it`);
    }
  }

  const guiValue = key => {
    try {
      const out = runBestEffort(runner, warnings, `launchctl getenv ${key}`, "launchctl", ["getenv", key]);
      return out && !out.error && out.status === 0 && typeof out.stdout === "string" ? out.stdout.replace(/\r?\n$/, "") : null;
    } catch (error) {
      warnings.push(`launchctl getenv ${key} failed (${error instanceof Error ? error.message : String(error)}); preserving GUI environment`);
      return null;
    }
  };
  let clearCli = false, clearDaemon = false;
  if (platform === "darwin" && owned.has(paths.wrapperPath)) {
    clearCli = guiValue("CODEX_CLI_PATH") === paths.wrapperPath;
    clearDaemon = guiValue("CODEX_APP_SERVER_USE_LOCAL_DAEMON") === "1";
  }
  if (platform === "darwin" && owned.has(paths.plistPath)) {
    const uid = typeof process.getuid === "function" ? process.getuid() : null;
    if (uid !== null && uid !== undefined) {
      runBestEffort(runner, warnings, "launchctl bootout", "launchctl", ["bootout", `gui/${uid}/${paths.label}`]);
    }
  }
  let plistRemoved = false;
  for (const path of owned) {
    try {
      rmSync(path);
      if (path === paths.plistPath) plistRemoved = true;
      else removed.push(path);
    } catch (error) {
      warnings.push(`could not remove ${path} (${error instanceof Error ? error.message : String(error)})`);
    }
  }
  if (clearCli) {
    runBestEffort(runner, warnings, "launchctl unsetenv CODEX_CLI_PATH", "launchctl", ["unsetenv", "CODEX_CLI_PATH"]);
    if (clearDaemon) runBestEffort(runner, warnings, "launchctl unsetenv CODEX_APP_SERVER_USE_LOCAL_DAEMON", "launchctl", ["unsetenv", "CODEX_APP_SERVER_USE_LOCAL_DAEMON"]);
  }
  return {
    action: "uninstall",
    exitCode: 0,
    plistPath: platform === "darwin" ? paths.plistPath : null,
    plistRemoved,
    removed,
    warnings,
    wrapperPath: paths.wrapperPath,
  };
}

function socketStateOf(path) {
  try {
    return statSync(path).isSocket() ? "socket" : "not-a-socket";
  } catch (error) {
    return error && (error.code === "EACCES" || error.code === "EPERM") ? "permission-denied" : "absent";
  }
}

/**
 * Inspect the shim without touching Desktop, pipes, or sockets beyond a stat.
 * On macOS the Desktop-facing CODEX_CLI_PATH lives in launchd's GUI domain,
 * which a shell-spawned `gbot` does not inherit — so status queries
 * `launchctl getenv` there (via the injectable runner) and reports the caller
 * environment separately. Elsewhere the process env is the whole story.
 */
export function desktopShimStatus({
  env = process.env,
  home = userHomeDir(env),
  platform = process.platform,
  runner = defaultRunner,
} = {}) {
  const paths = defaultPaths({ env, home });
  const warnings = [];
  const wrapperPresent = fileExists(paths.wrapperPath);
  const bridgePresent = fileExists(paths.bridgePath);
  const envScriptPresent = fileExists(paths.envScriptPath);
  const plistPresent = platform === "darwin" ? fileExists(paths.plistPath) : false;
  const cliPath = env.CODEX_CLI_PATH || null;
  let guiCliPath = null;
  if (platform === "darwin") {
    try {
      const out = runner("launchctl", ["getenv", "CODEX_CLI_PATH"]);
      const value = out && typeof out.stdout === "string" ? out.stdout.trim() : "";
      guiCliPath = value || null;
      if (out && (out.error || (typeof out.status === "number" && out.status !== 0))) {
        warnings.push("launchctl getenv CODEX_CLI_PATH failed; GUI-domain state unknown");
        guiCliPath = null;
      }
    } catch (error) {
      warnings.push(`launchctl getenv CODEX_CLI_PATH failed (${error instanceof Error ? error.message : String(error)})`);
      guiCliPath = null;
    }
  }
  // Desktop-facing value: the GUI domain on macOS, the caller env elsewhere.
  const desktopCliPath = platform === "darwin" ? guiCliPath : cliPath;
  const installed = wrapperPresent && isExecutable(paths.wrapperPath) && bridgePresent;
  // Effective socket, resolved exactly like gbot's own client (CODEX_APP_SERVER_SOCK
  // wins, else the install-time CODEX_HOME) so status and send/queue/status never
  // disagree. Inlined here so codex-bridge can reuse desktopShimStatus without a cycle.
  const socketPath = env.CODEX_APP_SERVER_SOCK
    || join(paths.codexHome, "app-server-control", "app-server-control.sock");
  return {
    action: "status",
    bridgePath: paths.bridgePath,
    bridgePresent,
    cliPath,
    codexHome: paths.codexHome,
    desktopCliPath,
    envScriptPath: paths.envScriptPath,
    envScriptPresent,
    exitCode: installed ? 0 : 1,
    guiCliPath,
    installed,
    persisted: platform === "darwin" ? plistPresent : null,
    platform,
    plistPath: platform === "darwin" ? paths.plistPath : null,
    plistPresent,
    realPath: paths.realPath,
    socketPath,
    socketSource: env.CODEX_APP_SERVER_SOCK ? "CODEX_APP_SERVER_SOCK" : "CODEX_HOME",
    socketState: socketStateOf(socketPath),
    warnings,
    wrapperExecutable: wrapperPresent && isExecutable(paths.wrapperPath),
    wrapperPath: paths.wrapperPath,
    wrapperPointsAtShim: desktopCliPath === paths.wrapperPath,
    wrapperPresent,
  };
}
