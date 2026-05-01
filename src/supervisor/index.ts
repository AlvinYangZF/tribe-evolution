import { EventEmitter } from 'node:events';
import path from 'node:path';
import fs from 'node:fs/promises';
import { EventLog } from './event-log.js';
import { Scheduler } from './scheduler.js';
import { ProposalManager } from './proposal.js';
import { runCycle as runLifeCycle } from './life-cycle.js';
import type { Config } from '../config/index.js';
import { ensureDir, safeWriteJSON, safeReadJSON } from '../shared/filesystem.js';
import type { AgentState, Genome } from '../shared/types.js';

/**
 * Supervisor main loop.
 * - Loads agents from disk
 * - Each cycle: load → think_cycle (if LLM available) → evaluate → eliminate → reproduce → save
 */
export class Supervisor extends EventEmitter {
  private config: Config;
  private eventLog: EventLog;
  private scheduler: Scheduler;
  private proposalManager: ProposalManager;
  private lastProposalCount: number = 0;
  private started = false;
  private agents: Map<string, AgentState> = new Map();
  private dashboard: { broadcast: () => Promise<void> } | null = null;

  constructor(config: Config) {
    super();
    this.config = config;
    this.eventLog = new EventLog(config.ecosystemDir);
    this.proposalManager = new ProposalManager(config.ecosystemDir);
    this.scheduler = new Scheduler({
      cycleIntervalMs: config.cycleIntervalMs,
    });

    this.scheduler.on('cycleStart', (cycleNum: number) => this.emit('cycleStart', cycleNum));
    this.scheduler.on('cycleEnd', (cycleNum: number) => this.emit('cycleEnd', cycleNum));
  }

  async start(): Promise<void> {
    if (this.started) return;
    this.started = true;

    await ensureDir(path.join(this.config.ecosystemDir, 'event-log'));
    await ensureDir(path.join(this.config.ecosystemDir, 'agents'));

    // Load existing agents from disk
    await this.loadAgents();

    // Start dashboard (with WebSocket server)
    try {
      const { startDashboard } = await import('../dashboard/server.js');
      this.dashboard = startDashboard(this.config.ecosystemDir, this.config.dashboardPort);
    } catch (err: unknown) {
      const msg = err instanceof Error ? err.message : String(err);
      console.warn(`Dashboard unavailable: ${msg}`);
    }

    await this.eventLog.append({
      type: 'agent_born',
      agentId: 'supervisor',
      data: { action: 'start', agentCount: this.agents.size },
    });

    console.log(`✅ ${this.agents.size} agents loaded, starting cycles...`);

    this.scheduler.startCycle((cycleNum) => this.runCycle(cycleNum));

    if (this.dashboard) {
      this.on('cycleEnd', async () => { await this.dashboard!.broadcast(); });
    }
  }

  private async loadAgents(): Promise<void> {
    this.agents.clear();
    const dir = path.join(this.config.ecosystemDir, 'agents');
    try {
      const files = await fs.readdir(dir);
      for (const file of files) {
        if (!file.endsWith('.json')) continue;
        const raw = await fs.readFile(path.join(dir, file), 'utf-8');
        const agent = JSON.parse(raw) as AgentState;
        this.agents.set(agent.id, agent);
      }
    } catch {
      // agents dir doesn't exist yet
    }
  }

  private async saveAgent(agent: AgentState): Promise<void> {
    const dir = path.join(this.config.ecosystemDir, 'agents');
    await safeWriteJSON(path.join(dir, `${agent.id}.json`), agent);
  }

