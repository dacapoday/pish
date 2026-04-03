/**
 * Unit tests for config helpers — envInt, parseArgs, inferShellType, resolveBinary.
 */

import * as assert from 'node:assert/strict';
import { afterEach, describe, it } from 'node:test';
import {
  envInt,
  inferShellType,
  parseArgs,
  resolveBinary,
} from '../../src/config.js';

// ── envInt ──

describe('envInt', () => {
  const KEY = '__PISH_TEST_ENVINT';

  afterEach(() => {
    delete process.env[KEY];
  });

  it('returns fallback when env var is not set', () => {
    assert.equal(envInt(KEY, 42), 42);
  });

  it('returns fallback when env var is empty', () => {
    process.env[KEY] = '';
    assert.equal(envInt(KEY, 10), 10);
  });

  it('parses valid integer', () => {
    process.env[KEY] = '7';
    assert.equal(envInt(KEY, 10), 7);
  });

  it('returns fallback for non-numeric string', () => {
    process.env[KEY] = 'abc';
    assert.equal(envInt(KEY, 10), 10);
  });

  it('returns fallback for zero', () => {
    process.env[KEY] = '0';
    assert.equal(envInt(KEY, 10), 10);
  });

  it('returns fallback for negative', () => {
    process.env[KEY] = '-5';
    assert.equal(envInt(KEY, 10), 10);
  });

  it('returns fallback for float string', () => {
    process.env[KEY] = '3.14';
    assert.equal(envInt(KEY, 10), 3); // parseInt truncates
  });

  it('handles large numbers', () => {
    process.env[KEY] = '999999';
    assert.equal(envInt(KEY, 10), 999999);
  });
});

// ── parseArgs ──

describe('parseArgs', () => {
  // argv[0]=node, argv[1]=script — parseArgs slices from index 2
  const base = ['node', 'dist/main.js'];

  it('returns defaults for empty args', () => {
    const r = parseArgs(base);
    assert.equal(r.shell, undefined);
    assert.equal(r.pi, undefined);
    assert.equal(r.noAgent, false);
    assert.equal(r.help, false);
    assert.equal(r.version, false);
  });

  it('parses positional shell argument', () => {
    const r = parseArgs([...base, 'zsh']);
    assert.equal(r.shell, 'zsh');
  });

  it('parses --shell flag', () => {
    const r = parseArgs([...base, '--shell', 'zsh']);
    assert.equal(r.shell, 'zsh');
  });

  it('parses -s flag', () => {
    const r = parseArgs([...base, '-s', 'bash']);
    assert.equal(r.shell, 'bash');
  });

  it('parses --shell=value', () => {
    const r = parseArgs([...base, '--shell=zsh']);
    assert.equal(r.shell, 'zsh');
  });

  it('parses --pi flag', () => {
    const r = parseArgs([...base, '--pi', '/usr/bin/pi']);
    assert.equal(r.pi, '/usr/bin/pi');
  });

  it('parses --pi=value', () => {
    const r = parseArgs([...base, '--pi=/usr/bin/pi']);
    assert.equal(r.pi, '/usr/bin/pi');
  });

  it('parses --no-agent', () => {
    const r = parseArgs([...base, '--no-agent']);
    assert.equal(r.noAgent, true);
  });

  it('parses --help', () => {
    assert.equal(parseArgs([...base, '--help']).help, true);
    assert.equal(parseArgs([...base, '-h']).help, true);
  });

  it('parses --version', () => {
    assert.equal(parseArgs([...base, '--version']).version, true);
    assert.equal(parseArgs([...base, '-v']).version, true);
  });

  it('handles combined flags', () => {
    const r = parseArgs([...base, '-s', 'zsh', '--pi', '/x', '--no-agent']);
    assert.equal(r.shell, 'zsh');
    assert.equal(r.pi, '/x');
    assert.equal(r.noAgent, true);
  });

  it('positional does not override --shell', () => {
    // --shell comes first, positional is ignored since shell is already set
    const r = parseArgs([...base, '--shell', 'bash', 'zsh']);
    assert.equal(r.shell, 'bash');
  });
});

// ── inferShellType ──

describe('inferShellType', () => {
  it('detects bash from path', () => {
    assert.equal(inferShellType('/usr/bin/bash'), 'bash');
  });

  it('detects bash from bare name', () => {
    assert.equal(inferShellType('bash'), 'bash');
  });

  it('detects bash with version suffix', () => {
    assert.equal(inferShellType('/usr/local/bin/bash5'), 'bash');
  });

  it('detects zsh from path', () => {
    assert.equal(inferShellType('/bin/zsh'), 'zsh');
  });

  it('detects zsh from bare name', () => {
    assert.equal(inferShellType('zsh'), 'zsh');
  });

  it('returns null for fish', () => {
    assert.equal(inferShellType('/usr/bin/fish'), null);
  });

  it('returns null for sh', () => {
    assert.equal(inferShellType('/bin/sh'), null);
  });

  it('returns null for empty string', () => {
    assert.equal(inferShellType(''), null);
  });
});

// ── resolveBinary ──

describe('resolveBinary', () => {
  it('resolves a known binary by name', () => {
    const result = resolveBinary('bash');
    assert.ok(result, 'bash should be found');
    assert.ok(result!.includes('bash'));
  });

  it('returns null for nonexistent binary name', () => {
    assert.equal(resolveBinary('__pish_nonexistent_binary_xyz__'), null);
  });

  it('resolves an absolute path to an executable', () => {
    const result = resolveBinary('/bin/sh');
    assert.equal(result, '/bin/sh');
  });

  it('returns null for nonexistent path', () => {
    assert.equal(resolveBinary('/nonexistent/path/to/binary'), null);
  });

  it('returns null for non-executable path', () => {
    // /etc/hostname exists but is not executable (on most systems)
    const result = resolveBinary('/etc/hostname');
    assert.equal(result, null);
  });
});
