import { AgentState } from '../shared/types.js';
import { createRandomGenome, cloneGenome } from '../agent/genome.js';
import { v4 as uuidv4 } from 'uuid';

// Simple UUID generator without dependency
function generateId(): string {
  const chars = '0123456789abcdef';
  const sections = [8, 4, 4, 4, 12];
  return sections
    .map(len => {
      let s = '';
      for (let i = 0; i < len; i++) {
        s += chars[Math.floor(Math.random() * 16)];
      }
      return s;
    })
    .join('-');
}

export interface RankedAgent {
  agent: AgentState;
  fitness: number;
}

/**
 * Evaluate fitness for each agent.
 *
 * Formula: fitness = contributionScore × 0.5 + age × 2 + reputation × 10
 *
 * Protection bonus: agents with protectionRounds > 0 get +20 fitness
 * (to help them survive their first few cycles).
 *
 * Returns agents sorted by fitness descending.
 */
export function evaluateFitness(agents: AgentState[]): RankedAgent[] {
  const ranked: RankedAgent[] = agents.map((agent) => {
    let fitness =
      agent.contributionScore * 0.5 +
      agent.age * 2 +
      agent.reputation * 10;

    // Protection bonus — +20 for new agents (protectionRounds > 0)
    if (agent.protectionRounds > 0) {
      fitness += 20;
    }

    return { agent, fitness };
  });

  // Sort descending by fitness
  ranked.sort((a, b) => b.fitness - a.fitness);
  return ranked;
}

/**
 * Eliminate the bottom percentage of ranked agents.
 *
 * @param ranked - Agents sorted by fitness descending
 * @param rate - Fraction to eliminate (default 0.3)
 * @returns Survivors and eliminated agents
 *
 * Rule: Agents with protectionRounds > 0 are skipped during elimination.
 * If the lowest-fitness agent is protected, move up to the next.
 */
export function eliminate(
  ranked: RankedAgent[],
  rate: number = 0.3,
): { survivors: AgentState[]; eliminated: AgentState[] } {
  const toEliminate = Math.max(1, Math.round(ranked.length * rate));
  const eliminated: AgentState[] = [];
  const survivors: AgentState[] = [];

  // Sort ascending by fitness (lowest first) and try to eliminate
  const sortedAsc = [...ranked].sort((a, b) => a.fitness - b.fitness);

  for (const entry of sortedAsc) {
    if (eliminated.length >= toEliminate) {
      survivors.push(entry.agent);
      continue;
    }

    if (entry.agent.protectionRounds > 0) {
      // Protected — skip elimination, add to survivors
      survivors.push(entry.agent);
    } else {
      eliminated.push({ ...entry.agent, alive: false });
    }
  }

  // Any remaining agents that weren't iterated go to survivors
  return { survivors, eliminated };
}

/**
 * Reproduce to create new agents from survivors.
 * Uses fitness-weighted selection for parents.
 *
 * @param ranked - Surviving agents ranked by fitness
 * @param count - Number of offspring to create
 * @returns Array of new AgentState objects
 *
 * Rules:
 * - 50% chance: single-parent cloning (with mutation)
 * - 50% chance: two-parent crossover
 * - Parents selected by fitness-weighted random
 */
