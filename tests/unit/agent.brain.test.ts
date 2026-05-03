import { describe, it, expect } from 'vitest';
import { compileAgentPrompt, parseDecision } from '../../src/agent/brain.js';
import type { Genome } from '../../src/shared/types.js';
import type { AgentDecision, AgentStateForBrain, AgentEnvironmentForBrain } from '../../src/agent/brain.js';

function makeGenome(overrides: Partial<Genome> = {}): Genome {
  return {
    personaName: 'TestBot',
    traits: ['curious', 'helpful'],
    skills: {
      web_search: 0.9,
      code_write: 0.3,
      data_analyze: 0.5,
      artifact_write: 0.8,
      observe: 0.4,
      propose: 0.6,
    },
    collabBias: 0.7,
    riskTolerance: 0.3,
    communicationFreq: 0.6,
    ...overrides,
  };
}

function makeState(overrides: Partial<AgentStateForBrain> = {}): AgentStateForBrain {
  return {
    balance: 1000,
    age: 50,
    reputation: 0.85,
    generation: 3,
    ...overrides,
  };
}

function makeEnv(overrides: Partial<AgentEnvironmentForBrain> = {}): AgentEnvironmentForBrain {
  return {
    aliveCount: 20,
    availableResources: 5,
    pendingMessages: 2,
    ...overrides,
  };
}

