/**
 * Renderer — UI output for pish.
 *
 * Uses pi-tui components (Box, Text, Markdown) for block rendering.
 * All output goes to process.stderr.
 */

import {
  Box,
  Markdown,
  type MarkdownTheme,
  Text,
  visibleWidth,
} from '@mariozechner/pi-tui';
import type { AgentEvent, AgentUsage, RpcResponse } from './agent.js';
import { bold, createMarkdownTheme, dim, TAG, theme, toolBg } from './theme.js';

// ─── Banner / Exit / Control ───

export function printBanner(
  version: string,
  shell: string,
  flags?: { noAgent?: boolean },
): void {
  const parts = [`v${version}`, dim(shell)];
  if (flags?.noAgent) parts.push(theme.warning('no-agent'));
  process.stderr.write(`${TAG} ${parts.join(dim(' │ '))}\n`);
}

export function printExit(): void {
  process.stderr.write(`${TAG} ${dim('session ended')}\n`);
}

export function printControl(cmd: string): void {
  process.stderr.write(`${TAG} ${dim(cmd)}\n`);
}

/** Render control command result (success or error). */
export function printControlResult(cmd: string, response: RpcResponse): void {
  const name = cmd.trim().split(/\s+/)[0];

  if (!response.success) {
    const err = response.error ?? 'unknown error';
    process.stderr.write(`${TAG} ${theme.error('✗')} ${dim(name)}: ${err}\n`);
    return;
  }

  const d = response.data;
  switch (response.command) {
    case 'set_model': {
      const prov = d?.provider as Record<string, unknown> | string | undefined;
      const provider =
        typeof prov === 'object' && prov !== null
          ? ((prov.id as string) ?? '')
          : String(prov ?? '');
      const modelId = (d?.id as string) ?? (d?.modelId as string) ?? '';
      process.stderr.write(
        `${TAG} ${theme.success('✓')} model → ${provider ? `${provider} ` : ''}${theme.accent(modelId)}\n`,
      );
      break;
    }
    case 'set_thinking_level': {
      const arg = cmd.trim().split(/\s+/).slice(1).join(' ') || 'medium';
      process.stderr.write(
        `${TAG} ${theme.success('✓')} thinking → ${theme.accent(arg)}\n`,
      );
      break;
    }
    case 'compact': {
      if (d?.tokensBefore) {
        process.stderr.write(
          `${TAG} ${theme.success('✓')} compacted ${formatCompact(d.tokensBefore as number)} tokens\n`,
        );
      } else {
        process.stderr.write(`${TAG} ${theme.success('✓')} compacted\n`);
      }
      break;
    }
    default:
      process.stderr.write(`${TAG} ${theme.success('✓')} ${dim(name)}\n`);
  }
}

export function printNotice(msg: string): void {
  process.stderr.write(`${TAG} ${theme.warning('⚠')} ${msg}\n`);
}

// ─── Spinner ───

const SPINNER_FRAMES = ['⠋', '⠙', '⠹', '⠸', '⠼', '⠴', '⠦', '⠧', '⠇', '⠏'];

export function startSpinner(
  label: string,
  intervalMs: number,
): () => void {
  let frame = 0;
  let stopped = false;

  const maxLabelCols = termWidth() - 3;
  let truncLabel = label;
  if (visibleWidth(label) > maxLabelCols) {
    while (
      visibleWidth(truncLabel) > maxLabelCols - 3 &&
      truncLabel.length > 0
    ) {
      truncLabel = truncLabel.slice(0, -1);
    }
    truncLabel += '...';
  }

  const render = () => {
    const f = SPINNER_FRAMES[frame % SPINNER_FRAMES.length];
    process.stderr.write(`\r${theme.accent(f)} ${theme.muted(truncLabel)}`);
    frame++;
  };
  render();
  const timer = setInterval(render, intervalMs);
  return () => {
    if (stopped) return;
    stopped = true;
    clearInterval(timer);
    process.stderr.write('\r\x1b[2K');
  };
}

// ─── Helpers ───

function termWidth(): number {
  return process.stderr.columns || FALLBACK_TERM_WIDTH;
}

function flush(comp: { render(width: number): string[] }): void {
  for (const line of comp.render(termWidth())) {
    process.stderr.write(`${line}\n`);
  }
}

