import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import fs from 'node:fs/promises';
import path from 'node:path';
import os from 'node:os';
import { EventLog } from '../../src/supervisor/event-log.js';
import {
  BOUNTY_TYPE_TO_SKILLS,
  attributeBountyOutcome,
  evaluateSkillPromotion,
  verdictToDelta,
} from '../../src/supervisor/skill-evaluator.js';

const TMP_DIR = path.join(os.tmpdir(), `tribe-skill-test-${Date.now()}`);
const LOG_PATH = path.join(TMP_DIR, 'events.jsonl');

describe('BOUNTY_TYPE_TO_SKILLS', () => {
  it('maps each known type to a skill list (other → empty)', () => {
    expect(BOUNTY_TYPE_TO_SKILLS.bug_fix).toEqual(['code_write']);
    expect(BOUNTY_TYPE_TO_SKILLS.feature).toEqual(['code_write']);
    expect(BOUNTY_TYPE_TO_SKILLS.research).toEqual(['web_search']);
    expect(BOUNTY_TYPE_TO_SKILLS.data_analysis).toEqual(['data_analyze']);
    expect(BOUNTY_TYPE_TO_SKILLS.code_review).toEqual(['observe']);
    expect(BOUNTY_TYPE_TO_SKILLS.other).toEqual([]);
  });
});

describe('attributeBountyOutcome', () => {
  let log: EventLog;
  beforeEach(async () => {
    await fs.mkdir(TMP_DIR, { recursive: true });
    log = new EventLog(LOG_PATH);
  });
  afterEach(async () => {
    await fs.rm(TMP_DIR, { recursive: true, force: true });
  });

  it('emits one skill_attributed event per mapped skill', async () => {
    await attributeBountyOutcome(e => log.append(e), {
      agentId: 'a1',
      bountyId: 'b1',
      bountyType: 'bug_fix',
      outcome: 'success',
    });
    const entries: Array<{ type: string; agentId: string; data: { skill: string; outcome: string; bountyType: string } }> = [];
    for await (const e of log.replay()) {
      entries.push(e as unknown as typeof entries[number]);
    }
    expect(entries).toHaveLength(1);
    expect(entries[0].type).toBe('skill_attributed');
    expect(entries[0].agentId).toBe('a1');
    expect(entries[0].data.skill).toBe('code_write');
    expect(entries[0].data.outcome).toBe('success');
  });

  it('is a no-op for bounty type "other"', async () => {
    await attributeBountyOutcome(e => log.append(e), {
      agentId: 'a1',
      bountyId: 'b1',
      bountyType: 'other',
      outcome: 'success',
    });
    expect(await log.size()).toBe(0);
  });
});

describe('evaluateSkillPromotion', () => {
  let log: EventLog;
  beforeEach(async () => {
    await fs.mkdir(TMP_DIR, { recursive: true });
    log = new EventLog(LOG_PATH);
  });
  afterEach(async () => {
    await fs.rm(TMP_DIR, { recursive: true, force: true });
  });

  async function record(agentId: string, bountyType: 'bug_fix' | 'research', outcome: 'success' | 'failure'): Promise<void> {
    await attributeBountyOutcome(e => log.append(e), {
      agentId,
      bountyId: `b-${Date.now()}-${Math.random()}`,
      bountyType,
      outcome,
    });
  }

  it('returns hold when there is insufficient evidence', async () => {
    await record('a1', 'bug_fix', 'success');
    await record('a1', 'bug_fix', 'success');
    const ev = await evaluateSkillPromotion(log, 'a1', 'code_write');
    expect(ev.sampleSize).toBe(2);
    expect(ev.verdict).toBe('hold');
  });

  it('promotes when success rate ≥ 70% over the window', async () => {
    for (let i = 0; i < 7; i++) await record('a1', 'bug_fix', 'success');
    for (let i = 0; i < 3; i++) await record('a1', 'bug_fix', 'failure');
    const ev = await evaluateSkillPromotion(log, 'a1', 'code_write');
    expect(ev.sampleSize).toBe(10);
    expect(ev.rate).toBeCloseTo(0.7);
    expect(ev.verdict).toBe('promote');
  });

  it('demotes when success rate ≤ 30% over the window', async () => {
    for (let i = 0; i < 7; i++) await record('a1', 'bug_fix', 'failure');
    for (let i = 0; i < 3; i++) await record('a1', 'bug_fix', 'success');
    const ev = await evaluateSkillPromotion(log, 'a1', 'code_write');
    expect(ev.verdict).toBe('demote');
  });

  it('holds when success rate is in the middle band', async () => {
    for (let i = 0; i < 5; i++) await record('a1', 'bug_fix', 'success');
    for (let i = 0; i < 5; i++) await record('a1', 'bug_fix', 'failure');
    const ev = await evaluateSkillPromotion(log, 'a1', 'code_write');
    expect(ev.rate).toBeCloseTo(0.5);
    expect(ev.verdict).toBe('hold');
  });

  it('only considers events for the requested agent + skill', async () => {
    // Noise: other agent succeeds at the same skill
    for (let i = 0; i < 5; i++) await record('a2', 'bug_fix', 'success');
    // Noise: a1 succeeds at a different skill
    for (let i = 0; i < 5; i++) await record('a1', 'research', 'success');
    // Signal: a1 fails at code_write, exactly 3 times (minimum)
    for (let i = 0; i < 3; i++) await record('a1', 'bug_fix', 'failure');
    const ev = await evaluateSkillPromotion(log, 'a1', 'code_write');
    expect(ev.sampleSize).toBe(3);
    expect(ev.rate).toBe(0);
    expect(ev.verdict).toBe('demote');
  });

  it('keeps only the last windowSize attributions', async () => {
    // 12 failures followed by 3 successes; window of 10 keeps the most recent
    // 10 = 7 failures + 3 successes → rate 0.3 → demote.
    for (let i = 0; i < 12; i++) await record('a1', 'bug_fix', 'failure');
    for (let i = 0; i < 3; i++) await record('a1', 'bug_fix', 'success');
    const ev = await evaluateSkillPromotion(log, 'a1', 'code_write', { windowSize: 10 });
    expect(ev.sampleSize).toBe(10);
    expect(ev.rate).toBeCloseTo(0.3);
    expect(ev.verdict).toBe('demote');
  });
});

describe('verdictToDelta', () => {
  it('promote → 0.2, hold → 0.05, demote → 0', () => {
    expect(verdictToDelta('promote')).toBe(0.2);
    expect(verdictToDelta('hold')).toBeCloseTo(0.05);
    expect(verdictToDelta('demote')).toBe(0);
  });
});
