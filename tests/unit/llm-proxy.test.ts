import { describe, it, expect, vi, beforeEach } from 'vitest';
import { proxyCall, deductTokens, getTokenBalance } from '../../src/supervisor/llm-proxy.js';

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
  });

  describe('deductTokens', () => {
    it('deducts tokens from balance when sufficient', () => {
      // Use fresh agent to avoid cross-test pollution
      const result = deductTokens('deduct-agent', 100);
      expect(result).toBe(true);
      expect(getTokenBalance('deduct-agent')).toBe(999_900);
    });

    it('returns false when insufficient tokens', () => {
      const balance = getTokenBalance('insufficient-agent');
      const overDeduct = balance + 1;
      const result = deductTokens('insufficient-agent', overDeduct);
      expect(result).toBe(false);
      expect(getTokenBalance('insufficient-agent')).toBe(balance);
    });

    it('maintains independent balances for different agents', () => {
      deductTokens('agent-alpha', 300);
      deductTokens('agent-beta', 500);
      expect(getTokenBalance('agent-alpha')).toBe(999_700);
      expect(getTokenBalance('agent-beta')).toBe(999_500);
    });
  });

  describe('getTokenBalance', () => {
    it('returns 1,000,000 for new agents', () => {
      expect(getTokenBalance('new-agent')).toBe(1_000_000);
    });
  });
});
