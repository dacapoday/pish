/**
 * Agent subprocess manager.
 *
 * Spawns `pi --mode rpc`, communicates via stdin/stdout JSONL.
 * Lifecycle: lazy spawn, restart on crash, abort on interrupt.
 *
 * Raw pi RPC events → flattened AgentEvent (consumed directly by renderer).
 */

import { type ChildProcess, spawn } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import { StringDecoder } from 'node:string_decoder';
import { log } from './log.js';

// ── Flattened event types (consumed directly by renderer) ──

export type AgentEvent =
  | { type: 'thinking_start' }
  | { type: 'thinking_delta'; delta: string }
  | { type: 'thinking_end'; content: string }
  | { type: 'text_start' }
  | { type: 'text_delta'; delta: string }
  | { type: 'text_end'; content: string }
  | {
      type: 'tool_start';
      toolCallId: string;
      toolName: string;
      args: Record<string, unknown>;
    }
  | {
      type: 'tool_update';
      toolCallId: string;
      toolName: string;
      partialResult: unknown;
    }
  | {
      type: 'tool_end';
      toolCallId: string;
      toolName: string;
      result: unknown;
      isError: boolean;
    }
  | { type: 'turn_end' }
  | { type: 'agent_done'; durationMs: number; usage?: AgentUsage }
  | { type: 'agent_error'; error: string }
  | { type: 'compaction_start'; reason: string }
  | {
      type: 'compaction_end';
      summary?: string;
      aborted: boolean;
      error?: string;
    };

/**
 * LLM API token usage statistics for a completed agent run.
 * Rendered in the status bar after agent_done:
 *   ✓ ↑2.1k ↓340 R12k $0.003 1.8s
 *
 * Aggregated from two sources (whichever is available):
 * - agent_end.messages[]  — preferred: sums usage across all messages in the run
 * - message_end.usage     — fallback: last single-message usage (lastUsage)
 */
export interface AgentUsage {
  inputTokens: number;
  outputTokens: number;
  cacheRead: number;
  cacheWrite: number;
  totalTokens: number;
  cost: number;
  model: string;
  provider: string;
  thinkingLevel: string;
  contextPercent: number | null;
  contextWindow: number;
}

/** RPC response from pi process. */
export interface RpcResponse {
  type: 'response';
  id?: string;
  command?: string;
  success: boolean;
  data?: Record<string, unknown>;
  error?: string;
}

export type AgentCallback = (event: AgentEvent) => void;

// ── JSON message helpers (pi RPC is untyped JSON) ──

/** Loose record type for parsed JSON messages from pi. */
type Msg = Record<string, unknown>;

/** Safely extract a string from an unknown value. */
function str(v: unknown): string {
  return typeof v === 'string' ? v : '';
}

/** Safely extract a number from an unknown value. */
function num(v: unknown): number {
  return typeof v === 'number' ? v : 0;
}

/** Convert a raw JSON message to a typed RpcResponse. */
function toRpcResponse(obj: Msg): RpcResponse {
  return {
    type: 'response',
    id: typeof obj.id === 'string' ? obj.id : undefined,
    command: typeof obj.command === 'string' ? obj.command : undefined,
    success: obj.success === true,
    data: (typeof obj.data === 'object' && obj.data !== null
      ? obj.data
      : undefined) as Record<string, unknown> | undefined,
    error: typeof obj.error === 'string' ? obj.error : undefined,
  };
}

/** Configuration for AgentManager (subset of global Config). */
export interface AgentConfig {
  piPath: string;
  rpcTimeout: number;
  killTimeout: number;
}

export class AgentManager {
  private proc: ChildProcess | null = null;
  private buf = '';
  private _onEvent: AgentCallback | null = null;
  private _running = false;
  private _submitted = false;
  private startTime = 0;
  private lastUsage: AgentUsage | null = null;
  private readonly config: AgentConfig;
  private pendingRpc = new Map<
    string,
    {
      resolve: (value: RpcResponse) => void;
      timer: ReturnType<typeof setTimeout>;
    }
  >();

