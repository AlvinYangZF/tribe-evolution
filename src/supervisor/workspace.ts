/**
 * Per-agent persistent workspace.
 *
 * Each agent gets a directory at ecosystem/workspaces/<id>/ that survives
 * across cycles. Today the only file in there is notes.md — a free-form
 * memory block the agent can rewrite via the `update_memory` action. The
 * notes are injected into the next cycle's system prompt, giving the agent
 * implicit long-term working memory without any extra subsystem.
 *
 * Borrowed from multica's per-agent work directory + Letta's self-editing
 * memory blocks (#2 on the borrow list).
 */

import * as fs from 'node:fs/promises';
import * as path from 'node:path';
import { ensureDir, safeReadJSON, safeWriteJSON } from '../shared/filesystem.js';

const WORKSPACES_DIR = 'workspaces';
const NOTES_FILE = 'notes.md';
const LAST_DECISION_FILE = 'last-decision.json';

/** Soft cap on agent notes. Longer payloads are truncated on write. */
export const MEMORY_LIMIT_BYTES = 4096;

/**
 * Target size for an inherited summary. Smaller than MEMORY_LIMIT_BYTES
 * so the child has room to add its own observations on top of the
 * inherited payload before re-hitting the cap.
 */
export const INHERITANCE_SUMMARY_BYTES = 1024;

/**
 * Optional callback that compacts a parent's notes into a shorter,
 * more actionable inheritance payload. Implementations should aim for
 * `maxBytes` UTF-8 bytes or fewer; over-budget output is truncated by
 * `writeMemory`. Failure (a thrown error) is non-fatal — `inheritMemory`
 * falls back to a verbatim copy, which preserves the never-block-on-LLM
 * contract for reproduction.
 */
export type Summarizer = (text: string, maxBytes: number) => Promise<string>;

function workspaceDir(ecosystemDir: string, agentId: string): string {
  return path.join(ecosystemDir, WORKSPACES_DIR, agentId);
}

function notesPath(ecosystemDir: string, agentId: string): string {
  return path.join(workspaceDir(ecosystemDir, agentId), NOTES_FILE);
}

function lastDecisionPath(ecosystemDir: string, agentId: string): string {
  return path.join(workspaceDir(ecosystemDir, agentId), LAST_DECISION_FILE);
}

/**
 * Per-agent debug snapshot of the most recent decide() result. Includes
 * the final action plus the explore + evaluate phase outputs so an
 * operator can see why the agent picked what it picked.
 *
 * Overwritten each cycle — we don't keep historical decisions on disk
 * here. The hash-chained event log already records the final action;
 * this file is purely a debug companion for the new three-phase pipeline.
 */
export interface LastDecisionSnapshot {
  cycle: number;
  timestamp: number;
  action: string;
  reasoning: string;
  fallbackReason?: string;
  phases?: {
    explore?: unknown;
    evaluate?: unknown;
  };
}

/** Write the most recent decide() result to last-decision.json, overwriting
 *  any previous snapshot. Routes through `safeWriteJSON` so the write is
 *  atomic (tmp + rename) — a process crash mid-write can't leave the file
 *  in a half-written state for the next reader. */
export async function writeLastDecision(
  ecosystemDir: string,
  agentId: string,
  snapshot: LastDecisionSnapshot,
): Promise<void> {
  await safeWriteJSON(lastDecisionPath(ecosystemDir, agentId), snapshot);
}

/** Read the most recent decide() snapshot, or null when the file is missing
 *  / corrupt / unreadable. Defers to `safeReadJSON` which returns null on
 *  any error — defensive against half-written files left by a previous
 *  crash and against manual edits that produce invalid JSON. */
export async function readLastDecision(ecosystemDir: string, agentId: string): Promise<LastDecisionSnapshot | null> {
  return await safeReadJSON<LastDecisionSnapshot>(lastDecisionPath(ecosystemDir, agentId));
}

/**
 * Read an agent's notes.md, or '' if the file does not exist yet. Errors
 * other than ENOENT propagate so we don't silently mask filesystem problems.
 */
export async function readMemory(ecosystemDir: string, agentId: string): Promise<string> {
  try {
    return await fs.readFile(notesPath(ecosystemDir, agentId), 'utf-8');
  } catch (err: unknown) {
    if ((err as NodeJS.ErrnoException).code === 'ENOENT') return '';
    throw err;
  }
}

