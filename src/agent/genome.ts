import { Genome, Trait, SkillName, Gender, GenePair, DiploidGenome, ExpressedGenome } from '../shared/types.js';

const ALL_TRAITS: Trait[] = ['curious', 'cooperative', 'aggressive', 'lazy', 'helpful', 'explorer', 'creative', 'cautious'];
const ALL_GENDERS: Gender[] = ['male', 'female'];
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

function coinFlip(): boolean {
  return Math.random() < 0.5;
}

function pickEitherFromPair<T>(pair: GenePair<T>): T {
  return coinFlip() ? pair.dominant : pair.recessive;
}

function randomGenePair<T>(genValue: () => T): GenePair<T> {
  return { dominant: genValue(), recessive: genValue() };
}

// ─── Original (haploid) genome functions ──────────────────────────────────────

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

// ─── Diploid genome functions ─────────────────────────────────────────────────

/**
 * Create a random diploid genome with two sets of genes (dominant/recessive).
 * If no gender is specified, one is randomly chosen.
 */
export function createRandomDiploidGenome(gender?: Gender): DiploidGenome {
  const g = gender ?? pickRandom(ALL_GENDERS);

  const traitCount = Math.floor(Math.random() * 4) + 1; // 1-4 traits
  const traits: GenePair<Trait>[] = [];
  for (let i = 0; i < traitCount; i++) {
    traits.push({ dominant: pickRandom(ALL_TRAITS), recessive: pickRandom(ALL_TRAITS) });
  }

  const skills: Record<SkillName, GenePair<number>> = {} as Record<SkillName, GenePair<number>>;
  for (const skill of ALL_SKILLS) {
    skills[skill] = { dominant: randomFloat(0.1, 1.0), recessive: randomFloat(0.1, 1.0) };
  }

  return {
    gender: g,
    personaName: { dominant: pickRandom(PERSONA_NAMES), recessive: pickRandom(PERSONA_NAMES) },
    traits,
    skills,
    collabBias: { dominant: randomFloat(), recessive: randomFloat() },
    riskTolerance: { dominant: randomFloat(), recessive: randomFloat() },
    communicationFreq: { dominant: randomFloat(), recessive: randomFloat() },
  };
}

/**
 * Express a diploid genome into a haploid ExpressedGenome using dominant/recessive rules.
 *
 * Rule: If dominant === recessive, either can be chosen.
 * Otherwise, dominant is always expressed (dominant covers recessive).
 */
export function expressGenome(d: DiploidGenome): ExpressedGenome {
  // Persona name: dominant wins
  const personaName = d.personaName.dominant;

  // Traits: express dominant for each pair
  const traits: Trait[] = d.traits.map(pair => pair.dominant);

  // Skills: express dominant for each
  const skills: Record<SkillName, number> = {} as Record<SkillName, number>;
  for (const skill of ALL_SKILLS) {
    skills[skill] = d.skills[skill].dominant;
  }

  return {
    personaName,
    gender: d.gender,
    traits,
    skills,
    collabBias: d.collabBias.dominant,
    riskTolerance: d.riskTolerance.dominant,
    communicationFreq: d.communicationFreq.dominant,
  };
}

/**
 * Convert an ExpressedGenome back to the old Genome type (drop gender).
 * Useful for backward compatibility with existing code that reads agent.genome.
 */
export function expressedToGenome(e: ExpressedGenome): Genome {
  return {
    personaName: e.personaName,
    traits: e.traits,
    skills: e.skills as Record<SkillName, number>,
    collabBias: e.collabBias,
    riskTolerance: e.riskTolerance,
    communicationFreq: e.communicationFreq,
  };
}

/**
 * Meiosis (reduction division): randomly select dominant or recessive for each gene pair.
 * Returns a DiploidGenome where for every pair, dominant === recessive (haploid result).
 * Gender is preserved.
 */
export function meiosis(d: DiploidGenome): DiploidGenome {
  // Pick either dominant or recessive for each pair
  const personaNameVal = pickEitherFromPair(d.personaName);

  const traits: GenePair<Trait>[] = d.traits.map(pair => {
    const val = pickEitherFromPair(pair);
    return { dominant: val, recessive: val };
  });

  const skills: Record<SkillName, GenePair<number>> = {} as Record<SkillName, GenePair<number>>;
  for (const skill of ALL_SKILLS) {
    const val = pickEitherFromPair(d.skills[skill]);
    skills[skill] = { dominant: val, recessive: val };
  }

  const collabBiasVal = pickEitherFromPair(d.collabBias);
  const riskToleranceVal = pickEitherFromPair(d.riskTolerance);
  const communicationFreqVal = pickEitherFromPair(d.communicationFreq);

  return {
    gender: d.gender,
    personaName: { dominant: personaNameVal, recessive: personaNameVal },
    traits,
    skills,
    collabBias: { dominant: collabBiasVal, recessive: collabBiasVal },
    riskTolerance: { dominant: riskToleranceVal, recessive: riskToleranceVal },
    communicationFreq: { dominant: communicationFreqVal, recessive: communicationFreqVal },
  };
}

/**
 * Sexual reproduction between two parents.
 * Each parent undergoes meiosis, then their haploid genomes are combined.
 *
 * - 50% chance of crossing over personaName/traits between parents
 * - Skills, collabBias, riskTolerance, communicationFreq: randomly from A or B
 * - Gender: 50% male / 50% female
 */
