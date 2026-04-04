/**
 * Unit tests for AgentManager — process lifecycle, RPC, event flattening.
 *
 * Uses a fake pi script (shell) instead of real pi binary.
 */

import * as assert from 'node:assert/strict';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { afterEach, describe, it } from 'node:test';
import {
  type AgentConfig,
  type AgentEvent,
  AgentManager,
} from '../../src/agent.js';

/** Default test config for AgentManager. */
const TEST_AGENT_CFG: AgentConfig = {
  piPath: '/nonexistent',
  rpcTimeout: 30_000,
  killTimeout: 2_000,
};

// ── Helpers ──

/** Create a temp script that acts as a fake pi. */
function fakePi(script: string): string {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'pish-test-'));
  const bin = path.join(dir, 'pi');
  fs.writeFileSync(bin, `#!/bin/bash\n${script}`, { mode: 0o755 });
  return bin;
}

/** Collect events until a predicate is met or timeout. */
function waitForEvent(
  agent: AgentManager,
  predicate: (e: AgentEvent) => boolean,
  timeoutMs = 5000,
): Promise<AgentEvent[]> {
  const events: AgentEvent[] = [];
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => {
      reject(
        new Error(
          `Timeout waiting for event. Got: ${events.map((e) => e.type).join(', ')}`,
        ),
      );
    }, timeoutMs);
    agent.onEvent((e) => {
      events.push(e);
      if (predicate(e)) {
        clearTimeout(timer);
        resolve(events);
      }
    });
  });
}

// Track agents for cleanup
const agents: AgentManager[] = [];

afterEach(() => {
  for (const a of agents) {
    a.kill();
  }
  agents.length = 0;
});

// ── Tests ──

