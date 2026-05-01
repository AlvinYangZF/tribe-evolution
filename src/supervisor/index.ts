import { EventEmitter } from 'node:events';
import path from 'node:path';
import fs from 'node:fs/promises';
import { EventLog } from './event-log.js';
import { Scheduler } from './scheduler.js';
import { ProposalManager } from './proposal.js';
import { runCycle as runLifeCycle } from './life-cycle.js';
import { notifyUser, type NotifyConfig } from './notify.js';
import { decide } from '../agent/brain.js';
import { proxyCall } from './llm-proxy.js';
import { genomeToSystemPrompt } from '../agent/genome.js';
import type { Config } from '../config/index.js';
import { checkEmailReplies as checkPop3, type EmailReply } from './email-checker.js';
import { ensureDir, safeWriteJSON } from '../shared/filesystem.js';
import type { AgentState } from '../shared/types.js';

/**
 * Extract a proposal ID from an email reply body or subject.
 * Matches patterns like:
 *   - "approve prop_xxx"
 *   - "reject <uuid>"
 *   - "批准 <uuid>"
 *   - Subject lines containing a UUID
 */
function extractProposalId(text: string): string | null {
  // Match UUID pattern
  const uuidRe = /[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}/i;
  const m = text.match(uuidRe);
  return m ? m[0] : null;
}

/**
 * Determine if an email reply is an approval or rejection,
 * and extract the target proposalId.
 */
function classifyReply(reply: EmailReply): {
  action: 'approve' | 'reject' | null;
  proposalId: string | null;
  reason: string;
} {
  const body = reply.body.trim();
  const bodyLower = body.toLowerCase();
  const subject = reply.subject;

  // Try to extract proposal ID from body + subject
  const proposalId = extractProposalId(body) ?? extractProposalId(subject);

  const approved =
    bodyLower.startsWith('approve') ||
    bodyLower.startsWith('同意') ||
    bodyLower.startsWith('批准');
  const rejected =
    bodyLower.startsWith('reject') ||
    bodyLower.startsWith('拒绝') ||
    bodyLower.startsWith('不同意');

  if (approved) return { action: 'approve', proposalId, reason: '' };
  if (rejected) {
    const reason = body
      .replace(/^(reject|拒绝|不同意)\s*/i, '')
      .replace(/[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}\s*/i, '')
      .trim() || '用户拒绝';
    return { action: 'reject', proposalId, reason };
  }

  return { action: null, proposalId: null, reason: '' };
}

/**
 * Make an LLM-powered decision for a single agent.
 * Handles LLM call, token deduction from agent.tokenBalance, scoring, and proposal creation.
 * Designed to be called in parallel via Promise.allSettled.
 */
