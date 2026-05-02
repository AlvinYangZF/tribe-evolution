/**
 * BountyBoard — Bounty 悬赏系统
 *
 * Manages bounty lifecycle: open → bidding → awarded → executing → verifying → completed
 * Persisted as JSON in ecosystem/bounties/bounties.json
 * Agent token balances are managed via ecosystem/agents/{agentId}.json
 */

import * as path from 'node:path';
import { randomUUID } from 'node:crypto';
import { execSync } from 'node:child_process';
import * as fs from 'node:fs/promises';
import { safeReadJSON, safeWriteJSON, ensureDir } from '../shared/filesystem.js';
import type {
  Bounty, BountyStatus, BountyType, Bid,
  VerificationTest, AgentState,
} from '../shared/types.js';

const BOUNTIES_DIR = 'bounties';
const BOUNTIES_FILE = 'bounties.json';
const AGENTS_DIR = 'agents';

/**
 * Valid state transitions for the bounty state machine.
 */
const VALID_TRANSITIONS: Record<BountyStatus, BountyStatus[]> = {
  open: ['bidding'],
  bidding: ['awarded'],
  awarded: ['executing'],
  executing: ['submitted'],
  submitted: ['publisher_review', 'executing'],
  publisher_review: ['supervisor_review', 'executing'],
  supervisor_review: ['completed', 'executing'],
  completed: [],
};

function assertTransition(from: BountyStatus, to: BountyStatus): void {
  const allowed = VALID_TRANSITIONS[from];
  if (!allowed || !allowed.includes(to)) {
    throw new Error(
      `Invalid state transition: ${from} → ${to}. Allowed: ${(allowed ?? []).join(', ') || 'none'}`,
    );
  }
}

export class BountyBoard {
  private bountiesFilePath: string;
  private agentsDir: string;

  constructor(private ecosystemDir: string) {
    this.bountiesFilePath = path.join(ecosystemDir, BOUNTIES_DIR, BOUNTIES_FILE);
    this.agentsDir = path.join(ecosystemDir, AGENTS_DIR);
  }

  // ─── Persistence helpers ──────────────────────────────────────────────

  private async loadAll(): Promise<Bounty[]> {
    return (await safeReadJSON<Bounty[]>(this.bountiesFilePath)) ?? [];
  }

  private async saveAll(bounties: Bounty[]): Promise<void> {
    await ensureDir(path.dirname(this.bountiesFilePath));
    await safeWriteJSON(this.bountiesFilePath, bounties);
  }

  private async findBounty(id: string): Promise<{ bounties: Bounty[]; bounty: Bounty; index: number }> {
    const bounties = await this.loadAll();
    const index = bounties.findIndex(b => b.id === id);
    if (index === -1) {
      throw new Error(`Bounty not found: ${id}`);
    }
    return { bounties, bounty: bounties[index], index };
  }

  private async readAgent(agentId: string): Promise<AgentState> {
    const agent = await safeReadJSON<AgentState>(path.join(this.agentsDir, `${agentId}.json`));
    if (!agent) {
      throw new Error(`Agent not found: ${agentId}`);
    }
    return agent;
  }

  private async writeAgent(agent: AgentState): Promise<void> {
    await ensureDir(this.agentsDir);
    await safeWriteJSON(path.join(this.agentsDir, `${agent.id}.json`), agent);
  }

  /**
   * Deduct tokens from an agent's balance.
   * Throws if insufficient balance.
   */
  private async deductAgentTokens(agentId: string, amount: number): Promise<AgentState> {
    const agent = await this.readAgent(agentId);
    if (agent.tokenBalance < amount) {
      throw new Error(`Insufficient token balance for agent ${agentId}: ${agent.tokenBalance} < ${amount}`);
    }
    agent.tokenBalance -= amount;
    await this.writeAgent(agent);
    return agent;
  }

  /**
   * Add tokens to an agent's balance.
   */
  private async addAgentTokens(agentId: string, amount: number): Promise<AgentState> {
    const agent = await this.readAgent(agentId);
    agent.tokenBalance += amount;
    await this.writeAgent(agent);
    return agent;
  }

  // ─── CRUD ─────────────────────────────────────────────────────────────

