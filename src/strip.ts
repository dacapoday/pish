/**
 * ANSI stripping + line-level truncation + alt screen detection.
 *
 * Used for the output segment (C→D).
 */

// Matches all ANSI escape sequences (CSI, OSC, ESC single-char, etc.)
// and control chars: \x08 (BS), \x0d (CR), \x00-\x1f except \x0a (LF)
const ANSI_RE =
  /\x1b(?:\[[0-9;?]*[a-zA-Z@`]|\][^\x07]*(?:\x07|\x1b\\)|\([A-Z0-9]|[=>DEHMNOPZ78])|[\x00-\x09\x0b-\x0d\x0e-\x1f\x7f]/g;

/** Alt screen enter: \e[?1049h, \e[?47h, \e[?1047h */
const ALT_SCREEN_RE = /\x1b\[\?(1049|47|1047)h/;

export function isAltScreen(data: string): boolean {
  return ALT_SCREEN_RE.test(data);
}

export function stripAnsi(data: string): string {
  return data.replace(ANSI_RE, '');
}

export interface TruncateOptions {
  /** Lines to keep from the beginning. */
  headLines: number;
  /** Lines to keep from the end. */
  tailLines: number;
  /** Max characters per line (excess truncated with ' ...'). */
  maxLineWidth: number;
}

export const DEFAULT_TRUNCATE: TruncateOptions = {
  headLines: 50,
  tailLines: 30,
  maxLineWidth: 512,
};

/**
 * Line-level truncation: keep head + tail lines, truncate the middle.
 * Also truncates individual long lines.
 *
 * Head > tail ratio: command output typically starts with structured info
 * (headers, column names, first results); tail preserves errors and final results.
 */
export function truncateLines(
  text: string,
  opts: TruncateOptions = DEFAULT_TRUNCATE,
): string {
  let lines = text.split('\n');

  // Per-line truncation
  lines = lines.map((line) => {
    if (line.length > opts.maxLineWidth) {
      return `${line.slice(0, opts.maxLineWidth)} ...`;
    }
    return line;
  });

  const total = lines.length;
  const max = opts.headLines + opts.tailLines;

  if (total <= max) return lines.join('\n');

  const head = lines.slice(0, opts.headLines);
  const tail = lines.slice(-opts.tailLines);
  const omitted = total - max;
  return [...head, `... (${omitted} lines truncated) ...`, ...tail].join('\n');
}
