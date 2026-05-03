/**
 * Skill evaluator — measured-competence model for agent skills.
 *
 * Inspired by wanman's `SkillManager.autoPromote()`: skills should grow based
 * on outcomes, not just token spend. When an agent wins a bounty we attribute
 * the success to the skill(s) that bounty type implies; when a bounty fails
 * permanently we attribute the failure the same way. The `develop_skill`
 * action consults the agent's recent track record to decide how much of the
 * bump to actually apply, so paying tokens to study a skill the agent has no
 * evidence of using is mostly wasted.
 */

import type { ActorType, BountyType, EventLogEntry, SkillName } from '../shared/types.js';
import type { AppendEventInput, EventLog } from './event-log.js';

/**
 * Which skill(s) a bounty type primarily exercises. Bounties of type 'other'
 * intentionally have no attribution — we don't want to credit/penalize a
 * random skill for an unstructured bounty.
 */
export const BOUNTY_TYPE_TO_SKILLS: Record<BountyType, SkillName[]> = {
  bug_fix: ['code_write'],
  feature: ['code_write'],
  research: ['web_search'],
  data_analysis: ['data_analyze'],
  code_review: ['observe'],
  other: [],
};

export type AttributionOutcome = 'success' | 'failure';

/**
 * Append one `skill_attributed` event per skill implied by the bounty type.
 * No-op for bounty types with no mapped skill (e.g. 'other').
 */
export async function attributeBountyOutcome(
  appendEvent: (e: AppendEventInput) => Promise<EventLogEntry>,
  args: {
    agentId: string;
    bountyId: string;
    bountyType: BountyType;
    outcome: AttributionOutcome;
  },
): Promise<void> {
  const skills = BOUNTY_TYPE_TO_SKILLS[args.bountyType];
  for (const skill of skills) {
    await appendEvent({
      type: 'skill_attributed',
      agentId: args.agentId,
      actorType: 'agent' satisfies ActorType,
      data: {
        skill,
        bountyId: args.bountyId,
        bountyType: args.bountyType,
        outcome: args.outcome,
      },
    });
  }
}

export interface SkillEvaluation {
  /** Number of attributions in the evaluation window. */
  sampleSize: number;
  /** Success rate over the window, or 0 when sampleSize === 0. */
  rate: number;
  verdict: 'promote' | 'hold' | 'demote';
}

/**
 * Walk `skill_attributed` events for (agentId, skill), keep the last
 * `windowSize`, and return a verdict. Insufficient evidence (< minSamples)
 * always yields 'hold' — we don't want a single failure to kill a skill.
 */
export async function evaluateSkillPromotion(
  eventLog: Pick<EventLog, 'replay'>,
  agentId: string,
  skill: SkillName,
  opts: { windowSize?: number; minSamples?: number; promoteAt?: number; demoteAt?: number } = {},
): Promise<SkillEvaluation> {
  const windowSize = opts.windowSize ?? 10;
  const minSamples = opts.minSamples ?? 3;
  const promoteAt = opts.promoteAt ?? 0.7;
  const demoteAt = opts.demoteAt ?? 0.3;

  const window: AttributionOutcome[] = [];
  for await (const entry of eventLog.replay()) {
    if (entry.type !== 'skill_attributed') continue;
    if (entry.agentId !== agentId) continue;
    const data = entry.data as { skill?: SkillName; outcome?: AttributionOutcome };
    if (data.skill !== skill || (data.outcome !== 'success' && data.outcome !== 'failure')) continue;
    window.push(data.outcome);
    if (window.length > windowSize) window.shift();
  }

  if (window.length < minSamples) {
    return { sampleSize: window.length, rate: 0, verdict: 'hold' };
  }

  const successes = window.filter(o => o === 'success').length;
  const rate = successes / window.length;
  let verdict: SkillEvaluation['verdict'];
  if (rate >= promoteAt) verdict = 'promote';
  else if (rate <= demoteAt) verdict = 'demote';
  else verdict = 'hold';
  return { sampleSize: window.length, rate, verdict };
}

/**
 * Map a verdict to the diploid-allele delta used by `develop_skill`. Promotion
 * lands the full bump; hold is cautious investment without evidence; demotion
 * means the tokens were spent but the skill didn't take.
 */
export function verdictToDelta(verdict: SkillEvaluation['verdict']): number {
  switch (verdict) {
    case 'promote': return 0.2;
    case 'hold':    return 0.05;
    case 'demote':  return 0;
  }
}
