/**
 * Unit tests for ANSI stripping, line truncation, and alt screen detection.
 */

import * as assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { isAltScreen, stripAnsi, truncateLines } from '../../src/strip.js';

describe('stripAnsi', () => {
  it('returns plain text unchanged', () => {
    assert.equal(stripAnsi('hello world'), 'hello world');
  });

  it('strips CSI color codes', () => {
    assert.equal(stripAnsi('\x1b[31mred\x1b[0m'), 'red');
  });

  it('strips 256-color codes', () => {
    assert.equal(stripAnsi('\x1b[38;5;196mred\x1b[0m'), 'red');
  });

  it('strips truecolor codes', () => {
    assert.equal(stripAnsi('\x1b[38;2;255;0;0mred\x1b[0m'), 'red');
  });

  it('strips OSC sequences (title)', () => {
    assert.equal(stripAnsi('\x1b]0;title\x07text'), 'text');
  });

  it('strips backspace', () => {
    assert.equal(stripAnsi('abc\x08'), 'abc');
  });

  it('strips carriage return', () => {
    assert.equal(stripAnsi('hello\rworld'), 'helloworld');
  });

  it('preserves newlines', () => {
    assert.equal(stripAnsi('line1\nline2'), 'line1\nline2');
  });

  it('strips multiple sequences', () => {
    assert.equal(
      stripAnsi('\x1b[1m\x1b[31mbold red\x1b[0m normal'),
      'bold red normal',
    );
  });

  it('strips control chars (0x00-0x1f except LF)', () => {
    assert.equal(stripAnsi('a\x00b\x01c\x0ed'), 'abcd');
  });
});

describe('truncateLines', () => {
  it('returns short text unchanged', () => {
    const text = 'line1\nline2\nline3';
    assert.equal(
      truncateLines(text, { headLines: 50, tailLines: 30, lineWidth: 512 }),
      text,
    );
  });

  it('truncates long lines', () => {
    const long = 'x'.repeat(600);
    const result = truncateLines(long, {
      headLines: 50,
      tailLines: 30,
      lineWidth: 100,
    });
    assert.ok(result.endsWith(' ...'));
    assert.equal(result.length, 104); // 100 + ' ...'
  });

  it('truncates middle lines', () => {
    const lines = Array.from({ length: 100 }, (_, i) => `line${i}`);
    const result = truncateLines(lines.join('\n'), {
      headLines: 5,
      tailLines: 3,
      lineWidth: 512,
    });
    const parts = result.split('\n');
    assert.equal(parts[0], 'line0');
    assert.equal(parts[4], 'line4');
    assert.ok(parts[5].includes('92 lines truncated'));
    assert.equal(parts[6], 'line97');
    assert.equal(parts[8], 'line99');
    assert.equal(parts.length, 9); // 5 head + 1 msg + 3 tail
  });

  it('does not truncate when within limit', () => {
    const lines = Array.from({ length: 10 }, (_, i) => `line${i}`);
    const text = lines.join('\n');
    assert.equal(
      truncateLines(text, { headLines: 5, tailLines: 5, lineWidth: 512 }),
      text,
    );
  });
});

describe('isAltScreen', () => {
  it('detects alt screen enter (1049)', () => {
    assert.ok(isAltScreen('\x1b[?1049h'));
  });

  it('detects alt screen enter (47)', () => {
    assert.ok(isAltScreen('\x1b[?47h'));
  });

  it('detects alt screen enter (1047)', () => {
    assert.ok(isAltScreen('\x1b[?1047h'));
  });

  it('returns false for normal data', () => {
    assert.ok(!isAltScreen('normal output'));
  });

  it('returns false for alt screen leave', () => {
    assert.ok(!isAltScreen('\x1b[?1049l'));
  });

  it('detects within larger data', () => {
    assert.ok(isAltScreen('before\x1b[?1049hafter'));
  });
});
