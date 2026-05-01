import { describe, it, expect } from 'vitest';
import { buildPrompt } from '../../src/agent/llm-proxy.js';
import { Genome } from '../../src/shared/types.js';

describe('llm-proxy', () => {
  it('should build a prompt with system and user message', () => {
    const genome: Genome = {
      personaName: 'ExplorerBot',
      traits: ['curious', 'explorer'],
      skills: { web_search: 0.9, code_write: 0.3, data_analyze: 0.6, artifact_write: 0.4, observe: 0.8, propose: 0.5 },
      collabBias: 0.6,
      riskTolerance: 0.7,
      communicationFreq: 0.5,
    };
    const result = buildPrompt(genome, 'Search for recent AI papers');
    expect(result).toBeDefined();
    expect(result.systemPrompt).toBeDefined();
    expect(typeof result.systemPrompt).toBe('string');
    expect(result.userMessage).toBe('Search for recent AI papers');
    expect(result.systemPrompt).toContain('ExplorerBot');
    expect(result.systemPrompt).toContain('curious');
    expect(result.systemPrompt).toContain('explorer');
  });

  it('should wrap personality instructions into the system prompt', () => {
    const genome: Genome = {
      personaName: 'HelperBot',
      traits: ['helpful', 'cooperative'],
      skills: { web_search: 0.5, code_write: 0.8, data_analyze: 0.5, artifact_write: 0.7, observe: 0.5, propose: 0.5 },
      collabBias: 0.9,
      riskTolerance: 0.2,
      communicationFreq: 0.8,
    };
    const result = buildPrompt(genome, 'Write a test');
    expect(result.systemPrompt).toContain('HelperBot');
    expect(result.systemPrompt).toMatch(/collab|cooperative|helpful/i);
  });
});
