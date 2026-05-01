import { describe, it, expect, beforeEach } from 'vitest';
import { ReputationSystem } from '../../src/supervisor/reputation.js';

describe('Reputation System', () => {
  let reputation: ReputationSystem;

  beforeEach(() => {
    reputation = new ReputationSystem();
  });

  it('new agent starts with reputation 1.0', () => {
    const rep = reputation.calculateReputation('new-agent');
    expect(rep).toBe(1.0);
  });

  it('records deal kept events', () => {
    reputation.recordEvent('alice', 'deal_kept');
    expect(reputation.calculateReputation('alice')).toBe(1.0);
  });

  it('records deal broken events', () => {
    reputation.recordEvent('bob', 'deal_broken');
    expect(reputation.calculateReputation('bob')).toBe(0);
  });

  it('isBlocked returns false for agents with reputation >= 0.6', () => {
    reputation.recordEvent('alice', 'deal_kept');
    expect(reputation.isBlocked('alice')).toBe(false);
  });

  it('isBlocked returns true for agents with reputation < 0.6', () => {
    reputation.recordEvent('alice', 'deal_broken'); // 0
    expect(reputation.isBlocked('alice')).toBe(true);
  });

  it('calculateReputation goes from 1.0 to below 0.6 after 3 breaches and no kept deals', () => {
    // Start: 1.0 (no events)
    expect(reputation.calculateReputation('bob')).toBe(1.0);

    // 3 breaches
    reputation.recordEvent('bob', 'deal_broken');
    reputation.recordEvent('bob', 'deal_broken');
    reputation.recordEvent('bob', 'deal_broken');

    // 0 kept, 3 broken → 0/(0+3) = 0
    expect(reputation.calculateReputation('bob')).toBe(0);
    expect(reputation.isBlocked('bob')).toBe(true);
  });

  it('calculateReputation with mixed events', () => {
    reputation.recordEvent('carol', 'deal_kept');
    reputation.recordEvent('carol', 'deal_kept');
    reputation.recordEvent('carol', 'deal_broken');
    // 2 kept, 1 broken → 2/3 ≈ 0.667
    const rep = reputation.calculateReputation('carol');
    expect(rep).toBeCloseTo(2 / 3);
    expect(reputation.isBlocked('carol')).toBe(false); // 0.667 >= 0.6
  });

  it('getBlockedAgents returns only agents below threshold', () => {
    reputation.recordEvent('alice', 'deal_kept');
    reputation.recordEvent('bob', 'deal_broken');
    reputation.recordEvent('bob', 'deal_broken');

    const blocked = reputation.getBlockedAgents();
    expect(blocked).toContain('bob');
    expect(blocked).not.toContain('alice');
  });

  it('filtered agents with no events are not blocked', () => {
    expect(reputation.isBlocked('unknown')).toBe(false);
  });
});
