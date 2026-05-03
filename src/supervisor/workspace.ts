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
import { ensureDir } from '../shared/filesystem.js';

const WORKSPACES_DIR = 'workspaces';
const NOTES_FILE = 'notes.md';

/** Soft cap on agent notes. Longer payloads are truncated on write. */
export const MEMORY_LIMIT_BYTES = 4096;

function workspaceDir(ecosystemDir: string, agentId: string): string {
  return path.join(ecosystemDir, WORKSPACES_DIR, agentId);
}

function notesPath(ecosystemDir: string, agentId: string): string {
  return path.join(workspaceDir(ecosystemDir, agentId), NOTES_FILE);
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
 * Copy a parent's notes to a child's workspace, prepending a small header so
 * the child knows the memory is inherited rather than self-written. No-op
 * when the parent has no notes — we don't want to seed an empty file.
 */
export async function inheritMemory(ecosystemDir: string, parentId: string, childId: string): Promise<void> {
  const parentNotes = await readMemory(ecosystemDir, parentId);
  if (!parentNotes.trim()) return;
  const header = `# Inherited from ${parentId}\n\n`;
  await writeMemory(ecosystemDir, childId, header + parentNotes);
}
