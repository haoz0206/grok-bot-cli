import { readFileSync } from 'node:fs';
import fsp from 'node:fs/promises';
import { syncBuiltinESMExports } from 'node:module';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';

import { runInstallCli } from 'agent-bundle/install';

const from = fileURLToPath(new URL('..', import.meta.url));

// Windows files have no executable bit, so the installer rejects package files the
// manifest marks executable (AB7001), and their staged copies then hash differently.
// Report the manifest mode for those bundle paths, in the package and in staged copies.
// shortcut: remove once agent-bundle's installer ignores executable bits on Windows.
const emulateManifestModes = (root: string): void => {
  const manifest = JSON.parse(readFileSync(join(root, 'agent-bundle.manifest.json'), 'utf8')) as {
    files: { mode?: number; path: string }[];
  };
  const modes = new Map(
    manifest.files
      .filter((file) => file.mode !== undefined && (file.mode & 0o111) !== 0)
      .map((file) => [`/${file.path.toLowerCase()}`, file.mode as number]),
  );
  const modeOf = (path: string): number | undefined => {
    const normalized = path.replaceAll('\\', '/').toLowerCase();
    for (const [suffix, mode] of modes) if (normalized.endsWith(suffix)) return mode;
    return undefined;
  };
  const lstat = fsp.lstat;
  fsp.lstat = (async (path: Parameters<typeof lstat>[0], ...rest: unknown[]) => {
    const metadata = await (lstat as (...args: unknown[]) => Promise<import('node:fs').Stats>)(path, ...rest);
    const mode = metadata.isFile() ? modeOf(String(path)) : undefined;
    if (mode !== undefined) {
      // lstat(path, { bigint: true }) returns bigint fields.
      const value = typeof metadata.mode === 'bigint' ? (metadata.mode & ~0o777n) | BigInt(mode) : (metadata.mode & ~0o777) | mode;
      Object.defineProperty(metadata, 'mode', { value });
    }
    return metadata;
  }) as typeof lstat;
  syncBuiltinESMExports();
};

if (process.platform === 'win32') emulateManifestModes(from);

/**
 * `gbot-install install|uninstall <host>` and `gbot-install doctor`, bound to the
 * emitted npm `dist/` root that holds the Claude, Codex, and Cursor projections.
 */
export const main = (argv: readonly string[]): Promise<number> =>
  runInstallCli(argv, {
    from,
    name: 'gbot-install',
  });