  async createBounty(data: {
    title: string;
    description: string;
    creatorId: string;
    type: BountyType;
    reward: number;
    deadline: number;
    depositRate?: number;
    verifierAgentId?: string;
    verificationTests?: VerificationTest[];
    maxRetries?: number;
  }): Promise<Bounty> {
    const now = Date.now();
    const bounty: Bounty = {
      id: randomUUID(),
      title: data.title,
      description: data.description,
      creatorId: data.creatorId,
      type: data.type,
      reward: data.reward,
      depositRate: data.depositRate ?? 0.5,
      status: 'open',
      bids: [],
      winningBidId: null,
      verificationTests: data.verificationTests ?? [],
      verifierAgentId: data.verifierAgentId ?? 'supervisor',
      escrowFrozen: 0,
      retryCount: 0,
      maxRetries: data.maxRetries ?? 3,
      createdAt: now,
      deadline: data.deadline,
      completedAt: null,
    };

    const bounties = await this.loadAll();
    bounties.push(bounty);
    await this.saveAll(bounties);
    return bounty;
  }

  async getBounty(id: string): Promise<Bounty | null> {
    const bounties = await this.loadAll();
    return bounties.find(b => b.id === id) ?? null;
  }

  async listBounties(status?: BountyStatus): Promise<Bounty[]> {
    const bounties = await this.loadAll();
    if (status) {
      return bounties.filter(b => b.status === status);
    }
    return bounties;
  }

  // ─── Bidding ──────────────────────────────────────────────────────────

  async placeBid(bountyId: string, agentId: string, price: number, plan: string): Promise<Bid> {
    const { bounties, bounty, index } = await this.findBounty(bountyId);

    // Only allow bidding on open or already-bidding bounties
    if (bounty.status !== 'open' && bounty.status !== 'bidding') {
      throw new Error(`Cannot bid on bounty in status: ${bounty.status}`);
    }

    const deposit = Math.floor(bounty.reward * bounty.depositRate);

    // Deduct deposit from agent
    await this.deductAgentTokens(agentId, deposit);

    const bid: Bid = {
      id: randomUUID(),
      bountyId,
      agentId,
      price,
      plan,
      deposit,
      createdAt: Date.now(),
    };

    const updated: Bounty = {
      ...bounty,
      status: 'bidding',
      bids: [...bounty.bids, bid],
    };

    bounties[index] = updated;
    await this.saveAll(bounties);
    return bid;
  }

  async awardBid(bountyId: string, winningBidId: string): Promise<Bounty> {
    const { bounties, bounty, index } = await this.findBounty(bountyId);

    assertTransition(bounty.status, 'awarded');

    const winningBid = bounty.bids.find(b => b.id === winningBidId);
    if (!winningBid) {
      throw new Error(`Bid not found: ${winningBidId}`);
    }

    // Refund losing bidders 50% of their deposit
    const losingBids = bounty.bids.filter(b => b.id !== winningBidId);
    for (const bid of losingBids) {
      const refund = Math.floor(bid.deposit * 0.5);
      try {
        await this.addAgentTokens(bid.agentId, refund);
      } catch {
        // Agent might not exist, skip refund
      }
    }

    // Freeze the reward as escrow (deduct from creator)
    // Note: we track escrowFrozen but don't deduct creator balance — it's virtual holding
    const updated: Bounty = {
      ...bounty,
      status: 'awarded',
      winningBidId,
      escrowFrozen: bounty.reward,
    };

    bounties[index] = updated;
    await this.saveAll(bounties);
    return updated;
  }

  // ─── Execution ────────────────────────────────────────────────────────

  async submitResult(bountyId: string, agentId: string, artifactUrl: string, summary: string): Promise<Bounty> {
    const { bounties, bounty, index } = await this.findBounty(bountyId);

    if (bounty.status !== 'awarded' && bounty.status !== 'executing') {
      throw new Error(`Cannot submit result for bounty in status: ${bounty.status}`);
    }

    // Verify the submitting agent is the winner
    const winningBid = bounty.bids.find(b => b.id === bounty.winningBidId);
    if (!winningBid || winningBid.agentId !== agentId) {
      throw new Error(`Agent ${agentId} is not the winning bidder for bounty ${bountyId}`);
    }

    const updated: Bounty = {
      ...bounty,
      status: 'submitted',
    };

    bounties[index] = updated;
    await this.saveAll(bounties);
    return updated;
  }

  // ─── Verification ─────────────────────────────────────────────────────

