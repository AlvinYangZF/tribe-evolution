import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import fs from 'node:fs/promises';
import path from 'node:path';
import os from 'node:os';
import { EventLog } from '../../src/supervisor/event-log.js';
import type { EventLogEntry } from '../../src/shared/types.js';

const TMP_DIR = path.join(os.tmpdir(), `tribe-event-test-${Date.now()}`);
const LOG_PATH = path.join(TMP_DIR, 'events.jsonl');

describe('EventLog', () => {
  let log: EventLog;

  beforeEach(async () => {
    await fs.mkdir(TMP_DIR, { recursive: true });
    log = new EventLog(LOG_PATH);
  });

  afterEach(async () => {
    await fs.rm(TMP_DIR, { recursive: true, force: true });
  });

  describe('append', () => {
    it('should create entries with auto-incrementing index and proper hashing', async () => {
      const e1 = await log.append({
        type: 'agent_born',
        agentId: 'agent-1',
        data: { name: 'Alice' },
      });

      expect(e1.index).toBe(0);
      expect(e1.prevHash).toBe('0'.repeat(64)); // genesis
      expect(e1.hash).toMatch(/^[a-f0-9]{64}$/);
      expect(e1.timestamp).toBeGreaterThan(0);
      expect(e1.type).toBe('agent_born');
      expect(e1.agentId).toBe('agent-1');
      expect(e1.data).toEqual({ name: 'Alice' });

      const e2 = await log.append({
        type: 'task_completed',
        agentId: 'agent-1',
        data: { task: 'explore' },
      });

      expect(e2.index).toBe(1);
      expect(e2.prevHash).toBe(e1.hash);

      const e3 = await log.append({
        type: 'token_allocated',
        agentId: 'agent-2',
        data: { amount: 100 },
      });

      expect(e3.index).toBe(2);
      expect(e3.prevHash).toBe(e2.hash);
    });

    it('should persist entries to disk', async () => {
      await log.append({ type: 'agent_born', agentId: 'a1', data: {} });
      const content = await fs.readFile(LOG_PATH, 'utf-8');
      const lines = content.trim().split('\n');
      expect(lines).toHaveLength(1);
      const parsed = JSON.parse(lines[0]);
      expect(parsed.index).toBe(0);
      expect(parsed.type).toBe('agent_born');
    });

    it('should infer actorType from agentId when not provided', async () => {
      const e1 = await log.append({ type: 'agent_born', agentId: 'a1', data: {} });
      const e2 = await log.append({ type: 'cycle_start', agentId: 'supervisor', data: {} });
      const e3 = await log.append({ type: 'proposal_created', agentId: 'user', data: {} });
      expect(e1.actorType).toBe('agent');
      expect(e2.actorType).toBe('supervisor');
      expect(e3.actorType).toBe('user');
    });

    it('should respect explicit actorType over inference', async () => {
      // Real-world example: a system-attributed event with a non-magic id.
      const e = await log.append({
        type: 'token_allocated',
        agentId: 'system-bootstrap',
        actorType: 'supervisor',
        data: { amount: 1000 },
      });
      expect(e.actorType).toBe('supervisor');
    });
  });

  describe('replay', () => {
    it('should replay all entries from start', async () => {
      const entries: EventLogEntry[] = [];
      for (let i = 0; i < 3; i++) {
        entries.push(
          await log.append({ type: 'agent_born', agentId: `a${i}`, data: {} })
        );
      }

      const replayed: EventLogEntry[] = [];
      for await (const entry of log.replay()) {
        replayed.push(entry);
      }

      expect(replayed).toHaveLength(3);
      expect(replayed[0].index).toBe(0);
      expect(replayed[1].index).toBe(1);
      expect(replayed[2].index).toBe(2);
    });

    it('should replay from a given index', async () => {
      for (let i = 0; i < 5; i++) {
        await log.append({ type: 'agent_born', agentId: `a${i}`, data: {} });
      }

      const replayed: EventLogEntry[] = [];
      for await (const entry of log.replay(3)) {
        replayed.push(entry);
      }

      expect(replayed).toHaveLength(2);
      expect(replayed[0].index).toBe(3);
      expect(replayed[1].index).toBe(4);
    });
  });

  describe('verify', () => {
    it('should return true for an intact chain', async () => {
      await log.append({ type: 'agent_born', agentId: 'a1', data: {} });
      await log.append({ type: 'task_completed', agentId: 'a1', data: {} });
      await log.append({ type: 'token_allocated', agentId: 'a2', data: {} });

      expect(await log.verify()).toBe(true);
    });

    it('should return false when a middle entry is tampered', async () => {
      await log.append({ type: 'agent_born', agentId: 'a1', data: {} });
      await log.append({ type: 'task_completed', agentId: 'a1', data: {} });
      await log.append({ type: 'token_allocated', agentId: 'a2', data: {} });

      // Tamper with the middle entry
      const content = await fs.readFile(LOG_PATH, 'utf-8');
      const lines = content.trim().split('\n');
      const middle = JSON.parse(lines[1]);
      middle.data.tampered = true;
      lines[1] = JSON.stringify(middle);
      await fs.writeFile(LOG_PATH, lines.join('\n') + '\n', 'utf-8');

      expect(await log.verify()).toBe(false);
    });

    it('should return false when prevHash does not match', async () => {
      await log.append({ type: 'agent_born', agentId: 'a1', data: {} });
      await log.append({ type: 'task_completed', agentId: 'a1', data: {} });

      // Break the prevHash reference
      const content = await fs.readFile(LOG_PATH, 'utf-8');
      const lines = content.trim().split('\n');
      const last = JSON.parse(lines[1]);
      last.prevHash = '0'.repeat(64);
      lines[1] = JSON.stringify(last);
      await fs.writeFile(LOG_PATH, lines.join('\n') + '\n', 'utf-8');

      expect(await log.verify()).toBe(false);
    });

    it('should return true for empty log (0 entries)', async () => {
      expect(await log.verify()).toBe(true);
    });

    it('should still verify legacy entries that lack actorType', async () => {
      // Simulate an event written before actorType existed: we hand-craft a
      // JSONL line whose hash was computed over the legacy payload shape.
      // verify() must accept it because JSON.stringify omits undefined keys,
      // reproducing the original payload byte-for-byte.
      const { sha256 } = await import('../../src/shared/filesystem.js');
      const legacy = {
        index: 0,
        timestamp: 1700000000000,
        type: 'agent_born' as const,
        agentId: 'a1',
        data: { name: 'Alice' },
        prevHash: '0'.repeat(64),
      };
      const legacyHash = sha256(JSON.stringify(legacy));
      const entry = { ...legacy, hash: legacyHash };
      await fs.writeFile(LOG_PATH, JSON.stringify(entry) + '\n', 'utf-8');

      expect(await log.verify()).toBe(true);
    });

    it('should chain new actor-typed entries on top of legacy entries', async () => {
      // Same legacy seed as above, then append a new entry with actorType
      // and confirm the chain is intact.
      const { sha256 } = await import('../../src/shared/filesystem.js');
      const legacy = {
        index: 0,
        timestamp: 1700000000000,
        type: 'agent_born' as const,
        agentId: 'a1',
        data: { name: 'Alice' },
        prevHash: '0'.repeat(64),
      };
      const legacyHash = sha256(JSON.stringify(legacy));
      await fs.writeFile(LOG_PATH, JSON.stringify({ ...legacy, hash: legacyHash }) + '\n', 'utf-8');

      const fresh = await log.append({
        type: 'cycle_start',
        agentId: 'supervisor',
        actorType: 'supervisor',
        data: { cycle: 1 },
      });
      expect(fresh.prevHash).toBe(legacyHash);
      expect(fresh.actorType).toBe('supervisor');
      expect(await log.verify()).toBe(true);
    });
  });
});
