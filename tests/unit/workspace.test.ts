import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import fs from 'node:fs/promises';
import path from 'node:path';
import os from 'node:os';
import {
  readMemory,
  writeMemory,
  inheritMemory,
  MEMORY_LIMIT_BYTES,
} from '../../src/supervisor/workspace.js';

let ECO_DIR: string;

beforeEach(async () => {
  ECO_DIR = path.join(os.tmpdir(), `tribe-workspace-test-${Date.now()}-${Math.random()}`);
  await fs.mkdir(ECO_DIR, { recursive: true });
});

afterEach(async () => {
  await fs.rm(ECO_DIR, { recursive: true, force: true });
});

describe('readMemory', () => {
  it('returns empty string when the agent has no notes file yet', async () => {
    expect(await readMemory(ECO_DIR, 'fresh-agent')).toBe('');
  });

  it('returns the file contents when present', async () => {
    await writeMemory(ECO_DIR, 'a1', 'hello');
    expect(await readMemory(ECO_DIR, 'a1')).toBe('hello');
  });
});

describe('writeMemory', () => {
  it('creates the workspace directory on demand', async () => {
    await writeMemory(ECO_DIR, 'new-agent', 'note one');
    const filePath = path.join(ECO_DIR, 'workspaces', 'new-agent', 'notes.md');
    const stat = await fs.stat(filePath);
    expect(stat.isFile()).toBe(true);
  });

  it('overwrites existing content (does not append)', async () => {
    await writeMemory(ECO_DIR, 'a1', 'first');
    await writeMemory(ECO_DIR, 'a1', 'second');
    expect(await readMemory(ECO_DIR, 'a1')).toBe('second');
  });

  it('truncates content longer than MEMORY_LIMIT_BYTES', async () => {
    const huge = 'x'.repeat(MEMORY_LIMIT_BYTES * 2);
    const written = await writeMemory(ECO_DIR, 'a1', huge);
    expect(written).toBe(MEMORY_LIMIT_BYTES);
    const stored = await readMemory(ECO_DIR, 'a1');
    expect(stored.length).toBe(MEMORY_LIMIT_BYTES);
  });
});

describe('inheritMemory', () => {
  it('copies parent notes to child with an inheritance header', async () => {
    await writeMemory(ECO_DIR, 'parent', 'I learned X by trying Y.');
    await inheritMemory(ECO_DIR, 'parent', 'child');
    const childNotes = await readMemory(ECO_DIR, 'child');
    expect(childNotes).toContain('Inherited from parent');
    expect(childNotes).toContain('I learned X by trying Y.');
  });

  it('is a no-op when the parent has no notes', async () => {
    await inheritMemory(ECO_DIR, 'parent', 'child');
    expect(await readMemory(ECO_DIR, 'child')).toBe('');
  });

  it('is a no-op when the parent has only whitespace', async () => {
    await writeMemory(ECO_DIR, 'parent', '   \n\n  ');
    await inheritMemory(ECO_DIR, 'parent', 'child');
    expect(await readMemory(ECO_DIR, 'child')).toBe('');
  });
});
