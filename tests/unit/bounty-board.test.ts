import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { BountyBoard } from '../../src/supervisor/bounty-board.js';
import { safeWriteJSON, safeReadJSON } from '../../src/shared/filesystem.js';
import type { AgentState, Bounty, Bid } from '../../src/shared/types.js';
import * as path from 'node:path';
import * as fs from 'node:fs/promises';
import * as os from 'node:os';
import { randomBytes } from 'node:crypto';

function makeTempDir(): string {
  return path.join(os.tmpdir(), `bounty-test-${randomBytes(6).toString('hex')}`);
}

function makeAgent(id: string, balance: number): AgentState {
  return {
    id,
    genome: {
      personaName: 'TestAgent',
      traits: [],
      skills: { web_search: 0, code_write: 0, data_analyze: 0, artifact_write: 0, observe: 0, propose: 0 },
      collabBias: 0.5,
      riskTolerance: 0.5,
      communicationFreq: 0.5,
    },
    generation: 0,
    parentId: null,
    tokenBalance: balance,
    contributionScore: 0,
    reputation: 0.5,
    dealsKept: 0,
    dealsBroken: 0,
    fitness: 0,
    age: 0,
    alive: true,
    protectionRounds: 0,
    createdAt: Date.now(),
    diploidGenome: {
      gender: 'male',
      personaName: { dominant: 'TestAgent', recessive: 'TestAgent' },
      traits: [],
      skills: { web_search: { dominant: 0, recessive: 0 }, code_write: { dominant: 0, recessive: 0 }, data_analyze: { dominant: 0, recessive: 0 }, artifact_write: { dominant: 0, recessive: 0 }, observe: { dominant: 0, recessive: 0 }, propose: { dominant: 0, recessive: 0 } },
      collabBias: { dominant: 0.5, recessive: 0.5 },
      riskTolerance: { dominant: 0.5, recessive: 0.5 },
      communicationFreq: { dominant: 0.5, recessive: 0.5 },
    },
  };
}

async function writeAgent(ecosystemDir: string, agent: AgentState): Promise<void> {
  await safeWriteJSON(path.join(ecosystemDir, 'agents', `${agent.id}.json`), agent);
}

async function readAgent(ecosystemDir: string, agentId: string): Promise<AgentState | null> {
  return safeReadJSON<AgentState>(path.join(ecosystemDir, 'agents', `${agentId}.json`));
}

