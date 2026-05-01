/**
 * Agent subprocess.
 * Reads JSON-RPC requests from stdin, processes them, and writes JSON responses to stdout.
 *
 * Supported methods:
 *   - ping          -> { status: 'pong' }
 *   - get_genome    -> the agent's Genome object
 *   - token_refresh -> updates token balance, returns new balance
 */

import { createRandomGenome } from './genome.js';
import type { Genome } from '../shared/types.js';
import * as readline from 'node:readline';

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

class AgentProcess {
  private genome: Genome;
  private tokenBalance: number = 0;

  constructor() {
    this.genome = createRandomGenome();
  }

  handle(request: RPCRequest): RPCResponse {
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

      default:
        return {
          id: request.id,
          error: { code: -32601, message: `Method not found: ${request.method}` },
        };
    }
  }
}

// Start the agent process
const agent = new AgentProcess();
const rl = readline.createInterface({
  input: process.stdin,
  output: process.stdout,
  terminal: false,
});

rl.on('line', (line: string) => {
  try {
    const request: RPCRequest = JSON.parse(line);
    const response = agent.handle(request);
    // Write response back on stdout as JSON line
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
