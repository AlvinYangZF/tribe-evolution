import http from 'node:http';
import path from 'node:path';
import fs from 'node:fs/promises';
import { randomBytes } from 'node:crypto';
import { WebSocketServer, WebSocket } from 'ws';
import { EventLog } from '../supervisor/event-log.js';
import type { AgentState, EventLogEntry, Resource, Deal, EventType, Bounty, BountyStatus, Bid } from '../shared/types.js';
import { safeReadJSON, safeWriteJSON } from '../shared/filesystem.js';

// ── Types ──────────────────────────────────────────────────────────────────

interface SnapshotData {
  type: 'snapshot';
  agents: AgentSummary[];
  stats: StatsResponse;
}

interface AgentSummary {
  id: string;
  genome: { personaName: string; traits: string[] };
  tokenBalance: number;
  reputation: number;
  fitness: number;
  age: number;
  generation: number;
  alive: boolean;
  /** Sourced from diploidGenome.gender. Optional for agents persisted
   *  before the diploid genome landed. */
  gender?: 'male' | 'female';
}

interface StatsResponse {
  averageFitness: number;
  maxFitness: number;
  populationSize: number;
  generationRange: [number, number];
  traitDistribution: Record<string, number>;
  roleDistribution: Record<string, number>;
  fitnessHistory: Array<{ cycle: number; avg: number; max: number; min: number }>;
  tokenSupply: number;
  reputationAvg: number;
}

interface ConfigResponse {
  cycleIntervalMs: number;
  eliminationRate: number;
  mutationBaseRate: number;
  maxAgents: number;
  defaultTokenPerCycle: number;
  newAgentProtectionRounds: number;
}

interface TreeAgentNode {
  id: string;
  personaName: string;
  generation: number;
  parentId: string | null;
  /** Full parent set for sexual reproduction. Optional; if absent, fall back
   *  to `parentId`. The first entry is the primary lineage parent (used to
   *  position the node in the tree); additional entries are co-parents and
   *  rendered as dashed edges. */
  parentIds?: string[];
  alive: boolean;
  fitness: number;
}

// ── Dashboard Server ──────────────────────────────────────────────────────

