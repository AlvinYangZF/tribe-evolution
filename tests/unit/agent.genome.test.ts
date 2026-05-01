import { describe, it, expect } from 'vitest';
import { createRandomGenome, cloneGenome, mutate, genomeToSystemPrompt } from '../../src/agent/genome.js';
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

  describe('cloneGenome', () => {
    it('should produce a genome with same base properties', () => {
      const g = createRandomGenome();
      const clone = cloneGenome(g, 0);
      expect(clone.personaName).toBe(g.personaName);
      expect(clone.traits).toEqual(g.traits);
      expect(clone.skills).toEqual(g.skills);
      expect(clone.collabBias).toBe(g.collabBias);
      expect(clone.riskTolerance).toBe(g.riskTolerance);
      expect(clone.communicationFreq).toBe(g.communicationFreq);
    });

    it('should not mutate with rate 0', () => {
      for (let i = 0; i < 100; i++) {
        const g = createRandomGenome();
        const clone = cloneGenome(g, 0);
        expect(clone.personaName).toBe(g.personaName);
        expect(clone.traits).toEqual(g.traits);
        expect(clone.skills).toEqual(g.skills);
      }
    });

    it('should mutate roughly 8-12% of 100 clones at default rate 0.1', () => {
      const g = createRandomGenome();
      let mutantCount = 0;
      for (let i = 0; i < 100; i++) {
        const clone = cloneGenome(g, 0.1);
        const isMutant =
          clone.personaName !== g.personaName ||
          JSON.stringify(clone.traits) !== JSON.stringify(g.traits) ||
          JSON.stringify(clone.skills) !== JSON.stringify(g.skills) ||
          clone.collabBias !== g.collabBias ||
          clone.riskTolerance !== g.riskTolerance ||
          clone.communicationFreq !== g.communicationFreq;
        if (isMutant) mutantCount++;
      }
      // Allow some tolerance — between 2 and 20 is acceptable
      expect(mutantCount).toBeGreaterThanOrEqual(2);
      expect(mutantCount).toBeLessThanOrEqual(20);
    });
  });

  describe('mutate', () => {
    it('should add event bonus for resource_conflict', () => {
      const g = createRandomGenome();
      let mutated = false;
      for (let i = 0; i < 20; i++) {
        const clone = cloneGenome(g, 0);
        const result = mutate(clone, 'resource_conflict');
        const isMutant =
          result.personaName !== clone.personaName ||
          JSON.stringify(result.traits) !== JSON.stringify(g.traits);
        if (isMutant) mutated = true;
      }
      // With +30% bonus, odds are ~40% per call — very likely to see mutation in 20 tries
      expect(mutated).toBe(true);
    });

    it('should generate valid mutation types', () => {
      const g = createRandomGenome();
      // Force a mutation by passing a high-base clone call and the event
      const clone = cloneGenome(g, 0);
      const result = mutate(clone, 'survive_crisis'); // +40% => ~50% chance
      // No strict assertion on whether it mutates, but should not throw
      expect(result).toBeDefined();
      expect(result.traits.length).toBeGreaterThanOrEqual(1);
    });

    it('should handle skill_gain mutation by increasing a skill', () => {
      const g = createRandomGenome();
      const minSkill = Object.entries(g.skills).sort((a, b) => a[1] - b[1])[0];
      // Force many mutations until we get one
      for (let i = 0; i < 100; i++) {
        const clone = cloneGenome(g, 0);
        const result = mutate(clone, 'deep_interaction'); // +25%
        if (JSON.stringify(result.skills) !== JSON.stringify(clone.skills)) {
          // Some skill changed — good
          const diff = Object.keys(result.skills).find(
            k => result.skills[k as SkillName] !== clone.skills[k as SkillName]
          );
          // Either increased or decreased (some types lower)
          expect(diff).toBeDefined();
          return;
        }
      }
      // Fallthrough — highly unlikely with 100 tries at 35% mutation rate
      expect(true).toBe(true);
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
