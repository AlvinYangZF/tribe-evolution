export type Trait = 'curious' | 'cooperative' | 'aggressive' | 'lazy' | 'helpful' | 'explorer' | 'creative' | 'cautious';
export type SkillName = 'web_search' | 'code_write' | 'data_analyze' | 'artifact_write' | 'observe' | 'propose';
export type ResourceType = 'file_lock' | 'skill_package' | 'disk_quota' | 'tool_access' | 'data_set';
export type EventType = 'token_allocated' | 'task_completed' | 'deal_kept' | 'deal_broken' | 'resource_locked' | 'resource_released' | 'agent_born' | 'agent_extinct' | 'mutation' | 'proposal_created' | 'proposal_approved' | 'proposal_rejected' | 'llm_call' | 'cycle_start' | 'cycle_end';
export type MessagePriority = 'high' | 'normal' | 'low';
export type DealStatus = 'open' | 'locked' | 'completed' | 'breached';

export interface Genome {
  personaName: string;
  traits: Trait[];
  skills: Record<SkillName, number>;
  collabBias: number;
  riskTolerance: number;
  communicationFreq: number;
}

export interface AgentState {
  id: string;
  genome: Genome;
  generation: number;
  parentId: string | null;
  /** Both parents for sexual reproduction (mother + father). Optional for
   *  backwards-compatibility with on-disk agent files written before this
   *  field existed; lineage rendering should fall back to `parentId`. */
  parentIds?: string[];
  tokenBalance: number;
  contributionScore: number;
  reputation: number;  // 0.0 ~ 1.0 (守信率)
  dealsKept: number;
  dealsBroken: number;
  fitness: number;
  age: number;
  alive: boolean;
  protectionRounds: number;  // 新生保护剩余轮数
  createdAt: number;
  diploidGenome: DiploidGenome;
}

export interface Resource {
  id: string;
  type: ResourceType;
  name: string;
  ownerId: string | null;
  lockedAt: number | null;
  lockExpiresAt: number | null;
  leasePrice: number;
}

export interface Deal {
  id: string;
  resourceId: string;
  fromAgent: string;
  toAgent: string;
  price: number;
  status: DealStatus;
  createdAt: number;
  settledAt: number | null;
}

export interface EventLogEntry {
  index: number;
  timestamp: number;
  type: EventType;
  agentId: string;
  data: Record<string, unknown>;
  prevHash: string;
  hash: string;
}

export interface Message {
  id: string;
  from: string;
  to: string | 'broadcast';
  priority: MessagePriority;
  content: unknown;
  timestamp: number;
  ttl: number;  // 有效期 ms
}

export interface ContributionScore {
  agentId: string;
  userTasksCompleted: number;
  artifactConsumed: number;
  collaborations: number;
  newKnowledge: number;
  total: number;
}

export interface LLMRequest {
  requestId: string;
  agentId: string;
  model: string;
  messages: Array<{ role: string; content: string }>;
  maxTokens: number;
}

export interface LLMResponse {
  requestId: string;
  content: string;
  tokenUsage: { input: number; output: number; total: number };
  cost: number;
}

// ─── Sexual reproduction types ──────────────────────────────────────────────

export type Gender = 'male' | 'female';

/** A gene pair with dominant and recessive alleles */
export interface GenePair<T> {
  dominant: T;
  recessive: T;
}

/** Diploid genome (two sets of genes) */
export interface DiploidGenome {
  gender: Gender;
  personaName: GenePair<string>;
  traits: GenePair<Trait>[];
  skills: Record<SkillName, GenePair<number>>;
  collabBias: GenePair<number>;
  riskTolerance: GenePair<number>;
  communicationFreq: GenePair<number>;
}

/** Expressed (haploid) genome after dominant/recessive resolution */
export interface ExpressedGenome {
  personaName: string;
  gender: Gender;
  traits: Trait[];
  skills: Record<SkillName, number>;
  collabBias: number;
  riskTolerance: number;
  communicationFreq: number;
}

// ─── Bounty types ────────────────────────────────────────────────────────

export type BountyStatus = 'open' | 'bidding' | 'awarded' | 'executing' | 'submitted' | 'publisher_review' | 'supervisor_review' | 'completed';
export type BountyType = 'bug_fix' | 'feature' | 'research' | 'data_analysis' | 'code_review' | 'other';
export type TestType = 'shell_test' | 'file_check' | 'api_check' | 'llm_review';

export interface VerificationTest {
  type: TestType;
  description: string;
  command?: string;        // for shell_test
  filePath?: string;       // for file_check
  expectedContent?: string;// for file_check
  url?: string;            // for api_check
  expectedStatus?: number; // for api_check
  prompt?: string;         // for llm_review
}

export interface Bid {
  id: string;
  bountyId: string;
  agentId: string;
  price: number;
  plan: string;            // agent's proposal for how to complete
  deposit: number;         // deposit amount (reward * depositRate)
  createdAt: number;
}

export interface Bounty {
  id: string;
  title: string;
  description: string;
  creatorId: string;
  type: BountyType;
  reward: number;
  depositRate: number;     // 0.5 = 50%

  status: BountyStatus;
  bids: Bid[];
  winningBidId: string | null;

  verificationTests: VerificationTest[];
  verifierAgentId: string;

  escrowFrozen: number;     // frozen reward
  retryCount: number;       // verification retry count
  maxRetries: number;       // default 3

  createdAt: number;
  deadline: number;
  completedAt: number | null;
}

// ─── Proposal types ───────────────────────────────────────────────────────

export type ProposalType = 'new_skill' | 'task_suggestion' | 'policy_change' | 'resource_request';
export type ProposalStatus = 'pending' | 'approved' | 'rejected' | 'expired';

export interface Proposal {
  id: string;
  agentId: string;
  type: ProposalType;
  title: string;
  description: string;
  expectedBenefit: string;
  tokenCost: number;
  tokenReward: number;
  status: ProposalStatus;
  reviewedBy: string | null;
  reviewNote: string | null;
  createdAt: number;
  reviewedAt: number | null;
}
