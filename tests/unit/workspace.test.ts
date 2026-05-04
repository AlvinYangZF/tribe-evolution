import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import fs from 'node:fs/promises';
import path from 'node:path';
import os from 'node:os';
import {
  readMemory,
  writeMemory,
  inheritMemory,
  summarizeOwnMemory,
  writeLastDecision,
  readLastDecision,
  MEMORY_LIMIT_BYTES,
  SUMMARIZE_MIN_BYTES,
} from '../../src/supervisor/workspace.js';

let ECO_DIR: string;

beforeEach(async () => {
  ECO_DIR = path.join(os.tmpdir(), `tribe-workspace-test-${Date.now()}-${Math.random()}`);
  await fs.mkdir(ECO_DIR, { recursive: true });
});

afterEach(async () => {
  await fs.rm(ECO_DIR, { recursive: true, force: true });
});

describe('readMemory', () => {
  it('returns empty string when the agent has no notes file yet', async () => {
    expect(await readMemory(ECO_DIR, 'fresh-agent')).toBe('');
  });

  it('returns the file contents when present', async () => {
    await writeMemory(ECO_DIR, 'a1', 'hello');
    expect(await readMemory(ECO_DIR, 'a1')).toBe('hello');
  });
});

describe('writeMemory', () => {
  it('creates the workspace directory on demand', async () => {
    await writeMemory(ECO_DIR, 'new-agent', 'note one');
    const filePath = path.join(ECO_DIR, 'workspaces', 'new-agent', 'notes.md');
    const stat = await fs.stat(filePath);
    expect(stat.isFile()).toBe(true);
  });

  it('overwrites existing content (does not append)', async () => {
    await writeMemory(ECO_DIR, 'a1', 'first');
    await writeMemory(ECO_DIR, 'a1', 'second');
    expect(await readMemory(ECO_DIR, 'a1')).toBe('second');
  });

  it('truncates content longer than MEMORY_LIMIT_BYTES', async () => {
    const huge = 'x'.repeat(MEMORY_LIMIT_BYTES * 2);
    const written = await writeMemory(ECO_DIR, 'a1', huge);
    expect(written).toBe(MEMORY_LIMIT_BYTES);
    const stored = await readMemory(ECO_DIR, 'a1');
    expect(stored.length).toBe(MEMORY_LIMIT_BYTES);
  });
});

describe('inheritMemory', () => {
  it('copies parent notes to child with an inheritance header', async () => {
    await writeMemory(ECO_DIR, 'parent', 'I learned X by trying Y.');
    await inheritMemory(ECO_DIR, 'parent', 'child');
    const childNotes = await readMemory(ECO_DIR, 'child');
    expect(childNotes).toContain('Inherited from parent');
    expect(childNotes).toContain('I learned X by trying Y.');
  });

  it('is a no-op when the parent has no notes', async () => {
    await inheritMemory(ECO_DIR, 'parent', 'child');
    expect(await readMemory(ECO_DIR, 'child')).toBe('');
  });

  it('is a no-op when the parent has only whitespace', async () => {
    await writeMemory(ECO_DIR, 'parent', '   \n\n  ');
    await inheritMemory(ECO_DIR, 'parent', 'child');
    expect(await readMemory(ECO_DIR, 'child')).toBe('');
  });

  it('uses the summarizer output when one is provided', async () => {
    const longParentNotes = 'I bid on bug_fix bounties 12 times and won 9 — code_write is paying off. ' +
      'Web search rarely correlates with bounty wins for me. ' +
      'Trade does well when iron supply tightens around cycle 30.';
    await writeMemory(ECO_DIR, 'parent', longParentNotes);
    const summary = 'Bias toward bug_fix bounties and code_write; skip web_search.';
    let receivedText = '';
    let receivedMaxBytes = -1;
    const summarizer = async (text: string, maxBytes: number) => {
      receivedText = text;
      receivedMaxBytes = maxBytes;
      return summary;
    };
    await inheritMemory(ECO_DIR, 'parent', 'child', summarizer);

    const childNotes = await readMemory(ECO_DIR, 'child');
    expect(childNotes).toContain('Inherited from parent (summarized)');
    expect(childNotes).toContain(summary);
    expect(childNotes).not.toContain('iron supply tightens');
    // Summarizer received the parent's full text and the byte budget.
    expect(receivedText).toBe(longParentNotes);
    expect(receivedMaxBytes).toBeGreaterThan(0);
  });

  it('falls back to verbatim when the summarizer throws', async () => {
    const parentNotes = 'lesson A.\nlesson B.';
    await writeMemory(ECO_DIR, 'parent', parentNotes);
    const summarizer = async () => { throw new Error('LLM unreachable'); };
    await inheritMemory(ECO_DIR, 'parent', 'child', summarizer);

    const childNotes = await readMemory(ECO_DIR, 'child');
    // Header reverts to the un-summarized form so the operator can tell
    // the LLM step was skipped.
    expect(childNotes).toContain('Inherited from parent');
    expect(childNotes).not.toContain('summarized');
    expect(childNotes).toContain(parentNotes);
  });

  it('falls back to verbatim when the summarizer returns empty/whitespace', async () => {
    const parentNotes = 'something useful.';
    await writeMemory(ECO_DIR, 'parent', parentNotes);
    const summarizer = async () => '   \n  ';
    await inheritMemory(ECO_DIR, 'parent', 'child', summarizer);

    const childNotes = await readMemory(ECO_DIR, 'child');
    expect(childNotes).toContain('Inherited from parent');
    expect(childNotes).not.toContain('summarized');
    expect(childNotes).toContain(parentNotes);
  });

  it('does not call the summarizer when the parent has no notes', async () => {
    let called = false;
    const summarizer = async () => { called = true; return 'should not happen'; };
    await inheritMemory(ECO_DIR, 'parent', 'child', summarizer);
    expect(called).toBe(false);
    expect(await readMemory(ECO_DIR, 'child')).toBe('');
  });
});

