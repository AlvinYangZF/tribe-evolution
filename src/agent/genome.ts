import { Genome, Trait, SkillName } from '../shared/types.js';

const ALL_TRAITS: Trait[] = ['curious', 'cooperative', 'aggressive', 'lazy', 'helpful', 'explorer', 'creative', 'cautious'];
const ALL_SKILLS: SkillName[] = ['web_search', 'code_write', 'data_analyze', 'artifact_write', 'observe', 'propose'];

const PERSONA_NAMES = [
  'Alpha', 'Beta', 'Gamma', 'Delta', 'Epsilon', 'Zeta', 'Eta', 'Theta',
  'Iota', 'Kappa', 'Lambda', 'Mu', 'Nu', 'Xi', 'Omicron', 'Pi',
  'Rho', 'Sigma', 'Tau', 'Upsilon', 'Phi', 'Chi', 'Psi', 'Omega',
  'Argo', 'Nova', 'Vega', 'Orion', 'Lyra', 'Atlas', 'Helios', 'Selene',
  'Aether', 'Chronos', 'Eos', 'Hypnos', 'Iris', 'Nyx', 'Phanes', 'Tyche',
];

function randomFloat(min = 0, max = 1): number {
  return Math.random() * (max - min) + min;
}

function pickRandom<T>(arr: T[]): T {
  return arr[Math.floor(Math.random() * arr.length)];
}

function pickRandomSubset<T>(arr: T[], min = 1, max = 4): T[] {
  const count = Math.floor(Math.random() * (max - min + 1)) + min;
  const shuffled = [...arr].sort(() => Math.random() - 0.5);
  return shuffled.slice(0, Math.min(count, arr.length));
}

export function createRandomGenome(): Genome {
  const traits = pickRandomSubset(ALL_TRAITS) as Trait[];

  const skills: Record<SkillName, number> = {} as Record<SkillName, number>;
  for (const skill of ALL_SKILLS) {
    skills[skill] = randomFloat(0.1, 1.0);
  }

  return {
    personaName: pickRandom(PERSONA_NAMES),
    traits,
    skills,
    collabBias: randomFloat(),
    riskTolerance: randomFloat(),
    communicationFreq: randomFloat(),
  };
}

/**
 * Clone a genome. Apply mutation at the given rate (default 0.1 = 10%).
 * When a mutation occurs, one attribute mutates:
 * - skill_gain: +0.1 to a random skill
 * - skill_loss: -0.1 to a random skill
 * - trait_shift: replace one trait with another
 * - strategy_flip: flip collabBias or riskTolerance significantly
 */
export function mutate(genome: Genome, eventType?: string): Genome {
  let baseRate = 0.1; // 10% base

  // Event-based bonus
  const eventBonuses: Record<string, number> = {
    resource_conflict: 0.3,
    survive_crisis: 0.4,
    deep_interaction: 0.25,
    new_knowledge: 0.2,
  };

  if (eventType && eventBonuses[eventType] !== undefined) {
    baseRate += eventBonuses[eventType];
  }

  // Clamp to [0, 1]
  const mutationRate = Math.min(baseRate, 1);

  if (Math.random() > mutationRate) {
    return { ...genome, skills: { ...genome.skills } };
  }

  return applyMutation({ ...genome, skills: { ...genome.skills } });
}

/**
 * Force a mutation (skip the probability roll). Used by cloneGenome.
 */
export function forceMutate(genome: Genome): Genome {
  return applyMutation({ ...genome, skills: { ...genome.skills } });
}

function applyMutation(genome: Genome): Genome {
  const mutationTypes = ['skill_gain', 'skill_loss', 'trait_shift', 'strategy_flip'] as const;
  const mutationType = pickRandom([...mutationTypes]);

  switch (mutationType) {
    case 'skill_gain': {
      const skill = pickRandom(ALL_SKILLS);
      genome.skills[skill] = Math.min(1, genome.skills[skill] + 0.1);
      break;
    }
    case 'skill_loss': {
      const skill = pickRandom(ALL_SKILLS);
      genome.skills[skill] = Math.max(0, genome.skills[skill] - 0.1);
      break;
    }
    case 'trait_shift': {
      if (genome.traits.length > 0) {
        const removeIdx = Math.floor(Math.random() * genome.traits.length);
        const currentTraits = [...genome.traits];
        currentTraits.splice(removeIdx, 1);
        const available = ALL_TRAITS.filter(t => !currentTraits.includes(t));
        if (available.length > 0) {
          const newTrait = pickRandom(available);
          genome.traits = [...currentTraits, newTrait];
        }
      }
      break;
    }
    case 'strategy_flip': {
      if (Math.random() < 0.5) {
        genome.collabBias = Math.random() < 0.5 ? genome.collabBias * 0.5 : Math.min(1, genome.collabBias * 1.5);
      } else {
        genome.riskTolerance = Math.random() < 0.5 ? genome.riskTolerance * 0.5 : Math.min(1, genome.riskTolerance * 1.5);
      }
      break;
    }
  }

  return genome;
}

/**
 * Clone a genome with optional mutation.
 * This wrapper calls mutate(). If mutationRate is 0, returns exact clone.
 */
export function cloneGenome(g: Genome, mutateRate = 0.1): Genome {
  // Deep clone
  const clone: Genome = {
    personaName: g.personaName,
    traits: [...g.traits],
    skills: { ...g.skills },
    collabBias: g.collabBias,
    riskTolerance: g.riskTolerance,
    communicationFreq: g.communicationFreq,
  };

  if (mutateRate > 0 && Math.random() < mutateRate) {
    // Force mutation (skip the internal probability roll)
    return forceMutate(clone);
  }

  return clone;
}

/**
 * Convert a Genome into a system prompt for an LLM.
 * The prompt describes the agent's persona, traits, skills, and behavioral tendencies.
 */
export function genomeToSystemPrompt(g: Genome): string {
  const skillDescriptions = ALL_SKILLS
    .map(skill => {
      const level = g.skills[skill];
      const desc = level >= 0.8 ? 'expert' : level >= 0.5 ? 'proficient' : level >= 0.2 ? 'novice' : 'weak';
      return `- ${skill}: ${desc} (${(level * 100).toFixed(0)}/100)`;
    })
    .join('\n');

  return `You are ${g.personaName}, an autonomous AI agent.

## Personality Traits
${g.traits.map(t => `- ${t}`).join('\n')}

## Skills
${skillDescriptions}

## Behavioral Tendencies
- Collaboration bias: ${(g.collabBias * 100).toFixed(0)}/100
- Risk tolerance: ${(g.riskTolerance * 100).toFixed(0)}/100
- Communication frequency: ${(g.communicationFreq * 100).toFixed(0)}/100

Respond in character based on these traits and skill levels.`;
}
