/**
 * Unit tests for Recorder — context extraction from PTY data stream.
 */

import * as assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import {
  Recorder,
  type RecorderEvent,
  type RecorderOptions,
} from '../../src/recorder.js';

/** Default test options for Recorder. */
const TEST_OPTS: RecorderOptions = {
  maxContext: 20,
  headLines: 50,
  tailLines: 30,
  lineWidth: 512,
  compactBufferThreshold: 100_000,
  defaultCols: 120,
  defaultRows: 30,
};

// ── Helpers ──

/** Build an OSC 9154 signal. */
function osc(payload: string): string {
  return `\x1b]9154;${payload}\x07`;
}

/**
 * Collect all events emitted by a recorder during a callback.
 * Waits until events settle (no new events for 30ms) instead of a fixed delay.
 */
function collectEvents(
  recorder: Recorder,
  fn: () => void,
  timeoutMs = 2000,
): Promise<RecorderEvent[]> {
  const events: RecorderEvent[] = [];
  recorder.onEvent((evt) => events.push(evt));
  fn();
  return new Promise((resolve) => {
    let lastCount = -1;
    const check = setInterval(() => {
      if (events.length === lastCount) {
        clearInterval(check);
        clearTimeout(deadline);
        resolve(events);
      }
      lastCount = events.length;
    }, 30);
    const deadline = setTimeout(() => {
      clearInterval(check);
      resolve(events);
    }, timeoutMs);
  });
}

// ── Tests ──

