#!/usr/bin/env node

process.title = 'pish';

/**
 * pish — Pi-Integrated Shell.
 *
 * Entry point: bootstrap resources, wire I/O, delegate to App.
 */

import { execFileSync } from 'node:child_process';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import * as pty from 'node-pty';
import { AgentManager } from './agent.js';
import { App } from './app.js';
import { loadConfig } from './config.js';
import { generateRcfile } from './hooks.js';
import { initLog, log } from './log.js';
import { Recorder } from './recorder.js';

// ═══════════════════════════════════════
// Nesting detection
// ═══════════════════════════════════════

if (process.env.PISH_PID) {
  process.stderr.write(
    '\x1b[31mpish: already running (nested launch blocked)\x1b[0m\n',
  );
  process.exit(1);
}

// ═══════════════════════════════════════
// Bootstrap
// ═══════════════════════════════════════

const cfg = loadConfig();
initLog(cfg.logTarget);

// ── Infrastructure ──

const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'pish-'));
const fifoPath = path.join(tmpDir, 'fifo');
execFileSync('mkfifo', [fifoPath]);

const rcPath = generateRcfile({ shell: cfg.shell, fifoPath, tmpDir });

// ── Objects ──

const recorder = new Recorder(cfg);
const agent = new AgentManager(cfg);

// ── PTY ──

const shellArgs = cfg.shell === 'bash' ? ['--rcfile', rcPath, '-i'] : ['-i'];

const env: Record<string, string> = {
  ...(process.env as Record<string, string>),
  PISH_PID: String(process.pid),
};

if (cfg.shell === 'zsh') {
  if (process.env.ZDOTDIR !== undefined) {
    env.__PISH_ORIG_ZDOTDIR = process.env.ZDOTDIR;
  }
  env.ZDOTDIR = path.dirname(rcPath);
}

const ptyProcess = pty.spawn(cfg.shellPath, shellArgs, {
  name: 'xterm-256color',
  cols: process.stdout.columns || cfg.defaultCols,
  rows: process.stdout.rows || cfg.defaultRows,
  cwd: process.cwd(),
  env,
});

log('start', { shell: cfg.shell, pid: ptyProcess.pid });

// ═══════════════════════════════════════
// App + wiring
// ═══════════════════════════════════════

const app = new App(
  { cfg, pty: ptyProcess, recorder, agent },
  { fifoPath, tmpDir },
);

ptyProcess.onData((data) => app.onPtyData(data));
ptyProcess.onExit(({ exitCode }) => app.onPtyExit(exitCode ?? 0));

process.stdin.setRawMode?.(true);
process.stdin.resume();
process.stdin.on('data', (data) => app.onStdin(Buffer.from(data)));

process.stdout.on('resize', () => {
  app.onResize(
    process.stdout.columns || cfg.defaultCols,
    process.stdout.rows || cfg.defaultRows,
  );
});

// ═══════════════════════════════════════
// Signals
// ═══════════════════════════════════════

const quit = () => {
  app.cleanup();
  process.exit(0);
};
process.on('SIGTERM', quit);
process.on('SIGHUP', quit);
process.on('SIGINT', quit);

process.on('unhandledRejection', (err) => {
  log('unhandled_rejection', { error: String(err) });
});