describe('compileAgentPrompt', () => {
  it('should include persona name in output', () => {
    const genome = makeGenome({ personaName: 'Omega' });
    const prompt = compileAgentPrompt(genome, makeState(), makeEnv());
    expect(prompt).toContain('Omega');
  });

  it('should include all traits', () => {
    const genome = makeGenome({ traits: ['curious', 'helpful', 'explorer'] });
    const prompt = compileAgentPrompt(genome, makeState(), makeEnv());
    expect(prompt).toContain('curious');
    expect(prompt).toContain('helpful');
    expect(prompt).toContain('explorer');
  });

  it('should include collabBias', () => {
    const genome = makeGenome({ collabBias: 0.7 });
    const prompt = compileAgentPrompt(genome, makeState(), makeEnv());
    expect(prompt).toContain('70/100');
  });

  it('should include riskTolerance', () => {
    const genome = makeGenome({ riskTolerance: 0.3 });
    const prompt = compileAgentPrompt(genome, makeState(), makeEnv());
    expect(prompt).toContain('30/100');
  });

  it('should include communicationFreq', () => {
    const genome = makeGenome({ communicationFreq: 0.6 });
    const prompt = compileAgentPrompt(genome, makeState(), makeEnv());
    expect(prompt).toContain('60/100');
  });

  it('should include state fields (balance, age, reputation, generation)', () => {
    const prompt = compileAgentPrompt(makeGenome(), makeState({ balance: 500, age: 10, reputation: 0.9, generation: 5 }), makeEnv());
    expect(prompt).toContain('500');
    expect(prompt).toContain('10');
    expect(prompt).toContain('0.9');
    expect(prompt).toContain('5');
  });

  it('should include environment fields (aliveCount, availableResources, pendingMessages)', () => {
    const prompt = compileAgentPrompt(makeGenome(), makeState(), makeEnv({ aliveCount: 15, availableResources: 3, pendingMessages: 1 }));
    expect(prompt).toContain('15');
    expect(prompt).toContain('3');
    expect(prompt).toContain('1');
  });

  it('should include skills with priority > 0', () => {
    const prompt = compileAgentPrompt(makeGenome(), makeState(), makeEnv());
    // Only web_search (0.9), artifact_write (0.8), propose (0.6) have skills > 0.5
    // Actually all skills have values > 0, so all should appear
    expect(prompt).toContain('web_search');
    expect(prompt).toContain('artifact_write');
    expect(prompt).toContain('propose');
  });

  it('should not include skills with priority 0', () => {
    const genome = makeGenome({
      skills: { web_search: 0.9, code_write: 0, data_analyze: 0, artifact_write: 0.8, observe: 0, propose: 0 },
    });
    const prompt = compileAgentPrompt(genome, makeState(), makeEnv());
    expect(prompt).toContain('web_search');
    expect(prompt).toContain('artifact_write');
    expect(prompt).not.toContain('code_write');
    expect(prompt).not.toContain('data_analyze');
  });

  it('should mention all available action types', () => {
    const prompt = compileAgentPrompt(makeGenome(), makeState(), makeEnv());
    expect(prompt).toContain('web_search');
    expect(prompt).toContain('write_artifact');
    expect(prompt).toContain('observe');
    expect(prompt).toContain('propose');
    expect(prompt).toContain('lock_resource');
    expect(prompt).toContain('trade');
    expect(prompt).toContain('idle');
  });

  it('should include JSON output format instruction', () => {
    const prompt = compileAgentPrompt(makeGenome(), makeState(), makeEnv());
    expect(prompt).toContain('"action"');
    expect(prompt).toContain('"params"');
    expect(prompt).toContain('"reasoning"');
  });

  it('should include core mission (SURVIVE + REPRODUCE)', () => {
    const prompt = compileAgentPrompt(makeGenome(), makeState(), makeEnv());
    expect(prompt).toContain('SURVIVE as long as possible');
    expect(prompt).toContain('age >= 50 = death');
    expect(prompt).toContain('Find a mate and REPRODUCE');
  });

  it('should include gender info when state has gender', () => {
    const prompt = compileAgentPrompt(makeGenome(), makeState({ gender: 'male' }), makeEnv());
    expect(prompt).toContain('You are a male agent');
    expect(prompt).toContain('Sexual reproduction requires a partner of the opposite gender');
  });

  it('should not include gender info when state has no gender', () => {
    const prompt = compileAgentPrompt(makeGenome(), makeState({ gender: undefined }), makeEnv());
    expect(prompt).not.toContain('You are a');
    expect(prompt).not.toContain('Sexual reproduction');
  });

  it('should include the Notes section when state has memory', () => {
    const prompt = compileAgentPrompt(makeGenome(), makeState({ memory: 'I beat Hunter at code_review last cycle.' }), makeEnv());
    expect(prompt).toContain('Your Notes');
    expect(prompt).toContain('I beat Hunter at code_review last cycle.');
  });

  it('should omit the Notes section when memory is empty or missing', () => {
    const promptA = compileAgentPrompt(makeGenome(), makeState({ memory: '' }), makeEnv());
    const promptB = compileAgentPrompt(makeGenome(), makeState({ memory: undefined }), makeEnv());
    expect(promptA).not.toContain('Your Notes');
    expect(promptB).not.toContain('Your Notes');
  });

  it('should advertise update_memory in the actions list', () => {
    const prompt = compileAgentPrompt(makeGenome(), makeState(), makeEnv());
    expect(prompt).toContain('update_memory');
  });
});

