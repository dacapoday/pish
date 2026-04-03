#!/usr/bin/env npx tsx
/**
 * JSONL log assertion tool.
 *
 * Usage: npx tsx test/verify.ts <logfile> <checks...>
 *
 * Check formats:
 *   event=<name>                    at least one event with this name
 *   event=<name>,<field>=<value>    event exists with matching field
 *   count:<event>=<n>               event appears exactly n times
 *   order:<event1>,<event2>         event1 appears before event2
 *   absent:<event>                  event does not exist
 *
 * Example:
 *   npx tsx test/verify.ts /tmp/test.jsonl \
 *     "event=start,shell=bash" \
 *     "event=context,rc=0" \
 *     "count:context=2" \
 *     "order:shell_ready,context" \
 *     "absent:error"
 */

import * as fs from 'node:fs';

interface LogEvent {
  ts: string;
  event: string;
  [key: string]: unknown;
}

function loadEvents(file: string): LogEvent[] {
  const content = fs.readFileSync(file, 'utf-8').trim();
  if (!content) return [];
  const lines = content.split('\n');
  const events: LogEvent[] = [];
  for (let i = 0; i < lines.length; i++) {
    try {
      events.push(JSON.parse(lines[i]) as LogEvent);
    } catch {
      console.error(`line ${i + 1}: invalid JSON: ${lines[i]}`);
      process.exit(1);
    }
  }
  return events;
}

function check(events: LogEvent[], spec: string): { ok: boolean; msg: string } {
  // count:event=N
  if (spec.startsWith('count:')) {
    const rest = spec.slice(6);
    const [eventName, countStr] = rest.split('=');
    const expected = parseInt(countStr, 10);
    const actual = events.filter((e) => e.event === eventName).length;
    if (actual !== expected) {
      return {
        ok: false,
        msg: `count:${eventName} expected=${expected} actual=${actual}`,
      };
    }
    return { ok: true, msg: `count:${eventName}=${expected}` };
  }

  // order:event1,event2
  if (spec.startsWith('order:')) {
    const rest = spec.slice(6);
    const [e1, e2] = rest.split(',');
    const i1 = events.findIndex((e) => e.event === e1);
    const i2 = events.findIndex((e) => e.event === e2);
    if (i1 === -1) return { ok: false, msg: `order: ${e1} not found` };
    if (i2 === -1) return { ok: false, msg: `order: ${e2} not found` };
    if (i1 >= i2)
      return {
        ok: false,
        msg: `order: ${e1}[${i1}] should be before ${e2}[${i2}]`,
      };
    return { ok: true, msg: `order:${e1}<${e2}` };
  }

  // absent:event
  if (spec.startsWith('absent:')) {
    const eventName = spec.slice(7);
    const found = events.find((e) => e.event === eventName);
    if (found)
      return {
        ok: false,
        msg: `absent:${eventName} but found: ${JSON.stringify(found)}`,
      };
    return { ok: true, msg: `absent:${eventName}` };
  }

  // event=name,field=value,...
  if (spec.startsWith('event=')) {
    const parts = spec.split(',');
    const conditions: Record<string, string> = {};
    for (const p of parts) {
      const [k, ...vs] = p.split('=');
      conditions[k] = vs.join('=');
    }

    const eventName = conditions.event;
    const matching = events.filter((e) => e.event === eventName);
    if (matching.length === 0) {
      return { ok: false, msg: `event=${eventName} not found` };
    }

    // Check additional fields
    const extraFields = Object.entries(conditions).filter(
      ([k]) => k !== 'event',
    );
    if (extraFields.length === 0) {
      return { ok: true, msg: `event=${eventName} (${matching.length} found)` };
    }

    const match = matching.find((e) =>
      extraFields.every(([k, v]) => {
        const actual = String(e[k] ?? '');
        // Substring match (~ prefix)
        if (v.startsWith('~')) return actual.includes(v.slice(1));
        return actual === v;
      }),
    );

    if (!match) {
      const fieldDesc = extraFields.map(([k, v]) => `${k}=${v}`).join(',');
      return {
        ok: false,
        msg: `event=${eventName} with ${fieldDesc} not matched. Had: ${matching.map((e) => JSON.stringify(e)).join('\n  ')}`,
      };
    }
    return {
      ok: true,
      msg: `event=${eventName},${extraFields.map(([k, v]) => `${k}=${v}`).join(',')}`,
    };
  }

  return { ok: false, msg: `unknown check: ${spec}` };
}

// ── main ──

const [logFile, ...checks] = process.argv.slice(2);
if (!logFile || checks.length === 0) {
  console.error('usage: verify.ts <logfile> <check1> [check2] ...');
  process.exit(1);
}

const events = loadEvents(logFile);
let allPassed = true;

for (const spec of checks) {
  const result = check(events, spec);
  if (result.ok) {
    console.log(`  ✓ ${result.msg}`);
  } else {
    console.log(`  ✗ ${result.msg}`);
    allPassed = false;
  }
}

if (!allPassed) {
  process.exit(1);
}