export function startDashboard(ecosystemDir: string, port: number = 3000) {
  const eventLog = new EventLog(ecosystemDir);
  

// ── Rate Limiting ──
const loginAttempts = new Map();
function checkRateLimit(ip: any) {
  const now = Date.now();
  const entry = loginAttempts.get(ip);
  if (!entry) return { allowed: true, waitSeconds: 0 };
  if (entry.lockedUntil > 0 && now < entry.lockedUntil) {
    return { allowed: false, waitSeconds: Math.ceil((entry.lockedUntil - now) / 1000) };
  }
  if (entry.lockedUntil > 0 && now >= entry.lockedUntil) {
    loginAttempts.delete(ip);
    return { allowed: true, waitSeconds: 0 };
  }
  return { allowed: true, waitSeconds: 0 };
}
function recordFailure(ip: any) {
  const entry = loginAttempts.get(ip) || { count: 0, lockedUntil: 0 };
  entry.count++;
  if (entry.count >= 3) {
    entry.lockedUntil = Date.now() + 30000 * Math.pow(2, entry.count - 3);
  }
  loginAttempts.set(ip, entry);
  return entry;
}
function recordSuccess(ip: any) { loginAttempts.delete(ip); }

// ── Auth Middleware ──
// API-only server. Authentication is bearer-token via the `x-auth-token`
// header; the cookie/HTML-redirect path was removed when the frontend was
// split out into the standalone web/ directory.
const AUTH_TOKEN = process.env.DASHBOARD_AUTH_TOKEN || 'tribe-admin';
function authMiddleware(req: any, res: any, next: any) {
  // /auth-check is the only public endpoint — it's how clients verify a
  // password and obtain the token they then send on subsequent requests.
  if (req.url === '/auth-check') return next();
  const token = req.headers['x-auth-token'] || '';
  if (token === AUTH_TOKEN) return next();
  res.writeHead(401, { 'Content-Type': 'application/json' });
  res.end(JSON.stringify({ error: 'Unauthorized' }));
}


const agentsDir = path.join(ecosystemDir, 'agents');

  // Keep track of current data caches
  let cachedAgents: AgentSummary[] = [];
  let cachedStats: StatsResponse | null = null;

  // ── Shared state loading ──

  async function loadAgentSummaries(): Promise<AgentSummary[]> {
    try {
      const dir = await fs.readdir(agentsDir);
      const agents: AgentSummary[] = [];
      for (const file of dir) {
        if (!file.endsWith('.json')) continue;
        try {
          const raw = await fs.readFile(path.join(agentsDir, file), 'utf-8');
          const state = JSON.parse(raw) as AgentState;
          agents.push({
            id: state.id,
            genome: {
              personaName: state.genome.personaName,
              traits: state.genome.traits,
            },
            tokenBalance: state.tokenBalance,
            reputation: state.reputation,
            fitness: state.fitness,
            age: state.age,
            generation: state.generation,
            alive: state.alive,
            gender: state.diploidGenome?.gender,
          });
        } catch {
          // skip corrupted files
        }
      }
      return agents;
    } catch {
      return [];
    }
  }

  async function loadAllEvents(): Promise<EventLogEntry[]> {
    const all: EventLogEntry[] = [];
    for await (const entry of eventLog.replay(0)) {
      all.push(entry);
    }
    return all;
  }

  /**
   * Walk events in chain order and stamp each with the cycle it belongs to.
   * Cycles are inferred from `cycle_start` markers — every event that follows
   * a `cycle_start` until the next one is attributed to that cycle. Events
   * before the first `cycle_start` get `cycle: null`. Useful for the
   * dashboard's time-travel filter, since most event types don't carry a
   * cycle field in their `data`.
   */
  function annotateEventsWithCycle(events: EventLogEntry[]): Array<EventLogEntry & { cycle: number | null }> {
    let current: number | null = null;
    return events.map(e => {
      if (e.type === 'cycle_start') {
        const c = (e.data as { cycle?: unknown })?.cycle;
        if (typeof c === 'number') current = c;
      }
      return { ...e, cycle: current };
    });
  }

  async function loadEvents(
    limit: number = 50,
    offset: number = 0,
    type?: string,
    fromCycle?: number,
    toCycle?: number,
  ): Promise<Array<EventLogEntry & { cycle: number | null }>> {
    const all = await loadAllEvents();
    const annotated = annotateEventsWithCycle(all);
    let filtered = annotated;
    if (type && type !== 'all') {
      filtered = filtered.filter(e => e.type === type);
    }
    if (typeof fromCycle === 'number') {
      filtered = filtered.filter(e => e.cycle !== null && e.cycle >= fromCycle);
    }
    if (typeof toCycle === 'number') {
      filtered = filtered.filter(e => e.cycle !== null && e.cycle <= toCycle);
    }
    // Reverse chronological order
    const reversed = filtered.reverse();
    return reversed.slice(offset, offset + limit);
  }

  async function loadCycleRange(): Promise<{ minCycle: number | null; maxCycle: number | null }> {
    const all = await loadAllEvents();
    let min: number | null = null;
    let max: number | null = null;
    for (const e of all) {
      if (e.type !== 'cycle_start') continue;
      const c = (e.data as { cycle?: unknown })?.cycle;
      if (typeof c !== 'number') continue;
      if (min === null || c < min) min = c;
      if (max === null || c > max) max = c;
    }
    return { minCycle: min, maxCycle: max };
  }

  async function loadEventById(idStr: string): Promise<{ event: EventLogEntry; relatedEvents: EventLogEntry[] } | null> {
    const index = parseInt(idStr, 10);
    if (isNaN(index)) return null;
    const all = await loadAllEvents();
    const event = all.find(e => e.index === index);
    if (!event) return null;

    // Find related events from same agent (up to 5 before, 5 after)
    const agentEvents = all.filter(e => e.agentId === event.agentId);
    const eventIdxInAgentEvents = agentEvents.findIndex(e => e.index === index);
    const start = Math.max(0, eventIdxInAgentEvents - 5);
    const end = Math.min(agentEvents.length, eventIdxInAgentEvents + 6);
    const relatedEvents = agentEvents.slice(start, end).filter(e => e.index !== index);

    return { event, relatedEvents };
  }

  async function loadTree(): Promise<{ nodes: TreeAgentNode[] }> {
    const nodes: TreeAgentNode[] = [];
    try {
      const dir = await fs.readdir(agentsDir);
      for (const file of dir) {
        if (!file.endsWith('.json')) continue;
        try {
          const raw = await fs.readFile(path.join(agentsDir, file), 'utf-8');
          const state = JSON.parse(raw) as AgentState;
          nodes.push({
            id: state.id,
            personaName: state.genome.personaName,
            generation: state.generation,
            parentId: state.parentId,
            parentIds: state.parentIds,
            alive: state.alive,
            fitness: state.fitness,
          });
        } catch {
          // skip corrupted files
        }
      }
    } catch {
      // agents dir doesn't exist
    }
    return { nodes };
  }

  async function loadConfig(): Promise<ConfigResponse> {
    const configPath = path.join(ecosystemDir, 'config.json');
    const cfg = await safeReadJSON<ConfigResponse>(configPath);
    if (cfg) return cfg;
    return {
      cycleIntervalMs: 14400000,
      eliminationRate: 0.3,
      mutationBaseRate: 0.1,
      maxAgents: 20,
      defaultTokenPerCycle: 1000000,
      newAgentProtectionRounds: 3,
    };
  }

  async function computeStats(agents: AgentSummary[]): Promise<StatsResponse> {
    const alive = agents.filter(a => a.alive);
    const popSize = alive.length;

    if (popSize === 0) {
      return {
        averageFitness: 0,
        maxFitness: 0,
        populationSize: 0,
        generationRange: [0, 0],
        traitDistribution: {},
        roleDistribution: {},
        fitnessHistory: [],
        tokenSupply: 0,
        reputationAvg: 0,
      };
    }

    const totalFitness = alive.reduce((s, a) => s + a.fitness, 0);
    const maxFitness = Math.max(...alive.map(a => a.fitness));
    const avgFitness = totalFitness / popSize;

    const generations = alive.map(a => a.generation);
    const minGen = Math.min(...generations);
    const maxGen = Math.max(...generations);

    // Trait distribution
    const traitDist: Record<string, number> = {};
    for (const agent of alive) {
      if (agent.genome?.traits) {
        for (const trait of agent.genome.traits) {
          traitDist[trait] = (traitDist[trait] || 0) + 1;
        }
      }
    }

    // Role (personaName) distribution
    const roleDist: Record<string, number> = {};
    for (const agent of alive) {
      const role = agent.genome?.personaName || 'unknown';
      roleDist[role] = (roleDist[role] || 0) + 1;
    }

    // Fitness history from events
    const fitnessHistory: Array<{ cycle: number; avg: number; max: number; min: number }> = [];
    const allEvents: EventLogEntry[] = [];
    for await (const entry of eventLog.replay(0)) {
      allEvents.push(entry);
    }
    for (const entry of allEvents) {
      if (entry.data?.fitnessStats) {
        const stats = entry.data.fitnessStats as Record<string, number>;
        fitnessHistory.push({
          cycle: (entry.data.cycle as number) || 0,
          avg: stats.avg ?? 0,
          max: stats.max ?? 0,
          min: stats.min ?? 0,
        });
      }
    }

    const totalTokens = agents.reduce((s, a) => s + a.tokenBalance, 0);
    const repAvg = agents.reduce((s, a) => s + a.reputation, 0) / agents.length;

    return {
      averageFitness: Math.round(avgFitness * 100) / 100,
      maxFitness,
      populationSize: popSize,
      generationRange: [minGen, maxGen],
      traitDistribution: traitDist,
      roleDistribution: roleDist,
      fitnessHistory,
      tokenSupply: totalTokens,
      reputationAvg: Math.round(repAvg * 100) / 100,
    };
  }

  // ── JSON body reader for POST/PUT ──

  function readJSONBody(req: http.IncomingMessage): Promise<any> {
    return new Promise((resolve, reject) => {
      let raw = '';
      req.on('data', (chunk: Buffer) => { raw += chunk.toString(); });
      req.on('end', () => {
        try {
          resolve(raw ? JSON.parse(raw) : null);
        } catch {
          resolve(null);
        }
      });
      req.on('error', reject);
    });
  }

  async function refreshCache(): Promise<void> {
    cachedAgents = await loadAgentSummaries();
    cachedStats = await computeStats(cachedAgents);
  }

  // ── HTTP Server ──

  const server = http.createServer(async (req, res) => {
    // CORS first — the browser needs these headers on EVERY response,
    // including the 401 from authMiddleware, or it drops the response and
    // the frontend can't see the actual status code.
    res.setHeader('Access-Control-Allow-Origin', '*');
    res.setHeader('Access-Control-Allow-Methods', 'GET, POST, PUT, OPTIONS');
    res.setHeader('Access-Control-Allow-Headers', 'Content-Type, x-auth-token');

    if (req.method === 'OPTIONS') {
      res.writeHead(204);
      res.end();
      return;
    }

    // Auth guard
    let authSkipped = false;
    authMiddleware(req, res, () => { authSkipped = true; });
    if (!authSkipped) return;

    const url = new URL(req.url || '/', `http://${req.headers.host || 'localhost'}`);
    const pathname = url.pathname;

    // Auth check endpoint
    if (pathname === '/auth-check' && req.method === 'POST') {
      let body = '';
      req.on('data', c => body += c);
      req.on('end', () => {
        try {
          const { token } = JSON.parse(body);
          const ip = req.socket?.remoteAddress || 'unknown';
          const limit = checkRateLimit(ip);
          if (!limit.allowed) {
            res.writeHead(429, { 'Content-Type': 'application/json' });
            res.end(JSON.stringify({ error: 'Rate limited', waitSeconds: limit.waitSeconds }));
            return;
          }
          if (token === AUTH_TOKEN) {
            recordSuccess(ip);
            // Frontend receives the validated password back as the token to
            // send on subsequent requests via x-auth-token. No cookies — the
            // frontend lives on a separate origin.
            res.writeHead(200, { 'Content-Type': 'application/json' });
            res.end(JSON.stringify({ ok: true, token }));
          } else {
            const entry = recordFailure(ip);
            res.writeHead(401, { 'Content-Type': 'application/json' });
            res.end(JSON.stringify({ error: 'Invalid password', attempts: entry.count, lockedUntil: entry.lockedUntil }));
          }
        } catch(e) { res.writeHead(400); res.end(); }
      });
      return;
    }



    // ── Bounties file path ──
    const bountiesPath = path.join(ecosystemDir, 'bounties', 'bounties.json');

    try {
      if (pathname === '/api/agents' && req.method === 'GET') {
        await refreshCache();
        res.writeHead(200, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify(cachedAgents));
        return;
      }

      if (pathname.startsWith('/api/agents/') && req.method === 'GET') {
        const agentId = pathname.slice('/api/agents/'.length);
        if (!agentId) {
          res.writeHead(400);
          res.end(JSON.stringify({ error: 'Missing agent ID' }));
          return;
        }
        const agentPath = path.join(agentsDir, `${agentId}.json`);
        const state = await safeReadJSON<AgentState>(agentPath);
        if (!state) {
          res.writeHead(404);
          res.end(JSON.stringify({ error: 'Agent not found' }));
          return;
        }
        res.writeHead(200, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify(state));
        return;
      }

      if (pathname === '/api/events' && req.method === 'GET') {
        const limit = parseInt(url.searchParams.get('limit') || '50', 10);
        const offset = parseInt(url.searchParams.get('offset') || '0', 10);
        const type = url.searchParams.get('type') || 'all';
        const fromCycleRaw = url.searchParams.get('fromCycle');
        const toCycleRaw = url.searchParams.get('toCycle');
        const fromCycle = fromCycleRaw !== null && fromCycleRaw !== '' ? parseInt(fromCycleRaw, 10) : undefined;
        const toCycle = toCycleRaw !== null && toCycleRaw !== '' ? parseInt(toCycleRaw, 10) : undefined;
        const events = await loadEvents(
          limit,
          offset,
          type,
          Number.isFinite(fromCycle) ? fromCycle : undefined,
          Number.isFinite(toCycle) ? toCycle : undefined,
        );
        res.writeHead(200, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify(events));
        return;
      }

      if (pathname === '/api/events/cycle-range' && req.method === 'GET') {
        const range = await loadCycleRange();
        res.writeHead(200, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify(range));
        return;
      }

      if (pathname.startsWith('/api/events/') && req.method === 'GET') {
        const idStr = pathname.slice('/api/events/'.length);
        if (!idStr) {
          res.writeHead(400);
          res.end(JSON.stringify({ error: 'Missing event index' }));
          return;
        }
        const result = await loadEventById(idStr);
        if (!result) {
          res.writeHead(404);
          res.end(JSON.stringify({ error: 'Event not found' }));
          return;
        }
        res.writeHead(200, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify(result));
        return;
      }

      if (pathname === '/api/market' && req.method === 'GET') {
        const marketPath = path.join(ecosystemDir, 'market.json');
        const market = await safeReadJSON<{ resources: Resource[]; deals: Deal[] }>(marketPath);
        res.writeHead(200, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify(market || { resources: [], deals: [] }));
        return;
      }

      if (pathname === '/api/stats' && req.method === 'GET') {
        await refreshCache();
        res.writeHead(200, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify(cachedStats));
        return;
      }

      if (pathname === '/api/config' && req.method === 'GET') {
        const config = await loadConfig();
        res.writeHead(200, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify(config));
        return;
      }

      if (pathname === '/api/tree' && req.method === 'GET') {
        const tree = await loadTree();
        res.writeHead(200, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify(tree));
        return;
      }

      // ── Bounties ──

      // GET /api/bounties?status=open
      if (pathname === '/api/bounties' && req.method === 'GET') {
        const status = url.searchParams.get('status') || undefined;
        let bounties = (await safeReadJSON<Bounty[]>(bountiesPath)) || [];
        if (status) {
          bounties = bounties.filter(b => b.status === status);
        }
        res.writeHead(200, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify(bounties));
        return;
      }

      // POST /api/bounties — create a new bounty
      if (pathname === '/api/bounties' && req.method === 'POST') {
        const body = await readJSONBody(req);
        if (!body || !body.title) {
          res.writeHead(400);
          res.end(JSON.stringify({ error: 'Missing required fields (title)' }));
          return;
        }

        const bounty: Bounty = {
          id: `bounty_${randomBytes(4).toString('hex')}_${Date.now()}`,
          title: body.title,
          description: body.description || '',
          type: body.type || 'other',
          reward: body.reward || 0,
          depositRate: 0.5,
          status: 'open',
          bids: [],
          winningBidId: null,
          verificationTests: [],
          verifierAgentId: body.verifierAgentId || 'supervisor',
          escrowFrozen: 0,
          retryCount: 0,
          maxRetries: 3,
          creatorId: body.creatorId || 'system',
          createdAt: Date.now(),
          deadline: body.deadline || (Date.now() + 86400000),
          completedAt: null,
        };

        const bounties = (await safeReadJSON<Bounty[]>(bountiesPath)) || [];
        bounties.push(bounty);
        await safeWriteJSON(bountiesPath, bounties);

        res.writeHead(201, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify(bounty));
        return;
      }

      // GET /api/bounties/:id
      if (pathname.startsWith('/api/bounties/') && req.method === 'GET') {
        const bountyId = pathname.slice('/api/bounties/'.length);
        if (!bountyId || bountyId.includes('/')) {
          res.writeHead(404);
          res.end(JSON.stringify({ error: 'Not found' }));
          return;
        }
        const bounties = (await safeReadJSON<Bounty[]>(bountiesPath)) || [];
        const bounty = bounties.find(b => b.id === bountyId);
        if (!bounty) {
          res.writeHead(404);
          res.end(JSON.stringify({ error: 'Bounty not found' }));
          return;
        }
        res.writeHead(200, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify(bounty));
        return;
      }

      // POST /api/bounties/:id/bid
      if (pathname.startsWith('/api/bounties/') && pathname.endsWith('/bid') && req.method === 'POST') {
        const bountyId = pathname.slice('/api/bounties/'.length, -'/bid'.length);
        if (!bountyId) {
          res.writeHead(404);
          res.end(JSON.stringify({ error: 'Not found' }));
          return;
        }
        const bounties = (await safeReadJSON<Bounty[]>(bountiesPath)) || [];
        const idx = bounties.findIndex(b => b.id === bountyId);
        if (idx === -1) {
          res.writeHead(404);
          res.end(JSON.stringify({ error: 'Bounty not found' }));
          return;
        }

        const body = await readJSONBody(req);
        if (!body || !body.agentId || body.price === undefined || !body.plan) {
          res.writeHead(400);
          res.end(JSON.stringify({ error: 'Missing required fields (agentId, price, plan)' }));
          return;
        }

        const bounty = bounties[idx];
        const deposit = Math.floor(bounty.reward * bounty.depositRate);
        const bid: Bid = {
          id: `bid_${randomBytes(4).toString('hex')}_${Date.now()}`,
          bountyId,
          agentId: body.agentId,
          price: body.price,
          plan: body.plan,
          deposit,
          createdAt: Date.now(),
        };

        bounties[idx].bids.push(bid);
        bounties[idx].status = 'bidding';
        await safeWriteJSON(bountiesPath, bounties);

        res.writeHead(201, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify(bid));
        return;
      }

      // PUT /api/bounties/:id/publisher-approve
      if (pathname.startsWith('/api/bounties/') && pathname.endsWith('/publisher-approve') && req.method === 'PUT') {
        const bountyId = pathname.slice('/api/bounties/'.length, -'/publisher-approve'.length);
        const bounties = (await safeReadJSON<Bounty[]>(bountiesPath)) || [];
        const idx = bounties.findIndex(b => b.id === bountyId);
        if (idx >= 0 && bounties[idx].status === 'submitted') {
          bounties[idx].status = 'publisher_review';
          await safeWriteJSON(bountiesPath, bounties);
          res.writeHead(200, { "Content-Type": "application/json" }); res.end(JSON.stringify(bounties[idx]));
        } else {
          res.writeHead(400, { "Content-Type": "application/json" }); res.end(JSON.stringify({error:'Invalid state'}));
        }
        return;
      }
      // PUT /api/bounties/:id/publisher-reject
      if (pathname.startsWith('/api/bounties/') && pathname.endsWith('/publisher-reject') && req.method === 'PUT') {
        const bountyId = pathname.slice('/api/bounties/'.length, -'/publisher-reject'.length);
        const data = await readJSONBody(req);
        const bounties = (await safeReadJSON<Bounty[]>(bountiesPath)) || [];
        const idx = bounties.findIndex(b => b.id === bountyId);
        if (idx >= 0 && bounties[idx].status === 'submitted') {
          bounties[idx].status = 'executing';
          await safeWriteJSON(bountiesPath, bounties);
          res.writeHead(200, { "Content-Type": "application/json" }); res.end(JSON.stringify(bounties[idx]));
        } else {
          res.writeHead(400, { "Content-Type": "application/json" }); res.end(JSON.stringify({error:'Invalid state'}));
        }
        return;
      }
      // PUT /api/bounties/:id/award
      if (pathname.startsWith('/api/bounties/') && pathname.endsWith('/award') && req.method === 'PUT') {
        const bountyId = pathname.slice('/api/bounties/'.length, -'/award'.length);
        if (!bountyId) {
          res.writeHead(404);
          res.end(JSON.stringify({ error: 'Not found' }));
          return;
        }
        const bounties = (await safeReadJSON<Bounty[]>(bountiesPath)) || [];
        const idx = bounties.findIndex(b => b.id === bountyId);
        if (idx === -1) {
          res.writeHead(404);
          res.end(JSON.stringify({ error: 'Bounty not found' }));
          return;
        }

        const body = await readJSONBody(req);
        if (!body || !body.winningBidId) {
          res.writeHead(400);
          res.end(JSON.stringify({ error: 'Missing winningBidId' }));
          return;
        }

        const winningBid = bounties[idx].bids.find(b => b.id === body.winningBidId);
        if (!winningBid) {
          res.writeHead(400);
          res.end(JSON.stringify({ error: 'Bid not found' }));
          return;
        }

        bounties[idx].winningBidId = body.winningBidId;
        bounties[idx].escrowFrozen = bounties[idx].reward;
        bounties[idx].status = 'awarded';
        await safeWriteJSON(bountiesPath, bounties);

        res.writeHead(200, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify(bounties[idx]));
        return;
      }

      // No matching API route. The frontend is served separately from the
      // standalone web/ directory (see `npm run web`).
      res.writeHead(404, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ error: 'Not found' }));
    } catch (err) {
      console.error('Dashboard server error:', err);
      res.writeHead(500);
      res.end('Internal Server Error');
    }
  });

  // ── WebSocket Server ──

  const wss = new WebSocketServer({ server, path: '/ws' });

  wss.on('connection', async (ws) => {
    // Register the message handler BEFORE the await to avoid a race where a
    // ping sent immediately after `open` arrives before the handler exists.
    ws.on('message', (raw) => {
      try {
        const msg = JSON.parse(raw.toString());
        if (msg.type === 'ping') {
          ws.send(JSON.stringify({ type: 'pong' }));
        }
      } catch {
        // ignore invalid messages
      }
    });

    // Send initial snapshot
    await refreshCache();
    const snapshot: SnapshotData = {
      type: 'snapshot',
      agents: cachedAgents,
      stats: cachedStats!,
    };
    ws.send(JSON.stringify(snapshot));

    // Periodic push every 2 seconds
    const interval = setInterval(async () => {
      if (ws.readyState !== WebSocket.OPEN) {
        clearInterval(interval);
        return;
      }
      await refreshCache();
      const snap: SnapshotData = {
        type: 'snapshot',
        agents: cachedAgents,
        stats: cachedStats!,
      };
      try {
        ws.send(JSON.stringify(snap));
      } catch {
        clearInterval(interval);
      }
    }, 2000);

    ws.on('close', () => clearInterval(interval));
    ws.on('error', () => clearInterval(interval));
  });

  // ── Listen (port 0 = random assigned port) ──

  server.listen(port, '127.0.0.1');

  // ── Broadcast ──

  async function broadcast(): Promise<void> {
    await refreshCache();
    const snapshot: SnapshotData = {
      type: 'snapshot',
      agents: cachedAgents,
      stats: cachedStats!,
    };
    const data = JSON.stringify(snapshot);

    wss.clients.forEach((ws) => {
      if (ws.readyState === WebSocket.OPEN) {
        ws.send(data);
      }
    });
  }

  return { server, broadcast };
}
