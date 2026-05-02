import { describe, it, expect, vi, beforeEach } from 'vitest';
import { proxyCall } from '../../src/shared/llm.js';

describe('LLM Proxy', () => {
  const originalEnv = process.env;

  beforeEach(() => {
    process.env = { ...originalEnv };
    vi.restoreAllMocks();
  });

  describe('proxyCall', () => {
    it('sends correct payload to DeepSeek API', async () => {
      const mockResponse = {
        id: 'test-id',
        choices: [{ message: { content: 'Hello from DeepSeek' } }],
        usage: { prompt_tokens: 10, completion_tokens: 5, total_tokens: 15 },
      };
      vi.stubGlobal('fetch', vi.fn().mockResolvedValue({
        ok: true,
        json: async () => mockResponse,
      }));

      process.env.DEEPSEEK_API_KEY = 'sk-test-key';

      const request = {
        requestId: 'req-1',
        agentId: 'agent-1',
        model: 'deepseek-chat',
        messages: [{ role: 'user', content: 'Hello' }],
        maxTokens: 100,
      };

      const response = await proxyCall(request);

      expect(response.requestId).toBe('req-1');
      expect(response.content).toBe('Hello from DeepSeek');
      expect(response.tokenUsage.total).toBe(15);
      
      const callArgs = (fetch as ReturnType<typeof vi.fn>).mock.calls[0];
      const body = JSON.parse(callArgs[1].body);
      expect(body.model).toBe('deepseek-chat');
      expect(body.messages).toEqual([{ role: 'user', content: 'Hello' }]);
      expect(body.max_tokens).toBe(100);
      expect(callArgs[1].headers['Authorization']).toBe('Bearer sk-test-key');
    });

    it('throws on API error', async () => {
      vi.stubGlobal('fetch', vi.fn().mockResolvedValue({
        ok: false,
        status: 401,
        statusText: 'Unauthorized',
      }));

      process.env.DEEPSEEK_API_KEY = 'sk-bad-key';

      await expect(proxyCall({
        requestId: 'req-2',
        agentId: 'agent-1',
        model: 'deepseek-chat',
        messages: [{ role: 'user', content: 'test' }],
        maxTokens: 50,
      })).rejects.toThrow('401');
    });

    it('does not internally deduct tokens (deduction is handled by Supervisor)', async () => {
      const mockResponse = {
        id: 'test-id',
        choices: [{ message: { content: 'Hello' } }],
        usage: { prompt_tokens: 10, completion_tokens: 5, total_tokens: 500 },
      };
      vi.stubGlobal('fetch', vi.fn().mockResolvedValue({
        ok: true,
        json: async () => mockResponse,
      }));

      process.env.DEEPSEEK_API_KEY = 'sk-test-key';

      const response = await proxyCall({
        requestId: 'req-3',
        agentId: 'agent-any',
        model: 'deepseek-chat',
        messages: [{ role: 'user', content: 'Hi' }],
        maxTokens: 50,
      });

      // Usage is reported but no internal deduction occurs
      expect(response.tokenUsage.total).toBe(500);
      expect(response.cost).toBe(500 * 0.000001);
    });

    it('passes AbortSignal.timeout (30s) to fetch', async () => {
      vi.stubGlobal('fetch', vi.fn().mockResolvedValue({
        ok: true,
        json: async () => ({
          id: 'test-id',
          choices: [{ message: { content: 'OK' } }],
          usage: { prompt_tokens: 1, completion_tokens: 1, total_tokens: 2 },
        }),
      }));

      process.env.DEEPSEEK_API_KEY = 'sk-test-key';

      await proxyCall({
        requestId: 'req-4',
        agentId: 'agent-1',
        model: 'deepseek-chat',
        messages: [{ role: 'user', content: 'Hi' }],
        maxTokens: 50,
      });

      const callArgs = (fetch as ReturnType<typeof vi.fn>).mock.calls[0];
      expect(callArgs[1].signal).toBeDefined();
    });
  });
});
