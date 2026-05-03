import { EventEmitter } from 'node:events';
import path from 'node:path';
import fs from 'node:fs/promises';
import { EventLog, type AppendEventInput } from './event-log.js';
import { Scheduler } from './scheduler.js';
import { ProposalManager } from './proposal.js';
import { runCycle as runLifeCycle } from './life-cycle.js';
import { notifyUser, type NotifyConfig } from './notify.js';
import { decide } from '../agent/brain.js';
import { proxyCall } from '../shared/llm.js';
import { genomeToSystemPrompt, expressGenome, expressedToGenome } from '../agent/genome.js';
import type { Config } from '../config/index.js';
import { checkEmailReplies as checkPop3 } from './email-checker.js';
import { classifyReply } from './email-approval.js';
import { ensureDir, safeWriteJSON } from '../shared/filesystem.js';
import { BountyBoard } from './bounty-board.js';
import { Treasury } from './treasury.js';
import type { AgentState, SkillName } from '../shared/types.js';

const ALL_SKILL_NAMES: SkillName[] = ['web_search', 'code_write', 'data_analyze', 'artifact_write', 'observe', 'propose'];

type DigestEntry = { id: string; agentId: string; title: string; status: string };

/**
 * Automatic proposal evaluation by Supervisor.
 * Returns 'approve' for good proposals, 'reject' for bad ones, 'escalate' for human review.
 */
function evaluateProposal(proposal: { title: string; description: string; agentId: string; tokenCost: number }, agent: AgentState): { action: 'approve' | 'reject' | 'escalate'; reason: string } {
  const text = (proposal.title + ' ' + proposal.description).toLowerCase();
  const length = (proposal.title + proposal.description).length;

  // Reject: too short/vague
  if (length < 40) return { action: 'reject', reason: '内容过短，提案不够具体' };

  // Reject: extremely long/spammy  
  if (length > 5000) return { action: 'reject', reason: '提案内容过长，疑似垃圾信息' };

  // Reject: low reputation agent requesting high tokens
  if (agent.reputation < 0.3 && proposal.tokenCost > 1000) {
    return { action: 'reject', reason: '信誉过低，无法申请高额资源' };
  }

  // Escalate: high token cost + high risk
  if (proposal.tokenCost > 10000) {
    return { action: 'escalate', reason: 'Token成本较高，需人工审核' };
  }

  // Escalate: contains sensitive keywords
  const sensitive = ['delete', 'remove all', 'shutdown', 'hack', 'bypass', 'override auth'];
  if (sensitive.some(k => text.includes(k))) {
    return { action: 'escalate', reason: '提案涉及敏感操作，需人工审核' };
  }

  // Escalate: creative/novel proposals from high-performing agents
  if (agent.reputation > 0.8 && agent.fitness > 70) {
    return { action: 'approve', reason: '高信誉+高适应度agent，自动批准' };
  }

  // Default: approve simple, well-formed proposals
  return { action: 'approve', reason: '提案格式和内容合格' };
}

// Email reply parsing and HMAC verification live in ./email-approval.ts.

/**
 * Make an LLM-powered decision for a single agent.
 * Handles LLM call, token deduction from agent.tokenBalance, scoring, and proposal creation.
 * Designed to be called in parallel via Promise.allSettled.
 */
interface CycleSnapshot {
  openBounties: number;
  topBountyReward: number;
}

