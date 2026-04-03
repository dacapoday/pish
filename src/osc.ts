/**
 * OSC 9154 signal parser.
 *
 * Strips OSC 9154 sequences from PTY data, extracts signals,
 * and returns clean data with signal positions.
 *
 * Handles cross-chunk splitting: if a partial OSC sequence is at the
 * end of a chunk, it is buffered and completed on the next feed().
 *
 * Format:
 *   ESC ] 9154 ; <payload> BEL      (BEL = 0x07)
 *   ESC ] 9154 ; <payload> ESC \    (ST = ESC 0x5c)
 */

export type Signal =
  | { type: 'S' }
  | { type: 'C' }
  | { type: 'D'; rc: number }
  | { type: 'P'; cmd: string }
  | { type: 'R' }
  | { type: 'E'; msg: string };

export interface PositionedSignal {
  signal: Signal;
  /** Byte offset in the clean data where this signal appeared. */
  cleanOffset: number;
}

export interface ParseResult {
  /** PTY data with all OSC 9154 sequences stripped. */
  clean: string;
  /** Signals extracted in order, with positions in clean data. */
  signals: PositionedSignal[];
}

// Maximum length of a buffered partial OSC before we give up and flush it.
// OSC 9154 payloads are short (longest: P;cmd, cmd < 4096 chars).
const MAX_PARTIAL = 8192;

// Full OSC 9154 regex — matches complete sequences.
const OSC_RE = /\x1b\]9154;([^\x07\x1b]*?)(?:\x07|\x1b\\)/g;

// Detects a potential partial OSC 9154 at end of string.
// Matches any prefix of: ESC ] 9 1 5 4 ; <payload> <terminator>
// We check if the string ends with an incomplete ESC sequence that could
// become a valid OSC 9154.
const OSC_PREFIX = '\x1b]9154;';

/**
 * Stateful OSC 9154 parser. Maintains a residual buffer for partial
 * sequences that span chunk boundaries.
 */
export class OscParser {
  /** Buffered partial OSC sequence from previous feed(). */
  private partial = '';

  /**
   * Feed raw PTY data. Returns clean data (OSC stripped) and signals.
   */
  feed(data: string): ParseResult {
    let input: string;
    if (this.partial) {
      input = this.partial + data;
      this.partial = '';
    } else {
      input = data;
    }

    // Check for partial OSC at end of input
    const tailStart = this.findPartialTail(input);
    let processable: string;

    if (tailStart >= 0) {
      this.partial = input.slice(tailStart);
      processable = input.slice(0, tailStart);

      // Safety: if partial grows too large, it's not a real OSC — flush it
      if (this.partial.length > MAX_PARTIAL) {
        processable += this.partial;
        this.partial = '';
      }
    } else {
      processable = input;
    }

    return parseOsc(processable);
  }

  /**
   * Find the start of a potential partial OSC 9154 at the end of the string.
   * Returns the index, or -1 if no partial is found.
   *
   * Scans backward through all ESC positions to find an unterminated
   * OSC 9154 prefix. An ESC is "unterminated" if from that ESC to the
   * end of string there is no BEL and no ST (ESC \\).
   */
  private findPartialTail(data: string): number {
    // Scan backward for ESC characters, find the earliest unterminated one
    let candidate = -1;

    for (let i = data.length - 1; i >= 0; i--) {
      if (data[i] !== '\x1b') continue;

      const tail = data.slice(i);

      // Check if this ESC starts a valid OSC 9154 prefix
      if (!this.isOscPrefix(tail)) continue;

      // Check if it's already terminated (BEL or ST after the opening ESC)
      const hasBel = tail.indexOf('\x07') >= 0;
      // ST = ESC \\ — look for \x1b\\ after position 1 (skip the leading ESC itself)
      let hasSt = false;
      for (let j = 1; j < tail.length - 1; j++) {
        if (tail[j] === '\x1b' && tail[j + 1] === '\\') {
          hasSt = true;
          break;
        }
      }

      if (hasBel || hasSt) {
        // Terminated — regex will handle it. Stop scanning: anything
        // before a terminated sequence cannot be a partial tail.
        break;
      }

      // Unterminated — record as candidate and keep scanning backward
      // to find the earliest one (the real start of the partial).
      candidate = i;
    }

    return candidate;
  }

  /**
   * Check if `s` is a valid prefix of an OSC 9154 sequence.
   * Valid prefixes: \x1b, \x1b], \x1b]9, \x1b]91, \x1b]915, \x1b]9154,
   * \x1b]9154;, \x1b]9154;<payload...>
   */
  private isOscPrefix(s: string): boolean {
    // Must start with ESC
    if (s[0] !== '\x1b') return false;
    if (s.length === 1) return true; // just ESC — could become ESC]...

    // After ESC must be ]
    if (s[1] !== ']') return false;
    if (s.length === 2) return true;

    // Check that chars 2..6 match "9154;" prefix
    for (let i = 2; i < s.length && i < OSC_PREFIX.length; i++) {
      if (s[i] !== OSC_PREFIX[i]) return false;
    }

    // If we've passed the full prefix, it's payload (waiting for terminator)
    return true;
  }
}

/** Stateless parse of a complete data chunk (no partial handling). */
export function parseOsc(data: string): ParseResult {
  const signals: PositionedSignal[] = [];
  let cleanOffset = 0;
  let lastIndex = 0;

  const clean = data.replace(
    OSC_RE,
    (match, payload: string, offset: number) => {
      cleanOffset += offset - lastIndex;
      lastIndex = offset + match.length;

      const sig = parsePayload(payload);
      if (sig) signals.push({ signal: sig, cleanOffset });
      return '';
    },
  );

  return { clean, signals };
}

function parsePayload(payload: string): Signal | null {
  if (payload === 'S') return { type: 'S' };
  if (payload === 'C') return { type: 'C' };
  if (payload === 'R') return { type: 'R' };

  if (payload.startsWith('D;')) {
    const rc = parseInt(payload.slice(2), 10);
    return { type: 'D', rc: Number.isNaN(rc) ? 0 : rc };
  }

  if (payload.startsWith('P;')) {
    return { type: 'P', cmd: payload.slice(2) };
  }

  if (payload.startsWith('E;')) {
    return { type: 'E', msg: payload.slice(2) };
  }

  return null;
}
