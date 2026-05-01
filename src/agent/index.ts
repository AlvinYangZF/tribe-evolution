/**
 * Agent subprocess.
 * Reads JSON-RPC requests from stdin, processes them, and writes JSON responses to stdout.
 *
 * Supported methods:
 *   - ping          -> { status: 'pong' }
 *   - get_genome    -> the agent's Genome object
 *   - token_refresh -> updates token balance, returns new balance
 *   - think_cycle   -> runs one LLM-powered decision cycle, returns the decision
 */

import { createRandomGenome } from './genome.js';
import { decide } from './brain.js';
import type { AgentDecision, AgentEnvironmentForBrain, AgentStateForBrain } from './brain.js';
import type { Genome } from '../shared/types.js';
import * as readline from 'node:readline';

// ─── Local LLM call ─────────────────────────────────────────────────────────

const DEEPSEEK_API_URL = 'https://api.deepseek.com/chat/completions';

/**
 * Call the DeepSeek API with a system prompt + user message.
 * This allows the agent subprocess to make independent LLM calls
 * without importing from the supervisor module.
 */
async function callLLMLocal(systemPrompt: string, userMessage: string): Promise<string> {
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
      model: 'deepseek-chat',
      messages: [
        { role: 'system', content: systemPrompt },
        { role: 'user', content: userMessage },
      ],
      max_tokens: 500,
    }),
  });

  if (!response.ok) {
    throw new Error(`LLM API error: ${response.status}`);
  }

  const data = await response.json() as {
    choices: Array<{ message: { content: string } }>;
  };

  return data.choices[0]?.message?.content ?? '';
}

// ─── JSON-RPC types ─────────────────────────────────────────────────────────

interface RPCRequest {
  id: string;
  method: string;
  params?: Record<string, unknown>;
}

interface RPCResponse {
  id: string;
  result?: unknown;
  error?: { code: number; message: string };
}

// ─── Agent Process ──────────────────────────────────────────────────────────

class AgentProcess {
  private genome: Genome;
  private tokenBalance: number = 0;

  constructor() {
    this.genome = createRandomGenome();
  }

  async handle(request: RPCRequest): Promise<RPCResponse> {
    switch (request.method) {
      case 'ping':
        return { id: request.id, result: { status: 'pong' } };

      case 'get_genome':
        return { id: request.id, result: this.genome };

      case 'token_refresh': {
        const tokens = (request.params?.tokens as number) || 0;
        this.tokenBalance += tokens;
        return { id: request.id, result: { newBalance: this.tokenBalance } };
      }

      case 'think_cycle': {
        return this.handleThinkCycle(request);
      }

      default:
        return {
          id: request.id,
          error: { code: -32601, message: `Method not found: ${request.method}` },
        };
    }
  }

  private async handleThinkCycle(request: RPCRequest): Promise<RPCResponse> {
    const params = request.params as Record<string, unknown> | undefined;
    const environment = params?.environment as AgentEnvironmentForBrain | undefined;
    const cycle = (params?.cycle as number) ?? 0;

    const state: AgentStateForBrain = {
      balance: this.tokenBalance,
      age: 0,
      reputation: 1,
      generation: 0,
    };

    const env: AgentEnvironmentForBrain = {
      aliveCount: environment?.aliveCount ?? 0,
      availableResources: environment?.availableResources ?? 0,
      pendingMessages: environment?.pendingMessages ?? 0,
    };

    try {
      const decision = await decide(this.genome, state, env, callLLMLocal);
      return {
        id: request.id,
        result: {
          cycle,
          decision,
        },
      };
    } catch (err) {
      // Catastrophic fallback — decide() should handle LLM errors internally,
      // but if decide() itself throws unexpectedly, return a safe idle response
      return {
        id: request.id,
        result: {
          cycle,
          decision: {
            action: 'idle',
            params: {},
            reasoning: `Brain error: ${(err as Error).message}`,
          },
        },
      };
    }
  }
}

// ─── Main loop ──────────────────────────────────────────────────────────────

const agent = new AgentProcess();
const rl = readline.createInterface({
  input: process.stdin,
  output: process.stdout,
  terminal: false,
});

rl.on('line', async (line: string) => {
  try {
    const request: RPCRequest = JSON.parse(line);
    const response = await agent.handle(request);
    process.stdout.write(JSON.stringify(response) + '\n');
  } catch (err: unknown) {
    const errorResponse: RPCResponse = {
      id: '',
      error: { code: -32700, message: `Parse error: ${(err as Error).message}` },
    };
    process.stdout.write(JSON.stringify(errorResponse) + '\n');
  }
});

// Handle EPIPE gracefully
process.stdout.on('error', () => {
  process.exit(0);
});
