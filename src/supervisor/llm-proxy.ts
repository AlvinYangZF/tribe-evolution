import type { LLMRequest, LLMResponse } from '../shared/types.js';

const DEEPSEEK_API_URL = 'https://api.deepseek.com/chat/completions';
const LLM_TIMEOUT_MS = 30_000;

/**
 * Proxy a call to the DeepSeek API.
 * Returns only usage/cost data; token deduction is handled by the Supervisor
 * based on the agent's actual tokenBalance field.
 */
export async function proxyCall(request: LLMRequest): Promise<LLMResponse> {
  const apiKey = process.env.DEEPSEEK_API_KEY;
  if (!apiKey) {
    throw new Error('DEEPSEEK_API_KEY not configured');
  }

  let response: Response;
  try {
    response = await fetch(DEEPSEEK_API_URL, {
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
      signal: AbortSignal.timeout(LLM_TIMEOUT_MS),
    });
  } catch (err: unknown) {
    if (err instanceof DOMException && err.name === 'TimeoutError') {
      throw new Error(`LLM call timed out after ${LLM_TIMEOUT_MS / 1000}s`);
    }
    throw err;
  }

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

  // Token deduction is handled by the Supervisor (agent.tokenBalance)
  // so that the on-disk agent state stays in sync.

  return {
    requestId: request.requestId,
    content: data.choices[0]?.message?.content ?? '',
    tokenUsage,
    cost: tokenUsage.total * 0.000001, // rough cost estimate
  };
}
