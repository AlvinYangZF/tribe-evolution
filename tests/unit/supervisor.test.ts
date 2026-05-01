import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import path from 'node:path';
import fs from 'node:fs/promises';
import os from 'node:os';
import { Supervisor } from '../../src/supervisor/index.js';
import { loadConfig } from '../../src/config/index.js';
import type { Config } from '../../src/config/index.js';

const TMP_DIR = path.join(os.tmpdir(), `tribe-supervisor-test-${Date.now()}`);

function makeTestConfig(): Config {
  return {
    deepseekApiKey: 'test-key',
    braveApiKey: 'test-brave-key',
    ecosystemDir: TMP_DIR,
    cycleIntervalMs: 100,
    defaultTokenPerCycle: 1000,
    maxAgents: 5,
    eliminationRate: 0.3,
    mutationBaseRate: 0.1,
    newAgentProtectionRounds: 3,
  };
}

async function createMockAgent(dir: string, id: string): Promise<void> {
  const agentDir = path.join(dir, 'agents', id);
  await fs.mkdir(agentDir, { recursive: true });
  await fs.writeFile(
    path.join(agentDir, 'state.json'),
    JSON.stringify({
      id,
      generation: 1,
      tokenBalance: 1000,
      contributionScore: 0,
      fitness: 0,
      alive: true,
      age: 0,
    }),
    'utf-8'
  );
}

describe('Supervisor', () => {
  let config: Config;
  let supervisor: Supervisor;

  beforeEach(async () => {
    await fs.mkdir(TMP_DIR, { recursive: true });
    config = makeTestConfig();
  });

  afterEach(async () => {
    if (supervisor) {
      await supervisor.shutdown();
    }
    await fs.rm(TMP_DIR, { recursive: true, force: true });
  });

  it('should initialize with event log and load existing events', async () => {
    supervisor = new Supervisor(config);
    expect(supervisor).toBeDefined();
  });

  it('should run cycles and track events', async () => {
    // Set up some mock agents
    await createMockAgent(TMP_DIR, 'agent-1');
    await createMockAgent(TMP_DIR, 'agent-2');

    supervisor = new Supervisor(config);

    const events: string[] = [];
    supervisor.on('cycleStart', (cycleNum) => {
      events.push(`cycleStart:${cycleNum}`);
    });
    supervisor.on('cycleEnd', (cycleNum) => {
      events.push(`cycleEnd:${cycleNum}`);
    });

    await supervisor.start();

    // Let it run for 2 cycles
    await new Promise(r => setTimeout(r, 250));
    await supervisor.shutdown();

    // Should have at least some events
    expect(events.length).toBeGreaterThanOrEqual(4); // at least 2 start + 2 end

    // Verify ordering: start then end for each cycle
    expect(events[0]).toBe('cycleStart:0');
    expect(events[1]).toBe('cycleEnd:0');
    expect(events[2]).toBe('cycleStart:1');
    expect(events[3]).toBe('cycleEnd:1');
  }, 10_000);

  it('should log events to the event store', async () => {
    await createMockAgent(TMP_DIR, 'agent-1');

    supervisor = new Supervisor(config);
    await supervisor.start();

    // Run for 1+ cycles
    await new Promise(r => setTimeout(r, 150));
    await supervisor.shutdown();

    // Verify events were persisted
    const eventLogPath = path.join(TMP_DIR, 'event-log', 'events.jsonl');
    const content = await fs.readFile(eventLogPath, 'utf-8');
    const lines = content.trim().split('\n');

    // Should have at least some entries (cycle_start, cycle_end, etc.)
    expect(lines.length).toBeGreaterThanOrEqual(2);

    // Verify we can read them as valid JSON
    for (const line of lines) {
      const entry = JSON.parse(line);
      expect(entry).toHaveProperty('index');
      expect(entry).toHaveProperty('hash');
      expect(entry).toHaveProperty('prevHash');
    }
  }, 10_000);
});
