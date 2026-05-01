export type Trait = 'curious' | 'cooperative' | 'aggressive' | 'lazy' | 'helpful' | 'explorer' | 'creative' | 'cautious';
export type SkillName = 'web_search' | 'code_write' | 'data_analyze' | 'artifact_write' | 'observe' | 'propose';
export type ResourceType = 'file_lock' | 'skill_package' | 'disk_quota' | 'tool_access' | 'data_set';
export type EventType = 'token_allocated' | 'task_completed' | 'deal_kept' | 'deal_broken' | 'resource_locked' | 'resource_released' | 'agent_born' | 'agent_extinct' | 'mutation' | 'proposal_created' | 'proposal_approved' | 'proposal_rejected' | 'llm_call';
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
