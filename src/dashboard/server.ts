import http from 'node:http';
import path from 'node:path';
import fs from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import { randomBytes, createHash } from 'node:crypto';
import { WebSocketServer, WebSocket } from 'ws';
import { EventLog } from '../supervisor/event-log.js';
import type { AgentState, EventLogEntry, Resource, Deal } from '../shared/types.js';
import { safeReadJSON } from '../shared/filesystem.js';

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

// ── Dashboard Server ──────────────────────────────────────────────────────

export function startDashboard(ecosystemDir: string, port: number = 3000) {
  const eventLog = new EventLog(ecosystemDir);
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

  async function loadEvents(limit: number = 50, offset: number = 0): Promise<EventLogEntry[]> {
    const all: EventLogEntry[] = [];
    for await (const entry of eventLog.replay(0)) {
      all.push(entry);
    }
    // Reverse chronological order
    const reversed = all.reverse();
    return reversed.slice(offset, offset + limit);
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

  async function refreshCache(): Promise<void> {
    cachedAgents = await loadAgentSummaries();
    cachedStats = await computeStats(cachedAgents);
  }

  // ── HTTP Server ──

  const server = http.createServer(async (req, res) => {
    // CORS
    res.setHeader('Access-Control-Allow-Origin', '*');
    res.setHeader('Access-Control-Allow-Methods', 'GET, OPTIONS');
    res.setHeader('Access-Control-Allow-Headers', 'Content-Type');

    if (req.method === 'OPTIONS') {
      res.writeHead(204);
      res.end();
      return;
    }

    const url = new URL(req.url || '/', `http://${req.headers.host || 'localhost'}`);
    const pathname = url.pathname;

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
        const events = await loadEvents(limit, offset);
        res.writeHead(200, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify(events));
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

      // ── Static Files ──

      let filePath: string;
      if (pathname === '/' || pathname === '/index.html') {
        filePath = path.join(__dirname, 'public', 'index.html');
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
    // Send initial snapshot
    await refreshCache();
    const snapshot: SnapshotData = {
      type: 'snapshot',
      agents: cachedAgents,
      stats: cachedStats!,
    };
    ws.send(JSON.stringify(snapshot));

    // Handle ping/pong
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
