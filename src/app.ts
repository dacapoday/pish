/**
 * App — core application object.
 *
 * Owns all mutable session state (mode, FIFO, reverse tracking).
 * Receives events from Recorder and AgentManager, drives rendering
 * and FIFO responses. Created by main.ts after all resources are ready.
 */

import * as fs from 'node:fs';
import * as path from 'node:path';
import type { IPty } from 'node-pty';
import type { AgentEvent, AgentManager, RpcResponse } from './agent.js';
import type { Config } from './config.js';
import { closeLog, log } from './log.js';
import type { ContextEntry, Recorder, RecorderEvent } from './recorder.js';
import {
  printBanner,
  printControl,
  printControlResult,
  printExit,
  printNotice,
  StreamRenderer,
  startSpinner,
} from './render.js';
import { findLatestSession } from './session.js';

// ═══════════════════════════════════════
// Pure helpers (module-level, no `this`)
// ═══════════════════════════════════════

function formatContext(entries: ContextEntry[]): string {
  return entries
    .map((e, i) => {
      const parts: string[] = [];
      const num = `[${i + 1}]`;
      if (e.prompt) {
        parts.push(`${num} ${e.prompt}`);
      } else {
        parts.push(num);
      }
      if (e.output) parts.push(e.output);
      if (e.rc !== 0) parts.push(`[exit code: ${e.rc}]`);
      return parts.join('\n');
    })
    .join('\n\n');
}


// ═══════════════════════════════════════
// App
// ═══════════════════════════════════════

export class App {
  // ── Injected dependencies ──
  private readonly cfg: Config;
  private readonly pty: IPty;
  private readonly recorder: Recorder;
  private readonly agent: AgentManager;

  // ── Infrastructure (immutable after construction) ──
  private readonly fifoPath: string;
  private readonly tmpDir: string;
  private readonly rcPath: string;
  private readonly debugFd: number | null;

  // ── FIFO ──
  private fifoFd: number | null = null;
  private cleaned = false;

  // ── Agent mode state ──
  private mode: 'normal' | 'agent' = 'normal';
  private agentCmd = '';
  private agentStartTime = 0;
  private stdinBuffer: Buffer[] = [];
  private renderer: StreamRenderer | null = null;

  // ── Reverse session recovery ──
  private sessionEpoch = Date.now();
  private reverseStartTime = 0;
  private preReverseSessionFile: string | undefined;

  constructor(
    deps: { cfg: Config; pty: IPty; recorder: Recorder; agent: AgentManager },
    infra: { fifoPath: string; tmpDir: string; rcPath: string },
  ) {
    this.cfg = deps.cfg;
    this.pty = deps.pty;
    this.recorder = deps.recorder;
    this.agent = deps.agent;

    this.fifoPath = infra.fifoPath;
    this.tmpDir = infra.tmpDir;
    this.rcPath = infra.rcPath;
    // Open debug log file (same file shell hooks append to)
    this.debugFd = deps.cfg.debugPath
      ? fs.openSync(deps.cfg.debugPath, 'a')
      : null;

    // Wire internal event handlers
    this.agent.onEvent((event) => this.onAgentEvent(event));
    this.recorder.onEvent((evt) => this.onRecorderEvent(evt));
  }

  // ═══════════════════════════════════════
  // Public I/O interface (called by main.ts wiring)
  // ═══════════════════════════════════════

  /** PTY stdout data → recorder + terminal. */
  onPtyData(data: string): void {
    const clean = this.recorder.feed(data);
    process.stdout.write(clean);
  }

  /** PTY process exited. */
  onPtyExit(code: number): void {
    this.debugLog('PTY exited, code:', code);
    printExit();
    log('exit', { context_count: this.recorder.contextCount, code });
    closeLog();
    this.cleanup();
    process.exit(code);
  }

  /** Terminal stdin data → mode routing. */
  onStdin(data: Buffer): void {
    if (this.mode === 'agent') {
      if (data.length === 1 && data[0] === 0x03) {
        this.abortAgent();
      } else {
        this.stdinBuffer.push(Buffer.from(data));
      }
      return;
    }

    // Ctrl+L: clear screen + reset context + full agent reset (including session)
    if (data.length === 1 && data[0] === 0x0c) {
      const cleared = this.recorder.drain();
      log('context_clear', { discarded: cleared.length });
      this.agent.reset();
      this.sessionEpoch = Date.now();
      this.preReverseSessionFile = undefined;
      this.pty.write(data.toString());
      return;
    }

    this.pty.write(data.toString());
  }

  /** Terminal resized. */
  onResize(cols: number, rows: number): void {
    this.pty.resize(cols, rows);
    this.recorder.updateSize(cols, rows);
  }

