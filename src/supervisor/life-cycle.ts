import { AgentState, Gender } from '../shared/types.js';
import { createRandomDiploidGenome, expressGenome, expressedToGenome, sexualReproduce, mutateDiploid } from '../agent/genome.js';

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
 * Aging penalty (age >= 30): fitness -= (age - 29) * 5
 * Agents age >= 50 are marked as dead (alive = false).
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

    // Aging penalty — age >= 30: fitness drops by (age - 29) * 5 per cycle
    if (agent.age >= 30) {
      fitness -= (agent.age - 29) * 5;
    }

    // Death at age >= 50
    if (agent.age >= 50) {
      agent.alive = false;
    }

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
 * Check if an agent can reproduce.
 * - Must be alive
 * - Must be age < 50 (too old to reproduce)
 * - Must have a valid diploidGenome with a gender
 */
export function canReproduce(agent: AgentState): boolean {
  if (!agent.alive) return false;
  if (agent.age >= 50) return false;
  if (!agent.diploidGenome || !agent.diploidGenome.gender) return false;
  return true;
}

/**
 * Reproduce to create new agents from survivors using sexual reproduction.
 * Parents must be opposite genders for pairing.
 *
 * @param ranked - Surviving agents ranked by fitness
 * @param count - Number of offspring to create
 * @returns Array of new AgentState objects
 *
 * Rules:
 * - Only male+female pairs can reproduce (sexual reproduction)
 * - Parents are selected by fitness-weighted random within their gender
 * - Each child is the result of sexualReproduce(parentA, parentB)
 * - Mutation is applied at 15% rate per gene
 */
export function reproduce(ranked: RankedAgent[], count: number): AgentState[] {
  if (ranked.length === 0) return [];

  const offspring: AgentState[] = [];

  // Filter eligible agents
  const eligible = ranked.filter(r => canReproduce(r.agent));
  if (eligible.length < 2) {
    // Fallback: asexual cloning if not enough eligible agents
    return reproduceAsexual(ranked, count);
  }

  // Split by gender
  const males = eligible.filter(r => r.agent.diploidGenome.gender === 'male');
  const females = eligible.filter(r => r.agent.diploidGenome.gender === 'female');

  // If no opposite-gender pairs available, fall back to asexual
  if (males.length === 0 || females.length === 0) {
    return reproduceAsexual(ranked, count);
  }

  // Compute fitness weights within each gender
  function computeWeights(group: typeof males): { agents: AgentState[]; weights: number[]; total: number } {
    const agents = group.map(r => r.agent);
    const weights = group.map(r => Math.max(r.fitness, 0.01));
    const total = weights.reduce((s, v) => s + v, 0);
    return { agents, weights, total };
  }

  const maleWeights = computeWeights(males);
  const femaleWeights = computeWeights(females);

  function selectFromGroup(g: typeof maleWeights): AgentState {
    if (g.total <= 0) {
      return g.agents[Math.floor(Math.random() * g.agents.length)];
    }
    let r = Math.random() * g.total;
    for (let i = 0; i < g.agents.length; i++) {
      r -= g.weights[i];
      if (r <= 0) return g.agents[i];
    }
    return g.agents[g.agents.length - 1];
  }

  for (let i = 0; i < count; i++) {
    const maleParent = selectFromGroup(maleWeights);
    const femaleParent = selectFromGroup(femaleWeights);

    // Sexual reproduction
    const childDiploid = sexualReproduce(maleParent.diploidGenome, femaleParent.diploidGenome);
    // Mutation
    const mutatedDiploid = mutateDiploid(childDiploid, 0.15);
    // Express to genome
    const expressed = expressGenome(mutatedDiploid);
    const genome = expressedToGenome(expressed);

    const newAgent: AgentState = {
      id: generateId(),
      genome,
      diploidGenome: mutatedDiploid,
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
 * Fallback: asexual reproduction (single-parent cloning with mutation).
 * Used when not enough eligible agents of both genders exist.
 */
function reproduceAsexual(ranked: RankedAgent[], count: number): AgentState[] {
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

  const offspring: AgentState[] = [];
  for (let i = 0; i < count; i++) {
    const parent = selectParent();

    // Clone with mutation
    const parentDiploid = parent.diploidGenome;
    const childDiploid = mutateDiploid(JSON.parse(JSON.stringify(parentDiploid)), 0.15);
    const expressed = expressGenome(childDiploid);
    const genome = expressedToGenome(expressed);

    const newAgent: AgentState = {
      id: generateId(),
      genome,
      diploidGenome: childDiploid,
      generation: 0,
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
 * Run one full evolution cycle.
 *
 * Steps:
 * 1. Evaluate fitness for all agents (with aging penalties)
 * 2. Eliminate bottom rate%
 * 3. Reproduce to replace eliminated agents (sexual reproduction)
 * 4. Increment age for all, decrement protection for survivors
 * 5. Return new agent population
 *
 * @param agents - Current population
 * @param cycleNumber - Current cycle number (1-indexed)
 * @returns Next generation agent pool
 */
export function runCycle(agents: AgentState[], cycleNumber: number, maxAgents: number = 20): AgentState[] {
  // Step 1: Evaluate (includes aging penalty and death at age 50)
  const ranked = evaluateFitness(agents);

  // Update fitness values on agents
  for (const r of ranked) {
    r.agent.fitness = r.fitness;
  }

  // Separate agents that died of old age (age >= 50)
  const aliveRanked = ranked.filter(r => r.agent.alive);
  const deadOfAge = ranked.filter(r => !r.agent.alive).map(r => ({
    ...r.agent,
    alive: false,
  }));

  // Step 2: Eliminate among alive agents only
  let { survivors, eliminated } = eliminate(aliveRanked, 0.3);
  eliminated.push(...deadOfAge);

  // Enforce max population cap — eliminate lowest fitness beyond max
  const sortedSurvivors = [...survivors].sort((a, b) => {
    const fa = ranked.find(r => r.agent.id === a.id)?.fitness ?? 0;
    const fb = ranked.find(r => r.agent.id === b.id)?.fitness ?? 0;
    return fb - fa;
  });
  while (sortedSurvivors.length > maxAgents) {
    const removed = sortedSurvivors.pop()!;
    removed.alive = false;
    eliminated.push(removed);
  }
  survivors = sortedSurvivors;

  // Only reproduce enough to fill slots
  const slots = Math.max(0, maxAgents - survivors.length);
  const eliminatedCount = Math.min(eliminated.length, slots);

  // Step 3: Reproduce (sexual reproduction with gender pairing)
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
