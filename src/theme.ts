/**
 * Theme — ANSI color utilities and color palette.
 *
 * Raw ANSI helpers (matching pi's Theme approach) and color definitions
 * used across all rendering functions.
 */

import type { MarkdownTheme } from '@mariozechner/pi-tui';

// ─── Raw ANSI helpers ───

function hexToRgb(hex: string): [number, number, number] {
  const h = hex.replace('#', '');
  return [
    parseInt(h.substring(0, 2), 16),
    parseInt(h.substring(2, 4), 16),
    parseInt(h.substring(4, 6), 16),
  ];
}

export function fg(hex: string): (s: string) => string {
  const [r, g, b] = hexToRgb(hex);
  const open = `\x1b[38;2;${r};${g};${b}m`;
  return (s: string) => `${open}${s}\x1b[39m`;
}

export function bg(hex: string): (s: string) => string {
  const [r, g, b] = hexToRgb(hex);
  const open = `\x1b[48;2;${r};${g};${b}m`;
  return (s: string) => `${open}${s}\x1b[49m`;
}

export const bold = (s: string) => `\x1b[1m${s}\x1b[22m`;
export const italic = (s: string) => `\x1b[3m${s}\x1b[23m`;
export const dim = (s: string) => `\x1b[2m${s}\x1b[22m`;
export const underline = (s: string) => `\x1b[4m${s}\x1b[24m`;
export const strikethrough = (s: string) => `\x1b[9m${s}\x1b[29m`;

// ─── Theme colors (pi dark.json) ───

export const theme = {
  accent: fg('#8abeb7'),
  success: fg('#b5bd68'),
  error: fg('#cc6666'),
  warning: fg('#ffff00'),
  muted: fg('#808080'),
  dim: fg('#666666'),
  thinkingText: (s: string) => italic(fg('#808080')(s)),
  toolOutput: fg('#808080'),
};

export const toolBg = {
  success: bg('#283228'),
  error: bg('#3c2828'),
};

export const TAG = dim(fg('#00d7ff')('pish')); // cyan dim

export function createMarkdownTheme(): MarkdownTheme {
  return {
    heading: (s) => bold(fg('#f0c674')(s)),
    link: fg('#81a2be'),
    linkUrl: fg('#666666'),
    code: fg('#8abeb7'),
    codeBlock: fg('#b5bd68'),
    codeBlockBorder: fg('#808080'),
    quote: fg('#808080'),
    quoteBorder: fg('#808080'),
    hr: fg('#808080'),
    listBullet: fg('#8abeb7'),
    bold,
    italic,
    strikethrough,
    underline,
  };
}