  /** Cleanup all resources. Public — called by signal handlers in main.ts. */
  cleanup(): void {
    if (this.cleaned) return;
    this.cleaned = true;
    process.stderr.write('\x1b[?25h'); // Restore cursor visibility
    this.agent.kill();
    if (this.fifoFd !== null) {
      try {
        fs.closeSync(this.fifoFd);
      } catch {
        /* fd may already be closed */
      }
      this.fifoFd = null;
    }
    try {
      fs.unlinkSync(this.fifoPath);
    } catch {
      /* already removed or never created */
    }
    try {
      fs.rmSync(this.tmpDir, { recursive: true, force: true });
    } catch {
      /* non-empty or already removed */
    }
    try {
      fs.unlinkSync(this.rcPath);
      fs.rmSync(path.dirname(this.rcPath), { recursive: true, force: true });
    } catch {
      /* zsh rcdir may not exist or already cleaned */
    }
    if (this.debugFd !== null) {
      try {
        fs.closeSync(this.debugFd);
      } catch {
        /* fd may already be closed */
      }
    }
  }

  // ═══════════════════════════════════════
  // Agent event handler
  // ═══════════════════════════════════════

  private onAgentEvent(event: AgentEvent): void {
    this.renderer?.handleEvent(event);

    if (event.type === 'agent_done' && this.mode === 'agent') {
      log('agent_done', {
        cmd: this.agentCmd,
        duration_ms: Date.now() - this.agentStartTime,
      });
      this.exitAgentMode();
    }

    if (event.type === 'agent_error' && this.mode === 'agent') {
      log('agent_error', { cmd: this.agentCmd, error: event.error });
      this.exitAgentMode();
    }
  }

  // ═══════════════════════════════════════
  // Recorder event handler
  // ═══════════════════════════════════════

  private onRecorderEvent(evt: RecorderEvent): void {
    switch (evt.type) {
      case 'shell_ready':
        this.debugLog('EVENT: shell_ready');
        this.fifoFd = fs.openSync(this.fifoPath, 'w');
        this.debugLog('FIFO write fd opened');
        log('shell_ready', { pid: this.pty.pid });
        if (!this.cfg.noBanner) {
          printBanner(this.cfg.version, this.cfg.shell, {
            noAgent: this.cfg.noAgent,
          });
        }
        break;

      case 'context':
        log('context', {
          prompt: evt.entry.prompt,
          output: evt.entry.output,
          rc: evt.entry.rc,
          kept: this.recorder.contextCount,
        });
        break;

      case 'context_skip':
        log('context_skip', { reason: evt.reason });
        break;

      case 'agent':
        this.handleAgentCmd(evt.cmd);
        break;

      case 'reverse':
        this.handleReverse();
        break;

      case 'reverse_done':
        this.handleReverseDone().catch((err) => {
          log('reverse_done_error', { error: String(err) });
        });
        break;

      case 'error':
        log('error', { msg: evt.msg });
        process.stderr.write(`\x1b[31mpish: ${evt.msg}\x1b[0m\n`);
        this.cleanup();
        process.exit(1);
        break;
    }
  }

  // ═══════════════════════════════════════
  // Agent mode transitions
  // ═══════════════════════════════════════

  private enterAgentMode(cmd: string): void {
    this.mode = 'agent';
    this.agentCmd = cmd;
    this.agentStartTime = Date.now();
    this.stdinBuffer = [];
    this.debugLog('enterAgentMode:', cmd);

    const entries = this.recorder.drain();
    log('agent', { cmd, context_count: entries.length });

    this.renderer = new StreamRenderer(
      this.cfg.toolResultLines,
      this.cfg.spinnerInterval,
    );

    const crashInfo = this.agent.consumeCrashInfo();
    if (crashInfo) {
      printNotice(crashInfo);
    }

    this.renderer.showSpinner();

    let message = cmd;
    const ctx = formatContext(entries);
    if (ctx) {
      message = `Here is my recent shell activity:\n\n${ctx}\n\n${cmd}`;
    }

    this.agent.submit(message);
  }

  private exitAgentMode(): void {
    this.debugLog(
      'exitAgentMode, stdinBuffer:',
      this.stdinBuffer.length,
      'chunks',
    );
    this.mode = 'normal';
    this.renderer = null;

    this.fifoWrite('PROCEED');

    // Request state to get session file (for subsequent reverse).
    // Only if agent process is alive — don't respawn after crash.
    if (this.agent.alive) {
      this.agent
        .rpcWait({ type: 'get_state' })
        .then((response) => {
          if (response.success && response.data?.sessionFile) {
            this.agent.sessionFile = response.data.sessionFile as string;
          }
        })
        .catch((err) => {
          log('get_state_error', { error: String(err) });
        });
    }

    const buffered = this.stdinBuffer;
    this.stdinBuffer = [];
    if (buffered.length > 0) {
      setTimeout(() => {
        for (const chunk of buffered) {
          this.pty.write(chunk.toString());
        }
        this.debugLog('replayed', buffered.length, 'stdin chunks');
      }, this.cfg.stdinReplayDelay);
    }
  }