/**
 * Overwrite notes.md with `content`, truncating to MEMORY_LIMIT_BYTES.
 * Creates the workspace directory on demand. Returns the bytes written.
 */
export async function writeMemory(ecosystemDir: string, agentId: string, content: string): Promise<number> {
  const dir = workspaceDir(ecosystemDir, agentId);
  await ensureDir(dir);
  const trimmed = content.length > MEMORY_LIMIT_BYTES ? content.slice(0, MEMORY_LIMIT_BYTES) : content;
  await fs.writeFile(notesPath(ecosystemDir, agentId), trimmed, 'utf-8');
  return Buffer.byteLength(trimmed, 'utf-8');
}

/**
 * Below this byte count, calling the summarizer on an agent's own notes
 * is wasteful — the notes are already short enough that compaction
 * wouldn't add headroom. Used by summarizeOwnMemory().
 */
export const SUMMARIZE_MIN_BYTES = 512;

export interface SummarizeOwnMemoryResult {
  /** True iff the notes were rewritten via the summarizer. False when
   *  the action was a no-op (no notes / too-short notes / summarizer
   *  failure / empty summary). */
  summarized: boolean;
  /** Reason the action was a no-op, when summarized === false. */
  reason?: 'no_notes' | 'too_short' | 'summarizer_failed' | 'empty_summary';
  beforeBytes: number;
  afterBytes: number;
}

/**
 * Compact an agent's own notes via the LLM and write the shorter version
 * back. The agent picks this action when its notes are getting long; the
 * supervisor wires up a Summarizer that uses the agent's per-cycle LLM
 * call (so the agent pays for its own compaction).
 *
 * Always non-throwing — returns a result object describing what happened.
 * That keeps the supervisor's action dispatch simple (no try/catch needed)
 * and gives the caller something to log.
 */
export async function summarizeOwnMemory(
  ecosystemDir: string,
  agentId: string,
  summarize: Summarizer,
  targetBytes: number = INHERITANCE_SUMMARY_BYTES,
): Promise<SummarizeOwnMemoryResult> {
  const before = await readMemory(ecosystemDir, agentId);
  const beforeBytes = Buffer.byteLength(before, 'utf-8');
  if (!before.trim()) {
    return { summarized: false, reason: 'no_notes', beforeBytes, afterBytes: beforeBytes };
  }
  if (beforeBytes < SUMMARIZE_MIN_BYTES) {
    return { summarized: false, reason: 'too_short', beforeBytes, afterBytes: beforeBytes };
  }
  let compact: string;
  try {
    compact = await summarize(before, targetBytes);
  } catch {
    return { summarized: false, reason: 'summarizer_failed', beforeBytes, afterBytes: beforeBytes };
  }
  if (!compact.trim()) {
    return { summarized: false, reason: 'empty_summary', beforeBytes, afterBytes: beforeBytes };
  }
  const afterBytes = await writeMemory(ecosystemDir, agentId, compact);
  return { summarized: true, beforeBytes, afterBytes };
}

/**
 * Copy a parent's notes to a child's workspace, prepending a small header so
 * the child knows the memory is inherited rather than self-written. No-op
 * when the parent has no notes — we don't want to seed an empty file.
 *
 * If `summarize` is provided, it's invoked first to compact the parent's
 * notes into a shorter inheritance payload (keeps lessons compounding
 * across generations from bloating the 4 KB cap). Summarizer failures
 * fall back to a verbatim copy — reproduction must never block on the
 * LLM, even when the LLM is misbehaving.
 */
export async function inheritMemory(
  ecosystemDir: string,
  parentId: string,
  childId: string,
  summarize?: Summarizer,
): Promise<void> {
  const parentNotes = await readMemory(ecosystemDir, parentId);
  if (!parentNotes.trim()) return;
  let payload = parentNotes;
  let summarized = false;
  if (summarize) {
    try {
      const compact = await summarize(parentNotes, INHERITANCE_SUMMARY_BYTES);
      if (compact.trim().length > 0) {
        payload = compact;
        summarized = true;
      }
    } catch {
      // Fall through to verbatim copy.
    }
  }
  const header = summarized
    ? `# Inherited from ${parentId} (summarized)\n\n`
    : `# Inherited from ${parentId}\n\n`;
  await writeMemory(ecosystemDir, childId, header + payload);
}
