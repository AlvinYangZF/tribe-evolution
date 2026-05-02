import http from 'node:http';
import path from 'node:path';
import fs from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import { randomBytes, createHash } from 'node:crypto';
import { WebSocketServer, WebSocket } from 'ws';
import { EventLog } from '../supervisor/event-log.js';
import type { AgentState, EventLogEntry, Resource, Deal, EventType, Bounty, BountyStatus, Bid } from '../shared/types.js';
import { safeReadJSON, safeWriteJSON } from '../shared/filesystem.js';

// ── ESM dirname shim ──────────────────────────────────────────────────────

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

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
const AUTH_TOKEN = process.env.DASHBOARD_AUTH_TOKEN || 'tribe-admin';
function authMiddleware(req: any, res: any, next: any) {
  // Allow public access to login page
  if (req.url === '/' || req.url === '/login' || req.url === '/auth-check' || req.url?.startsWith('/static/')) {
    return next();
  }
  // Check cookie first, then header
  const cookies = (req.headers['cookie'] || '').split(';').reduce((acc, c) => {
    const [k, v] = c.trim().split('=');
    if (k && v) acc[k] = v;
    return acc;
  }, {} as Record<string, string>);
  const token = cookies['tribe_token'] || req.headers['x-auth-token'] || '';
  if (token === AUTH_TOKEN) return next();
  if (req.method === 'GET' && req.headers['accept']?.includes('text/html')) {
    res.writeHead(302, { 'Location': '/login' });
    return res.end();
  }
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

  async function loadEvents(limit: number = 50, offset: number = 0, type?: string): Promise<EventLogEntry[]> {
    const all = await loadAllEvents();
    let filtered = all;
    if (type && type !== 'all') {
      filtered = all.filter(e => e.type === type);
    }
    // Reverse chronological order
    const reversed = filtered.reverse();
    return reversed.slice(offset, offset + limit);
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
    // Auth guard
    let authSkipped = false;
    const originalEnd = res.end.bind(res);
    authMiddleware(req, res, () => { authSkipped = true; });
    if (!authSkipped) return;
    // CORS
    res.setHeader('Access-Control-Allow-Origin', '*');
    res.setHeader('Access-Control-Allow-Methods', 'GET, POST, PUT, OPTIONS');
    res.setHeader('Access-Control-Allow-Headers', 'Content-Type');

    if (req.method === 'OPTIONS') {
      res.writeHead(204);
      res.end();
      return;
    }

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
            res.writeHead(200, { 
              'Content-Type': 'application/json',
              'Set-Cookie': 'tribe_token=' + token + '; Path=/; Max-Age=86400; SameSite=Lax'
            });
            res.end(JSON.stringify({ ok: true }));
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
        const events = await loadEvents(limit, offset, type);
        res.writeHead(200, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify(events));
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

      // ── Static Files ──

      let filePath: string;
    // Login page
    if (pathname === '/login' && req.method === 'GET') {
      res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8' });
      res.end('<!DOCTYPE html><html lang="zh-CN"><head><meta charset="UTF-8"><meta name="viewport" content="width=device-width,initial-scale=1.0"><title>Tribe Login</title><style>*{margin:0;padding:0;box-sizing:border-box}body{font-family:system-ui,sans-serif;background:#0d1117;color:#e6edf3;display:flex;align-items:center;justify-content:center;min-height:100vh}.box{background:#161b22;border:1px solid #30363d;border-radius:12px;padding:40px;width:360px;text-align:center}.box h1{font-size:24px;margin-bottom:4px}.box span{color:#39d353}.box p{color:#8b949e;font-size:14px;margin-bottom:20px}.box input{width:100%;padding:12px;margin-bottom:12px;background:#0d1117;border:1px solid #30363d;border-radius:8px;color:#e6edf3;font-size:16px;outline:none}.box input:focus{border-color:#39d353}.box button{width:100%;padding:12px;background:#238636;color:#fff;border:none;border-radius:8px;font-size:16px;cursor:pointer;font-weight:600}.box button:disabled{opacity:.5}.box .err{color:#f85149;font-size:13px;margin-top:8px;display:none}.box .warn{color:#d29922;font-size:13px;margin-top:8px;display:none}</style></head><body><div class="box"><h1>🧬 <span>Tribe</span> Evolution</h1><p>3次错误锁定30秒</p><input type="password" id="pwd" placeholder="输入密码" autofocus><button id="btn" onclick="login()">🔐 登录</button><div class="err" id="err"></div><div class="warn" id="warn"></div></div><script>var fails=0,locked=0;function login(){var p=document.getElementById("pwd").value,e=document.getElementById("err"),w=document.getElementById("warn"),b=document.getElementById("btn");if(!p)return;var n=Date.now();if(locked&&n<locked){var s=Math.ceil((locked-n)/1000);w.textContent="请等待 "+s+" 秒";w.style.display="block";return}w.style.display="none";e.style.display="none";fetch("/auth-check",{method:"POST",body:JSON.stringify({token:p}),headers:{"Content-Type":"application/json"}}).then(function(r){return r.json().then(function(d){return{ok:r.ok,data:d}})}).then(function(r){if(r.ok){sessionStorage.setItem("tribe_token",p);location.href="/"}else{fails=r.data.attempts||(fails+1);if(r.data.lockedUntil){locked=r.data.lockedUntil;var wait=Math.ceil((locked-Date.now())/1000);w.textContent="已锁定,请等待 "+wait+" 秒";w.style.display="block";b.disabled=true;var iv=setInterval(function(){var left=Math.ceil((locked-Date.now())/1000);if(left<=0){b.disabled=false;w.style.display="none";locked=0;fails=0;clearInterval(iv)}else w.textContent="请等待 "+left+" 秒后重试"},1000)}else{e.style.display="block";e.textContent="密码错误 ("+fails+"/3)"}}})}document.getElementById("pwd").addEventListener("keydown",function(e){if(e.key==="Enter")login()})</script></body></html>');
      return;
    }

    // Serve dashboard
      if (pathname === '/' || pathname === '/index.html') {
        // Serve dashboard if authenticated by cookie OR x-auth-token header,
        // else show the login page. Matches the rest of the auth middleware.
        const cookies = (req.headers['cookie'] || '').split(';').reduce((acc, c) => {
          const [k, v] = c.trim().split('=');
          if (k && v) acc[k] = v;
          return acc;
        }, {} as Record<string, string>);
        const headerToken = req.headers['x-auth-token'] || '';
        const authed = cookies['tribe_token'] === AUTH_TOKEN || headerToken === AUTH_TOKEN;
        if (authed) {
          filePath = path.join(__dirname, 'public', 'index.html');
        } else {
          // Serve login page
          res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8' });
          res.end('<!DOCTYPE html><html lang="zh-CN"><head><meta charset="UTF-8"><meta name="viewport" content="width=device-width,initial-scale=1.0"><title>Tribe Login</title><style>*{margin:0;padding:0;box-sizing:border-box}body{font-family:system-ui,sans-serif;background:#0d1117;color:#e6edf3;display:flex;align-items:center;justify-content:center;min-height:100vh}.box{background:#161b22;border:1px solid #30363d;border-radius:12px;padding:40px;width:360px;text-align:center}.box h1{font-size:24px;margin-bottom:4px}.box span{color:#39d353}.box p{color:#8b949e;font-size:14px;margin-bottom:20px}.box input{width:100%;padding:12px;margin-bottom:12px;background:#0d1117;border:1px solid #30363d;border-radius:8px;color:#e6edf3;font-size:16px;outline:none}.box input:focus{border-color:#39d353}.box button{width:100%;padding:12px;background:#238636;color:#fff;border:none;border-radius:8px;font-size:16px;cursor:pointer;font-weight:600}.box button:disabled{opacity:.5}.box .err{color:#f85149;font-size:13px;margin-top:8px;display:none}.box .warn{color:#d29922;font-size:13px;margin-top:8px;display:none}</style></head><body><div class="box"><h1>🧬 <span>Tribe</span> Evolution</h1><p>3次错误锁定30秒</p><input type="password" id="pwd" placeholder="输入密码" autofocus><button id="btn" onclick="login()">🔐 登录</button><div class="err" id="err"></div><div class="warn" id="warn"></div></div><script>var fails=0,locked=0;function login(){var p=document.getElementById("pwd").value,e=document.getElementById("err"),w=document.getElementById("warn"),b=document.getElementById("btn");if(!p)return;var n=Date.now();if(locked&&n<locked){var s=Math.ceil((locked-n)/1000);w.textContent="请等待 "+s+" 秒";w.style.display="block";return}w.style.display="none";e.style.display="none";fetch("/auth-check",{method:"POST",body:JSON.stringify({token:p}),headers:{"Content-Type":"application/json"}}).then(function(r){return r.json().then(function(d){return{ok:r.ok,data:d}})}).then(function(r){if(r.ok){location.href="/"}else{fails=r.data.attempts||(fails+1);if(r.data.lockedUntil){locked=r.data.lockedUntil;var wait=Math.ceil((locked-Date.now())/1000);w.textContent="已锁定,请等待 "+wait+" 秒";w.style.display="block";b.disabled=true;var iv=setInterval(function(){var left=Math.ceil((locked-Date.now())/1000);if(left<=0){b.disabled=false;w.style.display="none";locked=0;fails=0;clearInterval(iv)}else w.textContent="请等待 "+left+" 秒后重试"},1000)}else{e.style.display="block";e.textContent="密码错误 ("+fails+"/3)"}}})}document.getElementById("pwd").addEventListener("keydown",function(e){if(e.key==="Enter")login()})</script></body></html>');
          return;
        }
      } else {
        filePath = path.join(__dirname, 'public', pathname);
      }

      // Security: prevent directory traversal
      const publicDir = path.resolve(path.join(__dirname, 'public'));
      const resolved = path.resolve(filePath);
      if (!resolved.startsWith(publicDir)) {
        res.writeHead(403);
        res.end('Forbidden');
        return;
      }

      try {
        const content = await fs.readFile(resolved);
        const ext = path.extname(resolved).toLowerCase();
        const mimeTypes: Record<string, string> = {
          '.html': 'text/html',
          '.js': 'application/javascript',
          '.css': 'text/css',
          '.png': 'image/png',
          '.jpg': 'image/jpeg',
          '.svg': 'image/svg+xml',
          '.ico': 'image/x-icon',
          '.json': 'application/json',
        };
        res.writeHead(200, { 'Content-Type': mimeTypes[ext] || 'application/octet-stream' });
        res.end(content);
      } catch {
        res.writeHead(404);
        res.end('Not Found');
      }
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
