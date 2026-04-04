/**
 * Session file discovery.
 *
 * Locates pi session files on disk. Encapsulates the path encoding
 * convention shared with pi (getDefaultSessionDir) so that changes
 * to session layout only affect this module.
 *
 * All functions are pure / side-effect-free (aside from filesystem reads).
 */

import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';

/** pi agent directory, respects PI_CODING_AGENT_DIR env var. */
export function getAgentDir(): string {
  const envDir = process.env.PI_CODING_AGENT_DIR;
  if (envDir) {
    if (envDir === '~') return os.homedir();
    if (envDir.startsWith('~/')) return os.homedir() + envDir.slice(1);
    return envDir;
  }
  return path.join(os.homedir(), '.pi', 'agent');
}

/** CWD encoding rule, matching pi's getDefaultSessionDir. */
export function cwdToSessionSubdir(cwd: string): string {
  return `--${cwd.replace(/^[\/\\]/, '').replace(/[\/\\:]/g, '-')}--`;
}

/**
 * Find the latest session file (.jsonl) in the CWD session directory
 * with mtime strictly greater than `since` (epoch ms).
 *
 * Returns the absolute path, or null if none found.
 */
export async function findLatestSession(
  since: number,
  debug: (...a: unknown[]) => void = () => {},
): Promise<string | null> {
  const cwdSessionDir = path.join(
    getAgentDir(),
    'sessions',
    cwdToSessionSubdir(process.cwd()),
  );

  let files: string[];
  try {
    files = await fs.promises.readdir(cwdSessionDir);
  } catch {
    return null; // directory doesn't exist
  }

  let latest: { path: string; mtime: number } | null = null;

  for (const file of files) {
    if (!file.endsWith('.jsonl')) continue;
    try {
      const filePath = path.join(cwdSessionDir, file);
      const fstat = await fs.promises.stat(filePath);
      const mtime = fstat.mtimeMs;
      if (mtime > since && (!latest || mtime > latest.mtime)) {
        latest = { path: filePath, mtime };
      }
    } catch {
      debug('findLatestSession: stat error for', file);
    }
  }

  return latest?.path ?? null;
}
