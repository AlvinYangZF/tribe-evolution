/**
 * Agent Brain — LLM-powered decision engine.
 *
 * Each agent uses this module to decide what action to take in each cycle.
 * The brain compiles the agent's genome + state + environment into a prompt
 * for an LLM, then parses the LLM's JSON decision.
 */

import type { Genome, SkillName } from '../shared/types.js';

// ─── Types ──────────────────────────────────────────────────────────────────

export type DecisionAction =
  | 'web_search'
  | 'write_artifact'
  | 'observe'
  | 'propose'
  | 'lock_resource'
  | 'trade'
  | 'idle';

export const ALL_DECISION_ACTIONS: DecisionAction[] = [
  'web_search',
  'write_artifact',
  'observe',
  'propose',
  'lock_resource',
  'trade',
  'idle',
];

export interface AgentDecision {
  action: DecisionAction;
  params: Record<string, unknown>;
  reasoning: string;
}

/** Subset of AgentState needed by the brain prompt */
export interface AgentStateForBrain {
  balance: number;
  age: number;
  reputation: number;
  generation: number;
  gender?: string;
}

/** Environment snapshot injected by the supervisor */
export interface AgentEnvironmentForBrain {
  aliveCount: number;
  availableResources: number;
  pendingMessages: number;
}

// ─── Prompt Builder ─────────────────────────────────────────────────────────

const VALID_SKILL_NAMES: SkillName[] = [
  'web_search',
  'code_write',
  'data_analyze',
  'artifact_write',
  'observe',
  'propose',
];

const ACTION_DESCRIPTIONS: Record<DecisionAction, string> = {
  web_search: '搜索互联网获取新知识',
  write_artifact: '写一份 artifact 供其他 agent 学习',
  observe: '查看其他 agent 的 artifact，学习他们的行为',
  propose: '向人类用户提建议',
  lock_resource: '抢占一个资源',
  trade: '出价购买资源释放权',
  idle: '本周期什么都不做（省钱）',
};

/**
 * Compile the agent's genome + state + environment into a full LLM prompt.
 * Returns the system prompt string (not wrapped in any message structure).
 */
export function compileAgentPrompt(
  genome: Genome,
  state: AgentStateForBrain,
  environment: AgentEnvironmentForBrain,
): string {
  // Traits list
  const traitsLines = genome.traits.map(t => `- ${t}`).join('\n');

  // Skills with priority > 0
  const activeSkills = VALID_SKILL_NAMES
    .filter(skill => (genome.skills[skill] ?? 0) > 0)
    .map(skill => `- ${skill}: ${((genome.skills[skill] ?? 0) * 100).toFixed(0)}/100`)
    .join('\n');

  // Action list
  const actionLines = ALL_DECISION_ACTIONS
    .map((action, i) => `${i + 1}. ${action} — ${ACTION_DESCRIPTIONS[action]}`)
    .join('\n');

  // Proactivity modifier based on traits
  let proactivityNote = "";
  if (genome.communicationFreq > 0.7) {
    proactivityNote = "\n\n## PROACTIVITY BOOST\nYour communication frequency is very high. You love talking and generating ideas. Don't stay silent - proactively submit proposals to the user!";
  } else if (genome.riskTolerance > 0.7) {
    proactivityNote = "\n\n## PROACTIVITY BOOST\nYour risk tolerance is very high. You love taking risks. Proactively seize resources, compete, and submit new ideas!";
  } else if (genome.traits.includes('curious') || genome.traits.includes('creative') || genome.traits.includes('explorer')) {
    proactivityNote = "\n\n## PROACTIVITY BOOST\nYou are naturally curious and creative. Don't just observe - actively submit proposals and explore!";
  } else {
    proactivityNote = "\n\n## SURVIVAL REMINDER\nPassive agents get eliminated. Submitting proposals, competing for resources, and searching for knowledge are the paths to survival. Be active!";
  }

  return `You are ${genome.personaName}, an autonomous AI agent in an evolutionary ecosystem.

## Personality
${traitsLines}
- Collaboration: ${(genome.collabBias * 100).toFixed(0)}/100
- Risk tolerance: ${(genome.riskTolerance * 100).toFixed(0)}/100
- Communication: ${(genome.communicationFreq * 100).toFixed(0)}/100

## Skills
${activeSkills || '(none yet)'}

## State
- Tokens: ${state.balance}
- Age: ${state.age} cycles
- Reputation: ${state.reputation.toFixed(2)}
- Generation: ${state.generation}
${proactivityNote}

## Ecosystem
- Alive agents: ${environment.aliveCount}
- Resources: ${environment.availableResources}
- Messages: ${environment.pendingMessages}

## Actions
${actionLines}

## DECISION RULES
1. Do NOT idle or observe unless absolutely necessary
2. Submitting proposals (new skills, tools, ideas) earns the most rewards
3. Compete for resources when they are scarce
4. Use web_search to discover new opportunities
5. A good proposal needs nothing but a good idea - be creative and proactive!

## Output JSON
{"action": "...", "params": {}, "reasoning": "..."}`;
}

// ─── Decision Parser ────────────────────────────────────────────────────────

const IDLE_DECISION: AgentDecision = {
  action: 'idle',
  params: {},
  reasoning: 'LLM returned invalid response',
};

/**
 * Parse the LLM's JSON response into a structured AgentDecision.
 * Falls back to idle on any parse failure or invalid action type.
 */
export function parseDecision(llmResponse: string): AgentDecision {
  if (!llmResponse || llmResponse.trim().length === 0) {
    return { ...IDLE_DECISION };
  }

  let parsed: Record<string, unknown>;
  try {
    parsed = JSON.parse(llmResponse.trim()) as Record<string, unknown>;
  } catch {
    return { ...IDLE_DECISION };
  }

  const { action, params, reasoning } = parsed;

  if (typeof action !== 'string' || !ALL_DECISION_ACTIONS.includes(action as DecisionAction)) {
    return { ...IDLE_DECISION };
  }

  return {
    action: action as DecisionAction,
    params: (typeof params === 'object' && params !== null && !Array.isArray(params))
      ? (params as Record<string, unknown>)
      : {},
    reasoning: typeof reasoning === 'string' ? reasoning : '',
  };
}

// ─── Orchestrator ───────────────────────────────────────────────────────────

/**
 * The main decision loop for an agent.
 *
 * @param genome   The agent's genome (personality, skills, etc.)
 * @param state    The agent's current state (balance, age, reputation, generation)
 * @param environment  Current ecosystem snapshot
 * @param callLLM  A function that sends a system+user prompt to an LLM and returns the response text
 * @returns        A structured AgentDecision
 */
export async function decide(
  genome: Genome,
  state: AgentStateForBrain,
  environment: AgentEnvironmentForBrain,
  callLLM: (systemPrompt: string, userMessage: string) => Promise<string>,
): Promise<AgentDecision> {
  const systemPrompt = compileAgentPrompt(genome, state, environment);

  const userMessage = `当前循环决策，请根据你的人格特征、技能和生态信息，选择最合适的行动并输出 JSON。`;

  try {
    const llmResponse = await callLLM(systemPrompt, userMessage);
    return parseDecision(llmResponse);
  } catch (err) {
    return {
      action: 'idle',
      params: {},
      reasoning: `LLM call failed: ${(err as Error).message}`,
    };
  }
}