describe('parseDecision', () => {
  it('should parse a valid JSON decision', () => {
    const response = JSON.stringify({
      action: 'web_search',
      params: { query: 'AI news' },
      reasoning: 'I need to learn about AI',
    });
    const result = parseDecision(response);
    expect(result.action).toBe('web_search');
    expect(result.params).toEqual({ query: 'AI news' });
    expect(result.reasoning).toBe('I need to learn about AI');
  });

  it('should parse idle decision correctly', () => {
    const response = JSON.stringify({
      action: 'idle',
      params: {},
      reasoning: 'No need to act now',
    });
    const result = parseDecision(response);
    expect(result.action).toBe('idle');
    expect(result.params).toEqual({});
  });

  it('should parse decision with empty params', () => {
    const response = JSON.stringify({
      action: 'observe',
      params: {},
      reasoning: 'Let me observe others',
    });
    const result = parseDecision(response);
    expect(result.action).toBe('observe');
    expect(result.params).toEqual({});
  });

  it('should fallback to idle when response is not valid JSON', () => {
    const result = parseDecision('not json at all');
    expect(result.action).toBe('idle');
    expect(result.params).toEqual({});
    expect(result.reasoning).toBe('LLM returned invalid response');
    expect(result.fallbackReason).toBe('json_parse');
    expect(result.rawResponse).toBe('not json at all');
  });

  it('should fallback to idle when response is empty string', () => {
    const result = parseDecision('');
    expect(result.action).toBe('idle');
    expect(result.params).toEqual({});
    expect(result.fallbackReason).toBe('empty_response');
  });

  it('should fallback to idle when response is null', () => {
    const result = parseDecision(null as unknown as string);
    expect(result.action).toBe('idle');
    expect(result.fallbackReason).toBe('empty_response');
  });

  it('should fallback to idle when JSON is missing action field', () => {
    const response = JSON.stringify({ params: {}, reasoning: 'no action' });
    const result = parseDecision(response);
    expect(result.action).toBe('idle');
    expect(result.fallbackReason).toBe('schema_mismatch');
    expect(result.rawResponse).toBe(response);
  });

  it('should fallback to idle when action is not a valid action type', () => {
    const response = JSON.stringify({
      action: 'fly_to_moon',
      params: {},
      reasoning: 'testing',
    });
    const result = parseDecision(response);
    expect(result.action).toBe('idle');
    expect(result.fallbackReason).toBe('schema_mismatch');
  });

  it('should fallback to idle when propose action is missing both title and description', () => {
    const response = JSON.stringify({
      action: 'propose',
      params: {},
      reasoning: 'no fields',
    });
    const result = parseDecision(response);
    expect(result.action).toBe('idle');
    expect(result.fallbackReason).toBe('missing_propose_fields');
  });

  it('should not set fallbackReason on a legitimate idle decision', () => {
    const response = JSON.stringify({
      action: 'idle',
      params: {},
      reasoning: 'saving tokens',
    });
    const result = parseDecision(response);
    expect(result.action).toBe('idle');
    expect(result.fallbackReason).toBeUndefined();
    expect(result.rawResponse).toBeUndefined();
  });

  it('should truncate raw response longer than 200 chars', () => {
    const long = 'x'.repeat(300);
    const result = parseDecision(long);
    expect(result.fallbackReason).toBe('json_parse');
    expect(result.rawResponse?.length).toBeLessThanOrEqual(201); // 200 + ellipsis
    expect(result.rawResponse?.endsWith('…')).toBe(true);
  });

  it('should handle JSON with extra whitespace or newlines', () => {
    const response = `{
      "action": "lock_resource",
      "params": { "resourceId": "res-1" },
      "reasoning": "Need this resource"
    }`;
    const result = parseDecision(response);
    expect(result.action).toBe('lock_resource');
    expect(result.params).toEqual({ resourceId: 'res-1' });
  });
});

describe('decide (integration-style with mock LLM)', () => {
  // Import decide dynamically — it depends on compileAgentPrompt + parseDecision
  // which are already tested. We test the orchestration with a mock callLLM.

  it('should return a valid AgentDecision from mock LLM', async () => {
    const { decide } = await import('../../src/agent/brain.js');

    const mockLLM = async (_sys: string, _user: string): Promise<string> => {
      return JSON.stringify({
        action: 'web_search',
        params: { query: 'latest AI papers' },
        reasoning: 'Staying informed',
      });
    };

    const result = await decide(makeGenome(), makeState(), makeEnv(), mockLLM);
    expect(result.action).toBe('web_search');
    expect(result.params).toEqual({ query: 'latest AI papers' });
    expect(result.reasoning).toBe('Staying informed');
  });

  it('should return idle when mock LLM returns invalid JSON', async () => {
    const { decide } = await import('../../src/agent/brain.js');

    const mockLLM = async (_sys: string, _user: string): Promise<string> => {
      return 'this is not JSON';
    };

    const result = await decide(makeGenome(), makeState(), makeEnv(), mockLLM);
    expect(result.action).toBe('idle');
    expect(result.params).toEqual({});
    expect(result.reasoning).toBe('LLM returned invalid response');
    expect(result.fallbackReason).toBe('json_parse');
  });

  it('should return idle when mock LLM throws an error', async () => {
    const { decide } = await import('../../src/agent/brain.js');

    const mockLLM = async (_sys: string, _user: string): Promise<string> => {
      throw new Error('API unavailable');
    };

    const result = await decide(makeGenome(), makeState(), makeEnv(), mockLLM);
    expect(result.action).toBe('idle');
    expect(result.params).toEqual({});
    expect(result.reasoning).toContain('LLM call failed');
    expect(result.fallbackReason).toBe('llm_error');
  });

  it('should pass system prompt and user message to callLLM', async () => {
    const { decide } = await import('../../src/agent/brain.js');

    let capturedSystem = '';
    let capturedUser = '';

    const mockLLM = async (system: string, user: string): Promise<string> => {
      capturedSystem = system;
      capturedUser = user;
      return JSON.stringify({ action: 'idle', params: {}, reasoning: 'check' });
    };

    await decide(makeGenome({ personaName: 'Sigma' }), makeState({ balance: 999 }), makeEnv(), mockLLM);

    expect(capturedSystem).toContain('Sigma');
    expect(capturedSystem).toContain('999');
    expect(capturedUser).toBeDefined();
    expect(capturedUser.length).toBeGreaterThan(0);
  });
});