  /** Session file path. Maintained by pish across agent process restarts. */
  private _sessionFile: string | undefined;

  /** Crash info (in-memory), displayed on next enterAgentMode. */
  private _crashInfo: string | undefined;

  constructor(config: AgentConfig) {
    this.config = config;
  }

  get running(): boolean {
    return this._running;
  }

  /** Whether the agent process is alive and writable. */
  get alive(): boolean {
    return this.proc !== null && !this.proc.killed;
  }

  onEvent(cb: AgentCallback): void {
    this._onEvent = cb;
  }

  /** Ensure the pi process is alive (lazy spawn). */
  private ensureRunning(): void {
    if (this.proc && !this.proc.killed) return;

    const args = ['--mode', 'rpc'];
    if (this._sessionFile) {
      args.push('--session', this._sessionFile);
    }

    log('agent_spawn', { args });

    this.proc = spawn(this.config.piPath, args, {
      stdio: ['pipe', 'pipe', 'pipe'],
      env: { ...process.env },
    });

    this.buf = '';

    const decoder = new StringDecoder('utf8');
    this.proc.stdout!.on('data', (data: Buffer) => {
      this.buf += decoder.write(data);
      const lines = this.buf.split('\n');
      this.buf = lines.pop()!;
      for (const line of lines) {
        if (!line.trim()) continue;
        try {
          const obj = JSON.parse(line);
          this.parseLine(obj);
        } catch {
          log('agent_parse_error', { line });
        }
      }
    });

    // Ignore pi stderr (its own debug output)
    this.proc.stderr!.on('data', () => {});

    // Handle stdin errors (EPIPE if process dies before/during write)
    this.proc.stdin!.on('error', (err: NodeJS.ErrnoException) => {
      if (err.code === 'EPIPE' || err.code === 'ERR_STREAM_DESTROYED') return;
      log('agent_stdin_error', { error: String(err) });
    });

    this.proc.on('exit', (code, signal) => {
      log('agent_exit', { code, signal });
      const wasActive = this._running || this._submitted;
      this.proc = null;
      this._running = false;
      this._submitted = false;

      // Reject all pending RPC promises (process died)
      for (const [, pending] of this.pendingRpc) {
        clearTimeout(pending.timer);
        pending.resolve({
          type: 'response',
          success: false,
          error: `pi exited (code=${code})`,
        });
      }
      this.pendingRpc.clear();

      if (wasActive) {
        // Crashed while running or after submit but before agent_start
        this.emitEvent({
          type: 'agent_error',
          error: `pi exited unexpectedly (code=${code}, signal=${signal})`,
        });
      }

      // Non-zero exit (not SIGTERM) → store crash info for next agent mode
      if (
        code !== null &&
        code !== 0 &&
        signal !== 'SIGTERM' &&
        signal !== 'SIGKILL'
      ) {
        this._crashInfo = `agent process exited unexpectedly (code ${code})`;
      }
    });
  }

  // ── JSONL event parsing + flattening ──