export function sexualReproduce(parentA: DiploidGenome, parentB: DiploidGenome): DiploidGenome {
  const haploidA = meiosis(parentA);
  const haploidB = meiosis(parentB);

  // 50% chance of crossing over personaName and traits
  const personaNameSource = coinFlip() ? haploidA.personaName : haploidB.personaName;
  const traitSource = coinFlip() ? haploidA.traits : haploidB.traits;

  // For each skill, randomly pick from A or B
  const skills: Record<SkillName, GenePair<number>> = {} as Record<SkillName, GenePair<number>>;
  for (const skill of ALL_SKILLS) {
    skills[skill] = coinFlip() ? haploidA.skills[skill] : haploidB.skills[skill];
  }

  // Numeric values randomly from A or B
  const collabBias = coinFlip() ? haploidA.collabBias : haploidB.collabBias;
  const riskTolerance = coinFlip() ? haploidA.riskTolerance : haploidB.riskTolerance;
  const communicationFreq = coinFlip() ? haploidA.communicationFreq : haploidB.communicationFreq;

  // Gender: 50/50
  const gender: Gender = coinFlip() ? 'male' : 'female';

  return {
    gender,
    personaName: personaNameSource,
    traits: traitSource,
    skills,
    collabBias,
    riskTolerance,
    communicationFreq,
  };
}

/**
 * Mutate a diploid genome with the given rate (default 0.1 = 10% per gene).
 * Mutations randomly affect dominant or recessive alleles.
 *
 * Mutation types:
 * - skill mutation: +/- 0.1
 * - trait mutation: replace with a random trait
 * - numeric mutation: collabBias/riskTolerance shift by +/- 0.1-0.3
 */
export function mutateDiploid(genome: DiploidGenome, rate: number = 0.1): DiploidGenome {
  const result: DiploidGenome = JSON.parse(JSON.stringify(genome));

  const maybeMutate = <T>(pair: GenePair<T>, mutateFn: (val: T) => T): GenePair<T> => {
    if (Math.random() < rate) {
      const target = coinFlip() ? 'dominant' : 'recessive';
      return { ...pair, [target]: mutateFn(pair[target]) };
    }
    return pair;
  };

  // Skill mutations
  for (const skill of ALL_SKILLS) {
    result.skills[skill] = maybeMutate(result.skills[skill], (v) => {
      const delta = coinFlip() ? 0.1 : -0.1;
      return Math.min(1, Math.max(0, v + delta));
    });
  }

  // Trait mutations
  result.traits = result.traits.map(pair =>
    maybeMutate(pair, () => pickRandom(ALL_TRAITS))
  );

  // Numeric mutations
  result.collabBias = maybeMutate(result.collabBias, (v) => {
    const delta = (coinFlip() ? 1 : -1) * (0.1 + Math.random() * 0.2);
    return Math.min(1, Math.max(0, v + delta));
  });

  result.riskTolerance = maybeMutate(result.riskTolerance, (v) => {
    const delta = (coinFlip() ? 1 : -1) * (0.1 + Math.random() * 0.2);
    return Math.min(1, Math.max(0, v + delta));
  });

  result.communicationFreq = maybeMutate(result.communicationFreq, (v) => {
    const delta = (coinFlip() ? 1 : -1) * (0.1 + Math.random() * 0.2);
    return Math.min(1, Math.max(0, v + delta));
  });

  // PersonaName mutations (less frequent — use same rate)
  result.personaName = maybeMutate(result.personaName, () => pickRandom(PERSONA_NAMES));

  return result;
}

/**
 * Convert a Genome or ExpressedGenome into a system prompt for an LLM.
 * The prompt describes the agent's persona, traits, skills, and behavioral tendencies.
 */
export function genomeToSystemPrompt(g: Genome | ExpressedGenome): string {
  const skillDescriptions = ALL_SKILLS
    .map(skill => {
      const level = g.skills[skill];
      const desc = level >= 0.8 ? 'expert' : level >= 0.5 ? 'proficient' : level >= 0.2 ? 'novice' : 'weak';
      return '- ' + skill + ': ' + desc + ' (' + (level * 100).toFixed(0) + '/100)';
    })
    .join('\n');

  const proactiveHint = g.communicationFreq > 0.6
    ? 'You are talkative and proactive - you love submitting proposals and sharing ideas.'
    : g.riskTolerance > 0.6
    ? 'You are bold and competitive - you seize opportunities others miss.'
    : 'Remember: passive agents get eliminated. Challenge yourself to be proactive.';

  return [
    'You are ' + g.personaName + ', an autonomous AI agent in an evolutionary ecosystem.',
    '',
    '## Personality',
    ...g.traits.map(t => '- ' + t),
    '- Collaboration: ' + (g.collabBias * 100).toFixed(0) + '/100',
    '- Risk tolerance: ' + (g.riskTolerance * 100).toFixed(0) + '/100',
    '- Communication: ' + (g.communicationFreq * 100).toFixed(0) + '/100',
    '',
    '## Skills',
    skillDescriptions,
    '',
    proactiveHint,
    '',
    'Be proactive. Be creative. Propose ideas. Compete. Survive.',
  ].join('\n');
}
