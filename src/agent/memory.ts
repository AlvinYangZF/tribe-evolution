import * as fs from 'node:fs/promises';
import * as path from 'node:path';

function getMemoryPath(storageDir: string, agentId: string): string {
  return path.join(storageDir, `${agentId}.json`);
}

/**
 * Read an agent's memory from disk.
 * Returns null if no memory file exists.
 */
export async function readMemory<T = Record<string, unknown>>(storageDir: string, agentId: string): Promise<T | null> {
  const filePath = getMemoryPath(storageDir, agentId);
  try {
    const content = await fs.readFile(filePath, 'utf-8');
    return JSON.parse(content) as T;
  } catch (err: unknown) {
    if ((err as NodeJS.ErrnoException).code === 'ENOENT') {
      return null;
    }
    throw err;
  }
}

/**
 * Write (overwrite) an agent's memory to disk.
 * Creates the directory if it doesn't exist.
 */
export async function writeMemory<T = Record<string, unknown>>(storageDir: string, agentId: string, data: T): Promise<void> {
  const filePath = getMemoryPath(storageDir, agentId);
  await fs.mkdir(storageDir, { recursive: true });
  await fs.writeFile(filePath, JSON.stringify(data, null, 2), 'utf-8');
}

/**
 * Append data to an agent's memory.
 * If the existing memory is an object, merges top-level fields.
 * If a field is an array in both old and new data, concatenates them.
 * If no memory exists, creates new one with the given data.
 */
export async function appendToMemory<T = Record<string, unknown>>(storageDir: string, agentId: string, data: T): Promise<void> {
  const existing = await readMemory<Record<string, unknown>>(storageDir, agentId);

  if (!existing) {
    return writeMemory(storageDir, agentId, data);
  }

  const merged = { ...existing };
  for (const [key, value] of Object.entries(data as Record<string, unknown>)) {
    if (Array.isArray(existing[key]) && Array.isArray(value)) {
      merged[key] = [...(existing[key] as unknown[]), ...value];
    } else {
      merged[key] = value;
    }
  }

  return writeMemory(storageDir, agentId, merged as T);
}