  private async runCycle(cycleNum: number): Promise<void> {
    await this.eventLog.append({
      type: 'token_allocated',
      agentId: 'supervisor',
      data: { cycle: cycleNum, action: 'cycle_start' },
    });

    console.log(`\n🔄 Cycle ${cycleNum} — ${this.agents.size} agents`);

    // 1. Reload agents from disk (in case dashboard modified)
    await this.loadAgents();

    const alive = [...this.agents.values()].filter(a => a.alive);

    // 2. Assign random contribution scores to simulate agent activity
    // (In production, these would come from LLM think_cycle calls)
    for (const agent of alive) {
      const g = agent.genome;

      // Simulated contribution based on genome traits
      let score = Math.random() * 100;
      if (g.collabBias > 0.6) score += 20;       // cooperative agents contribute more
      if (g.riskTolerance > 0.6) score += 10;     // risk-takers try more things
      if (g.traits.includes('curious')) score += 15;
      if (g.traits.includes('helpful')) score += 10;
      if (g.traits.includes('lazy')) score -= 30;

      agent.contributionScore = Math.max(0, score);
      agent.age += 1;
    }

    // 3. Record contribution events
    for (const agent of alive) {
      await this.eventLog.append({
        type: 'task_completed',
        agentId: agent.id,
        data: { cycle: cycleNum, contribution: agent.contributionScore },
      });
    }

    // 4. Run evolution cycle
    const agentArray = [...this.agents.values()];
    const evolved = await runLifeCycle(agentArray, cycleNum, this.config.maxAgents);

    // 5. Save updated agents
    this.agents.clear();
    for (const agent of evolved) {
      this.agents.set(agent.id, agent);
      await this.saveAgent(agent);
    }

    // 6. Record birth/death events
    const newBorns = evolved.filter(a => a.age <= 1 && a.generation > 0);
    for (const agent of newBorns) {
      await this.eventLog.append({
        type: 'agent_born',
        agentId: agent.id,
        data: { generation: agent.generation, parentId: agent.parentId, personaName: agent.genome.personaName },
      });
      console.log(`  🐣 New: ${agent.id} (${agent.genome.personaName}) gen=${agent.generation}`);
    }

    const extinct = evolved.filter(a => !a.alive);
    for (const agent of extinct) {
      await this.eventLog.append({
        type: 'agent_extinct',
        agentId: agent.id,
        data: { generation: agent.generation, age: agent.age, fitness: agent.fitness },
      });
      console.log(`  💀 Extinct: ${agent.id} (${agent.genome.personaName}) age=${agent.age}`);
    }

    // Report mutations
    const mutants = evolved.filter(a => a.genome.traits.length > 2 || a.genome.riskTolerance > 0.9);
    for (const agent of mutants) {
      await this.eventLog.append({
        type: 'mutation',
        agentId: agent.id,
        data: { traits: agent.genome.traits, riskTolerance: agent.genome.riskTolerance },
      });
    }

    // 7. Scan proposals
    await this.scanProposals();

    // 8. Summary
    const totalFitness = alive.reduce((s, a) => s + a.fitness, 0);
    const avgFitness = alive.length > 0 ? (totalFitness / alive.length).toFixed(1) : '0';
    console.log(`  📊 ${alive.length} alive, avg fitness: ${avgFitness}`);

    await this.eventLog.append({
      type: 'task_completed',
      agentId: 'supervisor',
      data: { cycle: cycleNum, action: 'cycle_end', aliveCount: alive.length, avgFitness },
    });
  }

  private async scanProposals(): Promise<void> {
    try {
      const pending = await this.proposalManager.getPendingProposals();
      if (pending.length > this.lastProposalCount) {
        for (const p of pending.slice(this.lastProposalCount)) {
          console.log(`  📩 Proposal from ${p.agentId}: "${p.title}"`);
          await this.eventLog.append({
            type: 'proposal_created',
            agentId: p.agentId,
            data: { proposalId: p.id, title: p.title },
          });
        }
      }
      this.lastProposalCount = pending.length;
      const expired = await this.proposalManager.expireOldProposals();
      if (expired > 0) console.log(`  🧹 Expired ${expired} stale proposals`);
    } catch (err: unknown) {
      const msg = err instanceof Error ? err.message : String(err);
      console.warn(`  ⚠️ Proposal error: ${msg}`);
    }
  }

  async shutdown(): Promise<void> {
    this.scheduler.stop();
    if (this.started) {
      await this.eventLog.append({ type: 'agent_extinct', agentId: 'supervisor', data: { action: 'shutdown' } });
    }
    this.started = false;
  }

  getEventLog(): EventLog { return this.eventLog; }
  getProposalManager(): ProposalManager { return this.proposalManager; }
  getCurrentCycleNumber(): number { return this.scheduler.getCurrentCycleNumber(); }
}
