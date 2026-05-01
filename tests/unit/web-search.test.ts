import { describe, it, expect, vi, beforeEach } from 'vitest';
import { searchWeb } from '../../src/agent/web-search.js';

describe('Web Search', () => {
  const originalEnv = process.env;

  beforeEach(() => {
    process.env = { ...originalEnv };
    vi.restoreAllMocks();
  });

  it('returns results from Brave Search API', async () => {
    const mockResults = ['result1', 'result2'];
    const mockFetch = vi.fn().mockResolvedValue({
      ok: true,
      json: async () => ({
        web: { results: [{ snippet: 'result1' }, { snippet: 'result2' }] },
      }),
    });
    vi.stubGlobal('fetch', mockFetch);

    process.env.BRAVE_API_KEY = 'test-key';
    const results = await searchWeb('test query');

    expect(results).toEqual(mockResults);
    expect(mockFetch).toHaveBeenCalledTimes(1);
    const callUrl = mockFetch.mock.calls[0][0];
    // URLSearchParams encodes space as +, not %20
    expect(callUrl).toContain('test+query');
    expect(mockFetch.mock.calls[0][1].headers['X-Subscription-Token']).toBe('test-key');
  });

  it('returns empty array on API error', async () => {
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue({
      ok: false,
      status: 429,
    }));

    process.env.BRAVE_API_KEY = 'test-key';
    const results = await searchWeb('error query');
    expect(results).toEqual([]);
  });

  it('returns empty array when API key is missing', async () => {
    delete process.env.BRAVE_API_KEY;
    const results = await searchWeb('no key');
    expect(results).toEqual([]);
  });
});
