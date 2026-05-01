import crypto from 'node:crypto';
import type { Message, MessagePriority } from '../shared/types.js';

const deadLetter: Message[] = [];

/**
 * Create a new message with a unique ID, timestamp, and TTL.
 */
export function createMessage(
  from: string,
  to: string,
  content: unknown,
  priority: MessagePriority = 'normal',
  ttl: number = 60000,
): Message {
  return {
    id: crypto.randomUUID(),
    from,
    to,
    content,
    priority,
    timestamp: Date.now(),
    ttl,
  };
}

/**
 * Check if a message has expired (TTL exceeded).
 */
function isExpired(msg: Message): boolean {
  return Date.now() - msg.timestamp > msg.ttl;
}

/**
 * Move a message to the dead letter queue.
 */
function moveToDeadLetter(msg: Message): void {
  deadLetter.push(msg);
}

/**
 * Broadcast a message to multiple target agents.
 * Expired messages are moved to the dead letter queue.
 * Returns a list of successfully delivered (non-expired) messages.
 */
export function broadcast(msg: Message, agents: string[]): Message[] {
  if (isExpired(msg)) {
    moveToDeadLetter(msg);
    return [];
  }
  return agents.map((agentId) => ({
    ...msg,
    to: agentId,
  }));
}

/**
 * Direct a message to a single target agent.
 * Returns the message if delivered, or null if expired (moved to dead letter).
 */
export function direct(msg: Message, targetId: string): Message | null {
  if (isExpired(msg)) {
    moveToDeadLetter(msg);
    return null;
  }
  return { ...msg, to: targetId };
}

/**
 * Announce a message (broadcast) to all registered agents.
 * Returns successfully delivered messages.
 */
export function announce(msg: Message, agents: string[]): Message[] {
  return broadcast(msg, agents);
}

/**
 * Get all messages in the dead letter queue.
 */
export function getDeadLetters(): Message[] {
  return [...deadLetter];
}

/**
 * Clear the dead letter queue.
 */
export function clearDeadLetters(): void {
  deadLetter.length = 0;
}
