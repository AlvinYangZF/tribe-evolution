import type { LLMRequest, LLMResponse } from '../shared/types.js';

const DEEPSEEK_API_URL = 'https://api.deepseek.com/chat/completions';
const DEFAULT_TOKEN_PER_AGENT = 1_000_000;

/** In-memory token balances keyed by agentId */
const tokenBalances = new Map<string, number>();

/**
 * Proxy a call to the DeepSeek API.
 * Automatically deducts tokens from the agent's balance based on response usage.
 */
export async function proxyCall(request: LLMRequest): Promise<LLMResponse> {
  const apiKey = process.env.DEEPSEEK_API_KEY;
  if (!apiKey) {
    throw new Error('DEEPSEEK_API_KEY not configured');
  }

  const response = await fetch(DEEPSEEK_API_URL, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      Authorization: `Bearer ${apiKey}`,
    },
    body: JSON.stringify({
      model: request.model,
      messages: request.messages,
      max_tokens: request.maxTokens,
    }),
  });

  if (!response.ok) {
    throw new Error(`DeepSeek API returned ${response.status}: ${response.statusText}`);
  }

  const data = await response.json() as {
    id: string;
    choices: Array<{ message: { content: string } }>;
    usage: { prompt_tokens: number; completion_tokens: number; total_tokens: number };
  };

  const tokenUsage = {
    input: data.usage.prompt_tokens,
    output: data.usage.completion_tokens,
    total: data.usage.total_tokens,
  };

  // Deduct tokens from agent balance
  deductTokens(request.agentId, tokenUsage.total);

  return {
    requestId: request.requestId,
    content: data.choices[0]?.message?.content ?? '',
    tokenUsage,
    cost: tokenUsage.total * 0.000001, // rough cost estimate
  };
}

/**
 * Deduct tokens from an agent's balance.
 * Returns true if successful, false if insufficient tokens.
 */
export function deductTokens(agentId: string, amount: number): boolean {
  const current = tokenBalances.get(agentId) ?? DEFAULT_TOKEN_PER_AGENT;
  if (current < amount) {
    return false;
  }
  tokenBalances.set(agentId, current - amount);
  return true;
}

/**
 * Get the current token balance for an agent.
 * New/unseen agents default to DEFAULT_TOKEN_PER_AGENT.
 */
export function getTokenBalance(agentId: string): number {
  return tokenBalances.get(agentId) ?? DEFAULT_TOKEN_PER_AGENT;
}
