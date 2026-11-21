// Runs the agent-bundle CLI. On Windows, chmod is a no-op and lstat never reports an
// executable bit, so a local build drops `mode: 493` from the manifest and POSIX CI
// fails with AB6004. Emulate POSIX modes: remember what chmod set, and treat files that
// git records as 100755 as 0755.
// shortcut: remove once agent-bundle takes manifest modes from declared executables instead of lstat.
import { execFileSync } from "node:child_process";
import fsp from "node:fs/promises";
import { syncBuiltinESMExports } from "node:module";
import { resolve } from "node:path";

if (process.platform === "win32") {
  const key = (path) => resolve(String(path)).toLowerCase();
  const modes = new Map(
    execFileSync("git", ["ls-files", "-s"], { encoding: "utf8" })
      .split("\n")
      .filter((line) => line.startsWith("100755 "))
      .map((line) => [key(line.split("\t")[1]), 0o755]),
  );
  const chmod = fsp.chmod;
  fsp.chmod = async (path, mode) => {
    modes.set(key(path), Number(mode) & 0o777);
    return chmod(path, mode);
  };
  for (const name of ["lstat", "stat"]) {
    const original = fsp[name];
    fsp[name] = async (path, ...rest) => {
      const metadata = await original(path, ...rest);
      const mode = metadata.isFile() ? modes.get(key(path)) : undefined;
      if (mode !== undefined) Object.defineProperty(metadata, "mode", { value: (metadata.mode & ~0o777) | mode });
      return metadata;
    };
  }
  syncBuiltinESMExports();
}

await import(new URL("../node_modules/agent-bundle/bin/agent-bundle.js", import.meta.url));