export function reproduce(ranked: RankedAgent[], count: number): AgentState[] {
  if (ranked.length === 0) return [];

  const offspring: AgentState[] = [];
  const agents = ranked.map(r => r.agent);
  const fitnessValues = ranked.map(r => r.fitness);
  const totalFitness = fitnessValues.reduce((s, v) => s + Math.max(v, 0.01), 0);

  function selectParent(): AgentState {
    if (totalFitness <= 0) {
      return agents[Math.floor(Math.random() * agents.length)];
    }
    let r = Math.random() * totalFitness;
    for (let i = 0; i < agents.length; i++) {
      r -= Math.max(fitnessValues[i], 0.01);
      if (r <= 0) return agents[i];
    }
    return agents[agents.length - 1];
  }

  for (let i = 0; i < count; i++) {
    const isCrossover = Math.random() < 0.5;
    let genome;

    if (isCrossover && ranked.length >= 2) {
      // Two-parent crossover
      const parentA = selectParent();
      const parentB = selectParent();
      genome = crossoverGenomes(parentA.genome, parentB.genome);
    } else {
      // Single-parent cloning with mutation
      const parent = selectParent();
      genome = cloneGenome(parent.genome, 0.15);
    }

    const newAgent: AgentState = {
      id: generateId(),
      genome,
      generation: 0, // Will be set by caller (runCycle)
      parentId: null,
      tokenBalance: 100,
      contributionScore: 0,
      reputation: 0.5,
      dealsKept: 0,
      dealsBroken: 0,
      fitness: 0,
      age: 0,
      alive: true,
      protectionRounds: 3,
      createdAt: Date.now(),
    };

    offspring.push(newAgent);
  }

  return offspring;
}

/**
 * Crossover two genomes: randomly pick traits, average skills, mix parameters.
 */
function crossoverGenomes(a: AgentState['genome'], b: AgentState['genome']): AgentState['genome'] {
  // Mix traits — take from both
  const combinedTraits = [...new Set([...a.traits, ...b.traits])];
  // Randomly keep some of the combined traits
  const shuffledTraits = [...combinedTraits].sort(() => Math.random() - 0.5);
  const traitCount = Math.max(1, Math.floor(Math.random() * combinedTraits.length) + 1);
  const traits = shuffledTraits.slice(0, Math.min(traitCount, combinedTraits.length));

  // Average skills (with slight randomness)
  const skillNames = Object.keys(a.skills) as Array<keyof typeof a.skills>;
  const skills: typeof a.skills = {} as typeof a.skills;
  for (const s of skillNames) {
    const avg = (a.skills[s] + b.skills[s]) / 2;
    skills[s] = Math.min(1, Math.max(0, avg + (Math.random() - 0.5) * 0.2));
  }

  // Mix parameters
  const pickMix = (va: number, vb: number) => {
    const avg = (va + vb) / 2;
    return Math.min(1, Math.max(0, avg + (Math.random() - 0.5) * 0.3));
  };

  return {
    personaName: Math.random() < 0.5 ? a.personaName : b.personaName,
    traits: traits as AgentState['genome']['traits'],
    skills,
    collabBias: pickMix(a.collabBias, b.collabBias),
    riskTolerance: pickMix(a.riskTolerance, b.riskTolerance),
    communicationFreq: pickMix(a.communicationFreq, b.communicationFreq),
  };
}

/**
 * Run one full evolution cycle.
 *
 * Steps:
 * 1. Evaluate fitness for all agents
 * 2. Eliminate bottom rate%
 * 3. Reproduce to replace eliminated agents
 * 4. Increment age for all, decrement protection for survivors
 * 5. Return new agent population
 *
 * @param agents - Current population
 * @param cycleNumber - Current cycle number (1-indexed)
 * @returns Next generation agent pool
 */
export function runCycle(agents: AgentState[], cycleNumber: number): AgentState[] {
  // Step 1: Evaluate
  const ranked = evaluateFitness(agents);

  // Update fitness values on agents
  for (const r of ranked) {
    r.agent.fitness = r.fitness;
  }

  // Step 2: Eliminate
  const { survivors, eliminated } = eliminate(ranked, 0.3);
  const eliminatedCount = eliminated.length;

  // Step 3: Reproduce
  const offspring = reproduce(ranked, eliminatedCount);

  // Step 4: Update ages and protections for survivors
  const updatedSurvivors = survivors.map((agent) => ({
    ...agent,
    age: agent.age + 1,
    protectionRounds: Math.max(0, agent.protectionRounds - 1),
  }));

  // Set generation on offspring
  const updatedOffspring = offspring.map((child) => ({
    ...child,
    generation: cycleNumber,
  }));

  // Step 5: Return new population
  return [...updatedSurvivors, ...updatedOffspring];
}