function shortenPath(p: string): string {
  const home = process.env.HOME;
  if (home && p.startsWith(home)) return `~${p.slice(home.length)}`;
  return p;
}

/** Max visible chars for generic tool-title arg truncation. */
const TOOL_TITLE_MAX_CHARS = 60;
/** Max visible chars for compaction summary. */
const COMPACTION_SUMMARY_MAX_CHARS = 80;
/** Default terminal width when stderr columns is unknown. */
const FALLBACK_TERM_WIDTH = 80;

function truncate(s: string, max: number): string {
  const flat = s.replace(/\n/g, ' ');
  if (flat.length <= max) return flat;
  return `${flat.slice(0, max - 3)}...`;
}

// ─── Tool title (matching pi's per-tool renderCall) ───

function formatToolTitle(
  toolName: string,
  args: Record<string, unknown>,
): string {
  if (toolName === 'bash' && typeof args.command === 'string') {
    return `$ ${args.command}`;
  }
  if (toolName === 'read' && typeof args.path === 'string') {
    const p = shortenPath(args.path as string);
    const offset = args.offset as number | undefined;
    const limit = args.limit as number | undefined;
    let display = `read ${theme.accent(p)}`;
    if (offset !== undefined || limit !== undefined) {
      const start = offset ?? 1;
      const end = limit !== undefined ? start + limit - 1 : '';
      display += theme.warning(`:${start}${end ? `-${end}` : ''}`);
    }
    return display;
  }
  if (toolName === 'write' && typeof args.path === 'string') {
    return `write ${theme.accent(shortenPath(args.path as string))}`;
  }
  if (toolName === 'edit' && typeof args.path === 'string') {
    return `edit ${theme.accent(shortenPath(args.path as string))}`;
  }
  const keys = Object.keys(args);
  if (keys.length > 0)
    return `${toolName} ${truncate(String(args[keys[0]]), TOOL_TITLE_MAX_CHARS)}`;
  return toolName;
}

function extractResultText(result: unknown): string {
  if (!result || typeof result !== 'object') return '';
  const r = result as Record<string, unknown>;
  if (Array.isArray(r.content)) {
    const texts: string[] = [];
    for (const item of r.content) {
      if (item && typeof item === 'object') {
        const rec = item as Record<string, unknown>;
        if (rec.type === 'text' && typeof rec.text === 'string') {
          texts.push(rec.text);
        }
      }
    }
    return texts.join('\n').trim();
  }
  if (typeof r.text === 'string') return r.text;
  if (typeof r.output === 'string') return r.output;
  return '';
}

// ─── Status bar (pi footer style) ───

function formatCompact(n: number): string {
  if (n < 1000) return n.toString();
  if (n < 10000) return `${(n / 1000).toFixed(1)}k`;
  if (n < 1000000) return `${Math.round(n / 1000)}k`;
  if (n < 10000000) return `${(n / 1000000).toFixed(1)}M`;
  return `${Math.round(n / 1000000)}M`;
}

function renderStatusBar(durationMs: number, usage?: AgentUsage): void {
  const w = termWidth();
  const t = (durationMs / 1000).toFixed(1);

  if (!usage || usage.totalTokens === 0) {
    process.stderr.write(`${theme.success('✓')} done (${t}s)\n`);
    return;
  }

  const parts: string[] = [];
  if (usage.inputTokens) parts.push(`↑${formatCompact(usage.inputTokens)}`);
  if (usage.outputTokens) parts.push(`↓${formatCompact(usage.outputTokens)}`);
  if (usage.cacheRead) parts.push(`R${formatCompact(usage.cacheRead)}`);
  if (usage.cacheWrite) parts.push(`W${formatCompact(usage.cacheWrite)}`);
  if (usage.cost > 0) parts.push(`$${usage.cost.toFixed(3)}`);

  if (usage.contextWindow > 0) {
    const windowStr = formatCompact(usage.contextWindow);
    if (usage.contextPercent !== null) {
      parts.push(`${usage.contextPercent.toFixed(1)}%/${windowStr}`);
    } else {
      parts.push(`/${windowStr}`);
    }
  }

  parts.push(`${t}s`);

  const leftContent = parts.join(' ');

  const rightParts: string[] = [];
  if (usage.provider) rightParts.push(`(${usage.provider})`);
  if (usage.model) {
    let modelStr = usage.model;
    if (usage.thinkingLevel) modelStr += ` • ${usage.thinkingLevel}`;
    rightParts.push(modelStr);
  }
  const rightContent = rightParts.join(' ');

  const leftLen = leftContent.length;
  const rightLen = rightContent.length;
  const minPad = 2;

  let line: string;
  if (leftLen + minPad + rightLen <= w) {
    const pad = ' '.repeat(w - leftLen - rightLen);
    line = leftContent + pad + rightContent;
  } else if (leftLen + minPad <= w) {
    const avail = w - leftLen - minPad;
    const truncRight = rightContent.slice(0, avail);
    const pad = ' '.repeat(w - leftLen - truncRight.length);
    line = leftContent + pad + truncRight;
  } else {
    line = leftContent;
  }

  process.stderr.write(`${theme.dim(line)}\n`);
}

