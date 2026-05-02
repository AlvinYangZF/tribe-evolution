import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { Treasury } from '../../src/supervisor/treasury.js';
import * as path from 'node:path';
import * as fs from 'node:fs/promises';
import * as os from 'node:os';
import { randomBytes } from 'node:crypto';

describe('Treasury', () => {
  let tempDir: string;
  let treasury: Treasury;

  beforeEach(async () => {
    tempDir = path.join(os.tmpdir(), `treasury-test-${randomBytes(6).toString('hex')}`);
    await fs.mkdir(tempDir, { recursive: true });
    treasury = new Treasury(tempDir);
  });

  afterEach(async () => {
    await fs.rm(tempDir, { recursive: true, force: true });
  });

  it('seeds an initial balance on first read', async () => {
    const state = await treasury.getState();
    expect(state.balance).toBeGreaterThan(0);
    expect(state.totalIssued).toBe(0);
    expect(state.totalRefunded).toBe(0);
  });

  it('debit reduces balance and increments totalIssued', async () => {
    const before = await treasury.getState();
    await treasury.debit(500);
    const after = await treasury.getState();
    expect(after.balance).toBe(before.balance - 500);
    expect(after.totalIssued).toBe(500);
    expect(after.totalRefunded).toBe(0);
  });

  it('refund increases balance and increments totalRefunded', async () => {
    const before = await treasury.getState();
    await treasury.refund(250);
    const after = await treasury.getState();
    expect(after.balance).toBe(before.balance + 250);
    expect(after.totalRefunded).toBe(250);
  });

  it('throws on insufficient balance', async () => {
    const state = await treasury.getState();
    await expect(treasury.debit(state.balance + 1)).rejects.toThrow(/insufficient/i);
    // balance unchanged after the failed debit
    const after = await treasury.getState();
    expect(after.balance).toBe(state.balance);
  });

  it('rejects negative amounts', async () => {
    await expect(treasury.debit(-1)).rejects.toThrow(/non-negative/);
    await expect(treasury.refund(-1)).rejects.toThrow(/non-negative/);
  });

  it('persists state across instances', async () => {
    await treasury.debit(100);
    const fresh = new Treasury(tempDir);
    const state = await fresh.getState();
    expect(state.totalIssued).toBe(100);
  });
});