describe('AgentManager', () => {
  it('starts not running and not alive', () => {
    const agent = new AgentManager(TEST_AGENT_CFG);
    agents.push(agent);
    assert.equal(agent.running, false);
    assert.equal(agent.alive, false);
  });

  it('sessionFile defaults to undefined', () => {
    const agent = new AgentManager(TEST_AGENT_CFG);
    agents.push(agent);
    assert.equal(agent.sessionFile, undefined);
  });

  it('emits agent_error when process crashes immediately', async () => {
    const bin = fakePi('exit 42');
    const agent = new AgentManager({ ...TEST_AGENT_CFG, piPath: bin });
    agents.push(agent);

    const eventsP = waitForEvent(agent, (e) => e.type === 'agent_error');
    agent.submit('hello');
    const events = await eventsP;

    const err = events.find((e) => e.type === 'agent_error');
    assert.ok(err);
    if (err?.type === 'agent_error') {
      assert.ok(err.error.includes('42'));
    }
    assert.equal(agent.alive, false);
  });

  it('stores crashInfo on non-zero exit', async () => {
    const bin = fakePi('exit 42');
    const agent = new AgentManager({ ...TEST_AGENT_CFG, piPath: bin });
    agents.push(agent);

    const eventsP = waitForEvent(agent, (e) => e.type === 'agent_error');
    agent.submit('hello');
    await eventsP;

    const info = agent.consumeCrashInfo();
    assert.ok(info);
    assert.ok(info!.includes('42'));
  });

  it('emits agent_done for a complete agent run', async () => {
    // Fake pi that sends agent_start then agent_end
    const bin = fakePi(`
      read -r line  # read prompt command
      echo '{"type":"agent_start"}'
      echo '{"type":"agent_end","messages":[]}'
      # Keep alive briefly
      sleep 60
    `);
    const agent = new AgentManager({ ...TEST_AGENT_CFG, piPath: bin });
    agents.push(agent);

    const eventsP = waitForEvent(agent, (e) => e.type === 'agent_done');
    agent.submit('hello');
    const events = await eventsP;

    assert.ok(events.some((e) => e.type === 'agent_done'));
    assert.equal(agent.running, false);
  });

  it('flattens message_update thinking events', async () => {
    const bin = fakePi(`
      read -r line
      echo '{"type":"agent_start"}'
      echo '{"type":"message_update","assistantMessageEvent":{"type":"thinking_start"}}'
      echo '{"type":"message_update","assistantMessageEvent":{"type":"thinking_delta","delta":"hmm"}}'
      echo '{"type":"message_update","assistantMessageEvent":{"type":"thinking_end","content":"hmm"}}'
      echo '{"type":"agent_end","messages":[]}'
      sleep 60
    `);
    const agent = new AgentManager({ ...TEST_AGENT_CFG, piPath: bin });
    agents.push(agent);

    const eventsP = waitForEvent(agent, (e) => e.type === 'agent_done');
    agent.submit('hello');
    const events = await eventsP;

    assert.ok(events.some((e) => e.type === 'thinking_start'));
    assert.ok(events.some((e) => e.type === 'thinking_delta'));
    assert.ok(events.some((e) => e.type === 'thinking_end'));
  });

  it('flattens text events', async () => {
    const bin = fakePi(`
      read -r line
      echo '{"type":"agent_start"}'
      echo '{"type":"message_update","assistantMessageEvent":{"type":"text_start"}}'
      echo '{"type":"message_update","assistantMessageEvent":{"type":"text_delta","delta":"hi"}}'
      echo '{"type":"message_update","assistantMessageEvent":{"type":"text_end","content":"hi"}}'
      echo '{"type":"agent_end","messages":[]}'
      sleep 60
    `);
    const agent = new AgentManager({ ...TEST_AGENT_CFG, piPath: bin });
    agents.push(agent);

    const eventsP = waitForEvent(agent, (e) => e.type === 'agent_done');
    agent.submit('hello');
    const events = await eventsP;

    assert.ok(events.some((e) => e.type === 'text_start'));
    const delta = events.find((e) => e.type === 'text_delta');
    assert.ok(delta);
    if (delta?.type === 'text_delta') assert.equal(delta.delta, 'hi');
  });

  it('flattens tool events', async () => {
    const bin = fakePi(`
      read -r line
      echo '{"type":"agent_start"}'
      echo '{"type":"tool_execution_start","toolCallId":"t1","toolName":"bash","args":{"command":"ls"}}'
      echo '{"type":"tool_execution_end","toolCallId":"t1","toolName":"bash","result":{"text":"file.txt"},"isError":false}'
      echo '{"type":"agent_end","messages":[]}'
      sleep 60
    `);
    const agent = new AgentManager({ ...TEST_AGENT_CFG, piPath: bin });
    agents.push(agent);

    const eventsP = waitForEvent(agent, (e) => e.type === 'agent_done');
    agent.submit('hello');
    const events = await eventsP;

    const start = events.find((e) => e.type === 'tool_start');
    assert.ok(start);
    if (start?.type === 'tool_start') {
      assert.equal(start.toolName, 'bash');
      assert.equal(start.toolCallId, 't1');
    }
    const end = events.find((e) => e.type === 'tool_end');
    assert.ok(end);
    if (end?.type === 'tool_end') {
      assert.equal(end.isError, false);
    }
  });

  it('kill() stops the process', async () => {
    const bin = fakePi('sleep 60');
    const agent = new AgentManager({ ...TEST_AGENT_CFG, piPath: bin });
    agents.push(agent);

    agent.submit('hello');
    // Wait for process to start
    await new Promise((r) => setTimeout(r, 200));
    assert.equal(agent.alive, true);

    agent.kill();
    assert.equal(agent.alive, false);
    assert.equal(agent.running, false);
  });

  it('reset() clears sessionFile', () => {
    const agent = new AgentManager(TEST_AGENT_CFG);
    agents.push(agent);
    agent.sessionFile = '/tmp/session.jsonl';
    agent.reset();
    assert.equal(agent.sessionFile, undefined);
  });

  it('kill() preserves sessionFile', () => {
    const agent = new AgentManager(TEST_AGENT_CFG);
    agents.push(agent);
    agent.sessionFile = '/tmp/session.jsonl';
    agent.kill();
    assert.equal(agent.sessionFile, '/tmp/session.jsonl');
  });

  it('rpcWait resolves on matching response', async () => {
    // Use node to parse JSON reliably (bash grep is fragile)
    const bin = fakePi(`
      node -e '
        process.stdin.setEncoding("utf8");
        let buf = "";
        process.stdin.on("data", d => {
          buf += d;
          const lines = buf.split("\\n");
          buf = lines.pop();
          for (const line of lines) {
            if (!line.trim()) continue;
            const obj = JSON.parse(line);
            if (obj.type === "get_state" && obj.id) {
              const resp = {type:"response",id:obj.id,success:true,data:{model:"test"}};
              process.stdout.write(JSON.stringify(resp)+"\\n");
            }
          }
        });
      '
    `);
    const agent = new AgentManager({ ...TEST_AGENT_CFG, piPath: bin });
    agents.push(agent);

    const resp = await agent.rpcWait({ type: 'get_state' }, 3000);
    assert.equal(resp.success, true);
    assert.ok(resp.data);
  });

  it('rpcWait times out', async () => {
    const bin = fakePi('sleep 60');
    const agent = new AgentManager({
      ...TEST_AGENT_CFG,
      piPath: bin,
      rpcTimeout: 500,
    });
    agents.push(agent);

    const resp = await agent.rpcWait({ type: 'get_state' });
    assert.equal(resp.success, false);
    assert.ok(resp.error?.includes('timeout'));
  });

  it('rpcWait resolves with error when process dies', async () => {
    const bin = fakePi('read -r line; exit 1');
    const agent = new AgentManager({ ...TEST_AGENT_CFG, piPath: bin });
    agents.push(agent);

    const resp = await agent.rpcWait({ type: 'get_state' }, 3000);
    assert.equal(resp.success, false);
  });
});
