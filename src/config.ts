/**
 * Unified configuration.
 *
 * Priority: CLI args > ENV > defaults.
 * All tunable parameters live here; other modules access via cfg.xxx.
 */

import { execFileSync } from 'node:child_process';
import * as fs from 'node:fs';
import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);

// ── Defaults ──

export const DEFAULTS = {
  shell: 'bash',
  maxContext: 20,
  headLines: 50,
  tailLines: 30,
  lineWidth: 512,
  toolResultLines: 10,
} as const;

// ── Config type ──

export interface Config {
  /** Shell type (bash | zsh) */
  shell: 'bash' | 'zsh';
  /** Resolved shell binary path */
  shellPath: string;
  /** Resolved pi binary path */
  piPath: string;
  /** Version string from package.json */
  version: string;
  /** Disable agent (for debugging; CNF passes through) */
  noAgent: boolean;

  // ── Context truncation ──
  maxContext: number;
  headLines: number;
  tailLines: number;
  lineWidth: number;

  // ── Rendering ──
  toolResultLines: number;

  /** Hide startup banner */
  noBanner: boolean;
}

// ── Version ──

function readVersion(): string {
  try {
    return require('../package.json').version || '0.0.0';
  } catch {
    return '0.0.0';
  }
}

// ── Parse helpers ──

export function envInt(key: string, fallback: number): number {
  const v = process.env[key];
  if (!v) return fallback;
  const n = parseInt(v, 10);
  return Number.isFinite(n) && n > 0 ? n : fallback;
}

/**
 * Resolve a binary name or path to its full path.
 * Contains '/' → validate as path; otherwise → which lookup.
 * Returns null if not found.
 */
export function resolveBinary(nameOrPath: string): string | null {
  if (nameOrPath.includes('/')) {
    try {
      fs.accessSync(nameOrPath, fs.constants.X_OK);
      return nameOrPath;
    } catch {
      return null;
    }
  }
  try {
    return execFileSync('which', [nameOrPath], {
      encoding: 'utf-8',
      stdio: ['pipe', 'pipe', 'pipe'],
    }).trim();
  } catch {
    return null;
  }
}

/** Infer shell type from binary path basename. */
export function inferShellType(shellPath: string): 'bash' | 'zsh' | null {
  const base = shellPath.split('/').pop() ?? '';
  if (base === 'bash' || base.startsWith('bash')) return 'bash';
  if (base === 'zsh' || base.startsWith('zsh')) return 'zsh';
  return null;
}

// ── CLI parsing ──

interface CliArgs {
  shell?: string; // positional arg or --shell
  pi?: string; // --pi
  noAgent: boolean;
  help: boolean;
  version: boolean;
}

export function parseArgs(argv: string[]): CliArgs {
  const args = argv.slice(2); // skip node, script
  const result: CliArgs = { noAgent: false, help: false, version: false };

  let i = 0;
  while (i < args.length) {
    const a = args[i];
    if (a === '--help' || a === '-h') {
      result.help = true;
    } else if (a === '--version' || a === '-v') {
      result.version = true;
    } else if (a === '--shell' || a === '-s') {
      result.shell = args[++i];
    } else if (a.startsWith('--shell=')) {
      result.shell = a.slice('--shell='.length);
    } else if (a === '--pi') {
      result.pi = args[++i];
    } else if (a.startsWith('--pi=')) {
      result.pi = a.slice('--pi='.length);
    } else if (a === '--no-agent') {
      result.noAgent = true;
    } else if (!a.startsWith('-') && !result.shell) {
      // Positional argument = shell
      result.shell = a;
    }
    i++;
  }
  return result;
}

// ── Help ──

function printHelp(version: string): void {
  process.stderr.write(`pish v${version} — Pi-Integrated Shell

Usage: pish [options] [shell]

Arguments:
  shell               bash, zsh, or path (default: bash)

Options:
  -s, --shell <name>  Shell name or path
  --pi <path>         Path to pi binary (default: pi in PATH)
  --no-agent          Disable agent (CNF passes through, for debugging)
  -v, --version       Show version
  -h, --help          Show help

Environment variables:
  PISH_SHELL          Shell name or path (default: $SHELL or bash)
  PISH_PI             Path to pi binary
  PISH_MAX_CONTEXT    Max context entries (default: ${DEFAULTS.maxContext})
  PISH_HEAD_LINES     Output head lines (default: ${DEFAULTS.headLines})
  PISH_TAIL_LINES     Output tail lines (default: ${DEFAULTS.tailLines})
  PISH_LINE_WIDTH     Max line width (default: ${DEFAULTS.lineWidth})
  PISH_TOOL_LINES     Tool result lines (default: ${DEFAULTS.toolResultLines})
  PISH_LOG            Event log (stderr or file path)
  PISH_DEBUG          Debug log file path
  PISH_NO_BANNER      Hide startup banner (set to 1)

Priority: CLI args > ENV > defaults
`);
}

// ── Entry point ──

export function loadConfig(): Config {
  const cli = parseArgs(process.argv);
  const version = readVersion();

  if (cli.help) {
    printHelp(version);
    process.exit(0);
  }
  if (cli.version) {
    process.stderr.write(`pish v${version}\n`);
    process.exit(0);
  }

  // ── Shell resolution (CLI > ENV > default) ──
  const shellSpec =
    cli.shell ?? process.env.PISH_SHELL ?? process.env.SHELL ?? DEFAULTS.shell;
  const shellPath = resolveBinary(shellSpec);
  if (!shellPath) {
    process.stderr.write(`pish: shell not found: ${shellSpec}\n`);
    process.exit(1);
  }
  const shell = inferShellType(shellPath);
  if (!shell) {
    process.stderr.write(
      `pish: unsupported shell: ${shellSpec} (only bash and zsh)\n`,
    );
    process.exit(1);
  }

  // ── Pi resolution (skipped in --no-agent mode) ──
  const noAgent = cli.noAgent;
  let piPath = '';
  if (!noAgent) {
    const piSpec = cli.pi ?? process.env.PISH_PI ?? 'pi';
    const resolved = resolveBinary(piSpec);
    if (!resolved) {
      process.stderr.write(`pish: pi not found: ${piSpec}\n`);
      process.stderr.write(`  Install pi or set --pi <path> / PISH_PI\n`);
      process.exit(1);
    }
    piPath = resolved;
  }

  return {
    shell,
    shellPath,
    piPath,
    version,
    noAgent,
    maxContext: envInt('PISH_MAX_CONTEXT', DEFAULTS.maxContext),
    headLines: envInt('PISH_HEAD_LINES', DEFAULTS.headLines),
    tailLines: envInt('PISH_TAIL_LINES', DEFAULTS.tailLines),
    lineWidth: envInt('PISH_LINE_WIDTH', DEFAULTS.lineWidth),
    toolResultLines: envInt('PISH_TOOL_LINES', DEFAULTS.toolResultLines),
    noBanner: process.env.PISH_NO_BANNER === '1',
  };
}