describe('summarizeOwnMemory', () => {
  // A long enough payload to trigger summarization (over SUMMARIZE_MIN_BYTES).
  const LONG_NOTES = (
    'I keep losing bid_bounty on bug_fix to specialists. Code_write is stuck around 30%. ' +
    'Trade has yielded 200 tokens reliably when iron supplies tighten near cycle 30. ' +
    'My collab_bias is high so I should partner with workers, not aggressors. ' +
    'Web_search rarely converts unless followed by write_artifact. '
  ).repeat(3);

  it('rewrites notes when they are long enough and the summarizer succeeds', async () => {
    expect(LONG_NOTES.length).toBeGreaterThanOrEqual(SUMMARIZE_MIN_BYTES);
    await writeMemory(ECO_DIR, 'a1', LONG_NOTES);
    const summary = 'partner with workers; trade near cycle 30; pair web_search with write_artifact.';
    const summarizer = async () => summary;
    const result = await summarizeOwnMemory(ECO_DIR, 'a1', summarizer);
    expect(result.summarized).toBe(true);
    expect(result.beforeBytes).toBeGreaterThan(result.afterBytes);
    expect(await readMemory(ECO_DIR, 'a1')).toBe(summary);
  });

  it('is a no-op when there are no notes', async () => {
    const summarizer = async () => 'should not be called';
    const result = await summarizeOwnMemory(ECO_DIR, 'fresh', summarizer);
    expect(result.summarized).toBe(false);
    expect(result.reason).toBe('no_notes');
    expect(await readMemory(ECO_DIR, 'fresh')).toBe('');
  });

  it('is a no-op when the existing notes are below the min-byte threshold', async () => {
    const tinyNotes = 'too short to bother';
    expect(tinyNotes.length).toBeLessThan(SUMMARIZE_MIN_BYTES);
    await writeMemory(ECO_DIR, 'a1', tinyNotes);
    let called = false;
    const summarizer = async () => { called = true; return 'compacted'; };
    const result = await summarizeOwnMemory(ECO_DIR, 'a1', summarizer);
    expect(result.summarized).toBe(false);
    expect(result.reason).toBe('too_short');
    expect(called).toBe(false);
    // Original content untouched.
    expect(await readMemory(ECO_DIR, 'a1')).toBe(tinyNotes);
  });

  it('keeps the original notes when the summarizer throws', async () => {
    await writeMemory(ECO_DIR, 'a1', LONG_NOTES);
    const summarizer = async () => { throw new Error('LLM down'); };
    const result = await summarizeOwnMemory(ECO_DIR, 'a1', summarizer);
    expect(result.summarized).toBe(false);
    expect(result.reason).toBe('summarizer_failed');
    expect(await readMemory(ECO_DIR, 'a1')).toBe(LONG_NOTES);
  });

  it('keeps the original notes when the summarizer returns whitespace only', async () => {
    await writeMemory(ECO_DIR, 'a1', LONG_NOTES);
    const summarizer = async () => '   \n   ';
    const result = await summarizeOwnMemory(ECO_DIR, 'a1', summarizer);
    expect(result.summarized).toBe(false);
    expect(result.reason).toBe('empty_summary');
    expect(await readMemory(ECO_DIR, 'a1')).toBe(LONG_NOTES);
  });
});

describe('writeLastDecision / readLastDecision', () => {
  it('returns null when no snapshot has been written yet', async () => {
    expect(await readLastDecision(ECO_DIR, 'fresh')).toBeNull();
  });

  it('writes a snapshot and reads it back exactly', async () => {
    const snapshot = {
      cycle: 7,
      timestamp: 1700000000000,
      action: 'bid_bounty',
      reasoning: 'going for it',
      phases: {
        explore: { observations: ['low tokens'], focus_area: 'earn tokens' },
        evaluate: {
          candidates: [{ action: 'bid_bounty', why: 'fastest', expected_value: 70 }],
          top_choice: 'bid_bounty',
        },
      },
    };
    await writeLastDecision(ECO_DIR, 'a1', snapshot);
    const read = await readLastDecision(ECO_DIR, 'a1');
    expect(read).toEqual(snapshot);
  });

  it('overwrites the previous snapshot (no append, no history)', async () => {
    await writeLastDecision(ECO_DIR, 'a1', {
      cycle: 1, timestamp: 1, action: 'idle', reasoning: 'first',
    });
    await writeLastDecision(ECO_DIR, 'a1', {
      cycle: 2, timestamp: 2, action: 'observe', reasoning: 'second',
    });
    const read = await readLastDecision(ECO_DIR, 'a1');
    expect(read?.cycle).toBe(2);
    expect(read?.action).toBe('observe');
  });

  it('creates the workspace directory on demand', async () => {
    await writeLastDecision(ECO_DIR, 'new-agent', {
      cycle: 1, timestamp: 1, action: 'idle', reasoning: 'first cycle',
    });
    const filePath = path.join(ECO_DIR, 'workspaces', 'new-agent', 'last-decision.json');
    const stat = await fs.stat(filePath);
    expect(stat.isFile()).toBe(true);
  });

  it('preserves optional fields like fallbackReason when set', async () => {
    await writeLastDecision(ECO_DIR, 'a1', {
      cycle: 5,
      timestamp: 1,
      action: 'idle',
      reasoning: 'LLM call failed',
      fallbackReason: 'llm_error',
    });
    const read = await readLastDecision(ECO_DIR, 'a1');
    expect(read?.fallbackReason).toBe('llm_error');
  });
});