// ─── StreamRenderer ───

export class StreamRenderer {
  private inThinking = false;
  private inText = false;
  private textAccum = '';
  private stopSpinner: (() => void) | null = null;
  private mdTheme: MarkdownTheme;
  private pendingTools: Map<string, string> = new Map();
  private readonly toolResultLines: number;
  private readonly spinnerInterval: number;

  constructor(toolResultLines: number, spinnerInterval: number) {
    this.mdTheme = createMarkdownTheme();
    this.toolResultLines = toolResultLines;
    this.spinnerInterval = spinnerInterval;
  }

  handleEvent(event: AgentEvent): void {
    switch (event.type) {
      case 'thinking_start':
        this.onThinkingStart();
        break;
      case 'thinking_delta':
        this.onThinkingDelta(event.delta);
        break;
      case 'thinking_end':
        this.onThinkingEnd();
        break;
      case 'text_start':
        this.onTextStart();
        break;
      case 'text_delta':
        this.onTextDelta(event.delta);
        break;
      case 'text_end':
        this.onTextEnd();
        break;
      case 'tool_start':
        this.onToolStart(event.toolCallId, event.toolName, event.args);
        break;
      case 'tool_update':
        break;
      case 'tool_end':
        this.onToolEnd(
          event.toolCallId,
          event.toolName,
          event.result,
          event.isError,
        );
        break;
      case 'turn_end':
        break;
      case 'compaction_start':
        this.onCompactionStart(event.reason);
        break;
      case 'compaction_end':
        this.onCompactionEnd(event.summary, event.aborted, event.error);
        break;
      case 'agent_done':
        this.onDone(event.durationMs, event.usage);
        break;
      case 'agent_error':
        this.onError(event.error);
        break;
    }
  }

  showSpinner(): void {
    process.stderr.write('\x1b[?25l'); // hide cursor
    this.stopSpinner = startSpinner('Working...', this.spinnerInterval);
  }

  // ─── Thinking ───

  private onThinkingStart(): void {
    this.clearSpinner();
    this.inThinking = true;
    process.stderr.write('\n');
  }

  private onThinkingDelta(delta: string): void {
    if (!this.inThinking) return;
    process.stderr.write(theme.thinkingText(delta));
  }

  private onThinkingEnd(): void {
    if (!this.inThinking) return;
    this.inThinking = false;
    process.stderr.write('\n');
    this.restartSpinner();
  }

  // ─── Text ───

  private onTextStart(): void {
    this.clearSpinner();
    this.inText = true;
    this.textAccum = '';
    process.stderr.write('\n');
  }

  private onTextDelta(delta: string): void {
    if (!this.inText) return;
    this.textAccum += delta;
    process.stderr.write(delta);
  }

  private onTextEnd(): void {
    if (!this.inText) return;
    this.inText = false;

    const raw = this.textAccum.trim();
    if (!raw) {
      const linesToErase = this.countCursorLinesFromStart(this.textAccum);
      if (linesToErase > 0) {
        process.stderr.write(`\x1b[${linesToErase}A`);
      }
      process.stderr.write('\x1b[1G\x1b[0J');
      this.textAccum = '';
      return;
    }

    const linesToErase = this.countCursorLinesFromStart(this.textAccum);
    if (linesToErase > 0) {
      process.stderr.write(`\x1b[${linesToErase}A`);
    }
    process.stderr.write('\x1b[1G\x1b[0J');

    const md = new Markdown(raw, 1, 0, this.mdTheme);
    flush(md);
    this.textAccum = '';
    this.restartSpinner();
  }

