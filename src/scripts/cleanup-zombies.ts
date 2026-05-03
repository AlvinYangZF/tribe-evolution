#!/usr/bin/env node
/**
 * One-shot cleanup for zombie agents.
 *
 * Before the dead-of-age fix, agents that hit age >= 50 were flipped
 * `alive: false` in memory but never persisted to disk, so they revived
 * every cycle. This script walks `ecosystem/agents/*.json` once and
 * rewrites `alive: false` on any agent file with `age >= 50`.
 *
 * Usage:
 *   npx tsx src/scripts/cleanup-zombies.ts              # default ./ecosystem
 *   ECOSYSTEM_DIR=./other npx tsx src/scripts/cleanup-zombies.ts
 *   npx tsx src/scripts/cleanup-zombies.ts --dry-run    # report only
 */
import * as fs from 'node:fs/promises';
import * as path from 'node:path';
import { loadConfig } from '../config/index.js';
import { safeWriteJSON } from '../shared/filesystem.js';
import type { AgentState } from '../shared/types.js';

const DEATH_AGE = 50;

async function main() {
  const dryRun = process.argv.includes('--dry-run');
  const config = loadConfig();
  const agentsDir = path.join(config.ecosystemDir, 'agents');

  let files: string[];
  try {
    files = (await fs.readdir(agentsDir)).filter((f) => f.endsWith('.json'));
  } catch (err: unknown) {
    const m = err instanceof Error ? err.message : String(err);
    console.error(`Cannot read ${agentsDir}: ${m}`);
    process.exit(1);
  }

  let scanned = 0;
  let zombies = 0;
  let fixed = 0;

  for (const file of files) {
    scanned++;
    const fullPath = path.join(agentsDir, file);
    let agent: AgentState;
    try {
      agent = JSON.parse(await fs.readFile(fullPath, 'utf-8')) as AgentState;
    } catch (err: unknown) {
      const m = err instanceof Error ? err.message : String(err);
      console.warn(`  ⚠️  ${file}: parse failed (${m}) — skipping`);
      continue;
    }

    if (agent.alive && agent.age >= DEATH_AGE) {
      zombies++;
      console.log(
        `  💀 ${agent.id} (${agent.genome?.personaName ?? '?'}) ` +
          `gen=${agent.generation} age=${agent.age} → alive=false`,
      );
      if (!dryRun) {
        agent.alive = false;
        await safeWriteJSON(fullPath, agent);
        fixed++;
      }
    }
  }

  console.log('');
  console.log(`Scanned: ${scanned} agent file(s)`);
  console.log(`Zombies: ${zombies} (alive=true, age>=${DEATH_AGE})`);
  if (dryRun) {
    console.log('Dry run — no files modified. Re-run without --dry-run to apply.');
  } else {
    console.log(`Fixed:   ${fixed}`);
  }
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
