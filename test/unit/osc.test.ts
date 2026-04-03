/**
 * Unit tests for OSC 9154 parser — stateless parseOsc() and stateful OscParser.
 */

import * as assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { OscParser, type PositionedSignal, parseOsc } from '../../src/osc.js';

// ── Stateless parseOsc ──

describe('parseOsc (stateless)', () => {
  it('returns clean data with no OSC', () => {
    const r = parseOsc('hello world');
    assert.equal(r.clean, 'hello world');
    assert.equal(r.signals.length, 0);
  });

  it('extracts S signal', () => {
    const r = parseOsc('\x1b]9154;S\x07');
    assert.equal(r.clean, '');
    assert.equal(r.signals.length, 1);
    assert.deepEqual(r.signals[0].signal, { type: 'S' });
    assert.equal(r.signals[0].cleanOffset, 0);
  });

  it('extracts C signal', () => {
    const r = parseOsc('prompt\x1b]9154;C\x07output');
    assert.equal(r.clean, 'promptoutput');
    assert.equal(r.signals.length, 1);
    assert.deepEqual(r.signals[0].signal, { type: 'C' });
    assert.equal(r.signals[0].cleanOffset, 6);
  });

  it('extracts D signal with rc', () => {
    const r = parseOsc('\x1b]9154;D;42\x07');
    assert.equal(r.clean, '');
    assert.deepEqual(r.signals[0].signal, { type: 'D', rc: 42 });
  });

  it('extracts P signal with cmd', () => {
    const r = parseOsc('\x1b]9154;P;fix the bug\x07');
    assert.equal(r.clean, '');
    assert.deepEqual(r.signals[0].signal, { type: 'P', cmd: 'fix the bug' });
  });

  it('extracts R signal', () => {
    const r = parseOsc('\x1b]9154;R\x07');
    assert.deepEqual(r.signals[0].signal, { type: 'R' });
  });

  it('extracts E signal with msg', () => {
    const r = parseOsc('\x1b]9154;E;version too old\x07');
    assert.deepEqual(r.signals[0].signal, {
      type: 'E',
      msg: 'version too old',
    });
  });

  it('handles ST terminator (ESC \\)', () => {
    const r = parseOsc('\x1b]9154;D;0\x1b\\');
    assert.equal(r.clean, '');
    assert.deepEqual(r.signals[0].signal, { type: 'D', rc: 0 });
  });

  it('handles multiple signals', () => {
    const r = parseOsc('a\x1b]9154;C\x07b\x1b]9154;D;0\x07c');
    assert.equal(r.clean, 'abc');
    assert.equal(r.signals.length, 2);
    assert.deepEqual(r.signals[0].signal, { type: 'C' });
    assert.equal(r.signals[0].cleanOffset, 1);
    assert.deepEqual(r.signals[1].signal, { type: 'D', rc: 0 });
    assert.equal(r.signals[1].cleanOffset, 2);
  });

  it('preserves non-9154 OSC sequences', () => {
    const r = parseOsc('\x1b]0;title\x07hello');
    assert.equal(r.clean, '\x1b]0;title\x07hello');
    assert.equal(r.signals.length, 0);
  });

  it('handles unknown payload gracefully', () => {
    const r = parseOsc('\x1b]9154;X;unknown\x07');
    assert.equal(r.clean, '');
    assert.equal(r.signals.length, 0); // unknown payload → null → not pushed
  });
});

// ── Stateful OscParser ──

