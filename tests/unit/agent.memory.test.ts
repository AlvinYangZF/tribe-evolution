import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { readMemory, writeMemory, appendToMemory } from '../../src/agent/memory.js';
import * as fs from 'node:fs';
import * as path from 'node:path';
import * as os from 'node:os';

const testDir = path.join(os.tmpdir(), `tribe-memory-test-${Date.now()}`);

describe('agent memory', () => {
  beforeEach(() => {
    fs.mkdirSync(testDir, { recursive: true });
  });

  afterEach(() => {
    fs.rmSync(testDir, { recursive: true, force: true });
  });

  it('should write and read memory', async () => {
    const data = { thoughts: ['hello world'], timestamp: Date.now() };
    await writeMemory(testDir, 'agent-1', data);
    const read = await readMemory(testDir, 'agent-1');
    expect(read).toEqual(data);
  });

  it('should return null for nonexistent memory', async () => {
    const result = await readMemory(testDir, 'no-such-agent');
    expect(result).toBeNull();
  });

  it('should append to existing memory', async () => {
    await writeMemory(testDir, 'agent-2', { logs: ['first'] });
    await appendToMemory(testDir, 'agent-2', { logs: ['second'] });
    const read = await readMemory(testDir, 'agent-2');
    expect(read).toEqual({ logs: ['first', 'second'] });
  });

  it('should create new memory on append when none exists', async () => {
    await appendToMemory(testDir, 'agent-3', { fresh: true });
    const read = await readMemory(testDir, 'agent-3');
    expect(read).toEqual({ fresh: true });
  });

  it('should append array fields', async () => {
    await writeMemory(testDir, 'agent-4', { items: [1, 2] });
    await appendToMemory(testDir, 'agent-4', { items: [3, 4] });
    const read = await readMemory(testDir, 'agent-4');
    expect(read.items).toEqual([1, 2, 3, 4]);
  });

  it('should overwrite with writeMemory', async () => {
    await writeMemory(testDir, 'agent-5', { step: 1 });
    await writeMemory(testDir, 'agent-5', { step: 2 });
    const read = await readMemory(testDir, 'agent-5');
    expect(read).toEqual({ step: 2 });
  });

  it('should handle concurrent agents independently', async () => {
    await writeMemory(testDir, 'alpha', { msg: 'hello from alpha' });
    await writeMemory(testDir, 'beta', { msg: 'hello from beta' });
    const a = await readMemory(testDir, 'alpha');
    const b = await readMemory(testDir, 'beta');
    expect(a.msg).toBe('hello from alpha');
    expect(b.msg).toBe('hello from beta');
  });
});
