/**
 * Structured JSON event log.
 *
 * Target values (from Config.logTarget):
 *   null           → no output
 *   "1" | "stderr" → stderr
 *   file path      → append to file
 */

import * as fs from 'node:fs';

export interface LogEvent {
  ts: string;
  event: string;
  [key: string]: unknown;
}

let logFd: number | null = null;
let logToStderr = false;

export function initLog(target: string | null): void {
  if (!target) return;

  if (target === '1' || target === 'stderr') {
    logToStderr = true;
  } else {
    logFd = fs.openSync(target, 'a');
  }
}

export function closeLog(): void {
  if (logFd !== null) {
    try {
      fs.closeSync(logFd);
    } catch {
      /* fd may already be closed */
    }
    logFd = null;
  }
}

export function log(event: string, fields?: Record<string, unknown>): void {
  if (!logToStderr && logFd === null) return;

  const entry: LogEvent = {
    ts: new Date().toISOString(),
    event,
    ...fields,
  };

  const line = `${JSON.stringify(entry)}\n`;

  if (logToStderr) {
    process.stderr.write(line);
  }
  if (logFd !== null) {
    fs.writeSync(logFd, line);
  }
}
