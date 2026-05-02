/**
 * Shared LLM client. Used by both the in-process supervisor decision loop
 * and the JSON-RPC agent subprocess so the two deployment shells don't
 * drift on retry, timeout, or token-usage handling.
 *
 * Token deduction is handled by the caller (Supervisor reads tokenUsage.total
 * and subtracts from the agent's on-disk tokenBalance). This module never
 * mutates agent state directly.
 */

import type { LLMRequest, LLMResponse } from './types.js';

const DEEPSEEK_API_URL = 'https://api.deepseek.com/chat/completions';
const LLM_TIMEOUT_MS = 30_000;

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

  return {
    requestId: request.requestId,
    content: data.choices[0]?.message?.content ?? '',
    tokenUsage,
    cost: tokenUsage.total * 0.000001, // rough cost estimate
  };
}
