import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import fs from 'node:fs/promises';
import path from 'node:path';
import os from 'node:os';
import {
  safeReadJSON,
  safeWriteJSON,
  ensureDir,
  appendJSONL,
  readJSONL,
} from '../../src/shared/filesystem.js';

const TMP_DIR = path.join(os.tmpdir(), `tribe-fs-test-${Date.now()}`);

describe('filesystem', () => {
  beforeEach(async () => {
    await fs.mkdir(TMP_DIR, { recursive: true });
  });

  afterEach(async () => {
    await fs.rm(TMP_DIR, { recursive: true, force: true });
  });

  describe('ensureDir', () => {
    it('should create a directory that does not exist', async () => {
      const dir = path.join(TMP_DIR, 'nested', 'deep');
      await ensureDir(dir);
      const stat = await fs.stat(dir);
      expect(stat.isDirectory()).toBe(true);
    });

    it('should not throw for existing directory', async () => {
      await ensureDir(TMP_DIR);
      await expect(ensureDir(TMP_DIR)).resolves.toBeUndefined();
    });
  });

  describe('safeReadJSON / safeWriteJSON', () => {
    it('should write and read JSON correctly', async () => {
      const file = path.join(TMP_DIR, 'data.json');
      const data = { name: 'test', value: 42, nested: { a: 1 } };
      await safeWriteJSON(file, data);
      const result = await safeReadJSON<typeof data>(file);
      expect(result).toEqual(data);
    });

    it('should return null for missing file', async () => {
      const result = await safeReadJSON(path.join(TMP_DIR, 'nonexistent.json'));
      expect(result).toBeNull();
    });

    it('should return null for invalid JSON', async () => {
      const file = path.join(TMP_DIR, 'bad.json');
      await fs.writeFile(file, 'not-json', 'utf-8');
      const result = await safeReadJSON(file);
      expect(result).toBeNull();
    });

    it('should atomically write (no partial file on crash)', async () => {
      const file = path.join(TMP_DIR, 'atomic.json');
      await safeWriteJSON(file, { key: 'value' });
      const content = await fs.readFile(file, 'utf-8');
      expect(JSON.parse(content)).toEqual({ key: 'value' });
    });
  });

  describe('appendJSONL / readJSONL', () => {
    it('should append entries and read them back', async () => {
      const file = path.join(TMP_DIR, 'events.jsonl');
      await appendJSONL(file, { id: 1, msg: 'first' });
      await appendJSONL(file, { id: 2, msg: 'second' });
      await appendJSONL(file, { id: 3, msg: 'third' });

      const entries = await readJSONL<{ id: number; msg: string }>(file);
      expect(entries).toHaveLength(3);
      expect(entries[0]).toEqual({ id: 1, msg: 'first' });
      expect(entries[1]).toEqual({ id: 2, msg: 'second' });
      expect(entries[2]).toEqual({ id: 3, msg: 'third' });
    });

    it('should return empty array for missing file', async () => {
      const entries = await readJSONL(path.join(TMP_DIR, 'nope.jsonl'));
      expect(entries).toEqual([]);
    });

    it('should handle concurrent appends', async () => {
      const file = path.join(TMP_DIR, 'concurrent.jsonl');
      const promises = Array.from({ length: 10 }, (_, i) =>
        appendJSONL(file, { index: i })
      );
      await Promise.all(promises);
      const entries = await readJSONL<{ index: number }>(file);
      expect(entries).toHaveLength(10);
      const indices = entries.map(e => e.index).sort((a, b) => a - b);
      expect(indices).toEqual([0, 1, 2, 3, 4, 5, 6, 7, 8, 9]);
    });
  });
});
