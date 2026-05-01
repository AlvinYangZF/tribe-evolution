/**
 * Proposal Manager
 *
 * Handles agent proposals (suggestions for new skills, tasks, policy changes, etc.)
 * stored as an append-only JSONL file in ecosystem/proposals/log.jsonl.
 */

import * as path from 'node:path';
import { randomUUID } from 'node:crypto';
import { appendJSONL, readJSONL } from '../shared/filesystem.js';
import type { Proposal, ProposalType, ProposalStatus } from '../shared/types.js';

const PROPOSAL_DIR = 'proposals';
const PROPOSAL_FILE = 'log.jsonl';

const EXPIRY_DAYS = 7;
const EXPIRY_MS = EXPIRY_DAYS * 24 * 60 * 60 * 1000;

export class ProposalManager {
  private logFilePath: string;

  constructor(private ecosystemDir: string) {
    this.logFilePath = path.join(ecosystemDir, PROPOSAL_DIR, PROPOSAL_FILE);
  }

  /**
   * Create a new proposal.
   */
  async createProposal(
    agentId: string,
    data: {
      type: ProposalType;
      title: string;
      description: string;
      expectedBenefit: string;
      tokenCost: number;
      tokenReward: number;
    },
  ): Promise<Proposal> {
    const proposal: Proposal = {
      id: randomUUID(),
      agentId,
      type: data.type,
      title: data.title,
      description: data.description,
      expectedBenefit: data.expectedBenefit,
      tokenCost: data.tokenCost,
      tokenReward: data.tokenReward,
      status: 'pending',
      reviewedBy: null,
      reviewNote: null,
      createdAt: Date.now(),
      reviewedAt: null,
    };

    await appendJSONL(this.logFilePath, proposal);
    return proposal;
  }

  /**
   * Get all proposals for a given agent.
   */
  async getAgentProposals(agentId: string): Promise<Proposal[]> {
    const all = await this.readAll();
    return all.filter(p => p.agentId === agentId);
  }

  /**
   * Get all pending proposals.
   */
  async getPendingProposals(): Promise<Proposal[]> {
    const all = await this.readAll();
    return all.filter(p => p.status === 'pending');
  }

  /**
   * Approve a pending proposal.
   */
  async approveProposal(proposalId: string, reviewer: string = 'user'): Promise<Proposal> {
    return this.updateProposalStatus(proposalId, 'approved', reviewer, null);
  }

  /**
   * Reject a pending proposal.
   */
  async rejectProposal(proposalId: string, reason: string, reviewer: string = 'user'): Promise<Proposal> {
    return this.updateProposalStatus(proposalId, 'rejected', reviewer, reason);
  }

  /**
   * Expire proposals older than 7 days that are still pending.
   * Returns the count of expired proposals.
   */
  async expireOldProposals(): Promise<number> {
    const all = await this.readAll();
    const cutoff = Date.now() - EXPIRY_MS;
    let expiredCount = 0;

    const updated = all.map(p => {
      if (p.status === 'pending' && p.createdAt < cutoff) {
        expiredCount++;
        return {
          ...p,
          status: 'expired' as ProposalStatus,
        };
      }
      return p;
    });

    if (expiredCount > 0) {
      await this.rewriteAll(updated);
    }

    return expiredCount;
  }

  // ─── Private helpers ──────────────────────────────────────────────────

  private async readAll(): Promise<Proposal[]> {
    return readJSONL<Proposal>(this.logFilePath);
  }

  private async rewriteAll(proposals: Proposal[]): Promise<void> {
    const { safeWriteJSON } = await import('../shared/filesystem.js');
    const lines = proposals.map(p => JSON.stringify(p)).join('\n') + '\n';
    // Use the JSON file (not JSONL) temporarily for atomic rewrite
    const dir = path.dirname(this.logFilePath);
    const tmpFile = path.join(dir, `_rewrite_${randomUUID()}.json`);
    const { writeFile, rename } = await import('node:fs/promises');
    const { ensureDir } = await import('../shared/filesystem.js');
    await ensureDir(dir);
    await writeFile(tmpFile, lines, 'utf-8');
    await rename(tmpFile, this.logFilePath);
  }

  private async updateProposalStatus(
    proposalId: string,
    newStatus: 'approved' | 'rejected',
    reviewer: string,
    reviewNote: string | null,
  ): Promise<Proposal> {
    const all = await this.readAll();
    const index = all.findIndex(p => p.id === proposalId);

    if (index === -1) {
      throw new Error(`Proposal not found: ${proposalId}`);
    }

    const existing = all[index];
    if (existing.status !== 'pending') {
      throw new Error(`Proposal ${proposalId} has already been ${existing.status}, cannot ${newStatus}`);
    }

    const updated: Proposal = {
      ...existing,
      status: newStatus,
      reviewedBy: reviewer,
      reviewNote,
      reviewedAt: Date.now(),
    };

    all[index] = updated;
    await this.rewriteAll(all);

    return updated;
  }
}
