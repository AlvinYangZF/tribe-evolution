#!/usr/bin/env node
/**
 * Tribe Evolution — Quick Demo
 * Shows the core evolution engine working end-to-end
 * without needing full Supervisor integration.
 * 
 * Usage: npx tsx src/demo.ts
 */

import { loadConfig } from './config/index.js';
import { ensureDir, safeWriteJSON, safeReadJSON } from './shared/filesystem.js';
import { createRandomGenome, genomeToSystemPrompt } from './agent/genome.js';
import { runCycle } from './supervisor/life-cycle.js';
import { calculateContributionScores, allocateTokens } from './supervisor/token-economy.js';
import type { AgentState, Genome } from './shared/types.js';
import * as path from 'node:path';
import * as fs from 'node:fs/promises';

function createAgent(id: string, genome: Genome, generation: number, parentId: string | null): AgentState {
  return {
    id,
    genome,
    generation,
    parentId,
    tokenBalance: 1_000_000,
    contributionScore: 0,
    reputation: 1.0,
    dealsKept: 0,
    dealsBroken: 0,
    fitness: 0,
    age: 0,
    alive: true,
    protectionRounds: 3,
    createdAt: Date.now(),
  };
}

function generateStats(agents: AgentState[], label: string) {
  const alive = agents.filter(a => a.alive);
  const fitnesses = alive.map(a => a.fitness);
  const avgFitness = fitnesses.reduce((a, b) => a + b, 0) / fitnesses.length;
  const maxFitness = Math.max(...fitnesses);
  const minFitness = Math.min(...fitnesses);
  const genomes = alive.map(a => a.genome.personaName);
  const generations = [...new Set(alive.map(a => a.generation))].sort((a, b) => a - b);
  const traits = new Map<string, number>();
  alive.forEach(a => a.genome.traits.forEach(t => traits.set(t, (traits.get(t) || 0) + 1)));

  console.log(`\n${'='.repeat(60)}`);
  console.log(`  ${label}`);
  console.log(`  Population: ${alive.length} alive`);
  console.log(`  Generations: ${Math.min(...alive.map(a => a.generation))} - ${Math.max(...alive.map(a => a.generation))}`);
  console.log(`  Fitness: avg=${avgFitness.toFixed(1)} max=${maxFitness.toFixed(1)} min=${minFitness.toFixed(1)}`);
  console.log(`  Roles: ${genomes.join(', ')}`);
  console.log(`  Trait distribution:`);
  [...traits.entries()].sort((a, b) => b[1] - a[1]).forEach(([t, c]) => {
    const bar = '█'.repeat(Math.round(c / alive.length * 30));
    console.log(`    ${t.padEnd(15)} ${c.toString().padStart(2)} ${bar}`);
  });
  console.log(`${'='.repeat(60)}\n`);
}

async function main() {
  console.log('🧬 Tribe Evolution — Quick Demo\n');

  // Create ecosystem directory
  const demoDir = './ecosystem-demo';
  await ensureDir(demoDir);

  // Seed initial population with diverse roles
  const roles = [
    { name: 'Explorer', traits: ['curious', 'explorer'] as any, cb: 0.3, risk: 0.7, comm: 0.4 },
    { name: 'Worker', traits: ['helpful', 'cooperative'] as any, cb: 0.8, risk: 0.3, comm: 0.5 },
    { name: 'Creator', traits: ['creative', 'curious'] as any, cb: 0.4, risk: 0.6, comm: 0.6 },
    { name: 'Observer', traits: ['cautious', 'cooperative'] as any, cb: 0.6, risk: 0.2, comm: 0.8 },
    { name: 'Hunter', traits: ['aggressive', 'explorer'] as any, cb: 0.2, risk: 0.9, comm: 0.3 },
    { name: 'Merchant', traits: ['cooperative', 'helpful'] as any, cb: 0.9, risk: 0.4, comm: 0.9 },
    { name: 'Scientist', traits: ['curious', 'creative'] as any, cb: 0.5, risk: 0.5, comm: 0.5 },
    { name: 'Guardian', traits: ['cautious', 'helpful'] as any, cb: 0.7, risk: 0.2, comm: 0.4 },
    { name: 'Scout', traits: ['explorer', 'aggressive'] as any, cb: 0.3, risk: 0.8, comm: 0.3 },
    { name: 'Diplomat', traits: ['cooperative', 'creative'] as any, cb: 0.8, risk: 0.3, comm: 0.7 },
  ];

  let agents: AgentState[] = [];
  for (let i = 0; i < 10; i++) {
    const r = roles[i];
    const g = createRandomGenome();
    g.personaName = r.name;
    g.traits = r.traits;
    g.collabBias = r.cb;
    g.riskTolerance = r.risk;
    g.communicationFreq = r.comm;
    agents.push(createAgent(`agent_${String(i + 1).padStart(3, '0')}`, g, 0, null));
  }

  generateStats(agents, '🌱 GENERATION 0 — Initial Population');

  // Simulate 10 rounds of evolution
  for (let round = 1; round <= 10; round++) {
    // Random contribution scores (simulating agent activity)
    for (const agent of agents) {
      if (!agent.alive) continue;
      agent.contributionScore = Math.random() * 100;
      // Good agents do more
      if (agent.genome.collabBias > 0.6) agent.contributionScore += 20;
      if (agent.genome.riskTolerance > 0.6) agent.contributionScore += 10;
      if (agent.genome.traits.includes('curious')) agent.contributionScore += 15;
      if (agent.genome.traits.includes('helpful')) agent.contributionScore += 10;
    }

    // Run the evolution cycle
    agents = await runCycle(agents, round);

    const label = round <= 3 ? `🌱 GENERATION ${round} — Protection Phase` 
      : round === 4 ? `⚔️ GENERATION ${round} — First Elimination!`
      : round === 7 ? `⚔️ GENERATION ${round} — Mid-Evolution`
      : `🧬 GENERATION ${round}`;

    generateStats(agents, label);
  }

  // Print evolved genomes
  console.log('\n📊 Surviving Genomes (Top 5 by fitness):\n');
  const survivors = agents.filter(a => a.alive).sort((a, b) => b.fitness - a.fitness);
  for (const agent of survivors.slice(0, 5)) {
    const g = agent.genome;
    console.log(`  ${agent.id.padEnd(10)} ${g.personaName.padEnd(12)} gen=${agent.generation} fitness=${agent.fitness.toFixed(1)}`);
    console.log(`  ${' '.repeat(10)} traits: [${g.traits.join(', ')}]`);
    console.log(`  ${' '.repeat(10)} skills: {${Object.entries(g.skills).filter(([,v]) => v > 0).map(([k, v]) => `${k}:${v.toFixed(1)}`).join(', ')}}`);
    console.log(`  ${' '.repeat(10)} collab=${g.collabBias.toFixed(2)} risk=${g.riskTolerance.toFixed(2)} comm=${g.communicationFreq.toFixed(2)}`);
    console.log();
  }

  // Print extinction lineage
  const extinct = agents.filter(a => !a.alive);
  if (extinct.length > 0) {
    console.log(`💀 Extinct (${extinct.length} agents):`);
    for (const agent of extinct) {
      console.log(`  ${agent.id.padEnd(10)} ${agent.genome.personaName.padEnd(12)} gen=${agent.generation} age=${agent.age}`);
    }
  }

  console.log(`\n✅ Demo complete — ${survivors.length} survivors from ${agents.length} total across ${Math.max(...agents.map(a => a.generation))} generations\n`);

  // Cleanup
  await fs.rm(demoDir, { recursive: true, force: true }).catch(() => {});
}

main().catch(console.error);
