import { describe, it, expect } from 'vitest';
import { createMessage, broadcast, direct, announce, getDeadLetters, clearDeadLetters } from '../../src/shared/message-bus.js';

describe('Message Bus', () => {
  describe('createMessage', () => {
    it('generates unique IDs for 100 messages', () => {
      const ids = new Set<string>();
      for (let i = 0; i < 100; i++) {
        const msg = createMessage(`agent_${i}`, 'agent_0', `test ${i}`, 'normal');
        expect(ids.has(msg.id)).toBe(false);
        ids.add(msg.id);
      }
      expect(ids.size).toBe(100);
    });

    it('sets timestamp and ttl correctly', () => {
      const before = Date.now();
      const msg = createMessage('a1', 'a2', 'hello', 'high');
      const after = Date.now();
      expect(msg.from).toBe('a1');
      expect(msg.to).toBe('a2');
      expect(msg.content).toBe('hello');
      expect(msg.priority).toBe('high');
      expect(msg.timestamp).toBeGreaterThanOrEqual(before);
      expect(msg.timestamp).toBeLessThanOrEqual(after);
      expect(msg.ttl).toBeGreaterThan(0);
    });

    it('uses default priority normal', () => {
      const msg = createMessage('a1', 'a2', 'test');
      expect(msg.priority).toBe('normal');
    });
  });

  describe('broadcast', () => {
    it('sends message to all target agents', () => {
      const msg = createMessage('sender', 'broadcast', 'hello everyone');
      const agents = ['a1', 'a2', 'a3'];
      const result = broadcast(msg, agents);
      expect(result).toHaveLength(3);
      expect(result.every(r => r.to === 'a1' || r.to === 'a2' || r.to === 'a3')).toBe(true);
      expect(result.map(r => r.to).sort()).toEqual(['a1', 'a2', 'a3']);
    });
  });

  describe('direct', () => {
    it('delivers message to a single target', () => {
      const msg = createMessage('a1', 'a2', 'private hello');
      const result = direct(msg, 'target-42');
      expect(result.to).toBe('target-42');
      expect(result.content).toBe('private hello');
    });
  });

  describe('announce', () => {
    it('sends broadcast to all registered agents', () => {
      const msg = createMessage('system', 'broadcast', 'global announcement');
      const agents = Array.from({ length: 10 }, (_, i) => `agent_${i}`);
      const results = announce(msg, agents);
      expect(results).toHaveLength(10);
    });
  });

  describe('Dead Letter Queue (TTL expiry)', () => {
    beforeEach(() => {
      clearDeadLetters();
    });

    it('moves expired messages to dead letter queue', async () => {
      // Create a message with 10ms TTL
      const msg = createMessage('a1', 'a2', 'expire me', 'normal', 10);
      
      // Try to deliver it immediately - should work
      const result1 = direct(msg, 'a2');
      expect(result1).toBeDefined();

      // Wait for TTL to expire
      await new Promise(r => setTimeout(r, 30));

      // Try to deliver again - should fail and land in dead letter
      const result2 = direct(msg, 'a2');
      expect(result2).toBeNull();

      const deadLetters = getDeadLetters();
      expect(deadLetters.length).toBeGreaterThanOrEqual(1);
      expect(deadLetters[0].id).toBe(msg.id);
    });

    it('keeps non-expired messages out of dead letters', () => {
      clearDeadLetters();
      const msg = createMessage('a1', 'a2', 'valid', 'normal', 60000);
      direct(msg, 'a2');
      expect(getDeadLetters()).toHaveLength(0);
    });
  });
});