describe('BountyBoard', () => {
  let tempDir: string;
  let board: BountyBoard;

  beforeEach(async () => {
    tempDir = makeTempDir();
    await fs.mkdir(path.join(tempDir, 'agents'), { recursive: true });
    await fs.mkdir(path.join(tempDir, 'bounties'), { recursive: true });
    board = new BountyBoard(tempDir);
  });

  afterEach(async () => {
    await fs.rm(tempDir, { recursive: true, force: true });
  });

  // ─── createBounty ──────────────────────────────────────────────────────

  it('should create a bounty with open status', async () => {
    const bounty = await board.createBounty({
      title: 'Fix login bug',
      description: 'The login page crashes on empty input',
      creatorId: 'agent_001',
      type: 'bug_fix',
      reward: 1000,
      deadline: Date.now() + 86400000,
    });

    expect(bounty).toBeDefined();
    expect(bounty.id).toBeDefined();
    expect(bounty.title).toBe('Fix login bug');
    expect(bounty.creatorId).toBe('agent_001');
    expect(bounty.type).toBe('bug_fix');
    expect(bounty.reward).toBe(1000);
    expect(bounty.status).toBe('open');
    expect(bounty.bids).toEqual([]);
    expect(bounty.winningBidId).toBeNull();
    expect(bounty.verificationTests).toEqual([]);
    expect(bounty.escrowFrozen).toBe(0);
    expect(bounty.retryCount).toBe(0);
    expect(bounty.maxRetries).toBe(3);
    expect(bounty.depositRate).toBe(0.5);
    expect(bounty.verifierAgentId).toBe('supervisor');
    expect(bounty.completedAt).toBeNull();
  });

  it('should generate unique IDs for each bounty', async () => {
    const b1 = await board.createBounty({
      title: 'Bounty A', description: 'Desc A', creatorId: 'a1',
      type: 'feature', reward: 500, deadline: Date.now() + 86400000,
    });
    const b2 = await board.createBounty({
      title: 'Bounty B', description: 'Desc B', creatorId: 'a2',
      type: 'bug_fix', reward: 300, deadline: Date.now() + 86400000,
    });
    expect(b1.id).not.toBe(b2.id);
  });

  it('should persist bounty to file', async () => {
    await board.createBounty({
      title: 'Persist test', description: 'Testing persistence', creatorId: 'a1',
      type: 'research', reward: 100, deadline: Date.now() + 86400000,
    });

    const all = await board.listBounties();
    expect(all).toHaveLength(1);
    expect(all[0].title).toBe('Persist test');
  });

  // ─── getBounty ─────────────────────────────────────────────────────────

  it('should return null for non-existent bounty', async () => {
    const bounty = await board.getBounty('nonexistent');
    expect(bounty).toBeNull();
  });

  it('should return bounty by id', async () => {
    const created = await board.createBounty({
      title: 'Get me', description: 'Desc', creatorId: 'a1',
      type: 'bug_fix', reward: 200, deadline: Date.now() + 86400000,
    });
    const fetched = await board.getBounty(created.id);
    expect(fetched).not.toBeNull();
    expect(fetched!.id).toBe(created.id);
    expect(fetched!.title).toBe('Get me');
  });

  // ─── listBounties ──────────────────────────────────────────────────────

  it('should list bounties filtered by status', async () => {
    const creator = makeAgent('creator_filter', 10000);
    const winner = makeAgent('winner_filter', 5000);
    await writeAgent(tempDir, creator);
    await writeAgent(tempDir, winner);

    const b1 = await board.createBounty({
      title: 'B1', description: 'D1', creatorId: 'creator_filter',
      type: 'feature', reward: 500, deadline: Date.now() + 86400000, depositRate: 0.5,
    });
    const b2 = await board.createBounty({
      title: 'B2', description: 'D2', creatorId: 'creator_filter',
      type: 'bug_fix', reward: 300, deadline: Date.now() + 86400000, depositRate: 0.5,
    });

    // Complete b2 to have different statuses
    const bid2 = await board.placeBid(b2.id, 'winner_filter', 200, 'Plan');
    await board.awardBid(b2.id, bid2.id);
    await board.submitResult(b2.id, 'winner_filter', 'http://a', 'Done');
    await board.publisherApprove(b2.id);
    await board.supervisorApprove(b2.id);
    await board.completeBounty(b2.id);

    const openBounties = await board.listBounties('open');
    expect(openBounties).toHaveLength(1);
    expect(openBounties[0].title).toBe('B1');

    const completedBounties = await board.listBounties('completed');
    expect(completedBounties).toHaveLength(1);
    expect(completedBounties[0].title).toBe('B2');
  });

  // ─── placeBid ──────────────────────────────────────────────────────────

  it('should place a bid and deduct deposit from agent', async () => {
    const agent = makeAgent('agent_002', 2000);
    await writeAgent(tempDir, agent);

    const bounty = await board.createBounty({
      title: 'Bid test', description: 'Desc', creatorId: 'agent_001',
      type: 'bug_fix', reward: 1000, deadline: Date.now() + 86400000, depositRate: 0.5,
    });

    const bid = await board.placeBid(bounty.id, 'agent_002', 500, 'I will fix this bug');

    expect(bid.id).toBeDefined();
    expect(bid.agentId).toBe('agent_002');
    expect(bid.price).toBe(500);
    expect(bid.plan).toBe('I will fix this bug');
    expect(bid.deposit).toBe(500); // reward * depositRate = 1000 * 0.5

    // Check deposit deducted from agent
    const updatedAgent = await readAgent(tempDir, 'agent_002');
    expect(updatedAgent).not.toBeNull();
    expect(updatedAgent!.tokenBalance).toBe(1500); // 2000 - 500

    // Check bid is on bounty
    const updatedBounty = await board.getBounty(bounty.id);
    expect(updatedBounty!.bids).toHaveLength(1);
    expect(updatedBounty!.bids[0].agentId).toBe('agent_002');
    // Status should have changed to 'bidding'
    expect(updatedBounty!.status).toBe('bidding');
  });

  it('should reject bid when agent has insufficient tokens', async () => {
    const agent = makeAgent('agent_003', 100);
    await writeAgent(tempDir, agent);

    const bounty = await board.createBounty({
      title: 'Expensive bid', description: 'Desc', creatorId: 'agent_001',
      type: 'bug_fix', reward: 1000, deadline: Date.now() + 86400000, depositRate: 0.5,
    });

    await expect(
      board.placeBid(bounty.id, 'agent_003', 500, 'My plan')
    ).rejects.toThrow(/insufficient|Insufficient|balance/i);
  });

  it('should reject bid when bounty is not open or bidding', async () => {
    const agent = makeAgent('agent_004', 5000);
    await writeAgent(tempDir, agent);

    const bounty = await board.createBounty({
      title: 'Late bid', description: 'Desc', creatorId: 'agent_001',
      type: 'bug_fix', reward: 1000, deadline: Date.now() + 86400000, depositRate: 0.5,
    });

    // Place a bid to change status to bidding
    const bid = await board.placeBid(bounty.id, 'agent_004', 500, 'Plan');

    // Now award to complete the bidding stage
    await board.awardBid(bounty.id, bid.id);

    // Now try to place another bid — should fail
    const agent2 = makeAgent('agent_005', 5000);
    await writeAgent(tempDir, agent2);
    await expect(
      board.placeBid(bounty.id, 'agent_005', 400, 'Another plan')
    ).rejects.toThrow(/not open|not in|cannot|invalid|bidding/i);
  });

  // ─── awardBid ──────────────────────────────────────────────────────────

  it('should award winning bid and refund losing bidders 50%', async () => {
    const creator = makeAgent('creator_a', 10000);
    const bidder1 = makeAgent('bidder_1', 5000);
    const bidder2 = makeAgent('bidder_2', 5000);
    await writeAgent(tempDir, creator);
    await writeAgent(tempDir, bidder1);
    await writeAgent(tempDir, bidder2);

    const bounty = await board.createBounty({
      title: 'Award test',
      description: 'Desc',
      creatorId: 'creator_a',
      type: 'bug_fix',
      reward: 2000,
      deadline: Date.now() + 86400000,
      depositRate: 0.5,
    });

    const bid1 = await board.placeBid(bounty.id, 'bidder_1', 1500, 'Plan 1');
    const bid2 = await board.placeBid(bounty.id, 'bidder_2', 1200, 'Plan 2');

    const awarded = await board.awardBid(bounty.id, bid1.id);

    expect(awarded.status).toBe('awarded');
    expect(awarded.winningBidId).toBe(bid1.id);

    // Creator's escrow should be frozen (reward amount)
    expect(awarded.escrowFrozen).toBe(2000);

    // Winner's deposit is NOT refunded (it's part of the reward deduction)
    const winnerAfter = await readAgent(tempDir, 'bidder_1');
    // Winner paid 1000 deposit, not refunded
    expect(winnerAfter!.tokenBalance).toBe(4000); // 5000 - 1000

    // Loser gets 50% refund: paid 1000, gets 500 back
    const loserAfter = await readAgent(tempDir, 'bidder_2');
    expect(loserAfter!.tokenBalance).toBe(4500); // 5000 - 1000 + 500

    // Creator should have reward frozen (but not deducted from balance in this design)
  });

  // ─── submitResult ──────────────────────────────────────────────────────

  it('should change status to submitted after submission', async () => {
    const creator = makeAgent('creator_b', 10000);
    const winner = makeAgent('winner_b', 5000);
    await writeAgent(tempDir, creator);
    await writeAgent(tempDir, winner);

    const bounty = await board.createBounty({
      title: 'Submit test',
      description: 'Desc',
      creatorId: 'creator_b',
      type: 'bug_fix',
      reward: 1000,
      deadline: Date.now() + 86400000,
      depositRate: 0.5,
      verifierAgentId: 'verifier',
    });

    const bid = await board.placeBid(bounty.id, 'winner_b', 800, 'Plan');
    await board.awardBid(bounty.id, bid.id);

    const submitted = await board.submitResult(bounty.id, 'winner_b', 'http://artifact', 'Done!');

    expect(submitted.status).toBe('submitted');
  });

  it('should reject submission from wrong agent', async () => {
    const creator = makeAgent('creator_c', 10000);
    const winner = makeAgent('winner_c', 5000);
    await writeAgent(tempDir, creator);
    await writeAgent(tempDir, winner);

    const bounty = await board.createBounty({
      title: 'Wrong submit',
      description: 'Desc',
      creatorId: 'creator_c',
      type: 'feature',
      reward: 1000,
      deadline: Date.now() + 86400000,
      depositRate: 0.5,
    });

    const bid = await board.placeBid(bounty.id, 'winner_c', 800, 'Plan');
    await board.awardBid(bounty.id, bid.id);

    await expect(
      board.submitResult(bounty.id, 'intruder', 'http://artifact', 'Hack')
    ).rejects.toThrow(/not the|winner|wrong|agent/i);
  });

  // ─── runVerification + completeBounty (full lifecycle) ─────────────────

  it('should complete full lifecycle: open → bidding → awarded → submitted → publisher_review → supervisor_review → completed', async () => {
    const creator = makeAgent('creator_full', 10000);
    const bidder = makeAgent('bidder_full', 5000);
    const verifier = makeAgent('verifier_full', 1000);
    await writeAgent(tempDir, creator);
    await writeAgent(tempDir, bidder);
    await writeAgent(tempDir, verifier);

    // Step 1: Create
    const bounty = await board.createBounty({
      title: 'Full lifecycle',
      description: 'Test complete flow',
      creatorId: 'creator_full',
      type: 'bug_fix',
      reward: 1000,
      deadline: Date.now() + 86400000,
      depositRate: 0.5,
      verifierAgentId: 'verifier_full',
    });
    expect(bounty.status).toBe('open');

    // Step 2: Bid
    const bid = await board.placeBid(bounty.id, 'bidder_full', 800, 'Will fix');
    expect(bid.agentId).toBe('bidder_full');

    // Step 3: Award
    const awarded = await board.awardBid(bounty.id, bid.id);
    expect(awarded.status).toBe('awarded');

    // Step 4: Submit (transitions to submitted)
    const submitted = await board.submitResult(bounty.id, 'bidder_full', 'http://artifact', 'Fixed!');
    expect(submitted.status).toBe('submitted');

    // Step 5: Publisher tier
    const publisherReviewed = await board.publisherApprove(bounty.id);
    expect(publisherReviewed.status).toBe('publisher_review');

    // Step 6: Supervisor tier
    const supervisorReviewed = await board.supervisorApprove(bounty.id);
    expect(supervisorReviewed.status).toBe('supervisor_review');

    // Step 7: Complete
    const completed = await board.completeBounty(bounty.id);
    expect(completed.status).toBe('completed');
    expect(completed.completedAt).not.toBeNull();

    // Winner should get escrow released (minus deposit already deducted)
    // Reward = 1000, deposit = 500 already paid, escrow frozen = 1000
    // Winner gets 1000 added back from escrow
    const afterBidder = await readAgent(tempDir, 'bidder_full');
    expect(afterBidder!.tokenBalance).toBe(5000 - 500 + 1000); // 5500
  });

  it('should walk through both review tiers, with rejection at either tier sending back to executing', async () => {
    const creator = makeAgent('creator_review', 10000);
    const winner = makeAgent('winner_review', 5000);
    await writeAgent(tempDir, creator);
    await writeAgent(tempDir, winner);

    const bounty = await board.createBounty({
      title: 'Review test',
      description: 'Desc',
      creatorId: 'creator_review',
      type: 'bug_fix',
      reward: 1000,
      deadline: Date.now() + 86400000,
      depositRate: 0.5,
    });
    const bid = await board.placeBid(bounty.id, 'winner_review', 800, 'Plan');
    await board.awardBid(bounty.id, bid.id);

    // Round 1: publisher rejects → back to executing
    await board.submitResult(bounty.id, 'winner_review', 'http://a1', 'r1');
    const pubRejected = await board.publisherReject(bounty.id);
    expect(pubRejected.status).toBe('executing');

    // Round 2: publisher approves, supervisor rejects → back to executing
    await board.submitResult(bounty.id, 'winner_review', 'http://a2', 'r2');
    await board.publisherApprove(bounty.id);
    const supRejected = await board.supervisorReject(bounty.id);
    expect(supRejected.status).toBe('executing');

    // Round 3: both approve → complete
    await board.submitResult(bounty.id, 'winner_review', 'http://a3', 'r3');
    await board.publisherApprove(bounty.id);
    await board.supervisorApprove(bounty.id);
    const completed = await board.completeBounty(bounty.id);
    expect(completed.status).toBe('completed');
  });

  // ─── failVerification ──────────────────────────────────────────────────

  it('should retry on verification failure when retries remain', async () => {
    const creator = makeAgent('creator_retry', 10000);
    const winner = makeAgent('winner_retry', 5000);
    await writeAgent(tempDir, creator);
    await writeAgent(tempDir, winner);

    const bounty = await board.createBounty({
      title: 'Retry test',
      description: 'Desc',
      creatorId: 'creator_retry',
      type: 'research',
      reward: 1000,
      deadline: Date.now() + 86400000,
      depositRate: 0.5,
      maxRetries: 3,
      verifierAgentId: 'verifier_retry',
      verificationTests: [{ type: 'file_check', description: 'Check', filePath: '/nonexistent/file', expectedContent: 'data' }],
    });

    const bid = await board.placeBid(bounty.id, 'winner_retry', 800, 'Plan');
    await board.awardBid(bounty.id, bid.id);
    await board.submitResult(bounty.id, 'winner_retry', 'http://artifact', 'Done');

    const failed = await board.failVerification(bounty.id);
    expect(failed.status).toBe('executing');
    expect(failed.retryCount).toBe(1);
  });

  it('should revert to open after max retries', async () => {
    const creator = makeAgent('creator_max', 10000);
    const winner = makeAgent('winner_max', 5000);
    await writeAgent(tempDir, creator);
    await writeAgent(tempDir, winner);

    const bounty = await board.createBounty({
      title: 'Max retries',
      description: 'Desc',
      creatorId: 'creator_max',
      type: 'research',
      reward: 1000,
      deadline: Date.now() + 86400000,
      depositRate: 0.5,
      maxRetries: 1,
      verifierAgentId: 'verifier_max',
      verificationTests: [{ type: 'file_check', description: 'Check', filePath: '/nonexistent/file', expectedContent: 'data' }],
    });

    const bid = await board.placeBid(bounty.id, 'winner_max', 800, 'Plan');
    await board.awardBid(bounty.id, bid.id);
    await board.submitResult(bounty.id, 'winner_max', 'http://artifact', 'Done');

    // First fail → retry (executing)
    const fail1 = await board.failVerification(bounty.id);
    expect(fail1.status).toBe('executing');

    // Second attempt: submit again, fail again
    await board.submitResult(bounty.id, 'winner_max', 'http://artifact', 'Done again');
    const fail2 = await board.failVerification(bounty.id);
    // maxRetries=1, retryCount goes to 2 which equals maxRetries+1 → revert to open
    expect(fail2.status).toBe('open');
  });

  // ─── State machine validation ──────────────────────────────────────────

  it('should reject invalid state transitions', async () => {
    const bounty = await board.createBounty({
      title: 'State machine',
      description: 'Desc',
      creatorId: 'a1',
      type: 'bug_fix',
      reward: 100,
      deadline: Date.now() + 86400000,
      depositRate: 0.5,
    });

    // Can't submit result for an open bounty
    await expect(
      board.submitResult(bounty.id, 'x', 'http://a', 'Test')
    ).rejects.toThrow();

    // Can't complete an open bounty
    await expect(
      board.completeBounty(bounty.id)
    ).rejects.toThrow();

    // Can't award without bids
    await expect(
      board.awardBid(bounty.id, 'nonexistent')
    ).rejects.toThrow();
  });

  // ─── Verification test types ───────────────────────────────────────────

  it('should run shell_test verification', async () => {
    const creator = makeAgent('creator_sh', 10000);
    const winner = makeAgent('winner_sh', 5000);
    await writeAgent(tempDir, creator);
    await writeAgent(tempDir, winner);

    const bounty = await board.createBounty({
      title: 'Shell test',
      description: 'Desc',
      creatorId: 'creator_sh',
      type: 'feature',
      reward: 1000,
      deadline: Date.now() + 86400000,
      depositRate: 0.5,
      verifierAgentId: 'winner_sh',
      verificationTests: [{ type: 'shell_test', description: 'Echo test', command: 'echo "hello"' }],
    });

    const bid = await board.placeBid(bounty.id, 'winner_sh', 800, 'Plan');
    await board.awardBid(bounty.id, bid.id);
    await board.submitResult(bounty.id, 'winner_sh', 'http://artifact', 'Done');

    const result = await board.runVerification(bounty.id);
    expect(result.passed).toBe(true);
    expect(result.results.length).toBeGreaterThan(0);
  });

  it('should run file_check verification', async () => {
    const creator = makeAgent('creator_fc', 10000);
    const winner = makeAgent('winner_fc', 5000);

    // Create a test file
    const testFilePath = path.join(tempDir, 'test_artifact.txt');
    await fs.writeFile(testFilePath, 'expected_content', 'utf-8');

    await writeAgent(tempDir, creator);
    await writeAgent(tempDir, winner);

    const bounty = await board.createBounty({
      title: 'File check',
      description: 'Desc',
      creatorId: 'creator_fc',
      type: 'feature',
      reward: 1000,
      deadline: Date.now() + 86400000,
      depositRate: 0.5,
      verifierAgentId: 'winner_fc',
      verificationTests: [{ type: 'file_check', description: 'Check file', filePath: testFilePath, expectedContent: 'expected_content' }],
    });

    const bid = await board.placeBid(bounty.id, 'winner_fc', 800, 'Plan');
    await board.awardBid(bounty.id, bid.id);
    await board.submitResult(bounty.id, 'winner_fc', 'http://artifact', 'Done');

    const result = await board.runVerification(bounty.id);
    expect(result.passed).toBe(true);
  });

  it('should fail file_check when content mismatches', async () => {
    const creator = makeAgent('creator_fcf', 10000);
    const winner = makeAgent('winner_fcf', 5000);

    const testFilePath = path.join(tempDir, 'bad_artifact.txt');
    await fs.writeFile(testFilePath, 'wrong_content', 'utf-8');

    await writeAgent(tempDir, creator);
    await writeAgent(tempDir, winner);

    const bounty = await board.createBounty({
      title: 'File check fail',
      description: 'Desc',
      creatorId: 'creator_fcf',
      type: 'feature',
      reward: 1000,
      deadline: Date.now() + 86400000,
      depositRate: 0.5,
      verifierAgentId: 'winner_fcf',
      verificationTests: [{ type: 'file_check', description: 'Check file', filePath: testFilePath, expectedContent: 'expected_content_x' }],
    });

    const bid = await board.placeBid(bounty.id, 'winner_fcf', 800, 'Plan');
    await board.awardBid(bounty.id, bid.id);
    await board.submitResult(bounty.id, 'winner_fcf', 'http://artifact', 'Done');

    const result = await board.runVerification(bounty.id);
    expect(result.passed).toBe(false);
  });

  // ─── Edge cases ────────────────────────────────────────────────────────

  it('should handle multiple bounties and bids correctly', async () => {
    const creator = makeAgent('creator_multi', 10000);
    const bidder = makeAgent('bidder_multi', 10000);
    await writeAgent(tempDir, creator);
    await writeAgent(tempDir, bidder);

    const b1 = await board.createBounty({
      title: 'Bounty 1',
      description: 'D1',
      creatorId: 'creator_multi',
      type: 'feature',
      reward: 500,
      deadline: Date.now() + 86400000,
      depositRate: 0.5,
    });

    const b2 = await board.createBounty({
      title: 'Bounty 2',
      description: 'D2',
      creatorId: 'creator_multi',
      type: 'bug_fix',
      reward: 300,
      deadline: Date.now() + 86400000,
      depositRate: 0.5,
    });

    const bid1 = await board.placeBid(b1.id, 'bidder_multi', 400, 'Plan for 1');
    const bid2 = await board.placeBid(b2.id, 'bidder_multi', 200, 'Plan for 2');

    expect(bid1.bountyId).toBe(b1.id);
    expect(bid2.bountyId).toBe(b2.id);

    const all = await board.listBounties();
    expect(all).toHaveLength(2);
  });

  it('should create bounty with verification tests', async () => {
    const bounty = await board.createBounty({
      title: 'Verified bounty',
      description: 'Desc',
      creatorId: 'a1',
      type: 'feature',
      reward: 1000,
      deadline: Date.now() + 86400000,
      depositRate: 0.5,
      verifierAgentId: 'verifier_1',
      verificationTests: [
        { type: 'shell_test', description: 'Check output', command: 'echo ok' },
        { type: 'file_check', description: 'Check file', filePath: '/tmp/test', expectedContent: 'data' },
      ],
    });

    expect(bounty.verificationTests).toHaveLength(2);
    expect(bounty.verifierAgentId).toBe('verifier_1');
  });

  // ─── Treasury-funded escrow ────────────────────────────────────────────

  it('should debit the treasury at award time and credit the winner at completion', async () => {
    const creator = makeAgent('creator_t', 10000);
    const winner = makeAgent('winner_t', 5000);
    await writeAgent(tempDir, creator);
    await writeAgent(tempDir, winner);

    const treasury = board.getTreasury();
    const before = await treasury.getState();

    const bounty = await board.createBounty({
      title: 'Treasury test',
      description: 'Desc',
      creatorId: 'creator_t',
      type: 'bug_fix',
      reward: 1000,
      deadline: Date.now() + 86400000,
      depositRate: 0.5,
    });
    const bid = await board.placeBid(bounty.id, 'winner_t', 800, 'Plan');
    await board.awardBid(bounty.id, bid.id);

    // Award debits the treasury by the reward amount.
    const afterAward = await treasury.getState();
    expect(afterAward.balance).toBe(before.balance - 1000);
    expect(afterAward.totalIssued).toBe(before.totalIssued + 1000);

    await board.submitResult(bounty.id, 'winner_t', 'http://a', 'Done');
    await board.publisherApprove(bounty.id);
    await board.supervisorApprove(bounty.id);
    await board.completeBounty(bounty.id);

    // Treasury balance is unchanged at completion (the reservation was made
    // at award time); the winner's tokenBalance reflects the payout.
    const afterComplete = await treasury.getState();
    expect(afterComplete.balance).toBe(afterAward.balance);

    const finalWinner = await readAgent(tempDir, 'winner_t');
    // 5000 - 500 (deposit) + 1000 (escrow released) = 5500
    expect(finalWinner!.tokenBalance).toBe(5500);
  });

  it('should refund the treasury when a bounty exhausts its retries', async () => {
    const creator = makeAgent('creator_r', 10000);
    const winner = makeAgent('winner_r', 5000);
    await writeAgent(tempDir, creator);
    await writeAgent(tempDir, winner);

    const treasury = board.getTreasury();
    const before = await treasury.getState();

    const bounty = await board.createBounty({
      title: 'Refund test',
      description: 'Desc',
      creatorId: 'creator_r',
      type: 'research',
      reward: 1000,
      deadline: Date.now() + 86400000,
      depositRate: 0.5,
      maxRetries: 1,
      verificationTests: [{ type: 'file_check', description: 'Check', filePath: '/nonexistent/file', expectedContent: 'data' }],
    });
    const bid = await board.placeBid(bounty.id, 'winner_r', 800, 'Plan');
    await board.awardBid(bounty.id, bid.id);

    const afterAward = await treasury.getState();
    expect(afterAward.balance).toBe(before.balance - 1000);

    // Round 1: submit, fail → retry
    await board.submitResult(bounty.id, 'winner_r', 'http://a1', 'r1');
    await board.failVerification(bounty.id);

    // Round 2: submit, fail → exhausted, bounty re-opens
    await board.submitResult(bounty.id, 'winner_r', 'http://a2', 'r2');
    await board.failVerification(bounty.id);

    const finalState = (await board.listBounties())[0];
    expect(finalState.status).toBe('open');
    expect(finalState.escrowFrozen).toBe(0);

    // Treasury should be back to its pre-award balance.
    const afterRefund = await treasury.getState();
    expect(afterRefund.balance).toBe(before.balance);
    expect(afterRefund.totalRefunded).toBe(before.totalRefunded + 1000);
  });
});
