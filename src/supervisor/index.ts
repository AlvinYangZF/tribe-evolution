import { EventEmitter } from 'node:events';
import path from 'node:path';
import fs from 'node:fs/promises';
import { EventLog } from './event-log.js';
import { Scheduler } from './scheduler.js';
import { ProposalManager } from './proposal.js';
import { runCycle as runLifeCycle } from './life-cycle.js';
import { notifyUser } from './notify.js';
import { decide } from '../agent/brain.js';
import { proxyCall } from './llm-proxy.js';
import { genomeToSystemPrompt } from '../agent/genome.js';
import type { Config } from '../config/index.js';
import { ensureDir, safeWriteJSON } from '../shared/filesystem.js';
import type { AgentState } from '../shared/types.js';

export class Supervisor extends EventEmitter {
  private config: Config;
  private eventLog: EventLog;
  private scheduler: Scheduler;
  private proposalManager: ProposalManager;
  private lastProposalCount = 0;
  private started = false;
  private agents: Map<string, AgentState> = new Map();
  private dashboard: { broadcast: () => Promise<void> } | null = null;

  constructor(config: Config) {
    super();
    this.config = config;
    this.eventLog = new EventLog(config.ecosystemDir);
    this.proposalManager = new ProposalManager(config.ecosystemDir);
    this.scheduler = new Scheduler({ cycleIntervalMs: config.cycleIntervalMs });
    this.scheduler.on('cycleStart', (n: number) => this.emit('cycleStart', n));
    this.scheduler.on('cycleEnd', (n: number) => this.emit('cycleEnd', n));
  }

  async start(): Promise<void> {
    if (this.started) return;
    this.started = true;
    await ensureDir(path.join(this.config.ecosystemDir, 'event-log'));
    await ensureDir(path.join(this.config.ecosystemDir, 'agents'));
    await this.loadAgents();

    try {
      const { startDashboard } = await import('../dashboard/server.js');
      this.dashboard = startDashboard(this.config.ecosystemDir, this.config.dashboardPort);
    } catch (err: unknown) {
      console.warn(`Dashboard unavailable: ${err instanceof Error ? err.message : String(err)}`);
    }

    await this.eventLog.append({ type: 'agent_born', agentId: 'supervisor', data: { action: 'start', agentCount: this.agents.size } });
    console.log(`✅ ${this.agents.size} agents loaded, starting cycles...`);

    this.scheduler.startCycle((n) => this.runCycle(n));
    if (this.dashboard) {
      this.on('cycleEnd', async () => { await this.dashboard!.broadcast(); });
    }
  }

  private async loadAgents(): Promise<void> {
    this.agents.clear();
    const dir = path.join(this.config.ecosystemDir, 'agents');
    try {
      for (const file of await fs.readdir(dir)) {
        if (!file.endsWith('.json')) continue;
        const agent = JSON.parse(await fs.readFile(path.join(dir, file), 'utf-8')) as AgentState;
        this.agents.set(agent.id, agent);
      }
    } catch { /* dir may not exist */ }
  }

  private async saveAgent(agent: AgentState): Promise<void> {
    await safeWriteJSON(path.join(this.config.ecosystemDir, 'agents', `${agent.id}.json`), agent);
  }

