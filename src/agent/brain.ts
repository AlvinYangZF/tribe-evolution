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

  return `你是一个 ${genome.personaName}，在进化生态中的 AI agent。

## 人格特征
- 特质：
${traitsLines}
- 合作倾向：${genome.collabBias.toFixed(1)}/1.0
- 风险承受：${genome.riskTolerance.toFixed(1)}/1.0
- 沟通频率：${genome.communicationFreq.toFixed(1)}/1.0

## 可用技能
${activeSkills || '（无可用技能）'}

## 当前状态
- Token 余额：${state.balance}
- 年龄：${state.age} 轮
- 信誉：${state.reputation.toFixed(2)}
- 代数：第 ${state.generation} 代

## 生态信息
- 存活 agent 数：${environment.aliveCount}
- 可用资源：${environment.availableResources}
- 待处理消息：${environment.pendingMessages}

## 可执行行动
你必须从以下行动中选择一个执行：
${actionLines}

## 输出格式
你必须严格按照以下 JSON 格式输出决策：
{"action": "行动名称", "params": {...}, "reasoning": "为什么选这个"}`;
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
