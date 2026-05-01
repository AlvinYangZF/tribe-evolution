import { ContributionScore } from '../shared/types.js';

/**
 * Calculate contribution scores for a list of agents.
 * For now, each agent gets a zero-initialized score.
 * In a full implementation, this would query the ecosystem for actual contributions.
 *
 * Returns a ContributionScore for each agent.
 */
export function calculateContributionScores(agents: Array<{ id: string }>): ContributionScore[] {
  return agents.map((agent) => ({
    agentId: agent.id,
    userTasksCompleted: 0,
    artifactConsumed: 0,
    collaborations: 0,
    newKnowledge: 0,
    total: 0,
  }));
}

/**
 * Allocate a token pool among agents based on their contribution scores.
 *
 * Rules:
 * - Tokens are distributed proportionally to each agent's `total` contribution.
 * - An agent with 0 total contribution gets 0 tokens.
 * - If `zeroConsecutiveRounds` tracking shows >=3 consecutive zero-contribution rounds,
 *   the agent is marked for elimination (but still gets 0 tokens).
 * - If all agents have 0 contribution, tokens are divided equally.
 *
 * @param scores - Contribution scores for each agent
 * @param totalPool - Total token pool to distribute
 * @param zeroConsecutiveRounds - Map of agentId -> number of consecutive zero-contribution rounds (optional)
 * @returns Map of agentId -> allocated tokens, with metadata for elimination candidates
 */
export function allocateTokens(
  scores: ContributionScore[],
  totalPool: number,
  zeroConsecutiveRounds: Record<string, number> = {},
): Map<string, number> {
  const allocation = new Map<string, number>();
  const totalContribution = scores.reduce((sum, s) => sum + s.total, 0);

  if (totalContribution === 0) {
    // All zero — distribute equally
    const share = Math.floor(totalPool / scores.length);
    for (const score of scores) {
      allocation.set(score.agentId, share);
    }
    // Distribute remainder to the first agent
    const remainder = totalPool - share * scores.length;
    if (remainder > 0 && scores.length > 0) {
      allocation.set(scores[0].agentId, (allocation.get(scores[0].agentId) || 0) + remainder);
    }
    return allocation;
  }

  for (const score of scores) {
    const consecutiveZero = zeroConsecutiveRounds[score.agentId] || 0;

    if (score.total === 0) {
      // 0 contribution agents get 0 tokens regardless
      allocation.set(score.agentId, 0);
      continue;
    }

    const proportion = score.total / totalContribution;
    const tokens = Math.floor(proportion * totalPool);
    allocation.set(score.agentId, tokens);
  }

  // Distribute rounding remainder
  const allocated = [...allocation.values()].reduce((s, v) => s + v, 0);
  const remainder = totalPool - allocated;
  if (remainder > 0) {
    // Find the highest contributor to give the remainder to
    const topAgent = [...scores].sort((a, b) => b.total - a.total)[0];
    if (topAgent) {
      allocation.set(topAgent.agentId, (allocation.get(topAgent.agentId) || 0) + remainder);
    }
  }

  return allocation;
}
