/**
 * Recorder — extracts context entries from the PTY stream.
 *
 * Core idea:
 * - Continuously appends PTY data to a buffer.
 * - C signal marks the prompt/output boundary.
 * - D signal triggers commit or discard.
 * - Buffer is not cleared on signal; instead, segment start/end offsets are tracked.
 */

import { log } from './log.js';
import { OscParser, type Signal } from './osc.js';
import {
  DEFAULT_TRUNCATE,
  isAltScreen,
  stripAnsi,
  type TruncateOptions,
  truncateLines,
} from './strip.js';
import { vtermReplay } from './vterm.js';

export interface ContextEntry {
  prompt: string;
  output: string;
  rc: number;
}

export type RecorderEvent =
  | { type: 'shell_ready' }
  | { type: 'context'; entry: ContextEntry }
  | { type: 'context_skip'; reason: string }
  | { type: 'agent'; cmd: string }
  | { type: 'reverse' }
  | { type: 'reverse_done' }
  | { type: 'error'; msg: string };

export interface RecorderOptions {
  /** Max context history entries; oldest discarded when exceeded. Default: 20 */
  maxContext: number;
  /** Truncation params (line width, head/tail lines) */
  truncate: TruncateOptions;
}

const DEFAULT_OPTIONS: RecorderOptions = {
  maxContext: 20,
  truncate: DEFAULT_TRUNCATE,
};

export class Recorder {
  /**
   * Complete clean PTY data (OSC 9154 stripped).
   * Append-only; segStart tracks the current segment origin.
   */
  private fullBuffer = '';

  /** Start offset of the current segment (after last D). */
  private segStart = 0;

  /** Absolute offset of C in fullBuffer (null = no C in this segment). */
  private cAbs: number | null = null;

  private discardNext = false;
  private reverseInProgress = false;
  private gotFirstD = false;
  private pending: Promise<void> = Promise.resolve();

  private readonly opts: RecorderOptions;
  private readonly oscParser = new OscParser();

  /** Committed context entries. */
  readonly context: ContextEntry[] = [];

  private _onEvent: ((evt: RecorderEvent) => void) | null = null;

  constructor(opts?: Partial<RecorderOptions>) {
    this.opts = { ...DEFAULT_OPTIONS, ...opts };
  }

  onEvent(cb: (evt: RecorderEvent) => void): void {
    this._onEvent = cb;
  }

  /**
   * Feed raw PTY data. Returns clean data with OSC sequences stripped.
   */
  feed(data: string): string {
    const { clean, signals } = this.oscParser.feed(data);
    const base = this.fullBuffer.length;
    this.fullBuffer += clean;

    for (const ps of signals) {
      this.handleSignal(ps.signal, base + ps.cleanOffset);
    }

    return clean;
  }

  private handleSignal(sig: Signal, absOffset: number): void {
    switch (sig.type) {
      case 'S':
        this.emit({ type: 'shell_ready' });
        break;

      case 'C':
        this.cAbs = absOffset;
        break;

      case 'D': {
        // Snapshot shared mutable state before enqueuing — C/P/R signals
        // in the same feed() call modify these synchronously while D waits.
        const snap = {
          segStart: this.segStart,
          cAbs: this.cAbs,
          discardNext: this.discardNext,
          reverseInProgress: this.reverseInProgress,
        };
        this.pending = this.pending
          .then(() => this.handleD(sig.rc, absOffset, snap))
          .catch((err) => {
            log('vtermReplay_error', { error: String(err) });
          });
        break;
      }

      case 'P':
        this.discardNext = true;
        this.segStart = absOffset;
        this.cAbs = null;
        this.emit({ type: 'agent', cmd: sig.cmd });
        break;

      case 'R':
        this.discardNext = true;
        this.reverseInProgress = true;
        this.segStart = absOffset;
        this.cAbs = null;
        this.emit({ type: 'reverse' });
        break;

      case 'E':
        this.emit({ type: 'error', msg: sig.msg });
        break;
    }
  }

  private async handleD(
    rc: number,
    absOffset: number,
    snap: {
      segStart: number;
      cAbs: number | null;
      discardNext: boolean;
      reverseInProgress: boolean;
    },
  ): Promise<void> {
    // First D = startup garbage, skip
    if (!this.gotFirstD) {
      this.gotFirstD = true;
      this.segStart = absOffset;
      this.cAbs = null;
      return;
    }

    // D after agent or reverse — discard
    if (snap.discardNext) {
      this.discardNext = false;
      if (snap.reverseInProgress) {
        this.reverseInProgress = false;
        this.emit({ type: 'reverse_done' });
      }
      this.segStart = absOffset;
      this.cAbs = null;
      return;
    }

    // Current segment: snap.segStart .. absOffset
    const segData = this.fullBuffer.slice(snap.segStart, absOffset);

    let promptText: string;
    let outputText: string;

    if (snap.cAbs !== null && snap.cAbs >= snap.segStart) {
      const cRel = snap.cAbs - snap.segStart;
      const promptRaw = segData.slice(0, cRel);
      const outputRaw = segData.slice(cRel);

      promptText = await vtermReplay(promptRaw);

      if (isAltScreen(outputRaw)) {
        outputText = '[full-screen app]';
      } else {
        outputText = truncateLines(
          stripAnsi(outputRaw).trim(),
          this.opts.truncate,
        );
      }
    } else {
      // No C = no command executed (empty enter, etc.)
      this.segStart = absOffset;
      this.cAbs = null;
      this.emit({ type: 'context_skip', reason: 'no_c' });
      return;
    }

    // Skip empty entries (C present but no output and rc=0, e.g. `true`)
    if (!outputText && rc === 0) {
      this.segStart = absOffset;
      this.cAbs = null;
      this.emit({ type: 'context_skip', reason: 'no_output' });
      return;
    }

    const entry: ContextEntry = { prompt: promptText, output: outputText, rc };
    this.context.push(entry);

    // Discard oldest when over limit
    while (this.context.length > this.opts.maxContext) {
      this.context.shift();
    }

    this.emit({ type: 'context', entry });

    this.segStart = absOffset;
    this.cAbs = null;

    this.maybeCompact();
  }

  /** Release memory periodically (fullBuffer grows indefinitely). */
  private maybeCompact(): void {
    if (this.segStart > 100_000) {
      this.fullBuffer = this.fullBuffer.slice(this.segStart);
      if (this.cAbs !== null) this.cAbs -= this.segStart;
      this.segStart = 0;
    }
  }

  /**
   * Drain context — returns all current entries and clears the list.
   * Consumed context is not re-sent to the next agent invocation.
   */
  drain(): ContextEntry[] {
    const entries = this.context.splice(0);
    return entries;
  }

  private emit(evt: RecorderEvent): void {
    this._onEvent?.(evt);
  }
}