async function decideForAgent(
  agent: AgentState,
  cycleNum: number,
  aliveCount: number,
  proposalManager: ProposalManager,
  bountyBoard: BountyBoard,
  notifyConfig: NotifyConfig,
  saveAgent: (a: AgentState) => Promise<void>,
  agentLastProposal: Map<string, number>,
  pendingDigest: DigestEntry[],
  snapshot: CycleSnapshot,
  appendEvent: (e: AppendEventInput) => Promise<unknown>,
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
      openBounties: snapshot.openBounties,
      topBountyReward: snapshot.topBountyReward,
    }, llmCall);

    // Surface malformed LLM output to the audit trail. We still treat the
    // decision as idle (decide() guarantees never to throw), but the event
    // makes the failure visible instead of silently collapsing.
    if (decision.fallbackReason) {
      console.warn(`  ⚠️ ${agent.id} decision fallback (${decision.fallbackReason}): ${decision.reasoning}`);
      await appendEvent({
        type: 'decision_invalid',
        agentId: agent.id,
        actorType: 'agent',
        data: {
          cycle: cycleNum,
          reason: decision.fallbackReason,
          detail: decision.reasoning,
          ...(decision.rawResponse !== undefined ? { rawResponse: decision.rawResponse } : {}),
        },
      });
    }

    // Deduct tokens from agent balance (was previously in a detached module-level Map)
    if (cycleTokenUsage > 0) {
      agent.tokenBalance = Math.max(0, agent.tokenBalance - cycleTokenUsage);
      await saveAgent(agent);
    }

    let score = 10;
    if (decision.action === 'bid_bounty') score = 70;
        else if (decision.action === 'develop_skill') score = 55;
        else if (decision.action === 'web_search') score = 40;
    else if (decision.action === 'write_artifact') score = 50;
    else if (decision.action === 'propose') score = 60;
    else if (decision.action === 'lock_resource') score = 25;
    else if (decision.action === 'trade') score = 30;
    else if (decision.action === 'observe') score = 15;

    agent.contributionScore = score;
    const reason = (decision.reasoning ?? '').slice(0, 60);
    console.log(`  🧠 ${agent.id} (${g.personaName}): ${decision.action} — ${reason}`);

    // When agent chooses 'bid_bounty', actually place a bid
    if (decision.action === 'bid_bounty') {
      try {
        const openBounties = (await bountyBoard.listBounties()).filter((b: any) => b.status === 'open' || b.status === 'bidding');
        if (openBounties.length > 0 && agent.tokenBalance >= 1000) {
          const target = openBounties[Math.floor(Math.random() * openBounties.length)];
          const bidPrice = Math.floor(target.reward * 0.7 * (0.8 + Math.random() * 0.4));
          const actualPrice = Math.min(bidPrice, agent.tokenBalance - 100);
          if (actualPrice > 0) {
            await bountyBoard.placeBid(target.id, agent.id, actualPrice, 'Agent bids');
            console.log('  🎯 ' + agent.id + ' bid ' + actualPrice + ' on ' + target.title.slice(0, 30));
            agent.contributionScore += 15;
            await saveAgent(agent);
          }
        }
      } catch (err: unknown) {
        const m = err instanceof Error ? err.message : String(err);
        console.warn(`  ⚠️ ${agent.id} bid_bounty failed: ${m}`);
      }
    }

    // When agent chooses 'develop_skill', train one of its existing skills.
    // The bump is applied to the diploid genome (random allele) so the gain
    // is heritable through reproduction; the haploid `genome` is then
    // re-expressed to keep the two views in sync.
    if (decision.action === 'develop_skill') {
      const cost = 5000;
      if (agent.tokenBalance < cost) {
        agent.contributionScore = 10;
      } else if (!agent.diploidGenome) {
        // Defensive: pre-diploid agents shouldn't exist after seed, but skip
        // rather than corrupt state.
        agent.contributionScore = 10;
      } else {
        agent.tokenBalance -= cost;
        const skill = ALL_SKILL_NAMES[Math.floor(Math.random() * ALL_SKILL_NAMES.length)];
        const allele: 'dominant' | 'recessive' = Math.random() < 0.5 ? 'dominant' : 'recessive';
        const before = agent.diploidGenome.skills[skill][allele];
        agent.diploidGenome.skills[skill][allele] = Math.min(1, before + 0.2);
        const expressed = expressGenome(agent.diploidGenome);
        agent.genome = expressedToGenome(expressed);
        agent.contributionScore += 20;
        console.log(`  🔬 ${agent.id} trained ${skill} (${allele}: ${before.toFixed(2)} → ${agent.diploidGenome.skills[skill][allele].toFixed(2)})`);
        await saveAgent(agent);
      }
    }

        // When agent chooses 'propose', create proposal and auto-evaluate
    // Cooldown: only propose every 5 cycles
    if (decision.action === 'propose') {
      const lastPropose = agentLastProposal.get(agent.id) || 0;
      if (cycleNum - lastPropose < 5) {
        agent.contributionScore = 10;
        return;
      }
      agentLastProposal.set(agent.id, cycleNum);
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

        // Auto-evaluate: Supervisor decides approve/reject/escalate
        const evaluation = evaluateProposal(proposal, agent);
        if (evaluation.action === 'approve') {
          // Treasury funds the proposal reward — no minting from thin air.
          // If the treasury can't cover it, flip to a rejection rather than
          // silently failing.
          try {
            await bountyBoard.getTreasury().debit(proposal.tokenReward);
          } catch (err: unknown) {
            const m = err instanceof Error ? err.message : String(err);
            await proposalManager.rejectProposal(proposal.id, `Treasury cannot fund: ${m}`, 'supervisor');
            console.log(`  ❌ Auto-rejected (treasury): ${proposal.id}`);
            return;
          }
          await proposalManager.approveProposal(proposal.id, 'supervisor');
          agent.tokenBalance += proposal.tokenReward;
          await saveAgent(agent);
          console.log(`  ✅ Auto-approved: ${proposal.id}`);
          pendingDigest.push(proposal);
        } else if (evaluation.action === 'reject') {
          await proposalManager.rejectProposal(proposal.id, evaluation.reason, 'supervisor');
          console.log(`  ❌ Auto-rejected: ${proposal.id} (${evaluation.reason})`);
        } else {
          // Escalate to user — send email
          notifyUser(notifyConfig, {
            agentId: agent.id,
            type: 'task_suggestion',
            title,
            description: decision.reasoning,
            tokenCost: 3000,
            proposalId: proposal.id,
          }).catch(() => {});
          console.log(`  📩 Escalated to user: ${proposal.id}`);
        }
      } catch {
        // proposal creation failed
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
  private bountyBoard: BountyBoard;
  private seenProposalIds: Set<string> = new Set();
  // Proposal cooldown tracker: agent must wait N cycles between proposals.
  // In-memory; resets on restart (acceptable, since the worst case is one
  // extra proposal from a chatty agent right after a restart).
  private agentLastProposal: Map<string, number> = new Map();
  // Auto-approved proposals queued for the every-3-cycles digest email.
  private pendingDigest: DigestEntry[] = [];
  private started = false;
  private agents: Map<string, AgentState> = new Map();
  private dashboard: { broadcast: () => Promise<void> } | null = null;

  constructor(config: Config) {
    super();
    this.config = config;
    this.eventLog = new EventLog(config.ecosystemDir);
    this.proposalManager = new ProposalManager(config.ecosystemDir);
    // Route the bounty board's agent-token mutations through this
    // supervisor's in-memory map so a deduction (e.g., placeBid deposit) and
    // a later in-cycle saveAgent don't race. Falls through to disk for
    // agents not in memory (e.g., already-eliminated bidders).
    this.bountyBoard = new BountyBoard(
      config.ecosystemDir,
      undefined,
      {
        read: async (id) => {
          const inMem = this.agents.get(id);
          if (inMem) return inMem;
          const dir = path.join(config.ecosystemDir, 'agents');
          try {
            const raw = await fs.readFile(path.join(dir, `${id}.json`), 'utf-8');
            return JSON.parse(raw) as AgentState;
          } catch { return null; }
        },
        write: async (agent) => {
          if (this.agents.has(agent.id)) this.agents.set(agent.id, agent);
          await this.saveAgent(agent);
        },
      },
    );
    // Cycle counter is persisted at ecosystem/scheduler-state.json so
    // generation numbers tagged on offspring stay monotonic across restarts
    // (otherwise gen=0 keeps recurring every time the supervisor boots).
    this.scheduler = new Scheduler({ cycleIntervalMs: config.cycleIntervalMs });
    this.scheduler.on('cycleStart', (n: number) => this.emit('cycleStart', n));
    this.scheduler.on('cycleEnd', async (n: number) => {
      this.emit('cycleEnd', n);
      await safeWriteJSON(
        path.join(this.config.ecosystemDir, 'scheduler-state.json'),
        { lastCycle: n },
      );
    });
  }

  /** Build the NotifyConfig from the main Config. */
  private getNotifyConfig(): NotifyConfig {
    return {
      smtpHost: this.config.smtpHost,
      smtpPort: this.config.smtpPort,
      emailUser: this.config.emailUser,
      emailPass: this.config.emailPass,
      notifyEmail: this.config.notifyEmail,
      emailApprovalSecret: this.config.emailApprovalSecret,
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

    // Seed seenProposalIds with whatever's already pending so a restart
    // doesn't re-notify (or re-process) every existing pending proposal.
    try {
      const pending = await this.proposalManager.getPendingProposals();
      for (const p of pending) this.seenProposalIds.add(p.id);
    } catch { /* proposal log may be missing on first run */ }

    // Resume the scheduler cycle counter from persisted state so offspring
    // generation numbers stay monotonic across restarts.
    try {
      const persisted = JSON.parse(
        await fs.readFile(path.join(this.config.ecosystemDir, 'scheduler-state.json'), 'utf-8'),
      ) as { lastCycle?: number };
      if (typeof persisted.lastCycle === 'number') {
        // lastCycle is the most recently completed cycle; resume at lastCycle + 1
        this.scheduler.setStartingCycle(persisted.lastCycle + 1);
      }
    } catch { /* no persisted state on first run */ }

    await this.eventLog.append({ type: 'agent_born', agentId: 'supervisor', actorType: 'supervisor', data: { action: 'start', agentCount: this.agents.size } });
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
        // Defensive: re-express the haploid `genome` from the diploid source
        // of truth so any on-disk drift between the two views is corrected.
        // The diploid is the genetic state; the haploid is its expressed
        // snapshot. Reproduction and develop_skill keep them in sync, but
        // hand-edits or third-party writers might not.
        if (agent.diploidGenome) {
          agent.genome = expressedToGenome(expressGenome(agent.diploidGenome));
        }
        this.agents.set(agent.id, agent);
      }
    } catch { /* dir may not exist */ }
  }

  private async saveAgent(agent: AgentState): Promise<void> {
    await safeWriteJSON(path.join(this.config.ecosystemDir, 'agents', `${agent.id}.json`), agent);
  }

  private async runCycle(cycleNum: number): Promise<void> {
    await this.eventLog.append({ type: 'cycle_start', agentId: 'supervisor', actorType: 'supervisor', data: { cycle: cycleNum } });
    console.log(`\n🔄 Cycle ${cycleNum} — ${this.agents.size} agents`);
    await this.loadAgents();

    const alive = [...this.agents.values()].filter(a => a.alive);

    // Snapshot ecosystem-wide signals once per cycle so we don't re-read the
    // bounties file for every agent's prompt assembly.
    let snapshot: CycleSnapshot = { openBounties: 0, topBountyReward: 0 };
    try {
      const open = await this.bountyBoard.listBounties('open');
      snapshot = {
        openBounties: open.length,
        topBountyReward: open.length > 0 ? Math.max(...open.map(b => b.reward)) : 0,
      };
    } catch { /* bounties file may not exist on first run */ }

    // LLM-powered decisions for each agent (parallel)
    const appendEvent = this.eventLog.append.bind(this.eventLog);
    const results = await Promise.allSettled(
      alive.map(agent =>
        decideForAgent(
          agent,
          cycleNum,
          alive.length,
          this.proposalManager,
          this.bountyBoard,
          this.getNotifyConfig(),
          this.saveAgent.bind(this),
          this.agentLastProposal,
          this.pendingDigest,
          snapshot,
          appendEvent,
        )
      )
    );

    // Log any unhandled rejections (shouldn't happen since decideForAgent catches internally)
    for (const r of results) {
      if (r.status === 'rejected') {
        console.warn(`  ⚠️ Agent decision unhandled rejection: ${(r.reason as Error)?.message ?? String(r.reason)}`);
      }
    }

    // Notify winning agents of their awarded bounties
    await this.processBountyExecutions(alive);

    for (const agent of alive) {
      await this.eventLog.append({ type: 'task_completed', agentId: agent.id, actorType: 'agent', data: { cycle: cycleNum, contribution: agent.contributionScore } });
    }

    // Only feed living agents into the lifecycle. Already-dead agents stay
    // on disk but shouldn't be re-ranked, re-aged, or re-extincted.
    const evolved = await runLifeCycle(
      [...this.agents.values()].filter(a => a.alive),
      cycleNum,
      this.config.maxAgents,
    );
    this.agents.clear();
    for (const agent of evolved) {
      // Persist everything runCycle returned — survivors, offspring, and
      // freshly-dead agents. The dead ones must hit disk with alive=false
      // or they revive on the next loadAgents().
      await this.saveAgent(agent);
      if (agent.alive) this.agents.set(agent.id, agent);
    }

    const newBorns = evolved.filter(a => a.age <= 1 && a.generation > 0);
    for (const a of newBorns) {
      await this.eventLog.append({ type: 'agent_born', agentId: a.id, actorType: 'agent', data: { generation: a.generation, parentId: a.parentId, personaName: a.genome.personaName } });
      console.log(`  🐣 New: ${a.id} (${a.genome.personaName}) gen=${a.generation}`);
    }

    const extinct = evolved.filter(a => !a.alive);
    for (const a of extinct) {
      await this.eventLog.append({ type: 'agent_extinct', agentId: a.id, actorType: 'agent', data: { generation: a.generation, age: a.age, fitness: a.fitness } });
      console.log(`  💀 Extinct: ${a.id} (${a.genome.personaName}) age=${a.age}`);
    }

    await this.scanProposals();
    await this.checkEmailReplies();

    // Send digest email every 3 cycles with auto-approved proposals
    if (cycleNum % 3 === 0 && this.pendingDigest.length > 0) {
      const digestLines = [
        '🧬 Tribe Evolution — 提案摘要',
        '='.repeat(40),
        `Cycle ${cycleNum} | ${alive.length} agents alive`,
        '',
        `Supervisor 自动审批了 ${this.pendingDigest.length} 条提案:`,
      ];
      for (const p of this.pendingDigest) {
        digestLines.push(`  ${p.status === 'approved' ? '✅' : '❌'} [${p.agentId.slice(0,8)}] ${p.title.slice(0,60)}`);
      }
      digestLines.push('');
      digestLines.push('📧 需要人工审核的提案已单独发送邮件。');
      digestLines.push('🔗 Dashboard: http://yzftest.cpolar.top');

      notifyUser(this.getNotifyConfig(), {
        agentId: 'supervisor',
        type: 'task_suggestion',
        title: `Digest: ${this.pendingDigest.length} auto-approved proposals`,
        description: digestLines.join('\n'),
        proposalId: 'digest',
      }).catch(() => {});
      console.log(`  📧 Digest email sent: ${this.pendingDigest.length} proposals`);
      this.pendingDigest.length = 0;
    }

    const totalFitness = alive.reduce((s, a) => s + a.fitness, 0);
    const avgFitness = alive.length > 0 ? (totalFitness / alive.length).toFixed(1) : '0';
    console.log(`  📊 ${alive.length} alive, avg fitness: ${avgFitness}`);
    await this.eventLog.append({ type: 'cycle_end', agentId: 'supervisor', actorType: 'supervisor', data: { cycle: cycleNum, aliveCount: alive.length, avgFitness } });
  }


  private async processBountyExecutions(alive: AgentState[]): Promise<void> {
    let awarded;
    try {
      awarded = await this.bountyBoard.listBounties('awarded');
    } catch (err: unknown) {
      const m = err instanceof Error ? err.message : String(err);
      console.warn(`  ⚠️ Bounty execution: failed to list awarded bounties: ${m}`);
      return;
    }

    for (const bounty of awarded) {
      if (!bounty.winningBidId) continue;
      const winningBid = bounty.bids.find((b: any) => b.id === bounty.winningBidId);
      if (!winningBid) continue;
      const winner = alive.find(a => a.id === winningBid.agentId);
      if (!winner) continue;

      winner.contributionScore += 50;
      const summary = "Agent " + winner.genome.personaName + " completed: " + bounty.title;

      try {
        await this.bountyBoard.submitResult(bounty.id, winner.id, summary, summary);
        console.log("  🏗️ " + winner.id + " executing bounty: " + bounty.title.slice(0,30));

        // Two-tier review (auto-simulated — in production, the publisher and
        // the supervisor agent each approve via the dashboard).
        await this.bountyBoard.publisherApprove(bounty.id);
        await this.bountyBoard.supervisorApprove(bounty.id);

        // Run verification (no-op when verificationTests is empty → passes)
        const result = await this.bountyBoard.runVerification(bounty.id);
        if (result.passed) {
          await this.bountyBoard.completeBounty(bounty.id);
          winner.tokenBalance += bounty.reward;
          await this.saveAgent(winner);
          console.log("  ✅ Bounty completed! " + winner.id + " earned " + bounty.reward + " tokens");
          await this.eventLog.append({ type: 'task_completed', agentId: winner.id, actorType: 'agent', data: { action: 'bounty_completed', bountyId: bounty.id, reward: bounty.reward } });
        } else {
          await this.bountyBoard.failVerification(bounty.id);
          console.log("  ❌ Bounty verification failed: " + bounty.title.slice(0,30) + " (" + result.results.join('; ').slice(0,80) + ")");
        }
      } catch (err: unknown) {
        const m = err instanceof Error ? err.message : String(err);
        console.warn(`  ⚠️ Bounty ${bounty.id.slice(0,8)} execution failed: ${m}`);
      }
    }
  }

  private async scanProposals(): Promise<void> {
    const nc = this.getNotifyConfig();
    try {
      // Walk all currently-pending proposals; notify only the ones we haven't
      // seen before. Tracking by ID set is robust to count fluctuations as
      // proposals get auto-approved or auto-rejected mid-cycle.
      const pending = await this.proposalManager.getPendingProposals();
      for (const p of pending) {
        if (this.seenProposalIds.has(p.id)) continue;
        this.seenProposalIds.add(p.id);
        console.log(`  📩 Proposal from ${p.agentId}: "${p.title}"`);
        await this.eventLog.append({ type: 'proposal_created', agentId: p.agentId, actorType: 'agent', data: { proposalId: p.id, title: p.title } });
        notifyUser(nc, { agentId: p.agentId, type: p.type, title: p.title, description: p.description, tokenCost: p.tokenCost, proposalId: p.id }).catch(() => {});
      }
      const expired = await this.proposalManager.expireOldProposals();
      if (expired > 0) console.log(`  🧹 Expired ${expired} stale proposals`);
    } catch (err: unknown) {
      console.warn(`  ⚠️ Proposal error: ${err instanceof Error ? err.message : String(err)}`);
    }
  }

  async shutdown(): Promise<void> {
    this.scheduler.stop();
    if (this.started) {
      await this.eventLog.append({ type: 'agent_extinct', agentId: 'supervisor', actorType: 'supervisor', data: { action: 'shutdown' } });
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
        const { action, proposalId, reason, rejectionReason } = classifyReply(reply, this.config.emailApprovalSecret);

        if (!action || !proposalId) {
          // No actionable command, no proposal id, or no valid HMAC token —
          // log the why and move on. Without a token, the reply is purely
          // informational; the operator should approve via the dashboard.
          console.log(`  📧 Email skipped: "${reply.subject}" (${rejectionReason ?? 'no action'})`);
          continue;
        }

        try {
          if (action === 'approve') {
            await this.proposalManager.approveProposal(proposalId, 'user');
            console.log(`  ✅ Email approved: ${proposalId}`);
            await this.eventLog.append({
              type: 'proposal_created',
              agentId: 'user',
              actorType: 'user',
              data: { action: 'approved_via_email', proposalId },
            });
          } else {
            await this.proposalManager.rejectProposal(proposalId, reason, 'user');
            console.log(`  ❌ Email rejected: ${proposalId} (${reason})`);
            await this.eventLog.append({
              type: 'proposal_created',
              agentId: 'user',
              actorType: 'user',
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