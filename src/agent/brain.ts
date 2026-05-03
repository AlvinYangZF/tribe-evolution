/**
 * Agent Brain — LLM-powered decision engine.
 *
 * Each agent uses this module to decide what action to take in each cycle.
 * The brain compiles the agent's genome + state + environment into a prompt
 * for an LLM, then parses the LLM's JSON decision.
 */

import { z } from 'zod/v4';
import type { Genome, SkillName } from '../shared/types.js';

// ─── Types ──────────────────────────────────────────────────────────────────

export type DecisionAction =
  | 'web_search'
  | 'write_artifact'
  | 'observe'
  | 'propose'
  | 'lock_resource'
  | 'trade'
  | 'bid_bounty' | 'develop_skill' | 'update_memory' | 'idle';

export const ALL_DECISION_ACTIONS: DecisionAction[] = [
  'web_search',
  'write_artifact',
  'observe',
  'propose',
  'lock_resource',
  'trade',
  'bid_bounty',
  'develop_skill',
  'update_memory',
  'idle',
];

/**
 * Why a decision was synthesized as an idle fallback. Absent when the LLM
 * legitimately chose an action (including idle on its own). The supervisor
 * uses this to decide whether to surface a `decision_invalid` event so
 * malformed LLM output is visible in the audit trail instead of silently
 * collapsing to idle.
 */
export type DecisionFallbackReason =
  | 'empty_response'
  | 'json_parse'
  | 'schema_mismatch'
  | 'missing_propose_fields'
  | 'llm_error';

export interface AgentDecision {
  action: DecisionAction;
  params: Record<string, unknown>;
  reasoning: string;
  fallbackReason?: DecisionFallbackReason;
  /** Truncated raw LLM output. Only set on parse/schema fallbacks. */
  rawResponse?: string;
}

/** Subset of AgentState needed by the brain prompt */
export interface AgentStateForBrain {
  balance: number;
  age: number;
  reputation: number;
  generation: number;
  gender?: string;
  /** Long-term notes the agent has written to its workspace. Injected into
   *  the prompt as a "Your Notes" section. Empty string means no notes. */
  memory?: string;
}

/** Environment snapshot injected by the supervisor */
export interface AgentEnvironmentForBrain {
  aliveCount: number;
  availableResources: number;
  pendingMessages: number;
  openBounties?: number;
  topBountyReward?: number;
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
  bid_bounty: '竞标悬赏任务赚取奖励',
  develop_skill: '花费Token主动研发一种新技能（调研/实现/工具），立即加入技能库',
  observe: '查看其他 agent 的 artifact，学习他们的行为',
  propose: '向人类用户提建议',
  lock_resource: '抢占一个资源',
  trade: '出价购买资源释放权',
  update_memory: '用 params.content 重写你的私人备忘录（最多 4000 字节，跨周期保留，子代会继承）',
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

  // Gender section
  const genderInfo = state.gender
    ? `## Gender
You are a ${state.gender} agent. Sexual reproduction requires a partner of the opposite gender.`
    : '';

  // Core mission: survive and reproduce
  const coreMission = `

## Core Mission
1. SURVIVE as long as possible (age >= 50 = death)
2. Find a mate and REPRODUCE to pass on your genes`;

  // Long-term notes the agent has written for itself (or inherited from a
  // parent). Truncated to keep the prompt bounded — the on-disk file allows
  // up to MEMORY_LIMIT_BYTES, but we only show ~1500 chars to the LLM.
  const memorySection = state.memory && state.memory.trim().length > 0
    ? `\n\n## Your Notes (persistent across cycles)\n${state.memory.length > 1500 ? state.memory.slice(0, 1500) + '\n…' : state.memory}`
    : '';

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

