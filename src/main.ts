#!/usr/bin/env node
/**
 * Tribe Evolution — Entry Point
 * 
 * Usage:
 *   npm run seed    - Seed initial population
 *   npm start       - Start evolution ecosystem
 *   npm run dev     - Start with debug cycle (10s)
 */

import { loadConfig } from './config/index.js';
import { Supervisor } from './supervisor/index.js';
import { createRandomGenome, createRandomDiploidGenome, expressGenome, expressedToGenome } from './agent/genome.js';
import { ensureDir, safeWriteJSON } from './shared/filesystem.js';
import * as fs from 'node:fs/promises';
import * as path from 'node:path';

const COMMAND = process.argv[2] || 'start';

async function seed(config: ReturnType<typeof loadConfig>) {
  console.log('🌱 Seeding initial population...\n');

  const agentsDir = path.join(config.ecosystemDir, 'agents');
  await ensureDir(agentsDir);

  const roleTemplates = [
    { name: 'Explorer', traits: ['curious', 'explorer'], collabBias: 0.3, risk: 0.7, commFreq: 0.4 },
    { name: 'Worker', traits: ['helpful', 'cooperative'], collabBias: 0.8, risk: 0.3, commFreq: 0.5 },
    { name: 'Creator', traits: ['creative', 'curious'], collabBias: 0.4, risk: 0.6, commFreq: 0.6 },
    { name: 'Observer', traits: ['cautious', 'cooperative'], collabBias: 0.6, risk: 0.2, commFreq: 0.8 },
    { name: 'Hunter', traits: ['aggressive', 'explorer'], collabBias: 0.2, risk: 0.9, commFreq: 0.3 },
    { name: 'Merchant', traits: ['cooperative', 'helpful'], collabBias: 0.9, risk: 0.4, commFreq: 0.9 },
    { name: 'Scientist', traits: ['curious', 'creative'], collabBias: 0.5, risk: 0.5, commFreq: 0.5 },
    { name: 'Guardian', traits: ['cautious', 'helpful'], collabBias: 0.7, risk: 0.2, commFreq: 0.4 },
    { name: 'Scout', traits: ['explorer', 'aggressive'], collabBias: 0.3, risk: 0.8, commFreq: 0.3 },
    { name: 'Diplomat', traits: ['cooperative', 'creative'], collabBias: 0.8, risk: 0.3, commFreq: 0.7 },
  ];

  for (let i = 0; i < 10; i++) {
    const template = roleTemplates[i];
    const gender: 'male' | 'female' = i < 5 ? 'male' : 'female';
    const diploidGenome = createRandomDiploidGenome(gender);
    // Override with template (set both dominant and recessive)
    diploidGenome.personaName = { dominant: template.name, recessive: template.name };
    diploidGenome.traits = template.traits.map(t => ({ dominant: t as any, recessive: t as any }));
    diploidGenome.collabBias = { dominant: template.collabBias, recessive: template.collabBias };
    diploidGenome.riskTolerance = { dominant: template.risk, recessive: template.risk };
    diploidGenome.communicationFreq = { dominant: template.commFreq, recessive: template.commFreq };

    // Express to get haploid genome for backward compatibility
    const expressed = expressGenome(diploidGenome);
    const genome = expressedToGenome(expressed);

    const agentId = `agent_${String(i + 1).padStart(3, '0')}`;
    const agentFile = path.join(agentsDir, agentId + '.json');
    await safeWriteJSON(agentFile, {
      id: agentId,
      genome,
      diploidGenome,
      generation: 0,
      parentId: null,
      tokenBalance: config.defaultTokenPerCycle,
      contributionScore: 0,
      reputation: 1.0,
      dealsKept: 0,
      dealsBroken: 0,
      fitness: 0,
      age: 0,
      alive: true,
      protectionRounds: config.newAgentProtectionRounds,
      createdAt: Date.now(),
    });

    const genderEmoji = gender === 'male' ? '♂️' : '♀️';
    console.log(`  🧬 ${agentId} — ${genome.personaName} ${genderEmoji} (${genome.traits.join(', ')})`);
  }

  console.log(`  👤 5 male, 5 female agents`);

  // Init event log (only if not already present)
  const eventLogDir = path.join(config.ecosystemDir, 'event-log');
  await ensureDir(eventLogDir);
  const eventsPath = path.join(eventLogDir, 'events.jsonl');
  try {
    await fs.access(eventsPath);
  } catch {
    await fs.writeFile(eventsPath, '', 'utf-8');
  }

  // Init reputation log (only if not already present)
  const repDir = path.join(config.ecosystemDir, 'reputation');
  await ensureDir(repDir);
  const repLogPath = path.join(repDir, 'log.jsonl');
  try {
    await fs.access(repLogPath);
  } catch {
    await fs.writeFile(repLogPath, '', 'utf-8');
  }

  // Init config (only if not already present)
  const configPath = path.join(config.ecosystemDir, 'config.json');
  try {
    await fs.access(configPath);
  } catch {
    await safeWriteJSON(configPath, {
      cycleIntervalMs: config.cycleIntervalMs,
      eliminationRate: config.eliminationRate,
      mutationBaseRate: config.mutationBaseRate,
      maxAgents: config.maxAgents,
      defaultTokenPerCycle: config.defaultTokenPerCycle,
      newAgentProtectionRounds: config.newAgentProtectionRounds,
    });
  }

  // Init resources (only if not already present)
  const resourcesDir = path.join(config.ecosystemDir, 'resources');
  await ensureDir(resourcesDir);
  const resourcesPath = path.join(resourcesDir, 'resources.json');
  try {
    await fs.access(resourcesPath);
  } catch {
    const defaultResources = [
      { id: 'res_001', type: 'file_lock', name: 'Data Lake Alpha', ownerId: null, lockedAt: null, lockExpiresAt: null, leasePrice: 1000 },
      { id: 'res_002', type: 'file_lock', name: 'Compute Slot Beta', ownerId: null, lockedAt: null, lockExpiresAt: null, leasePrice: 2000 },
      { id: 'res_003', type: 'skill_package', name: 'Advanced Search', ownerId: null, lockedAt: null, lockExpiresAt: null, leasePrice: 5000 },
      { id: 'res_004', type: 'data_set', name: 'Market Data Feed', ownerId: null, lockedAt: null, lockExpiresAt: null, leasePrice: 3000 },
      { id: 'res_005', type: 'tool_access', name: 'Code Analysis Tool', ownerId: null, lockedAt: null, lockExpiresAt: null, leasePrice: 1500 },
    ];
    await safeWriteJSON(resourcesPath, defaultResources);
  }

  console.log(`\n✅ Population seeded (10 agents)`);
  console.log(`📁 Ecosystem dir: ${config.ecosystemDir}`);
  console.log(`\nRun 'npm start' to begin evolution.\n`);
}

