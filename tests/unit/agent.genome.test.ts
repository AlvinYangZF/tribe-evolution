import { describe, it, expect } from 'vitest';
import { createRandomGenome, genomeToSystemPrompt } from '../../src/agent/genome.js';
import { Genome, SkillName, Trait } from '../../src/shared/types.js';

describe('genome', () => {
  describe('createRandomGenome', () => {
    it('should create a genome with valid structure', () => {
      const g = createRandomGenome();
      expect(g).toBeDefined();
      expect(typeof g.personaName).toBe('string');
      expect(g.personaName.length).toBeGreaterThan(0);
      expect(Array.isArray(g.traits)).toBe(true);
      expect(g.traits.length).toBeGreaterThanOrEqual(1);
      expect(typeof g.collabBias).toBe('number');
      expect(g.collabBias).toBeGreaterThanOrEqual(0);
      expect(g.collabBias).toBeLessThanOrEqual(1);
      expect(typeof g.riskTolerance).toBe('number');
      expect(g.riskTolerance).toBeGreaterThanOrEqual(0);
      expect(g.riskTolerance).toBeLessThanOrEqual(1);
      expect(typeof g.communicationFreq).toBe('number');
      expect(g.communicationFreq).toBeGreaterThanOrEqual(0);
      expect(g.communicationFreq).toBeLessThanOrEqual(1);
    });

    it('should have all skills as numbers between 0-1', () => {
      const g = createRandomGenome();
      const skillNames: SkillName[] = ['web_search', 'code_write', 'data_analyze', 'artifact_write', 'observe', 'propose'];
      for (const s of skillNames) {
        expect(typeof g.skills[s]).toBe('number');
        expect(g.skills[s]).toBeGreaterThanOrEqual(0);
        expect(g.skills[s]).toBeLessThanOrEqual(1);
      }
    });

    it('should generate different genomes each call', () => {
      const g1 = createRandomGenome();
      const g2 = createRandomGenome();
      // Names may collide, but traits or skills should differ almost always
      const sameTraits = JSON.stringify(g1.traits) === JSON.stringify(g2.traits);
      const sameSkills = JSON.stringify(g1.skills) === JSON.stringify(g2.skills);
      expect(sameTraits && sameSkills).toBe(false);
    });
  });

  describe('genomeToSystemPrompt', () => {
    it('should produce a non-empty string', () => {
      const g = createRandomGenome();
      const prompt = genomeToSystemPrompt(g);
      expect(typeof prompt).toBe('string');
      expect(prompt.length).toBeGreaterThan(0);
    });

    it('should include persona name', () => {
      const g = createRandomGenome();
      const prompt = genomeToSystemPrompt(g);
      expect(prompt).toContain(g.personaName);
    });

    it('should include traits', () => {
      const g: Genome = {
        personaName: 'TestBot',
        traits: ['curious', 'helpful'],
        skills: { web_search: 0.9, code_write: 0.5, data_analyze: 0.5, artifact_write: 0.5, observe: 0.5, propose: 0.5 },
        collabBias: 0.7,
        riskTolerance: 0.3,
        communicationFreq: 0.6,
      };
      const prompt = genomeToSystemPrompt(g);
      expect(prompt).toContain('curious');
      expect(prompt).toContain('helpful');
    });
  });
});
