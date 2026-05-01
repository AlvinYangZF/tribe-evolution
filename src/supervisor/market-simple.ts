import crypto from 'node:crypto';
import type { Resource, Deal, DealStatus } from '../shared/types.js';
import type { ReputationSystem } from './reputation.js';

/**
 * Simple Market
 *
 * Manages resource locking/unlocking, deal offers, and settlement.
 * All deal completions and breaches are reported to the reputation system.
 */
export class Market {
  private deals = new Map<string, Deal>();
  private reputation: ReputationSystem;

  constructor(reputation: ReputationSystem) {
    this.reputation = reputation;
  }

  /**
   * Lock a resource for an agent.
   * Only succeeds if the resource is not already locked.
   */
  lockResource(resource: Resource, agentId: string): boolean {
    if (resource.ownerId !== null) {
      return false; // already locked
    }
    const now = Date.now();
    resource.ownerId = agentId;
    resource.lockedAt = now;
    resource.lockExpiresAt = now + 300_000; // 5 min lock timeout
    return true;
  }

  /**
   * Release a locked resource.
   * Only the lock owner can release.
   */
  releaseResource(resource: Resource, agentId: string): boolean {
    if (resource.ownerId !== agentId) {
      return false; // not the owner
    }
    resource.ownerId = null;
    resource.lockedAt = null;
    resource.lockExpiresAt = null;
    return true;
  }

  /**
   * Make an offer from one agent to another for a resource.
   * Creates a deal in 'open' status.
   */
  makeOffer(
    resourceId: string,
    fromAgent: string,
    toAgent: string,
    price: number,
  ): Deal {
    const deal: Deal = {
      id: crypto.randomUUID(),
      resourceId,
      fromAgent,
      toAgent,
      price,
      status: 'open',
      createdAt: Date.now(),
      settledAt: null,
    };
    this.deals.set(deal.id, deal);
    return deal;
  }

  /**
   * Accept an open offer.
   * Records a deal_kept event for both parties.
   */
  acceptOffer(dealId: string, agentId: string): boolean {
    const deal = this.deals.get(dealId);
    if (!deal || deal.status !== 'open') {
      return false;
    }
    if (deal.toAgent !== agentId) {
      return false; // only the target can accept
    }

    deal.status = 'completed';
    deal.settledAt = Date.now();

    // Record reputation events
    this.reputation.recordEvent(deal.fromAgent, 'deal_kept');
    this.reputation.recordEvent(deal.toAgent, 'deal_kept');

    return true;
  }

  /**
   * Breach (break) a deal.
   * Records a deal_broken event for the breaching agent.
   */
  breachDeal(dealId: string, agentId: string): boolean {
    const deal = this.deals.get(dealId);
    if (!deal) {
      return false;
    }
    if (deal.status !== 'open') {
      return false; // can only breach open deals
    }
    if (deal.fromAgent !== agentId && deal.toAgent !== agentId) {
      return false; // only participants can breach
    }

    deal.status = 'breached';
    deal.settledAt = Date.now();

    // Record reputation event for the breaching agent
    this.reputation.recordEvent(agentId, 'deal_broken');

    return true;
  }
}