  private parseLine(obj: Msg): void {
    const type = obj.type;
    if (!type) return;

    switch (type) {
      case 'message_update':
        this.handleMessageUpdate(obj);
        break;

      case 'tool_execution_start':
        this.emitEvent({
          type: 'tool_start',
          toolCallId: str(obj.toolCallId),
          toolName: str(obj.toolName),
          args: (obj.args ?? {}) as Record<string, unknown>,
        });
        break;

      case 'tool_execution_update':
        this.emitEvent({
          type: 'tool_update',
          toolCallId: str(obj.toolCallId),
          toolName: str(obj.toolName),
          partialResult: obj.partialResult,
        });
        break;

      case 'tool_execution_end':
        this.emitEvent({
          type: 'tool_end',
          toolCallId: str(obj.toolCallId),
          toolName: str(obj.toolName),
          result: obj.result,
          isError: (obj.isError as boolean) ?? false,
        });
        break;

      case 'turn_end':
        this.emitEvent({ type: 'turn_end' });
        break;

      case 'message_end': {
        // Stash per-message usage as fallback — agent_end may lack messages[]
        const msg = obj.message as Msg | undefined;
        if (msg?.role === 'assistant' && msg.usage) {
          const u = msg.usage as Msg;
          const cost = u.cost as Msg | undefined;
          this.lastUsage = {
            inputTokens: num(u.input),
            outputTokens: num(u.output),
            cacheRead: num(u.cacheRead),
            cacheWrite: num(u.cacheWrite),
            totalTokens: num(u.totalTokens),
            cost: num(cost?.total),
            model: str(msg.model),
            provider: str(msg.provider),
            thinkingLevel: '',
            contextPercent: null,
            contextWindow: 0,
          };
        }
        break;
      }

      case 'agent_start':
        this._running = true;
        this._submitted = false;
        this.startTime = Date.now();
        this.lastUsage = null;
        break;

      case 'agent_end':
        this._running = false;
        this.emitEvent({
          type: 'agent_done',
          durationMs: Date.now() - this.startTime,
          usage: this.aggregateUsage(obj),
        });
        break;

      case 'response': {
        const rpc = toRpcResponse(obj);
        // Match pending rpcWait() by id
        if (rpc.id && this.pendingRpc.has(rpc.id)) {
          const pending = this.pendingRpc.get(rpc.id)!;
          this.pendingRpc.delete(rpc.id);
          clearTimeout(pending.timer);
          pending.resolve(rpc);
          break;
        }
        // Unmatched RPC error → emit agent_error
        if (!rpc.success && rpc.error) {
          this.emitEvent({ type: 'agent_error', error: rpc.error });
        }
        break;
      }

      case 'auto_compaction_start':
        this.emitEvent({
          type: 'compaction_start',
          reason: str(obj.reason) || 'threshold',
        });
        break;

      case 'auto_compaction_end': {
        const result = obj.result as Msg | undefined;
        this.emitEvent({
          type: 'compaction_end',
          summary: result?.summary as string | undefined,
          aborted: (obj.aborted as boolean) ?? false,
          error: obj.errorMessage as string | undefined,
        });
        break;
      }

      // Ignored: extension_ui_request, session header, etc.
    }
  }

  private handleMessageUpdate(obj: Msg): void {
    const ame = obj.assistantMessageEvent as Msg | undefined;
    if (!ame) return;

    switch (ame.type) {
      case 'thinking_start':
        this.emitEvent({ type: 'thinking_start' });
        break;
      case 'thinking_delta':
        this.emitEvent({ type: 'thinking_delta', delta: str(ame.delta) });
        break;
      case 'thinking_end':
        this.emitEvent({ type: 'thinking_end', content: str(ame.content) });
        break;
      case 'text_start':
        this.emitEvent({ type: 'text_start' });
        break;
      case 'text_delta':
        this.emitEvent({ type: 'text_delta', delta: str(ame.delta) });
        break;
      case 'text_end':
        this.emitEvent({ type: 'text_end', content: str(ame.content) });
        break;
      // toolcall_start/delta/end handled by tool_execution_* events
    }
  }