describe('OscParser (stateful, cross-chunk)', () => {
  it('handles complete sequence in one chunk', () => {
    const p = new OscParser();
    const r = p.feed('before\x1b]9154;D;0\x07after');
    assert.equal(r.clean, 'beforeafter');
    assert.equal(r.signals.length, 1);
    assert.deepEqual(r.signals[0].signal, { type: 'D', rc: 0 });
  });

  it('handles ESC split at chunk boundary', () => {
    const p = new OscParser();
    // Chunk 1: "hello\x1b"  — ESC at end, buffered
    const r1 = p.feed('hello\x1b');
    assert.equal(r1.clean, 'hello');
    assert.equal(r1.signals.length, 0);
    // Chunk 2: "]9154;D;0\x07world"
    const r2 = p.feed(']9154;D;0\x07world');
    assert.equal(r2.clean, 'world');
    assert.equal(r2.signals.length, 1);
    assert.deepEqual(r2.signals[0].signal, { type: 'D', rc: 0 });
  });

  it('handles split in middle of "9154"', () => {
    const p = new OscParser();
    const r1 = p.feed('data\x1b]91');
    assert.equal(r1.clean, 'data');
    const r2 = p.feed('54;C\x07more');
    assert.equal(r2.clean, 'more');
    assert.equal(r2.signals.length, 1);
    assert.deepEqual(r2.signals[0].signal, { type: 'C' });
  });

  it('handles split in payload', () => {
    const p = new OscParser();
    const r1 = p.feed('\x1b]9154;P;fix');
    assert.equal(r1.clean, '');
    assert.equal(r1.signals.length, 0);
    const r2 = p.feed(' the bug\x07');
    assert.equal(r2.clean, '');
    assert.equal(r2.signals.length, 1);
    assert.deepEqual(r2.signals[0].signal, { type: 'P', cmd: 'fix the bug' });
  });

  it('handles split right before terminator', () => {
    const p = new OscParser();
    const r1 = p.feed('\x1b]9154;S');
    assert.equal(r1.clean, '');
    assert.equal(r1.signals.length, 0);
    const r2 = p.feed('\x07done');
    assert.equal(r2.clean, 'done');
    assert.equal(r2.signals.length, 1);
    assert.deepEqual(r2.signals[0].signal, { type: 'S' });
  });

  it('handles ST terminator split (ESC at end)', () => {
    const p = new OscParser();
    // OSC with ST: \x1b]9154;D;5\x1b\\
    const r1 = p.feed('\x1b]9154;D;5\x1b');
    assert.equal(r1.clean, '');
    const r2 = p.feed('\\next');
    assert.equal(r2.clean, 'next');
    assert.equal(r2.signals.length, 1);
    assert.deepEqual(r2.signals[0].signal, { type: 'D', rc: 5 });
  });

  it('flushes non-OSC ESC sequences immediately', () => {
    const p = new OscParser();
    // \x1b[ is CSI, not \x1b] — should not be buffered
    const r = p.feed('hello\x1b[31mred\x1b[0m');
    assert.equal(r.clean, 'hello\x1b[31mred\x1b[0m');
    assert.equal(r.signals.length, 0);
  });

  it('handles multiple chunks with clean data between', () => {
    const p = new OscParser();
    const r1 = p.feed('cmd1\x1b]9154;D;0\x07prompt\x1b]9154;C\x07out');
    assert.equal(r1.clean, 'cmd1promptout');
    assert.equal(r1.signals.length, 2);
    const r2 = p.feed('put\x1b]9154;D;1\x07');
    assert.equal(r2.clean, 'put');
    assert.equal(r2.signals.length, 1);
  });

  it('flushes oversized partial as non-OSC data', () => {
    const p = new OscParser();
    // Create a "partial" that exceeds MAX_PARTIAL (8192)
    const bigPayload = `\x1b]9154;P;${'x'.repeat(9000)}`;
    const r = p.feed(bigPayload);
    // Should be flushed as clean data since it's too big
    assert.ok(r.clean.length > 0);
  });

  it('handles lone ESC followed by normal data in next chunk', () => {
    const p = new OscParser();
    const r1 = p.feed('before\x1b');
    assert.equal(r1.clean, 'before');
    // Next chunk starts with [ (CSI), not ] (OSC)
    const r2 = p.feed('[31mred');
    assert.equal(r2.clean, '\x1b[31mred');
    assert.equal(r2.signals.length, 0);
  });

  it('byte-by-byte feeding works', () => {
    const p = new OscParser();
    const full = 'pre\x1b]9154;D;7\x07post';
    let allClean = '';
    const allSignals: PositionedSignal[] = [];
    for (const ch of full) {
      const r = p.feed(ch);
      allClean += r.clean;
      allSignals.push(...r.signals);
    }
    assert.equal(allClean, 'prepost');
    assert.equal(allSignals.length, 1);
    assert.deepEqual(allSignals[0].signal, { type: 'D', rc: 7 });
  });
});
