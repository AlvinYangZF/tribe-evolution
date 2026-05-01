import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { ProposalManager } from '../../src/supervisor/proposal.js';
import type { Proposal } from '../../src/shared/types.js';
import { readJSONL } from '../../src/shared/filesystem.js';
import * as fs from 'node:fs/promises';
import * as path from 'node:path';
import * as os from 'node:os';
import { randomBytes } from 'node:crypto';

function makeTempDir(): string {
  return path.join(os.tmpdir(), `proposal-test-${randomBytes(6).toString('hex')}`);
}

function sleep(ms: number): Promise<void> {
  return new Promise(resolve => setTimeout(resolve, ms));
}

describe('ProposalManager', () => {
  let tempDir: string;
  let manager: ProposalManager;

  beforeEach(async () => {
    tempDir = makeTempDir();
    await fs.mkdir(tempDir, { recursive: true });
    manager = new ProposalManager(tempDir);
  });

  afterEach(async () => {
    await fs.rm(tempDir, { recursive: true, force: true });
  });

  // ─── createProposal ────────────────────────────────────────────────────

  it('should create a proposal with pending status', async () => {
    const proposal = await manager.createProposal('agent_001', {
      type: 'new_skill',
      title: '数据分析技能包',
      description: '增加数据分析能力，支持 CSV 文件处理',
      expectedBenefit: '提升数据洞察能力',
      tokenCost: 50,
      tokenReward: 200,
    });

    expect(proposal).toBeDefined();
    expect(proposal.id).toBeDefined();
    expect(typeof proposal.id).toBe('string');
    expect(proposal.agentId).toBe('agent_001');
    expect(proposal.type).toBe('new_skill');
    expect(proposal.title).toBe('数据分析技能包');
    expect(proposal.description).toBe('增加数据分析能力，支持 CSV 文件处理');
    expect(proposal.expectedBenefit).toBe('提升数据洞察能力');
    expect(proposal.tokenCost).toBe(50);
    expect(proposal.tokenReward).toBe(200);
    expect(proposal.status).toBe('pending');
    expect(proposal.reviewedBy).toBeNull();
    expect(proposal.reviewNote).toBeNull();
    expect(proposal.createdAt).toBeGreaterThan(0);
    expect(proposal.reviewedAt).toBeNull();
  });

  it('should generate unique IDs for each proposal', async () => {
    const p1 = await manager.createProposal('agent_001', {
      type: 'new_skill', title: 'Skill A', description: 'Desc A',
      expectedBenefit: 'Benefit A', tokenCost: 10, tokenReward: 100,
    });
    const p2 = await manager.createProposal('agent_002', {
      type: 'task_suggestion', title: 'Task B', description: 'Desc B',
      expectedBenefit: 'Benefit B', tokenCost: 20, tokenReward: 200,
    });
    expect(p1.id).not.toBe(p2.id);
  });

  it('should persist proposal to JSONL file', async () => {
    const proposal = await manager.createProposal('agent_001', {
      type: 'policy_change', title: '测试策略', description: '描述',
      expectedBenefit: '好处', tokenCost: 30, tokenReward: 150,
    });

    const logFile = path.join(tempDir, 'proposals', 'log.jsonl');
    const entries = await readJSONL<Proposal>(logFile);
    expect(entries).toHaveLength(1);
    expect(entries[0].id).toBe(proposal.id);
    expect(entries[0].status).toBe('pending');
  });

  // ─── getAgentProposals ──────────────────────────────────────────────────

  it('should return agent proposals', async () => {
    await manager.createProposal('agent_001', {
      type: 'new_skill', title: 'S1', description: 'D1',
      expectedBenefit: 'B1', tokenCost: 10, tokenReward: 100,
    });
    await manager.createProposal('agent_002', {
      type: 'task_suggestion', title: 'S2', description: 'D2',
      expectedBenefit: 'B2', tokenCost: 10, tokenReward: 100,
    });
    await manager.createProposal('agent_001', {
      type: 'resource_request', title: 'S3', description: 'D3',
      expectedBenefit: 'B3', tokenCost: 10, tokenReward: 100,
    });

    const agent1Proposals = await manager.getAgentProposals('agent_001');
    expect(agent1Proposals).toHaveLength(2);

    const agent2Proposals = await manager.getAgentProposals('agent_002');
    expect(agent2Proposals).toHaveLength(1);
  });

  it('should return empty array for agent with no proposals', async () => {
    const proposals = await manager.getAgentProposals('nonexistent');
    expect(proposals).toHaveLength(0);
  });

  // ─── getPendingProposals ────────────────────────────────────────────────

  it('should return only pending proposals', async () => {
    const p1 = await manager.createProposal('agent_001', {
      type: 'new_skill', title: 'S1', description: 'D1',
      expectedBenefit: 'B1', tokenCost: 10, tokenReward: 100,
    });
    await manager.createProposal('agent_002', {
      type: 'task_suggestion', title: 'S2', description: 'D2',
      expectedBenefit: 'B2', tokenCost: 10, tokenReward: 100,
    });

    await manager.approveProposal(p1.id);

    const pending = await manager.getPendingProposals();
    expect(pending).toHaveLength(1);
    expect(pending[0].agentId).toBe('agent_002');
  });

  // ─── approveProposal ───────────────────────────────────────────────────

  it('should approve a pending proposal', async () => {
    const proposal = await manager.createProposal('agent_001', {
      type: 'new_skill', title: 'S1', description: 'D1',
      expectedBenefit: 'B1', tokenCost: 10, tokenReward: 100,
    });

    const approved = await manager.approveProposal(proposal.id);
    expect(approved.status).toBe('approved');
    expect(approved.reviewedBy).toBe('user');
    expect(approved.reviewNote).toBeNull();
    expect(approved.reviewedAt).toBeGreaterThan(0);
  });

  it('should allow custom reviewer', async () => {
    const proposal = await manager.createProposal('agent_001', {
      type: 'new_skill', title: 'S1', description: 'D1',
      expectedBenefit: 'B1', tokenCost: 10, tokenReward: 100,
    });

    const approved = await manager.approveProposal(proposal.id, 'supervisor');
    expect(approved.reviewedBy).toBe('supervisor');
  });

  it('should throw when approving non-existent proposal', async () => {
    await expect(manager.approveProposal('nonexistent-id')).rejects.toThrow('not found');
  });

  it('should throw when approving already-reviewed proposal', async () => {
    const proposal = await manager.createProposal('agent_001', {
      type: 'new_skill', title: 'S1', description: 'D1',
      expectedBenefit: 'B1', tokenCost: 10, tokenReward: 100,
    });
    await manager.approveProposal(proposal.id);
    await expect(manager.approveProposal(proposal.id)).rejects.toThrow('already been');
  });

  // ─── rejectProposal ────────────────────────────────────────────────────

  it('should reject a pending proposal with reason', async () => {
    const proposal = await manager.createProposal('agent_001', {
      type: 'new_skill', title: 'S1', description: 'D1',
      expectedBenefit: 'B1', tokenCost: 10, tokenReward: 100,
    });

    const rejected = await manager.rejectProposal(proposal.id, '请求不符合当前优先级');
    expect(rejected.status).toBe('rejected');
    expect(rejected.reviewedBy).toBe('user');
    expect(rejected.reviewNote).toBe('请求不符合当前优先级');
    expect(rejected.reviewedAt).toBeGreaterThan(0);
  });

  it('should throw when rejecting non-existent proposal', async () => {
    await expect(manager.rejectProposal('nonexistent-id', 'no reason')).rejects.toThrow('not found');
  });

  it('should throw when rejecting already-reviewed proposal', async () => {
    const proposal = await manager.createProposal('agent_001', {
      type: 'new_skill', title: 'S1', description: 'D1',
      expectedBenefit: 'B1', tokenCost: 10, tokenReward: 100,
    });
    await manager.rejectProposal(proposal.id, 'no');
    await expect(manager.rejectProposal(proposal.id, 'no again')).rejects.toThrow('already been');
  });

  // ─── Full lifecycle tests ──────────────────────────────────────────────

  it('should handle full lifecycle: create → pending → approve → approved', async () => {
    const proposal = await manager.createProposal('agent_001', {
      type: 'policy_change', title: '修改淘汰率', description: '降低淘汰率至10%',
      expectedBenefit: '保留更多多样性', tokenCost: 100, tokenReward: 500,
    });

    // Should be pending
    expect(proposal.status).toBe('pending');

    // Approve
    const approved = await manager.approveProposal(proposal.id);
    expect(approved.status).toBe('approved');
    expect(approved.reviewedBy).toBe('user');
    expect(approved.reviewedAt).not.toBeNull();

    // Verify via read
    const agentProposals = await manager.getAgentProposals('agent_001');
    expect(agentProposals).toHaveLength(1);
    expect(agentProposals[0].status).toBe('approved');
  });

  it('should handle full lifecycle: create → pending → reject → rejected', async () => {
    const proposal = await manager.createProposal('agent_002', {
      type: 'resource_request', title: '请求更多磁盘', description: '需要额外10GB',
      expectedBenefit: '存储更多数据', tokenCost: 200, tokenReward: 800,
    });

    expect(proposal.status).toBe('pending');

    const rejected = await manager.rejectProposal(proposal.id, '资源不足，暂无法分配');
    expect(rejected.status).toBe('rejected');
    expect(rejected.reviewNote).toBe('资源不足，暂无法分配');

    const agentProposals = await manager.getAgentProposals('agent_002');
    expect(agentProposals).toHaveLength(1);
    expect(agentProposals[0].status).toBe('rejected');
  });

  // ─── expireOldProposals ────────────────────────────────────────────────

  it('should expire proposals older than 7 days', async () => {
    // Create a proposal with an artificially old creation time
    const oldProposal = await manager.createProposal('agent_001', {
      type: 'new_skill', title: 'Old', description: 'Old proposal',
      expectedBenefit: 'N/A', tokenCost: 10, tokenReward: 50,
    });

    // Manually set the createdAt to 8 days ago
    const eightDaysAgo = Date.now() - 8 * 24 * 60 * 60 * 1000;
    const logFile = path.join(tempDir, 'proposals', 'log.jsonl');
    // Read all entries, rewrite with modified timestamp
    const entries = await readJSONL<any>(logFile);
    entries[0].createdAt = eightDaysAgo;
    const lines = entries.map((e: any) => JSON.stringify(e)).join('\n') + '\n';
    await fs.writeFile(logFile, lines, 'utf-8');

    // Create a recent proposal
    await manager.createProposal('agent_001', {
      type: 'task_suggestion', title: 'Recent', description: 'Recent',
      expectedBenefit: 'N/A', tokenCost: 10, tokenReward: 50,
    });

    const expired = await manager.expireOldProposals();
    expect(expired).toBe(1);

    const agentProposals = await manager.getAgentProposals('agent_001');
    const oldEntry = agentProposals.find(p => p.title === 'Old');
    const recentEntry = agentProposals.find(p => p.title === 'Recent');
    expect(oldEntry!.status).toBe('expired');
    expect(recentEntry!.status).toBe('pending');
  });

  it('should not expire proposals that are already reviewed', async () => {
    const proposal = await manager.createProposal('agent_001', {
      type: 'new_skill', title: 'Reviewed old', description: 'Desc',
      expectedBenefit: 'N/A', tokenCost: 10, tokenReward: 50,
    });
    await manager.approveProposal(proposal.id);

    // Manually set createdAt to 8 days ago
    const eightDaysAgo = Date.now() - 8 * 24 * 60 * 60 * 1000;
    const logFile = path.join(tempDir, 'proposals', 'log.jsonl');
    const entries = await readJSONL<any>(logFile);
    entries[0].createdAt = eightDaysAgo;
    const lines = entries.map((e: any) => JSON.stringify(e)).join('\n') + '\n';
    await fs.writeFile(logFile, lines, 'utf-8');

    const expired = await manager.expireOldProposals();
    expect(expired).toBe(0); // Already approved, should not be expired
  });

  it('should return 0 when no proposals to expire', async () => {
    const expired = await manager.expireOldProposals();
    expect(expired).toBe(0);
  });
});

