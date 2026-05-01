import { describe, it, expect } from 'vitest';
import { spawn } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import * as path from 'node:path';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const agentEntry = path.resolve(__dirname, '../../src/agent/index.ts');

function rpcCall(child: import('child_process').ChildProcess, id: string, method: string, params: Record<string, unknown> = {}): Promise<unknown> {
  return new Promise((resolve, reject) => {
    const payload = JSON.stringify({ id, method, params }) + '\n';
    const timeout = setTimeout(() => reject(new Error('RPC timeout')), 10000);

    let buffer = '';
    const onData = (chunk: Buffer) => {
      buffer += chunk.toString();
      try {
        const result = JSON.parse(buffer);
        clearTimeout(timeout);
        child.stdout?.removeListener('data', onData);
        resolve(result);
      } catch {
        // incomplete JSON, wait for more
      }
    };

    child.stdout?.on('data', onData);
    child.stdin?.write(payload);
  });
}

describe('agent subprocess (JSON-RPC)', () => {
  it('should respond to ping', async () => {
    const child = spawn('npx', ['tsx', agentEntry], {
      stdio: ['pipe', 'pipe', 'inherit'],
      cwd: path.resolve(__dirname, '../..'),
    });

    try {
      const response = await rpcCall(child, 'r1', 'ping') as { id: string; result: { status: string } };
      expect(response).toBeDefined();
      expect(response.result).toBeDefined();
      expect(response.result.status).toBe('pong');
    } finally {
      child.kill();
    }
  });

  it('should respond to get_genome', async () => {
    const child = spawn('npx', ['tsx', agentEntry], {
      stdio: ['pipe', 'pipe', 'inherit'],
      cwd: path.resolve(__dirname, '../..'),
    });

    try {
      const response = await rpcCall(child, 'r2', 'get_genome') as { id: string; result: { personaName: string; traits: string[] } };
      expect(response).toBeDefined();
      expect(response.result).toBeDefined();
      expect(response.result.personaName).toBeDefined();
      expect(typeof response.result.personaName).toBe('string');
      expect(Array.isArray(response.result.traits)).toBe(true);
    } finally {
      child.kill();
    }
  });

  it('should respond to token_refresh', async () => {
    const child = spawn('npx', ['tsx', agentEntry], {
      stdio: ['pipe', 'pipe', 'inherit'],
      cwd: path.resolve(__dirname, '../..'),
    });

    try {
      const response = await rpcCall(child, 'r3', 'token_refresh', { tokens: 500 }) as { id: string; result: { newBalance: number } };
      expect(response).toBeDefined();
      expect(response.result).toBeDefined();
      expect(typeof response.result.newBalance).toBe('number');
    } finally {
      child.kill();
    }
  });

  it('should maintain state across RPC calls', async () => {
    const child = spawn('npx', ['tsx', agentEntry], {
      stdio: ['pipe', 'pipe', 'inherit'],
      cwd: path.resolve(__dirname, '../..'),
    });

    try {
      // refresh tokens
      await rpcCall(child, 'r4a', 'token_refresh', { tokens: 300 });
      const fresh = await rpcCall(child, 'r4b', 'get_genome') as { result: { personaName: string } };
      expect(fresh.result.personaName).toBeDefined();
    } finally {
      child.kill();
    }
  });
});

describe('agent think_cycle', () => {
  it('should return a valid decision structure when LLM is unavailable', async () => {
    // Without DEEPSEEK_API_KEY set, the agent should fallback gracefully
    const child = spawn('npx', ['tsx', agentEntry], {
      stdio: ['pipe', 'pipe', 'inherit'],
      cwd: path.resolve(__dirname, '../..'),
      env: { ...process.env, DEEPSEEK_API_KEY: '' },
    });

    try {
      const response = await rpcCall(child, 't1', 'think_cycle', {
        cycle: 1,
        environment: {
          aliveCount: 10,
          availableResources: 5,
          pendingMessages: 2,
        },
      }) as {
        id: string;
        result: {
          cycle: number;
          decision: { action: string; params: Record<string, unknown>; reasoning: string };
        };
      };

      expect(response).toBeDefined();
      expect(response.result).toBeDefined();
      expect(response.result.cycle).toBe(1);
      expect(response.result.decision).toBeDefined();
      expect(typeof response.result.decision.action).toBe('string');
      expect(typeof response.result.decision.reasoning).toBe('string');
      // Should be a valid action type (likely 'idle' when no API key)
      expect(['web_search', 'write_artifact', 'observe', 'propose', 'lock_resource', 'trade', 'idle'])
        .toContain(response.result.decision.action);
    } finally {
      child.kill();
    }
  });

  it('should not crash when environment params are missing', async () => {
    const child = spawn('npx', ['tsx', agentEntry], {
      stdio: ['pipe', 'pipe', 'inherit'],
      cwd: path.resolve(__dirname, '../..'),
      env: { ...process.env, DEEPSEEK_API_KEY: '' },
    });

    try {
      const response = await rpcCall(child, 't2', 'think_cycle', {}) as {
        id: string;
        result: { decision: { action: string } };
      };

      expect(response).toBeDefined();
      expect(response.result).toBeDefined();
      expect(response.result.decision).toBeDefined();
      // Should not crash with missing params — action should be valid
      expect(typeof response.result.decision.action).toBe('string');
    } finally {
      child.kill();
    }
  });

  it('should not crash when no params at all', async () => {
    const child = spawn('npx', ['tsx', agentEntry], {
      stdio: ['pipe', 'pipe', 'inherit'],
      cwd: path.resolve(__dirname, '../..'),
      env: { ...process.env, DEEPSEEK_API_KEY: '' },
    });

    try {
      // Send a think_cycle with undefined params (just method, no params field)
      const response = await rpcCall(child, 't3', 'think_cycle') as {
        id: string;
        result: { decision: { action: string } };
      };

      expect(response).toBeDefined();
      expect(response.result).toBeDefined();
      expect(response.result.decision).toBeDefined();
      expect(typeof response.result.decision.action).toBe('string');
    } finally {
      child.kill();
    }
  });

  it('should still handle ping after think_cycle (agent stays alive)', async () => {
    const child = spawn('npx', ['tsx', agentEntry], {
      stdio: ['pipe', 'pipe', 'inherit'],
      cwd: path.resolve(__dirname, '../..'),
      env: { ...process.env, DEEPSEEK_API_KEY: '' },
    });

    try {
      // First run think_cycle
      await rpcCall(child, 't4a', 'think_cycle', {
        cycle: 1,
        environment: { aliveCount: 5, availableResources: 2, pendingMessages: 0 },
      });

      // Then ping — agent should still respond
      const pingResponse = await rpcCall(child, 't4b', 'ping') as { id: string; result: { status: string } };
      expect(pingResponse.result.status).toBe('pong');
    } finally {
      child.kill();
    }
  });
});