describe('three-phase decide pipeline', () => {
  // Mock the LLM to dispatch on the phase tag the orchestrator passes in opts.
  // The orchestrator calls explore → evaluate → execute in order; the mock
  // returns a phase-specific JSON shape for each.
  function phaseAwareMock(responses: { explore: string; evaluate: string; execute: string }) {
    const calls: Array<{ phase?: string; user: string }> = [];
    const mock = async (
      _sys: string,
      user: string,
      opts?: { phase?: 'explore' | 'evaluate' | 'execute'; maxTokens?: number },
    ): Promise<string> => {
      calls.push({ phase: opts?.phase, user });
      if (opts?.phase === 'explore') return responses.explore;
      if (opts?.phase === 'evaluate') return responses.evaluate;
      return responses.execute;
    };
    return { mock, calls };
  }

  it('runs explore → evaluate → execute in order with the right phase tags', async () => {
    const { decide } = await import('../../src/agent/brain.js');
    const { mock, calls } = phaseAwareMock({
      explore: JSON.stringify({ observations: ['low tokens', '3 open bounties'], focus_area: 'earn tokens' }),
      evaluate: JSON.stringify({
        candidates: [
          { action: 'bid_bounty', why: 'fastest path to tokens', expected_value: 70 },
          { action: 'idle', why: 'safe', expected_value: 5 },
        ],
        top_choice: 'bid_bounty',
      }),
      execute: JSON.stringify({ action: 'bid_bounty', params: { bountyId: 'b1' }, reasoning: 'going for it' }),
    });

    const result = await decide(makeGenome(), makeState(), makeEnv(), mock);
    expect(calls.map(c => c.phase)).toEqual(['explore', 'evaluate', 'execute']);
    expect(result.action).toBe('bid_bounty');
    expect(result.params).toEqual({ bountyId: 'b1' });
  });

  it('forwards explore observations into the evaluate user message', async () => {
    const { decide } = await import('../../src/agent/brain.js');
    const { mock, calls } = phaseAwareMock({
      explore: JSON.stringify({ observations: ['I am old (age 47)'], focus_area: 'survive' }),
      evaluate: JSON.stringify({ candidates: [], top_choice: null }),
      execute: JSON.stringify({ action: 'idle', params: {}, reasoning: 'rest' }),
    });

    await decide(makeGenome(), makeState(), makeEnv(), mock);
    const evalCall = calls.find(c => c.phase === 'evaluate');
    expect(evalCall?.user).toContain('I am old (age 47)');
    expect(evalCall?.user).toContain('survive');
  });

  it('still produces a decision when explore output is malformed (degrades gracefully)', async () => {
    const { decide } = await import('../../src/agent/brain.js');
    const { mock } = phaseAwareMock({
      explore: 'garbage',
      evaluate: JSON.stringify({ candidates: [], top_choice: null }),
      execute: JSON.stringify({ action: 'observe', params: {}, reasoning: 'fallback' }),
    });

    const result = await decide(makeGenome(), makeState(), makeEnv(), mock);
    expect(result.action).toBe('observe');
    expect(result.fallbackReason).toBeUndefined();
  });

  it('still produces a decision when evaluate output is malformed', async () => {
    const { decide } = await import('../../src/agent/brain.js');
    const { mock } = phaseAwareMock({
      explore: JSON.stringify({ observations: [], focus_area: '' }),
      evaluate: '{not valid',
      execute: JSON.stringify({ action: 'web_search', params: { query: 'x' }, reasoning: 'go' }),
    });

    const result = await decide(makeGenome(), makeState(), makeEnv(), mock);
    expect(result.action).toBe('web_search');
  });

  it('falls back to idle with json_parse when the execute phase output is malformed', async () => {
    const { decide } = await import('../../src/agent/brain.js');
    const { mock } = phaseAwareMock({
      explore: JSON.stringify({ observations: [], focus_area: '' }),
      evaluate: JSON.stringify({ candidates: [], top_choice: null }),
      execute: 'not valid execute output',
    });

    const result = await decide(makeGenome(), makeState(), makeEnv(), mock);
    expect(result.action).toBe('idle');
    expect(result.fallbackReason).toBe('json_parse');
  });

  it('passes phase-specific maxTokens to the LLM (300 / 100 / 600)', async () => {
    const { decide } = await import('../../src/agent/brain.js');
    const captured: Array<{ phase?: string; maxTokens?: number }> = [];
    const mock = async (
      _sys: string,
      _user: string,
      opts?: { phase?: 'explore' | 'evaluate' | 'execute'; maxTokens?: number },
    ): Promise<string> => {
      captured.push({ phase: opts?.phase, maxTokens: opts?.maxTokens });
      return JSON.stringify({ action: 'idle', params: {}, reasoning: '' });
    };

    await decide(makeGenome(), makeState(), makeEnv(), mock);
    expect(captured).toEqual([
      { phase: 'explore', maxTokens: 300 },
      { phase: 'evaluate', maxTokens: 100 },
      { phase: 'execute', maxTokens: 600 },
    ]);
  });
});

