import type { EventLogEntry, EventType } from '../shared/types.js';
import { appendJSONL, readJSONL, sha256 } from '../shared/filesystem.js';
import path from 'node:path';

const GENESIS_HASH = '0'.repeat(64);

export interface AppendEventInput {
  type: EventType;
  agentId: string;
  data: Record<string, unknown>;
}

export class EventLog {
  private filePath: string;
  // Cached chain tail. Hydrated from disk on first access, then updated
  // in place on every append. Lets append() avoid re-reading the entire
  // JSONL file every call, which was O(N) per write and grew unbounded.
  private cachedTail: { hash: string; count: number } | null = null;

  constructor(filePathOrDir: string) {
    // If it looks like a directory, default to event-log/events.jsonl
    if (!filePathOrDir.endsWith('.jsonl')) {
      this.filePath = path.join(filePathOrDir, 'event-log', 'events.jsonl');
    } else {
      this.filePath = filePathOrDir;
    }
  }

  private async readAll(): Promise<EventLogEntry[]> {
    return readJSONL<EventLogEntry>(this.filePath);
  }

  private async getTail(): Promise<{ hash: string; count: number }> {
    if (this.cachedTail) return this.cachedTail;
    const entries = await this.readAll();
    this.cachedTail = entries.length === 0
      ? { hash: GENESIS_HASH, count: 0 }
      : { hash: entries[entries.length - 1].hash, count: entries.length };
    return this.cachedTail;
  }

  /**
   * Append a new event to the log.
   * Computes index, timestamp, prevHash, and SHA-256 hash automatically.
   */
  async append(event: AppendEventInput): Promise<EventLogEntry> {
    const { hash: prevHash, count } = await this.getTail();
    const index = count;
    const timestamp = Date.now();

    const entry: EventLogEntry = {
      index,
      timestamp,
      type: event.type,
      agentId: event.agentId,
      data: event.data,
      prevHash,
      hash: '', // placeholder
    };

    // Compute hash over all fields except hash itself
    const hashPayload = JSON.stringify({
      index: entry.index,
      timestamp: entry.timestamp,
      type: entry.type,
      agentId: entry.agentId,
      data: entry.data,
      prevHash: entry.prevHash,
    });
    entry.hash = sha256(hashPayload);

    await appendJSONL(this.filePath, entry);
    this.cachedTail = { hash: entry.hash, count: count + 1 };
    return entry;
  }

  /**
   * Replay events from a given index onward (async generator).
   */
  async *replay(fromIndex = 0): AsyncGenerator<EventLogEntry> {
    const entries = await this.readAll();
    for (let i = fromIndex; i < entries.length; i++) {
      yield entries[i];
    }
  }

  /**
   * Verify the integrity of the entire event chain:
   * - Each entry's hash matches its content
   * - Each entry's prevHash matches the previous entry's hash
   */
  async verify(): Promise<boolean> {
    // Always re-read from disk to detect tampering
    const entries = await readJSONL<EventLogEntry>(this.filePath);
    if (entries.length === 0) return true;

    for (let i = 0; i < entries.length; i++) {
      const entry = entries[i];

      // Recompute hash
      const hashPayload = JSON.stringify({
        index: entry.index,
        timestamp: entry.timestamp,
        type: entry.type,
        agentId: entry.agentId,
        data: entry.data,
        prevHash: entry.prevHash,
      });
      const expectedHash = sha256(hashPayload);

      if (entry.hash !== expectedHash) {
        return false;
      }

      // Check chain link
      const expectedPrevHash = i === 0 ? GENESIS_HASH : entries[i - 1].hash;
      if (entry.prevHash !== expectedPrevHash) {
        return false;
      }
    }

    return true;
  }

  /**
   * Get the total number of events.
   */
  async size(): Promise<number> {
    const entries = await this.readAll();
    return entries.length;
  }
}
