/**
 * Treasury — system-funded token pool for bounty escrow and proposal rewards.
 *
 * Replaces the previous "mint from nothing" pattern where bounty rewards and
 * auto-approved proposal payouts appeared on agent balances without any
 * matching debit. The treasury starts with a fixed initial balance and is
 * the sole source of new tokens flowing into the agent economy via the
 * bounty/proposal pipelines.
 *
 * Persisted as JSON in ecosystem/treasury.json.
 */

import * as path from 'node:path';
import { safeReadJSON, safeWriteJSON } from '../shared/filesystem.js';

const TREASURY_FILE = 'treasury.json';
const INITIAL_BALANCE = 1_000_000_000;

export interface TreasuryState {
  balance: number;
  totalIssued: number;    // cumulative tokens debited (paid out)
  totalRefunded: number;  // cumulative tokens refunded (e.g., failed bounties)
}

export class Treasury {
  private filePath: string;

  constructor(ecosystemDir: string) {
    this.filePath = path.join(ecosystemDir, TREASURY_FILE);
  }

  async getState(): Promise<TreasuryState> {
    const existing = await safeReadJSON<TreasuryState>(this.filePath);
    if (existing) return existing;
    const fresh: TreasuryState = { balance: INITIAL_BALANCE, totalIssued: 0, totalRefunded: 0 };
    await safeWriteJSON(this.filePath, fresh);
    return fresh;
  }

  /** Debit `amount` tokens from the treasury. Throws on insufficient balance. */
  async debit(amount: number): Promise<TreasuryState> {
    if (amount < 0) throw new Error(`Treasury debit must be non-negative, got ${amount}`);
    const s = await this.getState();
    if (s.balance < amount) {
      throw new Error(`Treasury insufficient balance: ${s.balance} < ${amount}`);
    }
    s.balance -= amount;
    s.totalIssued += amount;
    await safeWriteJSON(this.filePath, s);
    return s;
  }

  /** Refund `amount` tokens back to the treasury (e.g., on failed bounty). */
  async refund(amount: number): Promise<TreasuryState> {
    if (amount < 0) throw new Error(`Treasury refund must be non-negative, got ${amount}`);
    const s = await this.getState();
    s.balance += amount;
    s.totalRefunded += amount;
    await safeWriteJSON(this.filePath, s);
    return s;
  }
}
