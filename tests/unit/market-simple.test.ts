import { describe, it, expect, beforeEach } from 'vitest';
import { Market } from '../../src/supervisor/market-simple.js';
import { ReputationSystem } from '../../src/supervisor/reputation.js';
import type { Resource } from '../../src/shared/types.js';

describe('Market', () => {
  let reputation: ReputationSystem;
  let market: Market;
  let resource: Resource;

  beforeEach(() => {
    reputation = new ReputationSystem();
    market = new Market(reputation);
    resource = {
      id: 'res-1',
      type: 'file_lock',
      name: 'test-resource',
      ownerId: null,
      lockedAt: null,
      lockExpiresAt: null,
      leasePrice: 100,
    };
  });

  it('locks a resource for an agent', () => {
    const result = market.lockResource(resource, 'alice');
    expect(result).toBe(true);
    expect(resource.ownerId).toBe('alice');
    expect(resource.lockedAt).toBeGreaterThan(0);
    expect(resource.lockExpiresAt).toBeGreaterThan(resource.lockedAt!);
  });

  it('prevents locking an already locked resource', () => {
    market.lockResource(resource, 'alice');
    const result = market.lockResource(resource, 'bob');
    expect(result).toBe(false);
    expect(resource.ownerId).toBe('alice');
  });

  it('only lock owner can release', () => {
    market.lockResource(resource, 'alice');
    const result = market.releaseResource(resource, 'bob');
    expect(result).toBe(false);
    expect(resource.ownerId).toBe('alice');
  });

  it('owner can release the lock', () => {
    market.lockResource(resource, 'alice');
    const result = market.releaseResource(resource, 'alice');
    expect(result).toBe(true);
    expect(resource.ownerId).toBeNull();
    expect(resource.lockedAt).toBeNull();
    expect(resource.lockExpiresAt).toBeNull();
  });

  it('makes an offer that creates a deal', () => {
    const deal = market.makeOffer('res-1', 'alice', 'bob', 100);
    expect(deal).toBeDefined();
    expect(deal.resourceId).toBe('res-1');
    expect(deal.fromAgent).toBe('alice');
    expect(deal.toAgent).toBe('bob');
    expect(deal.price).toBe(100);
    expect(deal.status).toBe('open');
  });

  it('accepts an open offer and records deal_kept', () => {
    const deal = market.makeOffer('res-1', 'alice', 'bob', 100);
    const result = market.acceptOffer(deal.id, 'bob');
    expect(result).toBe(true);
    expect(deal.status).toBe('completed');
    expect(deal.settledAt).toBeGreaterThan(0);
  });

  it('breach of deal records deal_broken in reputation', () => {
    const deal = market.makeOffer('res-1', 'alice', 'bob', 100);
    const result = market.breachDeal(deal.id, 'alice');
    expect(result).toBe(true);
    expect(deal.status).toBe('breached');

    const aliceRep = reputation.calculateReputation('alice');
    expect(aliceRep).toBeLessThan(1.0);
    expect(aliceRep).toBe(0); // 0 kept, 1 broken → 0/(0+1) = 0
  });

  it('completes lock → offer → accept → release flow with transfer', () => {
    // 1. Lock
    market.lockResource(resource, 'alice');
    expect(resource.ownerId).toBe('alice');

    // 2. Make offer
    const deal = market.makeOffer('res-1', 'alice', 'bob', 100);
    expect(deal.status).toBe('open');

    // 3. Accept offer
    market.acceptOffer(deal.id, 'bob');
    expect(deal.status).toBe('completed');

    // 4. Release
    market.releaseResource(resource, 'alice');
    expect(resource.ownerId).toBeNull();

    // alice got 100 tokens reputation event recorded
    const aliceRep = reputation.calculateReputation('alice');
    expect(aliceRep).toBe(1.0);
  });
});