  /**
   * Aggregate usage from agent_end.messages[]. Falls back to lastUsage
   * (stashed from message_end) if messages array is absent or empty.
   */
  private aggregateUsage(agentEnd: Msg): AgentUsage | undefined {
    const messages = agentEnd.messages;
    if (!Array.isArray(messages)) {
      return this.lastUsage ?? undefined;
    }

    let input = 0;
    let output = 0;
    let cacheRead = 0;
    let cacheWrite = 0;
    let total = 0;
    let cost = 0;
    let model = '';
    let provider = '';

    for (const msg of messages as Msg[]) {
      if (msg.role === 'assistant' && msg.usage) {
        const u = msg.usage as Msg;
        const c = u.cost as Msg | undefined;
        input += num(u.input);
        output += num(u.output);
        cacheRead += num(u.cacheRead);
        cacheWrite += num(u.cacheWrite);
        total += num(u.totalTokens);
        cost += num(c?.total);
        if (msg.model) model = str(msg.model);
        if (msg.provider) provider = str(msg.provider);
      }
    }

    if (total === 0) return this.lastUsage ?? undefined;
    return {
      inputTokens: input,
      outputTokens: output,
      cacheRead,
      cacheWrite,
      totalTokens: total,
      cost,
      model,
      provider,
      thinkingLevel: '',
      contextPercent: null,
      contextWindow: 0,
    };
  }

  private emitEvent(event: AgentEvent): void {
    this._onEvent?.(event);
  }

  /** Submit a prompt to the agent. */
  submit(message: string): void {
    this.ensureRunning();
    if (!this.proc?.stdin?.writable) {
      this.emitEvent({
        type: 'agent_error',
        error: 'pi process not available',
      });
      return;
    }
    this._submitted = true;
    const cmd = `${JSON.stringify({ type: 'prompt', message })}\n`;
    this.proc.stdin.write(cmd);
  }

  /** Abort the current agent run. */
  abort(): void {
    if (!this.proc?.stdin?.writable) return;
    const cmd = `${JSON.stringify({ type: 'abort' })}\n`;
    this.proc.stdin.write(cmd);
  }

  /** Send an RPC command (fire-and-forget). */
  rpc(command: Record<string, unknown>): void {
    this.ensureRunning();
    if (!this.proc?.stdin?.writable) return;
    this.proc.stdin.write(`${JSON.stringify(command)}\n`);
  }

  /** Send an RPC command and wait for the matching response. */
  async rpcWait(
    command: Record<string, unknown>,
    timeoutMs?: number,
  ): Promise<RpcResponse> {
    const timeout = timeoutMs ?? this.config.rpcTimeout;
    this.ensureRunning();
    if (!this.proc?.stdin?.writable) {
      return {
        type: 'response',
        success: false,
        error: 'pi process not available',
      };
    }
    const id = randomUUID();
    return new Promise((resolve) => {
      const timer = setTimeout(() => {
        if (this.pendingRpc.delete(id)) {
          resolve({ type: 'response', success: false, error: 'RPC timeout' });
        }
      }, timeout);
      this.pendingRpc.set(id, { resolve, timer });
      this.proc!.stdin!.write(`${JSON.stringify({ ...command, id })}\n`);
    });
  }

  /** Kill the process but preserve sessionFile. */
  kill(): void {
    // Resolve pending RPCs before killing
    for (const [, pending] of this.pendingRpc) {
      clearTimeout(pending.timer);
      pending.resolve({
        type: 'response',
        success: false,
        error: 'agent killed',
      });
    }
    this.pendingRpc.clear();

    if (this.proc && !this.proc.killed) {
      const p = this.proc;
      p.kill('SIGTERM');
      // Escalate to SIGKILL if process doesn't exit in time
      const forceKill = setTimeout(() => {
        try {
          p.kill('SIGKILL');
        } catch {
          /* already exited */
        }
      }, this.config.killTimeout);
      forceKill.unref(); // Don't prevent Node from exiting
      this.proc = null;
    }
    this._running = false;
    this._submitted = false;
  }

  get sessionFile(): string | undefined {
    return this._sessionFile;
  }

  set sessionFile(path: string | undefined) {
    this._sessionFile = path;
  }

  /**
   * Consume crash info — returns the stored message and clears it.
   * Designed for one-time display on next enterAgentMode.
   */
  consumeCrashInfo(): string | undefined {
    const info = this._crashInfo;
    this._crashInfo = undefined;
    return info;
  }

  /** Kill process + clear session (full reset via Ctrl+L). */
  reset(): void {
    this.kill();
    this._sessionFile = undefined;
  }
}
