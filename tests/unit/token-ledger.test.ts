import { describe, it, expect } from 'vitest';
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

  it('ignores zero or negative usage', () => {
    const ledger = new TokenLedger();
    ledger.recordUsage(0);
    ledger.recordUsage(-50);
    expect(ledger.totalUsage()).toBe(0);
  });

  it('markDeducted returns the unbilled delta and resets pendingDelta', () => {
    const ledger = new TokenLedger();
    ledger.recordUsage(300);
    expect(ledger.markDeducted()).toBe(300);
    expect(ledger.pendingDelta()).toBe(0);
    // totalUsage is unchanged by deduction — it's a lifetime counter.
    expect(ledger.totalUsage()).toBe(300);
  });

  it('only the new delta is charged on a second flush', () => {
    // Simulates the supervisor flow: decide() phases run, flush, then a
    // summarize_memory action makes another LLM call, then flush again.
    const ledger = new TokenLedger();
    ledger.recordUsage(700); // explore + evaluate + execute totals
    expect(ledger.markDeducted()).toBe(700);

    ledger.recordUsage(250); // summarize_memory action
    expect(ledger.pendingDelta()).toBe(250);
    expect(ledger.markDeducted()).toBe(250);

    expect(ledger.totalUsage()).toBe(950);
    expect(ledger.pendingDelta()).toBe(0);
  });

  it('returns 0 from a no-op flush when nothing new was recorded', () => {
    const ledger = new TokenLedger();
    ledger.recordUsage(100);
    ledger.markDeducted();
    expect(ledger.markDeducted()).toBe(0);
    expect(ledger.markDeducted()).toBe(0);
  });

  it('regression: a flush followed by more usage and another flush charges only the new amount', () => {
    // The PR #20 bug shape: decide() ran, deduction happened, summarize_memory
    // then made another LLM call but the original code path never flushed
    // again, giving the agent free LLM time. The ledger is the safe
    // primitive that prevents that.
    const ledger = new TokenLedger();
    ledger.recordUsage(500); // decide() phases
    expect(ledger.markDeducted()).toBe(500); // first flush charges 500

    ledger.recordUsage(200); // summarize_memory call
    // If a second flush is missed, the agent never pays for the 200.
    // The ledger ensures pendingDelta exposes it.
    expect(ledger.pendingDelta()).toBe(200);
    expect(ledger.markDeducted()).toBe(200);
  });
});