async function decideForAgent(
  agent: AgentState,
  cycleNum: number,
  aliveCount: number,
  proposalManager: ProposalManager,
  notifyConfig: NotifyConfig,
  saveAgent: (a: AgentState) => Promise<void>,
): Promise<void> {
  agent.age += 1;
  const g = agent.genome;

  try {
    let cycleTokenUsage = 0;
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
      cycleTokenUsage = resp.tokenUsage?.total ?? 0;
      return resp.content;
    };

    const decision = await decide(g, {
      balance: agent.tokenBalance,
      age: agent.age,
      reputation: agent.reputation,
      generation: agent.generation,
      gender: agent.diploidGenome?.gender,
    }, {
      aliveCount,
      pendingMessages: 0,
      availableResources: 0,
    }, llmCall);

    // Deduct tokens from agent balance (was previously in a detached module-level Map)
    if (cycleTokenUsage > 0) {
      agent.tokenBalance = Math.max(0, agent.tokenBalance - cycleTokenUsage);
      await saveAgent(agent);
    }

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

    // When agent chooses 'propose', actually create a proposal
    if (decision.action === 'propose') {
      const title = (decision.reasoning ?? '新提案').slice(0, 80);
      try {
        const proposal = await proposalManager.createProposal(agent.id, {
          type: 'task_suggestion',
          title,
          description: decision.reasoning ?? 'Agent 提出了一个新想法',
          expectedBenefit: '提升生态效率',
          tokenCost: 3000,
          tokenReward: 5000,
        });
        // Email user immediately
        notifyUser(notifyConfig, {
          agentId: agent.id,
          type: 'task_suggestion',
          title,
          description: decision.reasoning,
          tokenCost: 3000,
          proposalId: proposal.id,
        }).catch(() => {});
        console.log(`  📩 Proposal created & emailed: ${proposal.id}`);
      } catch {
        // proposal creation failed, don't break the cycle
      }
    }
  } catch (err: unknown) {
    const m = err instanceof Error ? err.message : String(err);
    console.warn(`  ⚠️ ${agent.id} LLM error: ${m.slice(0, 80)}`);
    agent.contributionScore = 5;
  }
}

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

  /** Build the NotifyConfig from the main Config. */
  private getNotifyConfig(): NotifyConfig {
    return {
      smtpHost: this.config.smtpHost,
      smtpPort: this.config.smtpPort,
      emailUser: this.config.emailUser,
      emailPass: this.config.emailPass,
      notifyEmail: this.config.notifyEmail,
    };
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

    // Sync config to ecosystem for dashboard
    await safeWriteJSON(path.join(this.config.ecosystemDir, 'config.json'), {
      cycleIntervalMs: this.config.cycleIntervalMs,
      eliminationRate: this.config.eliminationRate,
      mutationBaseRate: this.config.mutationBaseRate,
      maxAgents: this.config.maxAgents,
      defaultTokenPerCycle: this.config.defaultTokenPerCycle,
      newAgentProtectionRounds: this.config.newAgentProtectionRounds,
    });

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

    // LLM-powered decisions for each agent (parallel)
    const results = await Promise.allSettled(
      alive.map(agent =>
        decideForAgent(agent, cycleNum, alive.length, this.proposalManager, this.getNotifyConfig(), this.saveAgent.bind(this))
      )
    );

    // Log any unhandled rejections (shouldn't happen since decideForAgent catches internally)
    for (const r of results) {
      if (r.status === 'rejected') {
        console.warn(`  ⚠️ Agent decision unhandled rejection: ${(r.reason as Error)?.message ?? String(r.reason)}`);
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
    await this.checkEmailReplies();
    const totalFitness = alive.reduce((s, a) => s + a.fitness, 0);
    const avgFitness = alive.length > 0 ? (totalFitness / alive.length).toFixed(1) : '0';
    console.log(`  📊 ${alive.length} alive, avg fitness: ${avgFitness}`);
    await this.eventLog.append({ type: 'task_completed', agentId: 'supervisor', data: { cycle: cycleNum, action: 'cycle_end', aliveCount: alive.length, avgFitness } });
  }

  private async scanProposals(): Promise<void> {
    const nc = this.getNotifyConfig();
    try {
      const pending = await this.proposalManager.getPendingProposals();
      if (pending.length > this.lastProposalCount) {
        for (const p of pending.slice(this.lastProposalCount)) {
          console.log(`  📩 Proposal from ${p.agentId}: "${p.title}"`);
          await this.eventLog.append({ type: 'proposal_created', agentId: p.agentId, data: { proposalId: p.id, title: p.title } });
          notifyUser(nc, { agentId: p.agentId, type: p.type, title: p.title, description: p.description, tokenCost: p.tokenCost, proposalId: p.id }).catch(() => {});
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

  /**
   * Check email replies via POP3 (Node.js native — no external scripts).
   * Only acts on replies that reference a specific proposal ID.
   */
  private async checkEmailReplies(): Promise<void> {
    try {
      const replies = await checkPop3(
        {
          pop3Host: this.config.pop3Host,
          pop3Port: this.config.pop3Port,
          emailUser: this.config.emailUser,
          emailPass: this.config.emailPass,
          stateFile: path.join(this.config.ecosystemDir, 'email-state.json'),
          checkWindow: 10,
        },
        (from: string) => from.toLowerCase().includes(this.config.notifyEmail.split('@')[0] || ''),
      );

      if (replies.length === 0) return;

      for (const reply of replies) {
        const { action, proposalId, reason } = classifyReply(reply);

        if (!action || !proposalId) {
          // No actionable command or no proposal ID found — skip
          console.log(`  📧 Email skipped (no matching proposal ID): "${reply.subject}"`);
          continue;
        }

        try {
          if (action === 'approve') {
            await this.proposalManager.approveProposal(proposalId, 'user');
            console.log(`  ✅ Email approved: ${proposalId}`);
            await this.eventLog.append({
              type: 'proposal_created',
              agentId: 'user',
              data: { action: 'approved_via_email', proposalId },
            });
          } else {
            await this.proposalManager.rejectProposal(proposalId, reason, 'user');
            console.log(`  ❌ Email rejected: ${proposalId} (${reason})`);
            await this.eventLog.append({
              type: 'proposal_created',
              agentId: 'user',
              data: { action: 'rejected_via_email', proposalId, reason },
            });
          }
        } catch (err: unknown) {
          const m = err instanceof Error ? err.message : String(err);
          console.warn(`  ⚠️ Email action failed for ${proposalId}: ${m}`);
        }
      }
    } catch (err: unknown) {
      // Silently fail — email checking is best-effort
      if (err instanceof Error && err.message !== 'POP3 login failed') {
        // Only log unexpected errors, not auth failures
      }
    }
  }

  getEventLog() { return this.eventLog; }
  getProposalManager() { return this.proposalManager; }
  getCurrentCycleNumber() { return this.scheduler.getCurrentCycleNumber(); }
}