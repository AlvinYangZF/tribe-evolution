/**
 * Per-cycle token-usage ledger for an agent.
 *
 * decideForAgent() runs the three-phase decide() pipeline and may also fire
 * action handlers that make additional LLM calls (e.g. summarize_memory).
 * Token usage from every call must be charged to the agent's balance, and
 * we must never charge twice for the same usage. This class tracks the
 * watermark of how much has already been deducted so flushes after each
 * stage charge only the new delta.
 *
 * Lives in its own module purely so it's directly unit-testable; the bug
 * caught in PR #20's review (free LLM calls for summarize_memory) was a
 * single misplaced deduction in decideForAgent that no test was watching.
 */
export class TokenLedger {
  private cycleTokenUsage = 0;
  private lastDeductedTokens = 0;

  /**
   * Add `tokens` to this cycle's running total. Negative input almost
   * always indicates a bug at the call site — we drop it but warn so the
   * misuse is at least visible in dev/test logs.
   */
  recordUsage(tokens: number): void {
    if (tokens < 0) {
      console.warn(`TokenLedger: ignoring negative usage value (${tokens})`);
      return;
    }
    if (tokens > 0) this.cycleTokenUsage += tokens;
  }

  /** Total tokens recorded since the ledger was constructed. */
  totalUsage(): number {
    return this.cycleTokenUsage;
  }

  /** Tokens recorded since the last `settle()` call. */
  pendingDelta(): number {
    return this.cycleTokenUsage - this.lastDeductedTokens;
  }

  /**
   * Acknowledge that the caller is deducting `pendingDelta()` from the
   * agent's balance and reset the watermark. Returns the same value.
   * Subsequent `pendingDelta()` calls return 0 until more usage is
   * recorded. Idempotent: calling settle() with no new usage returns 0
   * every time without side effects.
   */
  settle(): number {
    const delta = this.pendingDelta();
    this.lastDeductedTokens = this.cycleTokenUsage;
    return delta;
  }
}