async function start(config: ReturnType<typeof loadConfig>) {
  console.log('🦞 Tribe Evolution starting...\n');
  console.log(`  Cycle interval: ${config.cycleIntervalMs}ms (${config.cycleIntervalMs / 1000}s)`);
  console.log(`  Max agents: ${config.maxAgents}`);
  console.log(`  Token per cycle: ${config.defaultTokenPerCycle.toLocaleString()}`);
  console.log(`  Ecosystem: ${config.ecosystemDir}\n`);

  const supervisor = new Supervisor(config);
  await supervisor.start();

  // Graceful shutdown
  const shutdown = async () => {
    console.log('\n\n⏹️  Shutting down...');
    await supervisor.shutdown();
    process.exit(0);
  };
  process.on('SIGINT', shutdown);
  process.on('SIGTERM', shutdown);
}

async function main() {
  const config = loadConfig();

  if (COMMAND === 'seed') {
    await seed(config);
  } else if (COMMAND === 'start' || COMMAND === 'dev') {
    if (COMMAND === 'dev') {
      config.cycleIntervalMs = 10000; // 10s for debugging
      console.log('🐛 Debug mode: 10s cycles\n');
    }
    await start(config);
  } else {
    console.log(`Usage: npm run seed | npm start | npm run dev`);
    process.exit(1);
  }
}

main().catch((err) => {
  console.error('Fatal error:', err);
  process.exit(1);
});
