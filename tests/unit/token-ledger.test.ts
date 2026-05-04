import { describe, it, expect, vi } from 'vitest';
import { TokenLedger, flushAndSave } from '../../src/supervisor/token-ledger.js';

describe('TokenLedger', () => {
  it('starts at zero usage and zero pending delta', () => {
    const ledger = new TokenLedger();
    expect(ledger.totalUsage()).toBe(0);
    expect(ledger.pendingDelta()).toBe(0);
  });

  it('accumulates recorded usage', () => {
    const ledger = new TokenLedger();
    ledger.recordUsage(120);
    ledger.recordUsage(80);
    expect(ledger.totalUsage()).toBe(200);
    expect(ledger.pendingDelta()).toBe(200);
  });

  it('ignores zero usage silently', () => {
    const ledger = new TokenLedger();
    ledger.recordUsage(0);
    expect(ledger.totalUsage()).toBe(0);
  });

  it('warns and drops negative usage (likely call-site bug)', () => {
    const ledger = new TokenLedger();
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    try {
      ledger.recordUsage(-50);
      expect(ledger.totalUsage()).toBe(0);
      expect(warn).toHaveBeenCalledTimes(1);
      expect(warn.mock.calls[0][0]).toMatch(/negative usage/);
    } finally {
      warn.mockRestore();
    }
  });

  it('settle returns the unbilled delta and resets pendingDelta', () => {
    const ledger = new TokenLedger();
    ledger.recordUsage(300);
    expect(ledger.settle()).toBe(300);
    expect(ledger.pendingDelta()).toBe(0);
    // totalUsage is unchanged by deduction — it's a lifetime counter.
    expect(ledger.totalUsage()).toBe(300);
  });

  it('only the new delta is charged on a second settle', () => {
    // Simulates the supervisor flow: decide() phases run, settle, then a
    // summarize_memory action makes another LLM call, then settle again.
    const ledger = new TokenLedger();
    ledger.recordUsage(700); // explore + evaluate + execute totals
    expect(ledger.settle()).toBe(700);

    ledger.recordUsage(250); // summarize_memory action
    expect(ledger.pendingDelta()).toBe(250);
    expect(ledger.settle()).toBe(250);

    expect(ledger.totalUsage()).toBe(950);
    expect(ledger.pendingDelta()).toBe(0);
  });

  it('settle is idempotent — repeated calls with no usage return 0 without side effects', () => {
    const ledger = new TokenLedger();
    ledger.recordUsage(100);
    expect(ledger.settle()).toBe(100);
    // Three more settles in a row — all 0, totalUsage and watermark stable.
    expect(ledger.settle()).toBe(0);
    expect(ledger.settle()).toBe(0);
    expect(ledger.settle()).toBe(0);
    expect(ledger.totalUsage()).toBe(100);
    expect(ledger.pendingDelta()).toBe(0);
  });

  it('regression: a settle followed by more usage and another settle charges only the new amount', () => {
    // The PR #20 bug shape: decide() ran, deduction happened, summarize_memory
    // then made another LLM call but the original code path never settled
    // again, giving the agent free LLM time. The ledger is the safe
    // primitive that prevents that.
    const ledger = new TokenLedger();
    ledger.recordUsage(500); // decide() phases
    expect(ledger.settle()).toBe(500); // first settle charges 500

    ledger.recordUsage(200); // summarize_memory call
    // If a second settle is missed, the agent never pays for the 200.
    // The ledger ensures pendingDelta exposes it.
    expect(ledger.pendingDelta()).toBe(200);
    expect(ledger.settle()).toBe(200);
  });
});

describe('flushAndSave', () => {
  it('debits the agent balance and advances the watermark on a successful save', async () => {
    const ledger = new TokenLedger();
    ledger.recordUsage(150);
    const agent = { tokenBalance: 1000 };
    const saveCalls: Array<{ tokenBalance: number }> = [];
    const save = async (a: { tokenBalance: number }) => { saveCalls.push({ ...a }); };

    await flushAndSave(ledger, agent, save);
    expect(agent.tokenBalance).toBe(850);
    expect(saveCalls).toHaveLength(1);
    expect(saveCalls[0].tokenBalance).toBe(850);
    expect(ledger.pendingDelta()).toBe(0);
  });

  it('clamps the balance at zero when the debit exceeds available tokens', async () => {
    const ledger = new TokenLedger();
    ledger.recordUsage(900);
    const agent = { tokenBalance: 100 };
    const save = async () => { /* succeed */ };
    await flushAndSave(ledger, agent, save);
    expect(agent.tokenBalance).toBe(0);
    expect(ledger.pendingDelta()).toBe(0);
  });

  it('is a no-op when there is no pending usage (no save call)', async () => {
    const ledger = new TokenLedger();
    const agent = { tokenBalance: 1000 };
    let saveCalled = false;
    const save = async () => { saveCalled = true; };
    await flushAndSave(ledger, agent, save);
    expect(agent.tokenBalance).toBe(1000);
    expect(saveCalled).toBe(false);
  });

  it('rolls back the in-memory balance and leaves the watermark untouched when save throws', async () => {
    const ledger = new TokenLedger();
    ledger.recordUsage(150);
    const agent = { tokenBalance: 1000 };
    const save = async () => { throw new Error('disk full'); };

    await expect(flushAndSave(ledger, agent, save)).rejects.toThrow('disk full');
    // Balance restored.
    expect(agent.tokenBalance).toBe(1000);
    // Watermark NOT advanced — a retry should still see the same delta.
    expect(ledger.pendingDelta()).toBe(150);
  });

  it('a successful retry after a failure charges exactly once', async () => {
    // Regression test for the PR #21 TODO: previously the watermark
    // advanced before the save, so after a save throw the balance was
    // already debited in-memory and a retry would skip the redo. With
    // flushAndSave, retry is safe and idempotent.
    const ledger = new TokenLedger();
    ledger.recordUsage(150);
    const agent = { tokenBalance: 1000 };
    let calls = 0;
    const save = async () => {
      calls += 1;
      if (calls === 1) throw new Error('transient');
    };

    await expect(flushAndSave(ledger, agent, save)).rejects.toThrow('transient');
    expect(agent.tokenBalance).toBe(1000);
    expect(ledger.pendingDelta()).toBe(150);

    await flushAndSave(ledger, agent, save);
    expect(agent.tokenBalance).toBe(850);
    expect(ledger.pendingDelta()).toBe(0);
    expect(calls).toBe(2);
  });
});