  // ─── Tool calls ───

  private onToolStart(
    toolCallId: string,
    toolName: string,
    args: Record<string, unknown>,
  ): void {
    this.clearSpinner();
    const title = formatToolTitle(toolName, args);
    this.pendingTools.set(toolCallId, title);
    this.stopSpinner = startSpinner(title, this.spinnerInterval);
  }

  private onToolEnd(
    toolCallId: string,
    _toolName: string,
    result: unknown,
    isError: boolean,
  ): void {
    this.clearSpinner();

    const title = this.pendingTools.get(toolCallId) || '';
    this.pendingTools.delete(toolCallId);

    const bgFunc = isError ? toolBg.error : toolBg.success;
    const text = extractResultText(result);

    const box = new Box(1, 1, bgFunc);
    box.addChild(new Text(bold(title), 0, 0));

    if (text) {
      const allLines = text.split('\n');
      const display =
        allLines.length > this.toolResultLines
          ? [
              ...allLines.slice(0, this.toolResultLines),
              theme.muted(
                `  ... (${allLines.length - this.toolResultLines} more lines)`,
              ),
            ].join('\n')
          : text;
      box.addChild(new Text(theme.toolOutput(display), 0, 0));
    } else if (isError) {
      box.addChild(new Text(theme.error('(error)'), 0, 0));
    }

    process.stderr.write('\n');
    flush(box);
    this.restartSpinner();
  }

  // ─── Auto-compaction ───

  private onCompactionStart(reason: string): void {
    this.clearSpinner();
    const reasonText =
      reason === 'overflow'
        ? 'Context overflow — auto-compacting...'
        : 'Auto-compacting...';
    this.stopSpinner = startSpinner(reasonText, this.spinnerInterval);
  }

  private onCompactionEnd(
    summary?: string,
    aborted?: boolean,
    error?: string,
  ): void {
    this.clearSpinner();
    if (aborted) {
      process.stderr.write(`${theme.warning('⚠')} compaction cancelled\n`);
    } else if (error) {
      process.stderr.write(`${theme.error('✗')} compaction failed: ${error}\n`);
    } else if (summary) {
      const short =
        summary.length > COMPACTION_SUMMARY_MAX_CHARS
          ? `${summary.slice(0, COMPACTION_SUMMARY_MAX_CHARS - 3)}...`
          : summary;
      process.stderr.write(
        `${theme.accent('●')} compacted: ${theme.muted(short)}\n`,
      );
    }
  }

  // ─── Done / Error / Interrupted ───

  private showCursor(): void {
    process.stderr.write('\x1b[?25h');
  }

  private onDone(durationMs: number, usage?: AgentUsage): void {
    this.clearSpinner();
    this.showCursor();
    process.stderr.write('\n');
    renderStatusBar(durationMs, usage);
    process.stderr.write('\n');
  }

  private onError(msg: string): void {
    this.clearSpinner();
    this.showCursor();
    process.stderr.write(`\n ${theme.error(`Error: ${msg}`)}\n\n`);
  }

  printInterrupted(): void {
    this.clearSpinner();
    this.showCursor();
    if (this.inThinking) {
      process.stderr.write('\n');
      this.inThinking = false;
    }
    if (this.inText) {
      process.stderr.write('\n');
      this.inText = false;
    }
    process.stderr.write(`\n ${theme.error('Operation aborted')}\n\n`);
  }

  // ─── Internal ───

  private clearSpinner(): void {
    if (this.stopSpinner) {
      this.stopSpinner();
      this.stopSpinner = null;
    }
  }

  private restartSpinner(): void {
    this.stopSpinner = startSpinner('Working...', this.spinnerInterval);
  }

  private countCursorLinesFromStart(text: string): number {
    const w = termWidth();
    const segments = text.split('\n');
    const newlineCount = segments.length - 1;

    let wrapExtra = 0;
    for (const seg of segments) {
      const cols = visibleWidth(seg);
      if (cols > w) {
        wrapExtra += Math.ceil(cols / w) - 1;
      }
    }

    return newlineCount + wrapExtra;
  }
}