// ─── Agent subprocess proposal tests ──────────────────────────────────────

describe('agent proposal RPC (subprocess)', () => {
  let tempDir: string;

  beforeEach(async () => {
    tempDir = makeTempDir();
    await fs.mkdir(tempDir, { recursive: true });
  });

  afterEach(async () => {
    await fs.rm(tempDir, { recursive: true, force: true });
  });

  async function spawnAgent() {
    const { spawn } = await import('node:child_process');
    const { fileURLToPath } = await import('node:url');
    const agentEntry = path.resolve(import.meta.dirname ?? path.dirname(fileURLToPath(import.meta.url)), '../../src/agent/index.ts');

    const child = spawn('npx', ['tsx', agentEntry], {
      stdio: ['pipe', 'pipe', 'inherit'],
      cwd: path.resolve(import.meta.dirname ?? path.dirname(fileURLToPath(import.meta.url)), '../..'),
      env: { ...process.env, ECOSYSTEM_DIR: tempDir, DEEPSEEK_API_KEY: '' },
    });

    return child;
  }

  function rpcCall(child: import('child_process').ChildProcess, id: string, method: string, params: Record<string, unknown> = {}): Promise<unknown> {
    return new Promise((resolve, reject) => {
      const payload = JSON.stringify({ id, method, params }) + '\n';
      const timeout = setTimeout(() => reject(new Error('RPC timeout')), 10000);

      let buffer = '';
      const onData = (chunk: Buffer) => {
        buffer += chunk.toString();
        try {
          const result = JSON.parse(buffer);
          clearTimeout(timeout);
          child.stdout?.removeListener('data', onData);
          resolve(result);
        } catch {
          // incomplete JSON, wait for more
        }
      };

      child.stdout?.on('data', onData);
      child.stdin?.write(payload);
    });
  }

  it('should create proposal via RPC and return valid id', async () => {
    const child = await spawnAgent();
    try {
      // First give the agent some tokens
      await rpcCall(child, 'tr1', 'token_refresh', { tokens: 500 });

      const response = await rpcCall(child, 'r1', 'create_proposal', {
        type: 'new_skill',
        title: '数据分析技能包',
        description: '增加数据分析能力',
        expectedBenefit: '提升数据洞察能力',
        tokenCost: 50,
        tokenReward: 200,
      }) as { id: string; result: { proposalId: string } };

      expect(response).toBeDefined();
      expect(response.result).toBeDefined();
      expect(response.result.proposalId).toBeDefined();
      expect(typeof response.result.proposalId).toBe('string');
      expect(response.result.proposalId.length).toBeGreaterThan(0);
    } finally {
      child.kill();
    }
  });

  it('should deduct token cost from agent balance when creating proposal', async () => {
    const child = await spawnAgent();
    try {
      // Give agent 100 tokens
      const refreshResp = await rpcCall(child, 'tr1', 'token_refresh', { tokens: 100 }) as { result: { newBalance: number } };
      expect(refreshResp.result.newBalance).toBe(100);

      // Create a proposal costing 30 tokens
      await rpcCall(child, 'r2', 'create_proposal', {
        type: 'new_skill',
        title: 'New Skill',
        description: 'Desc',
        expectedBenefit: 'Benefit',
        tokenCost: 30,
        tokenReward: 100,
      });

      // Check balance — should have been deducted
      const balanceResp = await rpcCall(child, 'tr2', 'token_refresh', { tokens: 0 }) as { result: { newBalance: number } };
      expect(balanceResp.result.newBalance).toBe(70); // 100 - 30
    } finally {
      child.kill();
    }
  });

  it('should reject proposal creation when agent has insufficient tokens', async () => {
    const child = await spawnAgent();
    try {
      // Give agent only 10 tokens
      await rpcCall(child, 'tr1', 'token_refresh', { tokens: 10 });

      const response = await rpcCall(child, 'r3', 'create_proposal', {
        type: 'new_skill',
        title: 'Expensive Proposal',
        description: 'Desc',
        expectedBenefit: 'Benefit',
        tokenCost: 50, // Costs 50 but only has 10
        tokenReward: 200,
      }) as { id: string; error: { code: number; message: string } };

      expect(response.error).toBeDefined();
      expect(response.error.message).toContain('Insufficient');
    } finally {
      child.kill();
    }
  });

  it('should list proposals via RPC', async () => {
    const child = await spawnAgent();
    try {
      // Give tokens and create proposals
      await rpcCall(child, 'tr1', 'token_refresh', { tokens: 500 });
      await rpcCall(child, 'cp1', 'create_proposal', {
        type: 'new_skill', title: 'Skill 1', description: 'D1',
        expectedBenefit: 'B1', tokenCost: 10, tokenReward: 50,
      });
      await rpcCall(child, 'cp2', 'create_proposal', {
        type: 'task_suggestion', title: 'Task 1', description: 'D2',
        expectedBenefit: 'B2', tokenCost: 20, tokenReward: 100,
      });

      const response = await rpcCall(child, 'lp1', 'list_proposals') as { result: { proposals: Array<{ id: string; title: string; status: string }> } };
      expect(response.result.proposals).toHaveLength(2);
      expect(response.result.proposals[0].title).toBe('Skill 1');
      expect(response.result.proposals[1].title).toBe('Task 1');
      expect(response.result.proposals.every(p => p.status === 'pending')).toBe(true);
    } finally {
      child.kill();
    }
  });

  it('should return error for unknown method', async () => {
    const child = await spawnAgent();
    try {
      const response = await rpcCall(child, 'u1', 'nonexistent_method') as { error: { code: number; message: string } };
      expect(response.error).toBeDefined();
      expect(response.error.code).toBe(-32601);
    } finally {
      child.kill();
    }
  });
});