describe('parseExplore / parseEvaluate', () => {
  it('parseExplore accepts a valid response', async () => {
    const { parseExplore } = await import('../../src/agent/brain.js');
    const r = parseExplore(JSON.stringify({ observations: ['x', 'y'], focus_area: 'z' }));
    expect(r).toEqual({ observations: ['x', 'y'], focus_area: 'z' });
  });

  it('parseExplore returns null on garbage', async () => {
    const { parseExplore } = await import('../../src/agent/brain.js');
    expect(parseExplore('not json')).toBeNull();
    expect(parseExplore('')).toBeNull();
    expect(parseExplore(JSON.stringify({ wrong: 'shape' }))).toBeNull();
  });

  it('parseEvaluate accepts a response with candidates and a top_choice', async () => {
    const { parseEvaluate } = await import('../../src/agent/brain.js');
    const r = parseEvaluate(JSON.stringify({
      candidates: [{ action: 'idle', why: 'safe', expected_value: 1 }],
      top_choice: 'idle',
    }));
    expect(r?.top_choice).toBe('idle');
    expect(r?.candidates).toHaveLength(1);
  });

  it('parseEvaluate accepts a null top_choice', async () => {
    const { parseEvaluate } = await import('../../src/agent/brain.js');
    const r = parseEvaluate(JSON.stringify({ candidates: [], top_choice: null }));
    expect(r?.top_choice).toBeNull();
  });

  it('parseEvaluate rejects an invalid action enum', async () => {
    const { parseEvaluate } = await import('../../src/agent/brain.js');
    const r = parseEvaluate(JSON.stringify({
      candidates: [{ action: 'fly_to_moon', why: '', expected_value: 0 }],
      top_choice: null,
    }));
    expect(r).toBeNull();
  });
});
