import type { EventType } from '../shared/types.js';

const REPUTATION_THRESHOLD = 0.6;

interface AgentReputation {
  dealsKept: number;
  dealsBroken: number;
}

/**
 * Reputation System
 *
 * Tracks deal_kept and deal_broken events per agent.
 * Reputation = dealsKept / (dealsKept + dealsBroken)
 * - 1.0 if no events (fresh agent)
 * - Falls to 0 as breaches accumulate
 * - Agents with reputation < 0.6 are blocked from participating
 */
export class ReputationSystem {
  private agents = new Map<string, AgentReputation>();

  /**
   * Record a reputation-related event for an agent.
   * Only 'deal_kept' and 'deal_broken' affect reputation.
   */
  recordEvent(agentId: string, eventType: EventType): void {
    if (eventType !== 'deal_kept' && eventType !== 'deal_broken') {
      return;
    }

    const rep = this.agents.get(agentId) ?? { dealsKept: 0, dealsBroken: 0 };
    if (eventType === 'deal_kept') {
      rep.dealsKept++;
    } else {
      rep.dealsBroken++;
    }
    this.agents.set(agentId, rep);
  }

  /**
   * Calculate the reputation score for an agent (0.0 ~ 1.0).
   */
  calculateReputation(agentId: string): number {
    const rep = this.agents.get(agentId);
    if (!rep) {
      return 1.0; // no events → perfect reputation
    }
    const total = rep.dealsKept + rep.dealsBroken;
    if (total === 0) {
      return 1.0;
    }
    return rep.dealsKept / total;
  }

  /**
   * Check if an agent is blocked (reputation < threshold).
   */
  isBlocked(agentId: string): boolean {
    return this.calculateReputation(agentId) < REPUTATION_THRESHOLD;
  }

  /**
   * Get all agents currently below the reputation threshold.
   */
  getBlockedAgents(): string[] {
    const blocked: string[] = [];
    for (const [agentId] of this.agents) {
      if (this.isBlocked(agentId)) {
        blocked.push(agentId);
      }
    }
    return blocked;
  }
}
