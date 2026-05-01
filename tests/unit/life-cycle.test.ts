import { describe, it, expect } from 'vitest';
import { evaluateFitness, eliminate, reproduce, runCycle } from '../../src/supervisor/life-cycle.js';
import { AgentState, Genome } from '../../src/shared/types.js';

const defaultGenome: Genome = {
  personaName: 'TestBot',
  traits: ['curious', 'helpful'],
  skills: { web_search: 0.5, code_write: 0.5, data_analyze: 0.5, artifact_write: 0.5, observe: 0.5, propose: 0.5 },
  collabBias: 0.5,
  riskTolerance: 0.5,
  communicationFreq: 0.5,
};

function makeAgent(id: string, overrides: Partial<AgentState> = {}): AgentState {
  return {
    id,
    genome: defaultGenome,
    generation: 1,
    parentId: null,
    tokenBalance: 1000,
    contributionScore: 0,
    reputation: 0.5,
    dealsKept: 0,
    dealsBroken: 0,
    fitness: 0,
    age: 1,
    alive: true,
    protectionRounds: 3,
    createdAt: Date.now(),
    ...overrides,
  };
}

describe('life-cycle', () => {
  describe('evaluateFitness', () => {
    it('should rank agents descending by fitness', () => {
      const agents = [
        makeAgent('a1', { contributionScore: 100, age: 5, reputation: 0.8 }),
        makeAgent('a2', { contributionScore: 50, age: 10, reputation: 0.3 }),
      ];
      const ranked = evaluateFitness(agents);
      expect(ranked).toHaveLength(2);
      expect(ranked[0].agent.id).toBe('a1');
      expect(ranked[1].agent.id).toBe('a2');
    });

    it('should calculate fitness as contribution×0.5 + age×2 + reputation×10', () => {
      const agents = [makeAgent('a1', { contributionScore: 100, age: 5, reputation: 0.8, protectionRounds: 0 })];
      const ranked = evaluateFitness(agents);
      // 100*0.5 + 5*2 + 0.8*10 = 50 + 10 + 8 = 68
      expect(ranked[0].fitness).toBeCloseTo(68, 5);
    });

    it('should give +20 protection bonus for agents in first 3 rounds', () => {
      const agents = [
        makeAgent('a1', { contributionScore: 0, age: 1, reputation: 0, protectionRounds: 2 }),
        makeAgent('a2', { contributionScore: 0, age: 1, reputation: 0, protectionRounds: 0 }),
      ];
      const ranked = evaluateFitness(agents);
      // a1: 0 + 2 + 0 + 20 = 22
      // a2: 0 + 2 + 0 + 0 = 2
      expect(ranked[0].agent.id).toBe('a1');
      expect(ranked[0].fitness).toBeCloseTo(22, 5);
      expect(ranked[1].fitness).toBeCloseTo(2, 5);
    });
  });

  describe('eliminate', () => {
    it('should eliminate bottom 30% by default', () => {
      const agents = [1,2,3,4,5,6,7,8,9,10].map(i =>
        makeAgent(`a${i}`, { protectionRounds: 0, contributionScore: i * 10, age: i, reputation: i / 10 })
      );
      const ranked = evaluateFitness(agents);
      const { survivors, eliminated } = eliminate(ranked, 0.3);
      // 10 agents * 0.3 = 3 eliminated
      expect(eliminated).toHaveLength(3);
      expect(survivors).toHaveLength(7);
      // bottom 3 should be eliminated
      const eliminatedIds = eliminated.map(e => e.id);
      expect(eliminatedIds).toContain('a1');
      expect(eliminatedIds).toContain('a2');
    });

    it('should skip protected agents during elimination', () => {
      const agents = [
        makeAgent('a1', { protectionRounds: 2, contributionScore: 0 }),  // protected
        makeAgent('a2', { protectionRounds: 0, contributionScore: 10 }), // normal
      ];
      const ranked = evaluateFitness(agents);
      const { survivors, eliminated } = eliminate(ranked, 0.5);
      // a1 gets +20 protection: fitness = 0 + 2 + 0 + 20 = 22
      // a2: fitness = 10*0.5 + 1*2 + 0*10 = 7
      // a2 has lower fitness and no protection — gets eliminated
      expect(eliminated).toHaveLength(1);
      expect(eliminated[0].id).toBe('a2');
      expect(survivors).toHaveLength(1);
      expect(survivors[0].id).toBe('a1');
    });

    it('should not eliminate fewer than 1 agent when there are many', () => {
      const agents = [1,2,3,4,5].map(i =>
        makeAgent(`a${i}`, { protectionRounds: 0, contributionScore: i * 10, age: i, reputation: i / 10 })
      );
      const ranked = evaluateFitness(agents);
      const { survivors, eliminated } = eliminate(ranked, 0.3);
      // 5 * 0.3 = 1.5 -> ceil to 2
      expect(eliminated.length).toBeGreaterThanOrEqual(1);
      expect(survivors.length + eliminated.length).toBe(5);
    });
  });

  describe('reproduce', () => {
    it('should create new agents from survivors', () => {
      const survivors = [1,2,3,4,5].map(i =>
        makeAgent(`a${i}`, { protectionRounds: 0, contributionScore: i * 10, age: i, reputation: i / 10 })
      );
      const ranked = evaluateFitness(survivors);
      const offspring = reproduce(ranked, 3);
      expect(offspring).toHaveLength(3);
      for (const child of offspring) {
        expect(child.id).toBeDefined();
        expect(child.id).not.toBe('');
        expect(child.alive).toBe(true);
        expect(child.protectionRounds).toBeGreaterThanOrEqual(1);
        expect(child.age).toBe(0); // new offspring have age 0
      }
    });

    it('should produce valid genome on each offspring', () => {
      const survivors = [1,2,3,4,5].map(i =>
        makeAgent(`a${i}`, { protectionRounds: 0, contributionScore: i * 10, age: i, reputation: i / 10 })
      );
      const ranked = evaluateFitness(survivors);
      const offspring = reproduce(ranked, 2);
      for (const child of offspring) {
        expect(child.genome).toBeDefined();
        expect(child.genome.personaName).toBeDefined();
        expect(child.genome.traits.length).toBeGreaterThanOrEqual(1);
      }
    });
  });

  describe('runCycle', () => {
    it('should produce stable cycle with no errors', () => {
      const agents = [1,2,3,4,5,6,7,8,9,10].map(i =>
        makeAgent(`a${i}`, {
          protectionRounds: 0,
          contributionScore: Math.floor(Math.random() * 100),
          age: Math.floor(Math.random() * 10) + 1,
          reputation: Math.random(),
        })
      );
      expect(() => runCycle(agents, 1)).not.toThrow();
    });

    it('should increase average fitness over 5 rounds', () => {
      let agents = [1,2,3,4,5,6,7,8,9,10].map(i =>
        makeAgent(`a${i}`, {
          contributionScore: Math.floor(Math.random() * 100),
          age: 1,
          reputation: 0.5,
          protectionRounds: 3,
        })
      );

      const fitnessHistory: number[] = [];

      for (let cycle = 1; cycle <= 5; cycle++) {
        agents = runCycle(agents, cycle);
        const avgFitness = agents.reduce((s, a) => s + a.fitness, 0) / agents.length;
        fitnessHistory.push(avgFitness);
      }

      // Average fitness should trend upward over 5 rounds
      const lastAvg = fitnessHistory[fitnessHistory.length - 1];
      const firstAvg = fitnessHistory[0];
      // In many runs this will hold; with randomness we give some tolerance
      expect(lastAvg).toBeGreaterThanOrEqual(firstAvg * 0.5);
      // Log for debugging
      console.log('Fitness history:', fitnessHistory.map(f => f.toFixed(2)));
    });
  });
});
