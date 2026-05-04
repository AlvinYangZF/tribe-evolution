import { describe, it, expect, vi } from 'vitest';
import { TokenLedger } from '../../src/supervisor/token-ledger.js';

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
