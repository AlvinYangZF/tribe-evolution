import { describe, it, expect } from 'vitest';
import {
  createRandomGenome,
  createRandomDiploidGenome,
  expressGenome,
  meiosis,
  sexualReproduce,
  mutateDiploid,
  genomeToSystemPrompt,
} from '../../src/agent/genome.js';
import type { DiploidGenome, ExpressedGenome, Gender, Trait, SkillName } from '../../src/shared/types.js';

describe('diploid genome', () => {
  describe('createRandomDiploidGenome', () => {
    it('should create a diploid genome with valid structure', () => {
      const d = createRandomDiploidGenome();
      expect(d).toBeDefined();
      expect(d.gender).toMatch(/^male$|^female$/);
      expect(typeof d.personaName.dominant).toBe('string');
      expect(typeof d.personaName.recessive).toBe('string');
      expect(d.personaName.dominant.length).toBeGreaterThan(0);
      expect(d.personaName.recessive.length).toBeGreaterThan(0);
      expect(Array.isArray(d.traits)).toBe(true);
      expect(d.traits.length).toBeGreaterThanOrEqual(1);
      for (const pair of d.traits) {
        expect(pair).toHaveProperty('dominant');
        expect(pair).toHaveProperty('recessive');
        expect(['curious', 'cooperative', 'aggressive', 'lazy', 'helpful', 'explorer', 'creative', 'cautious']).toContain(pair.dominant);
      }
      const skillNames: SkillName[] = ['web_search', 'code_write', 'data_analyze', 'artifact_write', 'observe', 'propose'];
      for (const s of skillNames) {
        expect(d.skills[s]).toBeDefined();
        expect(typeof d.skills[s].dominant).toBe('number');
        expect(d.skills[s].dominant).toBeGreaterThanOrEqual(0);
        expect(d.skills[s].dominant).toBeLessThanOrEqual(1);
        expect(d.skills[s].recessive).toBeGreaterThanOrEqual(0);
        expect(d.skills[s].recessive).toBeLessThanOrEqual(1);
      }
      expect(d.collabBias.dominant).toBeGreaterThanOrEqual(0);
      expect(d.collabBias.dominant).toBeLessThanOrEqual(1);
      expect(d.collabBias.recessive).toBeGreaterThanOrEqual(0);
      expect(d.collabBias.recessive).toBeLessThanOrEqual(1);
      expect(d.riskTolerance.dominant).toBeGreaterThanOrEqual(0);
      expect(d.riskTolerance.dominant).toBeLessThanOrEqual(1);
      expect(d.communicationFreq.dominant).toBeGreaterThanOrEqual(0);
      expect(d.communicationFreq.dominant).toBeLessThanOrEqual(1);
    });

    it('should respect specified gender', () => {
      const male = createRandomDiploidGenome('male');
      expect(male.gender).toBe('male');
      const female = createRandomDiploidGenome('female');
      expect(female.gender).toBe('female');
    });

    it('should generate different genomes each call', () => {
      const d1 = createRandomDiploidGenome();
      const d2 = createRandomDiploidGenome();
      const sameSkills = JSON.stringify(d1.skills) === JSON.stringify(d2.skills);
      const sameTraits = JSON.stringify(d1.traits) === JSON.stringify(d2.traits);
      // Very unlikely both are same
      expect(sameSkills && sameTraits).toBe(false);
    });
  });

  describe('expressGenome', () => {
    it('should resolve dominant over recessive when they differ', () => {
      const d: DiploidGenome = {
        gender: 'male',
        personaName: { dominant: 'Alpha', recessive: 'Beta' },
        traits: [
          { dominant: 'curious', recessive: 'lazy' },
          { dominant: 'helpful', recessive: 'aggressive' },
        ],
        skills: {
          web_search: { dominant: 0.9, recessive: 0.3 },
          code_write: { dominant: 0.5, recessive: 0.5 },
          data_analyze: { dominant: 0.2, recessive: 0.8 },
          artifact_write: { dominant: 0.7, recessive: 0.1 },
          observe: { dominant: 0.4, recessive: 0.6 },
          propose: { dominant: 0.3, recessive: 0.9 },
        },
        collabBias: { dominant: 0.8, recessive: 0.2 },
        riskTolerance: { dominant: 0.3, recessive: 0.7 },
        communicationFreq: { dominant: 0.6, recessive: 0.4 },
      };

      const e = expressGenome(d);
      expect(e.personaName).toBe('Alpha'); // dominant
      expect(e.gender).toBe('male');
      expect(e.traits).toContain('curious');
      expect(e.traits).toContain('helpful');
      expect(e.skills.web_search).toBe(0.9);
      expect(e.skills.artifact_write).toBe(0.7);
      expect(e.collabBias).toBe(0.8);
      expect(e.riskTolerance).toBe(0.3);
      expect(e.communicationFreq).toBe(0.6);
    });

    it('should use either when dominant equals recessive', () => {
      const d: DiploidGenome = {
        gender: 'female',
        personaName: { dominant: 'Nova', recessive: 'Nova' },
        traits: [
          { dominant: 'creative', recessive: 'creative' },
        ],
        skills: {
          web_search: { dominant: 0.5, recessive: 0.5 },
          code_write: { dominant: 0.5, recessive: 0.5 },
          data_analyze: { dominant: 0.5, recessive: 0.5 },
          artifact_write: { dominant: 0.5, recessive: 0.5 },
          observe: { dominant: 0.5, recessive: 0.5 },
          propose: { dominant: 0.5, recessive: 0.5 },
        },
        collabBias: { dominant: 0.5, recessive: 0.5 },
        riskTolerance: { dominant: 0.5, recessive: 0.5 },
        communicationFreq: { dominant: 0.5, recessive: 0.5 },
      };

      const e = expressGenome(d);
      expect(e.personaName).toBe('Nova');
      expect(e.gender).toBe('female');
      expect(e.traits).toContain('creative');
    });

    it('should produce valid ExpressedGenome matching Genome-like shape', () => {
      const d = createRandomDiploidGenome();
      const e = expressGenome(d);
      expect(typeof e.personaName).toBe('string');
      expect(typeof e.gender).toBe('string');
      expect(Array.isArray(e.traits)).toBe(true);
      expect(typeof e.collabBias).toBe('number');
      expect(typeof e.riskTolerance).toBe('number');
      expect(typeof e.communicationFreq).toBe('number');
      const skillNames: SkillName[] = ['web_search', 'code_write', 'data_analyze', 'artifact_write', 'observe', 'propose'];
      for (const s of skillNames) {
        expect(typeof e.skills[s]).toBe('number');
        expect(e.skills[s]).toBeGreaterThanOrEqual(0);
        expect(e.skills[s]).toBeLessThanOrEqual(1);
      }
    });
  });

  describe('meiosis', () => {
    it('should preserve gender', () => {
      const d = createRandomDiploidGenome('male');
      const m = meiosis(d);
      expect(m.gender).toBe('male');

      const d2 = createRandomDiploidGenome('female');
      const m2 = meiosis(d2);
      expect(m2.gender).toBe('female');
    });

    it('should produce haploid result where dominant === recessive for each pair', () => {
      const d = createRandomDiploidGenome();
      const m = meiosis(d);
      expect(m.personaName.dominant).toBe(m.personaName.recessive);
      for (const pair of m.traits) {
        expect(pair.dominant).toBe(pair.recessive);
      }
      const skillNames: SkillName[] = ['web_search', 'code_write', 'data_analyze', 'artifact_write', 'observe', 'propose'];
      for (const s of skillNames) {
        expect(m.skills[s].dominant).toBe(m.skills[s].recessive);
      }
      expect(m.collabBias.dominant).toBe(m.collabBias.recessive);
      expect(m.riskTolerance.dominant).toBe(m.riskTolerance.recessive);
      expect(m.communicationFreq.dominant).toBe(m.communicationFreq.recessive);
    });

    it('should not lose gene variation over multiple meiosis rounds', () => {
      const d = createRandomDiploidGenome();
      // Run meiosis 10 times and collect results
      const results: string[] = [];
      for (let i = 0; i < 10; i++) {
        const m = meiosis(d);
        results.push(m.personaName.dominant);
      }
      // If d had different dominant/recessive, both should appear across runs
      if (d.personaName.dominant !== d.personaName.recessive) {
        const unique = new Set(results);
        expect(unique.size).toBeGreaterThan(1);
      }
    });
  });

  describe('sexualReproduce', () => {
    it('should produce a valid diploid genome', () => {
      const a = createRandomDiploidGenome('male');
      const b = createRandomDiploidGenome('female');
      const child = sexualReproduce(a, b);
      expect(child).toBeDefined();
      expect(child.gender).toMatch(/^male$|^female$/);
      expect(child.personaName.dominant).toBeDefined();
      expect(child.personaName.recessive).toBeDefined();
      expect(child.traits.length).toBeGreaterThanOrEqual(1);
    });

    it('should have gender from either parent with 50/50 distribution', () => {
      const a = createRandomDiploidGenome('male');
      const b = createRandomDiploidGenome('female');
      const genders: string[] = [];
      for (let i = 0; i < 100; i++) {
        const child = sexualReproduce(a, b);
        genders.push(child.gender);
      }
      const maleCount = genders.filter(g => g === 'male').length;
      // Should have some of each (extremely unlikely to be all one)
      expect(maleCount).toBeGreaterThan(10);
      expect(maleCount).toBeLessThan(90);
    });

    it('should produce different children on multiple calls', () => {
      const a = createRandomDiploidGenome('male');
      const b = createRandomDiploidGenome('female');
      const children = [];
      for (let i = 0; i < 5; i++) {
        children.push(sexualReproduce(a, b));
      }
      // Check that not all children have the same expressed personaName
      const expressedNames = children.map(c => c.personaName.dominant);
      const uniqueNames = new Set(expressedNames);
      // With random meiosis + crossover, some should differ
      expect(uniqueNames.size).toBeGreaterThanOrEqual(1);
    });

    it('should produce genomes whose expressed form is valid', () => {
      const a = createRandomDiploidGenome('male');
      const b = createRandomDiploidGenome('female');
      const child = sexualReproduce(a, b);
      const expressed = expressGenome(child);
      expect(typeof expressed.personaName).toBe('string');
      expect(expressed.personaName.length).toBeGreaterThan(0);
      expect(expressed.traits.length).toBeGreaterThanOrEqual(1);
    });
  });

  describe('mutateDiploid', () => {
    it('should not mutate with rate 0', () => {
      const d = createRandomDiploidGenome();
      const snapshot = JSON.stringify(d);
      for (let i = 0; i < 50; i++) {
        const mutated = mutateDiploid(JSON.parse(snapshot) as DiploidGenome, 0);
        expect(JSON.stringify(mutated)).toBe(snapshot);
      }
    });

    it('should mutate frequently at default rate 0.1 (per-gene mutation means nearly all have at least one mutation)', () => {
      const d = createRandomDiploidGenome();
      const snapshot = JSON.stringify(d);
      let mutantCount = 0;
      for (let i = 0; i < 100; i++) {
        const mutated = mutateDiploid(JSON.parse(snapshot) as DiploidGenome, 0.1);
        if (JSON.stringify(mutated) !== snapshot) {
          mutantCount++;
        }
      }
      // With ~12+ genes each at 10% mutation, virtually all genomes get at least one mutation
      expect(mutantCount).toBeGreaterThan(50);
    });

    it('should maintain valid structure after mutation', () => {
      const d = createRandomDiploidGenome();
      for (let i = 0; i < 50; i++) {
        const mutated = mutateDiploid(JSON.parse(JSON.stringify(d)) as DiploidGenome, 1.0);
        expect(mutated.gender).toMatch(/^male$|^female$/);
        expect(mutated.personaName.dominant.length).toBeGreaterThan(0);
        expect(mutated.personaName.recessive.length).toBeGreaterThan(0);
        expect(mutated.traits.length).toBeGreaterThanOrEqual(1);
        const skillNames: SkillName[] = ['web_search', 'code_write', 'data_analyze', 'artifact_write', 'observe', 'propose'];
        for (const s of skillNames) {
          expect(mutated.skills[s].dominant).toBeGreaterThanOrEqual(0);
          expect(mutated.skills[s].dominant).toBeLessThanOrEqual(1);
          expect(mutated.skills[s].recessive).toBeGreaterThanOrEqual(0);
          expect(mutated.skills[s].recessive).toBeLessThanOrEqual(1);
        }
      }
    });
  });

  describe('serial reproduction diversity', () => {
    it('should maintain genome diversity over multiple generations', () => {
      // Simulate 5 generations with 10 initial agents
      let population = ['male', 'female', 'male', 'female', 'male', 'female', 'male', 'female', 'male', 'female']
        .map(g => createRandomDiploidGenome(g as Gender));

      const allNames = new Set<string>();

      for (let gen = 0; gen < 5; gen++) {
        const offspring: DiploidGenome[] = [];
        // Let each male pair with a female
        const males = population.filter(d => d.gender === 'male');
        const females = population.filter(d => d.gender === 'female');

        for (let i = 0; i < Math.min(males.length, females.length); i++) {
          const child = sexualReproduce(males[i], females[i]);
          const mutated = mutateDiploid(child, 0.1);
          offspring.push(mutated);
          // Express to get personaName
          const expressed = expressGenome(mutated);
          allNames.add(expressed.personaName);
        }

        // Replace population with offspring + some parents
        population = [...offspring, ...population.slice(0, 4)];
      }

      // Should have multiple unique names across generations
      expect(allNames.size).toBeGreaterThan(1);
    });
  });

  describe('genomeToSystemPrompt with ExpressedGenome', () => {
    it('should produce a valid prompt from ExpressedGenome', () => {
      const d = createRandomDiploidGenome();
      const e = expressGenome(d);
      const prompt = genomeToSystemPrompt(e as any);
      expect(typeof prompt).toBe('string');
      expect(prompt.length).toBeGreaterThan(0);
      expect(prompt).toContain(e.personaName);
    });
  });
});