  private abortAgent(): void {
    this.debugLog('abortAgent');
    this.agent.abort();
    this.renderer?.printInterrupted();
    log('agent_abort', {
      cmd: this.agentCmd,
      duration_ms: Date.now() - this.agentStartTime,
    });
    this.mode = 'normal';
    this.renderer = null;
    this.stdinBuffer = [];
    this.fifoWrite('PROCEED');
  }

  // ═══════════════════════════════════════
  // Agent / control command dispatch
  // ═══════════════════════════════════════

  private handleAgentCmd(cmd: string): void {
    this.debugLog('EVENT: agent cmd=', cmd);

    if (cmd.startsWith('/')) {
      log('control', { cmd });
      printControl(cmd);
      if (this.cfg.noAgent) {
        this.fifoWrite('PROCEED');
        return;
      }
      this.handleControlAsync(cmd)
        .then((response) => {
          if (response) printControlResult(cmd, response);
        })
        .catch((err) => {
          log('control_error', { cmd, error: String(err) });
        })
        .finally(() => {
          this.fifoWrite('PROCEED');
        });
      return;
    }

    if (this.cfg.noAgent) {
      log('agent_skip', { cmd, reason: 'no-agent' });
      printNotice(`agent disabled, skipped: ${cmd}`);
      this.fifoWrite('PROCEED');
      return;
    }

    this.enterAgentMode(cmd);
  }

  private async handleControlAsync(cmd: string): Promise<RpcResponse | null> {
    const parts = cmd.trim().split(/\s+/);
    const name = parts[0];
    const arg = parts.slice(1).join(' ');

    switch (name) {
      case '/compact': {
        const stopSpinner = startSpinner(
          'Compacting...',
          this.cfg.spinnerInterval,
        );
        try {
          return await this.agent.rpcWait(
            { type: 'compact', ...(arg ? { customInstructions: arg } : {}) },
            this.cfg.compactTimeout,
          );
        } finally {
          stopSpinner();
        }
      }
      case '/model': {
        if (!arg) {
          const state = await this.agent.rpcWait({ type: 'get_state' });
          if (state.success && state.data?.model) {
            const m = state.data.model as Record<string, unknown>;
            const prov = m.provider as
              | Record<string, unknown>
              | string
              | undefined;
            const provider =
              typeof prov === 'object' && prov !== null
                ? ((prov.id as string) ?? '')
                : String(prov ?? '');
            const modelId = (m.id as string) ?? '';
            return {
              type: 'response',
              command: 'set_model',
              success: true,
              data: { provider: { id: provider }, id: modelId },
            };
          }
          return {
            type: 'response',
            command: 'set_model',
            success: false,
            error: 'no model info available',
          };
        }
        const slashIdx = arg.indexOf('/');
        if (slashIdx > 0) {
          return await this.agent.rpcWait({
            type: 'set_model',
            provider: arg.slice(0, slashIdx),
            modelId: arg.slice(slashIdx + 1),
          });
        } else {
          return await this.agent.rpcWait({
            type: 'set_model',
            provider: '',
            modelId: arg,
          });
        }
      }
      case '/think': {
        const level = arg || 'medium';
        return await this.agent.rpcWait({ type: 'set_thinking_level', level });
      }
      default:
        return null;
    }
  }

  // ═══════════════════════════════════════
  // Reverse session recovery
  // ═══════════════════════════════════════

  private handleReverse(): void {
    this.debugLog('EVENT: reverse');
    const sessionFile = this.agent.sessionFile;
    this.agent.kill();
    this.reverseStartTime = Date.now();
    this.preReverseSessionFile = sessionFile;
    log('reverse', {
      context_count: this.recorder.contextCount,
      session: sessionFile || null,
    });
    if (sessionFile) {
      this.fifoWrite(`SESSION:${sessionFile}`);
    } else {
      this.fifoWrite('SESSION:');
    }
  }

  private async handleReverseDone(): Promise<void> {
    this.debugLog('EVENT: reverse_done');
    const since = Math.max(this.reverseStartTime, this.sessionEpoch);
    const recovered = await findLatestSession(since, (...a) =>
      this.debugLog(...a),
    );
    this.agent.sessionFile = recovered ?? this.preReverseSessionFile;
    log('reverse_done', { session: this.agent.sessionFile ?? null });
  }

  // ═══════════════════════════════════════
  // FIFO + debug
  // ═══════════════════════════════════════

  private fifoWrite(data: string): void {
    if (this.fifoFd !== null) {
      fs.writeSync(this.fifoFd, `${data}\n`);
      this.debugLog('FIFO wrote:', data);
    } else {
      this.debugLog('FIFO not ready, dropping:', data);
    }
  }

  private debugLog(...args: unknown[]): void {
    if (this.debugFd !== null) {
      const ts = new Date().toISOString().slice(11, 23);
      fs.writeSync(
        this.debugFd,
        `[${ts}] PISH ${args.map(String).join(' ')}\n`,
      );
    }
  }
}