  return `You are ${genome.personaName},
${environment.openBounties && environment.openBounties > 0 ? "\n** BOUNTIES AVAILABLE **\n" + environment.openBounties + " open bounties! Top reward: " + (environment.topBountyReward || "?") + " tokens. Use bid_bounty to compete!\n" : ""} an autonomous AI agent in an evolutionary ecosystem.

${genderInfo}${coreMission}

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
- Generation: ${state.generation}${memorySection}
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

const RAW_RESPONSE_LIMIT = 200;

function truncate(s: string, n = RAW_RESPONSE_LIMIT): string {
  return s.length <= n ? s : s.slice(0, n) + '…';
}

const DecisionSchema = z.object({
  action: z.enum(ALL_DECISION_ACTIONS as [DecisionAction, ...DecisionAction[]]),
  params: z.looseObject({}),
  reasoning: z.string().optional(),
});

/**
 * Parse the LLM's JSON response into a structured AgentDecision.
 * Falls back to idle on any parse failure or invalid action type, tagging
 * the result with `fallbackReason` so the caller can audit it.
 */
export function parseDecision(llmResponse: string): AgentDecision {
  if (!llmResponse || llmResponse.trim().length === 0) {
    return { ...IDLE_DECISION, fallbackReason: 'empty_response' };
  }

  let raw: unknown;
  try {
    raw = JSON.parse(llmResponse.trim());
  } catch {
    return { ...IDLE_DECISION, fallbackReason: 'json_parse', rawResponse: truncate(llmResponse) };
  }

  const parsed = DecisionSchema.safeParse(raw);
  if (!parsed.success) {
    return {
      ...IDLE_DECISION,
      reasoning: `LLM response did not match schema: ${parsed.error.message.slice(0, 80)}`,
      fallbackReason: 'schema_mismatch',
      rawResponse: truncate(llmResponse),
    };
  }

  const { action, params, reasoning } = parsed.data;

  // For 'propose' action, require at least title or description
  if (action === 'propose') {
    const hasTitle = typeof params.title === 'string' && params.title.trim().length > 0;
    const hasDescription = typeof params.description === 'string' && params.description.trim().length > 0;
    if (!hasTitle && !hasDescription) {
      return {
        ...IDLE_DECISION,
        reasoning: 'LLM propose action missing title or description',
        fallbackReason: 'missing_propose_fields',
        rawResponse: truncate(llmResponse),
      };
    }
  }

  return {
    action,
    params: params as Record<string, unknown>,
    reasoning: reasoning ?? '',
  };
}

// ─── Three-phase decision pipeline ──────────────────────────────────────────

/** Phase 1 output: what the agent observes about its situation. */
export interface ExploreOutput {
  observations: string[];
  focus_area: string;
}

/** Phase 2 output: weighed alternatives + a leading pick. */
export interface EvaluateOutput {
  candidates: Array<{ action: DecisionAction; why: string; expected_value: number }>;
  top_choice: DecisionAction | null;
}

const ExploreSchema = z.object({
  observations: z.array(z.string()).max(10),
  focus_area: z.string(),
});

const EvaluateSchema = z.object({
  candidates: z.array(z.object({
    action: z.enum(ALL_DECISION_ACTIONS as [DecisionAction, ...DecisionAction[]]),
    why: z.string(),
    expected_value: z.number(),
  })).max(8),
  top_choice: z.enum(ALL_DECISION_ACTIONS as [DecisionAction, ...DecisionAction[]]).nullable(),
});

function safeJsonParse(s: string): unknown | null {
  try { return JSON.parse(s.trim()); } catch { return null; }
}

/** Parse an explore-phase response. Returns null on any failure — the
 *  pipeline degrades gracefully to an empty observation set. */
export function parseExplore(raw: string): ExploreOutput | null {
  if (!raw || raw.trim().length === 0) return null;
  const obj = safeJsonParse(raw);
  if (obj === null) return null;
  const parsed = ExploreSchema.safeParse(obj);
  return parsed.success ? parsed.data : null;
}

/** Parse an evaluate-phase response. Returns null on any failure. */
export function parseEvaluate(raw: string): EvaluateOutput | null {
  if (!raw || raw.trim().length === 0) return null;
  const obj = safeJsonParse(raw);
  if (obj === null) return null;
  const parsed = EvaluateSchema.safeParse(obj);
  return parsed.success ? parsed.data : null;
}

const EXPLORE_PROMPT = `OBSERVE phase. Look at your state, memory, the ecosystem, and any open bounties. List up to 5 short observations and pick the most important focus_area for this cycle.

Output JSON ONLY:
{"observations": ["...", "..."], "focus_area": "..."}`;

function evaluatePromptFor(explore: ExploreOutput | null): string {
  const obsBlock = explore && explore.observations.length > 0
    ? `Observations from your explore phase:\n${explore.observations.map(o => `- ${o}`).join('\n')}\nFocus area: ${explore.focus_area}\n\n`
    : 'No observations carried over from explore.\n\n';
  return `${obsBlock}EVALUATE phase. Consider up to 5 candidate actions you could take this cycle. For each, give a one-sentence reason and a numeric expected_value (rough utility, can be negative). Then choose the single top_choice.

Output JSON ONLY:
{"candidates": [{"action": "...", "why": "...", "expected_value": 0}], "top_choice": "..."}`;
}

function executePromptFor(explore: ExploreOutput | null, evaluate: EvaluateOutput | null): string {
  const evalBlock = evaluate && evaluate.candidates.length > 0
    ? `Your evaluation:\n${evaluate.candidates.map(c => `- ${c.action} (EV=${c.expected_value}): ${c.why}`).join('\n')}\nLeading choice: ${evaluate.top_choice ?? '(unset)'}\n\n`
    : '';
  const focusLine = explore?.focus_area ? `Your focus area: ${explore.focus_area}\n\n` : '';
  return `${focusLine}${evalBlock}EXECUTE phase. Commit to exactly ONE action and produce its concrete params. You may override the leading choice if you reconsider.

Output JSON ONLY:
{"action": "...", "params": {...}, "reasoning": "..."}`;
}

// ─── Orchestrator ───────────────────────────────────────────────────────────

/** Token caps per phase. wanman's 30/10/60 split applied to a 1000-token
 *  total budget. The supervisor passes these through to proxyCall. */
const PHASE_BUDGETS = { explore: 300, evaluate: 100, execute: 600 } as const;

export type CallLLM = (
  systemPrompt: string,
  userMessage: string,
  opts?: { maxTokens?: number; phase?: 'explore' | 'evaluate' | 'execute' },
) => Promise<string>;

/**
 * The main decision loop for an agent. Runs as three sequential LLM calls:
 *   explore  → gather observations
 *   evaluate → weigh up to 5 actions
 *   execute  → commit to one action (same shape as legacy decide())
 *
 * Failures in explore or evaluate degrade gracefully — the pipeline
 * continues with empty/null phase output. Only execute-phase failures
 * (or thrown LLM errors) collapse the whole decision to idle. The public
 * AgentDecision shape is preserved.
 */
export async function decide(
  genome: Genome,
  state: AgentStateForBrain,
  environment: AgentEnvironmentForBrain,
  callLLM: CallLLM,
): Promise<AgentDecision> {
  const systemPrompt = compileAgentPrompt(genome, state, environment);

  // Phase 1: explore
  let explore: ExploreOutput | null = null;
  try {
    const raw = await callLLM(systemPrompt, EXPLORE_PROMPT, { maxTokens: PHASE_BUDGETS.explore, phase: 'explore' });
    explore = parseExplore(raw);
  } catch (err) {
    return {
      action: 'idle',
      params: {},
      reasoning: `LLM call failed: ${err instanceof Error ? err.message : String(err)}`,
      fallbackReason: 'llm_error',
    };
  }

  // Phase 2: evaluate
  let evaluate: EvaluateOutput | null = null;
  try {
    const raw = await callLLM(systemPrompt, evaluatePromptFor(explore), { maxTokens: PHASE_BUDGETS.evaluate, phase: 'evaluate' });
    evaluate = parseEvaluate(raw);
  } catch (err) {
    return {
      action: 'idle',
      params: {},
      reasoning: `LLM call failed: ${err instanceof Error ? err.message : String(err)}`,
      fallbackReason: 'llm_error',
    };
  }

  // Phase 3: execute — collapses to idle on any failure (preserved by parseDecision)
  try {
    const raw = await callLLM(systemPrompt, executePromptFor(explore, evaluate), { maxTokens: PHASE_BUDGETS.execute, phase: 'execute' });
    return parseDecision(raw);
  } catch (err) {
    return {
      action: 'idle',
      params: {},
      reasoning: `LLM call failed: ${err instanceof Error ? err.message : String(err)}`,
      fallbackReason: 'llm_error',
    };
  }
}
