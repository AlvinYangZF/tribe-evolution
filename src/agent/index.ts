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
import { proxyCall } from '../shared/llm.js';
import { ProposalManager } from '../supervisor/proposal.js';
import * as readline from 'node:readline';

// ─── Local LLM call ─────────────────────────────────────────────────────────

/**
 * Call the DeepSeek API via the shared LLM client. The agent subprocess uses
 * the same proxyCall as the in-process supervisor path so retry, timeout, and
 * tokenUsage accounting stay in sync. This subprocess only consumes the
 * `content` field; tokenUsage is reported but not acted on (the subprocess
 * has no view of the agent's on-disk balance).
 */
async function callLLMLocal(systemPrompt: string, userMessage: string, agentId: string): Promise<string> {
  const resp = await proxyCall({
    requestId: `${agentId}-${Date.now()}`,
    agentId,
    model: 'deepseek-chat',
    messages: [
      { role: 'system', content: systemPrompt },
      { role: 'user', content: userMessage },
    ],
    maxTokens: 500,
  });
  return resp.content;
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
  private proposalManager: ProposalManager | null = null;

  constructor() {
    this.genome = createRandomGenome();
    const ecosystemDir = process.env.ECOSYSTEM_DIR;
    if (ecosystemDir) {
      this.proposalManager = new ProposalManager(ecosystemDir);
    }
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

      case 'create_proposal': {
        return this.handleCreateProposal(request);
      }

      case 'list_proposals': {
        return this.handleListProposals(request);
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
      const agentLabel = `subprocess-${this.genome.personaName}`;
      const callLLM = (sys: string, user: string) => callLLMLocal(sys, user, agentLabel);
      const decision = await decide(this.genome, state, env, callLLM);
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

  private async handleCreateProposal(request: RPCRequest): Promise<RPCResponse> {
    if (!this.proposalManager) {
      return {
        id: request.id,
        error: { code: -32603, message: 'ECOSYSTEM_DIR not configured, proposals disabled' },
      };
    }

    const params = request.params as Record<string, unknown> | undefined;
    if (!params) {
      return {
        id: request.id,
        error: { code: -32602, message: 'Missing params' },
      };
    }

    const type = params.type as string;
    const title = params.title as string;
    const description = params.description as string;
    const expectedBenefit = params.expectedBenefit as string;
    const tokenCost = params.tokenCost as number;
    const tokenReward = params.tokenReward as number;

    // Validate required fields
    if (!type || !title || !description || !expectedBenefit || tokenCost == null || tokenReward == null) {
      return {
        id: request.id,
        error: { code: -32602, message: 'Missing required params: type, title, description, expectedBenefit, tokenCost, tokenReward' },
      };
    }

    // Validate type
    const validTypes = ['new_skill', 'task_suggestion', 'policy_change', 'resource_request'];
    if (!validTypes.includes(type)) {
      return {
        id: request.id,
        error: { code: -32602, message: `Invalid proposal type: ${type}` },
      };
    }

    // Check token balance
    if (this.tokenBalance < (tokenCost as number)) {
      return {
        id: request.id,
        error: { code: -32000, message: `Insufficient tokens: have ${this.tokenBalance}, need ${tokenCost}` },
      };
    }

    try {
      const proposal = await this.proposalManager.createProposal('agent', {
        type: type as any,
        title: title as string,
        description: description as string,
        expectedBenefit: expectedBenefit as string,
        tokenCost: tokenCost as number,
        tokenReward: tokenReward as number,
      });

      // Deduct token cost (proposal deposit)
      this.tokenBalance -= tokenCost as number;

      return {
        id: request.id,
        result: { proposalId: proposal.id },
      };
    } catch (err) {
      return {
        id: request.id,
        error: { code: -32603, message: `Failed to create proposal: ${(err as Error).message}` },
      };
    }
  }

  private async handleListProposals(request: RPCRequest): Promise<RPCResponse> {
    if (!this.proposalManager) {
      return {
        id: request.id,
        error: { code: -32603, message: 'ECOSYSTEM_DIR not configured, proposals disabled' },
      };
    }

    try {
      const proposals = await this.proposalManager.getAgentProposals('agent');
      return {
        id: request.id,
        result: { proposals },
      };
    } catch (err) {
      return {
        id: request.id,
        error: { code: -32603, message: `Failed to list proposals: ${(err as Error).message}` },
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
