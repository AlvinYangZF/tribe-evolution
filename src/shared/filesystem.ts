import fs from 'node:fs/promises';
import path from 'node:path';
import { createHash, randomBytes } from 'node:crypto';

/**
 * Ensure a directory exists (recursive).
 */
export async function ensureDir(dir: string): Promise<void> {
  await fs.mkdir(dir, { recursive: true });
}

/**
 * Safely read and parse a JSON file.
 * Returns null if file does not exist or is invalid JSON.
 */
export async function safeReadJSON<T>(filePath: string): Promise<T | null> {
  try {
    const raw = await fs.readFile(filePath, 'utf-8');
    return JSON.parse(raw) as T;
  } catch {
    return null;
  }
}

/**
 * Atomically write JSON to a file (write to tmp, then rename).
 */
export async function safeWriteJSON(filePath: string, data: unknown): Promise<void> {
  const dir = path.dirname(filePath);
  await ensureDir(dir);
  const tmpPath = path.join(dir, `.tmp-${randomBytes(6).toString('hex')}-${path.basename(filePath)}`);
  const content = JSON.stringify(data, null, 2) + '\n';
  await fs.writeFile(tmpPath, content, 'utf-8');
  await fs.rename(tmpPath, filePath);
}

/**
 * Append a JSON line to a JSONL file (thread-safe via atomic write).
 */
export async function appendJSONL(filePath: string, entry: unknown): Promise<void> {
  const dir = path.dirname(filePath);
  await ensureDir(dir);
  const line = JSON.stringify(entry) + '\n';
  await fs.appendFile(filePath, line, 'utf-8');
}

/**
 * Read all entries from a JSONL file.
 * Returns empty array if file does not exist.
 */
export async function readJSONL<T>(filePath: string): Promise<T[]> {
  try {
    const raw = await fs.readFile(filePath, 'utf-8');
    const lines = raw.trim().split('\n');
    return lines.filter(l => l.trim().length > 0).map(l => JSON.parse(l) as T);
  } catch {
    return [];
  }
}

/**
 * Compute SHA-256 hex digest of a string.
 */
export function sha256(data: string): string {
  return createHash('sha256').update(data).digest('hex');
}
