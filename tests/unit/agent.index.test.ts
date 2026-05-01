import { describe, it, expect } from 'vitest';
import { spawn } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import * as path from 'node:path';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const agentEntry = path.resolve(__dirname, '../../src/agent/index.ts');

function rpcCall(child: import('child_process').ChildProcess, id: string, method: string, params: Record<string, unknown> = {}): Promise<unknown> {
  return new Promise((resolve, reject) => {
    const payload = JSON.stringify({ id, method, params }) + '\n';
    const timeout = setTimeout(() => reject(new Error('RPC timeout')), 5000);

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
