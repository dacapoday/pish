/**
 * Virtual terminal replay for the prompt segment.
 *
 * Uses @xterm/headless to replay raw PTY data and extract the final
 * displayed text. Handles readline editing, ANSI colors, cursor
 * movement, etc.
 *
 * Reuses a single Terminal instance (reset + write) to avoid
 * repeated construction overhead.
 */

// @xterm/headless 6.0.0 lacks an "exports" field in package.json,
// so Node ESM resolution only sees "main" (CJS). Use createRequire
// as a workaround until the next stable release (#5632).
import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);
const { Terminal } = require('@xterm/headless');

// Lazily initialized shared Terminal instance
let sharedTerm: InstanceType<typeof Terminal> | null = null;

function getTerm(cols: number, rows: number): InstanceType<typeof Terminal> {
  if (sharedTerm) {
    if (sharedTerm.cols !== cols || sharedTerm.rows !== rows) {
      sharedTerm.resize(cols, rows);
    }
    sharedTerm.reset();
    return sharedTerm;
  }

  sharedTerm = new Terminal({
    cols,
    rows,
    scrollback: 200,
    allowProposedApi: true,
    logLevel: 'off',
  });
  return sharedTerm;
}

/**
 * Replay raw PTY data and return the final displayed text.
 * Digests readline editing, ANSI color, cursor operations, alt screen, etc.
 */
export function vtermReplay(
  data: string,
  cols: number,
  rows: number,
): Promise<string> {
  return new Promise((resolve) => {
    const term = getTerm(cols, rows);

    term.write(data, () => {
      const buf = term.buffer.active;
      const lines: string[] = [];

      // scrollback (baseY lines scrolled off top) + viewport (up to cursorY)
      const totalLines = buf.baseY + buf.cursorY + 1;
      for (let i = 0; i < totalLines; i++) {
        const line = buf.getLine(i)?.translateToString(true);
        lines.push(line?.trimEnd() ?? '');
      }

      // Trim trailing empty lines
      while (lines.length > 0 && lines[lines.length - 1] === '') {
        lines.pop();
      }

      resolve(lines.join('\n'));
    });
  });
}