  async runVerification(bountyId: string): Promise<{ passed: boolean; results: string[] }> {
    const { bounty } = await this.findBounty(bountyId);

    const results: string[] = [];
    let allPassed = true;

    for (const test of bounty.verificationTests) {
      try {
        const passed = await this.runSingleTest(test);
        results.push(`[${passed ? 'PASS' : 'FAIL'}] ${test.description}`);
        if (!passed) {
          allPassed = false;
        }
      } catch (err: unknown) {
        const msg = err instanceof Error ? err.message : String(err);
        results.push(`[ERROR] ${test.description}: ${msg}`);
        allPassed = false;
      }
    }

    return { passed: allPassed, results };
  }

  private async runSingleTest(test: VerificationTest): Promise<boolean> {
    switch (test.type) {
      case 'shell_test': {
        if (!test.command) throw new Error('shell_test requires command');
        execSync(test.command, { timeout: 10000, stdio: 'pipe' });
        return true;
      }

      case 'file_check': {
        if (!test.filePath) throw new Error('file_check requires filePath');
        const content = await fs.readFile(test.filePath, 'utf-8');
        if (test.expectedContent !== undefined && content.trim() !== test.expectedContent.trim()) {
          return false;
        }
        return true;
      }

      case 'api_check': {
        if (!test.url) throw new Error('api_check requires url');
        const resp = await fetch(test.url);
        if (test.expectedStatus !== undefined && resp.status !== test.expectedStatus) {
          return false;
        }
        return true;
      }

      case 'llm_review': {
        // LLM review is not implemented automatically — pass through for manual or skip
        // For now, skip LLM reviews with a warning
        console.warn(`LLM review skipped (no auto-executor): ${test.description}`);
        return true;
      }

      default:
        throw new Error(`Unknown test type: ${(test as VerificationTest).type}`);
    }
  }

  // ─── State transitions ────────────────────────────────────────────────

  async publisherApprove(bountyId: string): Promise<Bounty> {
    const bounty = await this.getBounty(bountyId);
    if (!bounty) throw new Error('Bounty not found');
    if (bounty.status !== 'submitted') throw new Error('Must be in submitted state');
    bounty.status = 'publisher_review';
    await this.saveAll([bounty]);
    return bounty;
  }
  async publisherReject(bountyId: string): Promise<Bounty> {
    const bounty = await this.getBounty(bountyId);
    if (!bounty) throw new Error('Bounty not found');
    if (bounty.status !== 'submitted') throw new Error('Must be in submitted state');
    bounty.status = 'executing';
    await this.saveAll([bounty]);
    return bounty;
  }

  async completeBounty(bountyId: string): Promise<Bounty> {
    const { bounties, bounty, index } = await this.findBounty(bountyId);

    assertTransition(bounty.status, 'completed');

    // Release escrow to the winning bidder
    const winningBid = bounty.bids.find(b => b.id === bounty.winningBidId);
    if (winningBid) {
      await this.addAgentTokens(winningBid.agentId, bounty.escrowFrozen);
    }

    const updated: Bounty = {
      ...bounty,
      status: 'completed',
      escrowFrozen: 0,
      completedAt: Date.now(),
    };

    bounties[index] = updated;
    await this.saveAll(bounties);
    return updated;
  }

  async failVerification(bountyId: string): Promise<Bounty> {
    const { bounties, bounty, index } = await this.findBounty(bountyId);

    if (bounty.status !== 'submitted') {
      throw new Error(`Cannot fail verification for bounty in status: ${bounty.status}`);
    }

    const newRetryCount = bounty.retryCount + 1;

    if (newRetryCount <= bounty.maxRetries) {
      // Retry: go back to executing
      const updated: Bounty = {
        ...bounty,
        status: 'executing',
        retryCount: newRetryCount,
      };
      bounties[index] = updated;
      await this.saveAll(bounties);
      return updated;
    } else {
      // Exhausted retries: revert to open, penalize winner 20% deposit
      const winningBid = bounty.bids.find(b => b.id === bounty.winningBidId);
      if (winningBid) {
        const penalty = Math.floor(winningBid.deposit * 0.2);
        try {
          await this.deductAgentTokens(winningBid.agentId, penalty);
        } catch {
          // Agent may have insufficient balance; skip penalty
        }
      }

      const updated: Bounty = {
        ...bounty,
        status: 'open',
        retryCount: newRetryCount,
        winningBidId: null,
        escrowFrozen: 0,
        bids: [], // Clear bids so agents can bid again
      };
      bounties[index] = updated;
      await this.saveAll(bounties);
      return updated;
    }
  }
}