  private async runCycle(cycleNum: number): Promise<void> {
    await this.eventLog.append({ type: 'token_allocated', agentId: 'supervisor', data: { cycle: cycleNum, action: 'cycle_start' } });
    console.log(`\n🔄 Cycle ${cycleNum} — ${this.agents.size} agents`);
    await this.loadAgents();

    const alive = [...this.agents.values()].filter(a => a.alive);

    // LLM-powered decisions for each agent
    for (const agent of alive) {
      agent.age += 1;
      const g = agent.genome;

      try {
        // Build LLM request and call it
        const llmCall = async (sys: string, userMsg: string) => {
          const resp = await proxyCall({
            requestId: `${agent.id}-${cycleNum}`,
            agentId: agent.id,
            model: 'deepseek-chat',
            messages: [
              { role: 'system', content: sys },
              { role: 'user', content: userMsg },
            ],
            maxTokens: 300,
          });
          return resp.content;
        };

        const decision = await decide(g, {
          balance: agent.tokenBalance,
          age: agent.age,
          reputation: agent.reputation,
          generation: agent.generation,
        }, {
          aliveCount: alive.length,
          pendingMessages: 0,
          availableResources: 0,
        }, llmCall);

        let score = 10;
        if (decision.action === 'web_search') score = 40;
        else if (decision.action === 'write_artifact') score = 50;
        else if (decision.action === 'propose') score = 60;
        else if (decision.action === 'lock_resource') score = 25;
        else if (decision.action === 'trade') score = 30;
        else if (decision.action === 'observe') score = 15;

        agent.contributionScore = score;
        const reason = (decision.reasoning ?? '').slice(0, 60);
        console.log(`  🧠 ${agent.id} (${g.personaName}): ${decision.action} — ${reason}`);
      } catch (err: unknown) {
        const m = err instanceof Error ? err.message : String(err);
        console.warn(`  ⚠️ ${agent.id} LLM error: ${m.slice(0, 80)}`);
        agent.contributionScore = 5;
      }
    }

    for (const agent of alive) {
      await this.eventLog.append({ type: 'task_completed', agentId: agent.id, data: { cycle: cycleNum, contribution: agent.contributionScore } });
    }

    const evolved = await runLifeCycle([...this.agents.values()], cycleNum, this.config.maxAgents);
    this.agents.clear();
    for (const agent of evolved) {
      this.agents.set(agent.id, agent);
      await this.saveAgent(agent);
    }

    const newBorns = evolved.filter(a => a.age <= 1 && a.generation > 0);
    for (const a of newBorns) {
      await this.eventLog.append({ type: 'agent_born', agentId: a.id, data: { generation: a.generation, parentId: a.parentId, personaName: a.genome.personaName } });
      console.log(`  🐣 New: ${a.id} (${a.genome.personaName}) gen=${a.generation}`);
    }

    const extinct = evolved.filter(a => !a.alive);
    for (const a of extinct) {
      await this.eventLog.append({ type: 'agent_extinct', agentId: a.id, data: { generation: a.generation, age: a.age, fitness: a.fitness } });
      console.log(`  💀 Extinct: ${a.id} (${a.genome.personaName}) age=${a.age}`);
    }

    await this.scanProposals();
    const totalFitness = alive.reduce((s, a) => s + a.fitness, 0);
    const avgFitness = alive.length > 0 ? (totalFitness / alive.length).toFixed(1) : '0';
    console.log(`  📊 ${alive.length} alive, avg fitness: ${avgFitness}`);
    await this.eventLog.append({ type: 'task_completed', agentId: 'supervisor', data: { cycle: cycleNum, action: 'cycle_end', aliveCount: alive.length, avgFitness } });
  }

  private async scanProposals(): Promise<void> {
    try {
      const pending = await this.proposalManager.getPendingProposals();
      if (pending.length > this.lastProposalCount) {
        for (const p of pending.slice(this.lastProposalCount)) {
          console.log(`  📩 Proposal from ${p.agentId}: "${p.title}"`);
          await this.eventLog.append({ type: 'proposal_created', agentId: p.agentId, data: { proposalId: p.id, title: p.title } });
          notifyUser({ agentId: p.agentId, type: p.type, title: p.title, description: p.description, tokenCost: p.tokenCost, proposalId: p.id }).catch(() => {});
        }
      }
      this.lastProposalCount = pending.length;
      const expired = await this.proposalManager.expireOldProposals();
      if (expired > 0) console.log(`  🧹 Expired ${expired} stale proposals`);
    } catch (err: unknown) {
      console.warn(`  ⚠️ Proposal error: ${err instanceof Error ? err.message : String(err)}`);
    }
  }

  async shutdown(): Promise<void> {
    this.scheduler.stop();
    if (this.started) {
      await this.eventLog.append({ type: 'agent_extinct', agentId: 'supervisor', data: { action: 'shutdown' } });
    }
    this.started = false;
  }

  getEventLog() { return this.eventLog; }
  getProposalManager() { return this.proposalManager; }
  getCurrentCycleNumber() { return this.scheduler.getCurrentCycleNumber(); }
}