describe('Recorder', () => {
  it('emits shell_ready on S signal', async () => {
    const r = new Recorder(TEST_OPTS);
    const events = await collectEvents(r, () => {
      r.feed(osc('S'));
    });
    assert.ok(events.some((e) => e.type === 'shell_ready'));
  });

  it('strips OSC from clean output', () => {
    const r = new Recorder(TEST_OPTS);
    const clean = r.feed(`hello${osc('S')}world`);
    assert.equal(clean, 'helloworld');
  });

  it('first D is discarded (startup garbage)', async () => {
    const r = new Recorder(TEST_OPTS);
    const events = await collectEvents(r, () => {
      r.feed(`garbage${osc('D;0')}`);
    });
    assert.ok(!events.some((e) => e.type === 'context'));
    assert.ok(!events.some((e) => e.type === 'context_skip'));
  });

  it('emits context_skip for empty enter (no C)', async () => {
    const r = new Recorder(TEST_OPTS);
    const events = await collectEvents(r, () => {
      // First D (discarded)
      r.feed(osc('D;0'));
      // Second D with no C in between = empty enter
      r.feed(`prompt${osc('D;0')}`);
    });
    assert.ok(events.some((e) => e.type === 'context_skip'));
    const skip = events.find((e) => e.type === 'context_skip');
    assert.ok(skip);
    if (skip?.type === 'context_skip') {
      assert.equal(skip.reason, 'no_c');
    }
  });

  it('emits context for normal command (D → C → output → D)', async () => {
    const r = new Recorder(TEST_OPTS);
    const events = await collectEvents(r, () => {
      r.feed(osc('D;0')); // first D, discarded
      r.feed(`$ echo hi${osc('C')}hi\n${osc('D;0')}`);
    });
    const ctx = events.find((e) => e.type === 'context');
    assert.ok(ctx, 'should emit context');
    if (ctx?.type === 'context') {
      assert.equal(ctx.entry.output, 'hi');
      assert.equal(ctx.entry.rc, 0);
    }
  });

  it('captures exit code from D signal', async () => {
    const r = new Recorder(TEST_OPTS);
    const events = await collectEvents(r, () => {
      r.feed(osc('D;0'));
      r.feed(`$ false${osc('C')}error output\n${osc('D;42')}`);
    });
    const ctx = events.find((e) => e.type === 'context');
    assert.ok(ctx);
    if (ctx?.type === 'context') {
      assert.equal(ctx.entry.rc, 42);
    }
  });

  it('skips empty output with rc=0 (no_output)', async () => {
    const r = new Recorder(TEST_OPTS);
    const events = await collectEvents(r, () => {
      r.feed(osc('D;0'));
      // Command with C but no output (e.g. `true`)
      r.feed(`$ true${osc('C')}${osc('D;0')}`);
    });
    const skip = events.find(
      (e) => e.type === 'context_skip' && e.reason === 'no_output',
    );
    assert.ok(skip, 'should skip empty output with rc=0');
  });

  it('keeps entries with rc!=0 even without output', async () => {
    const r = new Recorder(TEST_OPTS);
    const events = await collectEvents(r, () => {
      r.feed(osc('D;0'));
      r.feed(`$ false${osc('C')}${osc('D;1')}`);
    });
    // rc=1 with no output should NOT be skipped — wait, let me check...
    // Actually the code skips when !outputText && rc === 0.
    // rc=1 with empty output should be kept as context.
    const ctx = events.find((e) => e.type === 'context');
    // If there's truly no output text after trim, and rc != 0, it should still be a context entry
    // But stripAnsi('').trim() === '' ... let's check the actual behavior
    // The code: if (!outputText && rc === 0) skip. So rc=1 with empty output → NOT skipped.
    // But outputText = truncateLines(stripAnsi('').trim()) = '' → context with empty output
    assert.ok(ctx, 'should emit context for rc!=0 even with empty output');
  });

  it('respects maxContext limit', async () => {
    const r = new Recorder({ ...TEST_OPTS, maxContext: 2 });
    await collectEvents(r, () => {
      r.feed(osc('D;0'));
      r.feed(`$ cmd1${osc('C')}out1\n${osc('D;0')}`);
      r.feed(`$ cmd2${osc('C')}out2\n${osc('D;0')}`);
      r.feed(`$ cmd3${osc('C')}out3\n${osc('D;0')}`);
    });
    assert.equal(r.context.length, 2);
    assert.equal(r.context[0].output, 'out2');
    assert.equal(r.context[1].output, 'out3');
  });

  it('drain() returns and clears context', async () => {
    const r = new Recorder(TEST_OPTS);
    await collectEvents(r, () => {
      r.feed(osc('D;0'));
      r.feed(`$ echo hi${osc('C')}hi\n${osc('D;0')}`);
    });
    assert.equal(r.context.length, 1);
    const drained = r.drain();
    assert.equal(drained.length, 1);
    assert.equal(r.context.length, 0);
  });

  it('emits agent event on P signal and discards next D', async () => {
    const r = new Recorder(TEST_OPTS);
    const events = await collectEvents(r, () => {
      r.feed(osc('D;0'));
      r.feed(`prompt${osc('C')}${osc('P;fix the bug')}`);
      // D after agent should be discarded
      r.feed(osc('D;0'));
    });
    const agent = events.find((e) => e.type === 'agent');
    assert.ok(agent);
    if (agent?.type === 'agent') {
      assert.equal(agent.cmd, 'fix the bug');
    }
    // No context should be emitted (discarded)
    assert.ok(!events.some((e) => e.type === 'context'));
  });

  it('emits reverse and reverse_done events', async () => {
    const r = new Recorder(TEST_OPTS);
    const events = await collectEvents(r, () => {
      r.feed(osc('D;0'));
      r.feed(`prompt${osc('C')}${osc('R')}`);
      r.feed(osc('D;0'));
    });
    assert.ok(events.some((e) => e.type === 'reverse'));
    assert.ok(events.some((e) => e.type === 'reverse_done'));
  });

  it('emits error on E signal', async () => {
    const r = new Recorder(TEST_OPTS);
    const events = await collectEvents(r, () => {
      r.feed(osc('E;bash 3.2 not supported'));
    });
    const err = events.find((e) => e.type === 'error');
    assert.ok(err);
    if (err?.type === 'error') {
      assert.equal(err.msg, 'bash 3.2 not supported');
    }
  });

  it('handles alt screen output', async () => {
    const r = new Recorder(TEST_OPTS);
    const events = await collectEvents(r, () => {
      r.feed(osc('D;0'));
      r.feed(
        `$ vim${osc('C')}\x1b[?1049hscreen content\x1b[?1049l${osc('D;0')}`,
      );
    });
    const ctx = events.find((e) => e.type === 'context');
    assert.ok(ctx);
    if (ctx?.type === 'context') {
      assert.equal(ctx.entry.output, '[full-screen app]');
    }
  });

  it('compacts fullBuffer when segStart > 100KB', async () => {
    const r = new Recorder(TEST_OPTS);
    r.feed(osc('D;0')); // first D

    // Feed >100KB of data, then wait for async D via collectEvents
    const bigData = 'x'.repeat(110_000);
    await collectEvents(r, () => {
      r.feed(`$ cmd${osc('C')}${bigData}${osc('D;0')}`);
    });

    // Context should still work after compaction
    const events = await collectEvents(r, () => {
      r.feed(`$ echo test${osc('C')}test\n${osc('D;0')}`);
    });
    const ctx = events.find((e) => e.type === 'context');
    assert.ok(ctx, 'should still produce context after compaction');
  });
});
