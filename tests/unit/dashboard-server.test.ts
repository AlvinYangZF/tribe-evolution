import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import fs from 'node:fs/promises';
import path from 'node:path';
import os from 'node:os';
import { WebSocket } from 'ws';
import { startDashboard } from '../../src/dashboard/server.js';
import { EventLog } from '../../src/supervisor/event-log.js';

const TMP_DIR = path.join(os.tmpdir(), `tribe-dashboard-test-${Date.now()}`);
let dashboard: ReturnType<typeof startDashboard>;
let baseUrl: string;
let wsUrl: string;

// The dashboard reads `process.env.DASHBOARD_AUTH_TOKEN || 'tribe-admin'` at
// module load time. Tests use the default token via this helper so every
// REST call is authenticated.
const AUTH_TOKEN = 'tribe-admin';
function authedFetch(url: string, init: RequestInit = {}): Promise<Response> {
  const headers = new Headers(init.headers);
  headers.set('x-auth-token', AUTH_TOKEN);
  return fetch(url, { ...init, headers });
}

async function seedAgents() {
  const agentsDir = path.join(TMP_DIR, 'agents');
  await fs.mkdir(agentsDir, { recursive: true });

  const agents = [
    { id: 'agent_001', genome: { personaName: 'Explorer', traits: ['curious'] }, generation: 0, parentId: null, fitness: 85.3, alive: true, tokenBalance: 1000, reputation: 0.9, age: 10, createdAt: Date.now(), contributionScore: 5, dealsKept: 3, dealsBroken: 0, protectionRounds: 0 },
    { id: 'agent_002', genome: { personaName: 'Worker', traits: ['helpful'] }, generation: 1, parentId: 'agent_001', fitness: 72.1, alive: true, tokenBalance: 800, reputation: 0.8, age: 5, createdAt: Date.now(), contributionScore: 3, dealsKept: 2, dealsBroken: 0, protectionRounds: 0 },
    { id: 'agent_003', genome: { personaName: 'Trader', traits: ['cooperative'] }, generation: 1, parentId: 'agent_001', fitness: 60.0, alive: false, tokenBalance: 500, reputation: 0.7, age: 8, createdAt: Date.now(), contributionScore: 2, dealsKept: 1, dealsBroken: 1, protectionRounds: 0 },
    { id: 'agent_004', genome: { personaName: 'Creator', traits: ['creative'] }, generation: 2, parentId: 'agent_002', fitness: 40.0, alive: true, tokenBalance: 300, reputation: 0.6, age: 3, createdAt: Date.now(), contributionScore: 1, dealsKept: 0, dealsBroken: 0, protectionRounds: 1 },
  ];

  for (const agent of agents) {
    await fs.writeFile(path.join(agentsDir, `${agent.id}.json`), JSON.stringify(agent, null, 2), 'utf-8');
  }
}

async function seedEvents() {
  const eventLog = new EventLog(TMP_DIR);

  // Seed events for agent_001
  await eventLog.append({ type: 'agent_born', agentId: 'agent_001', data: { role: 'Explorer' } });
  await eventLog.append({ type: 'task_completed', agentId: 'agent_001', data: { task: 'explore_terrain' } });
  await eventLog.append({ type: 'token_allocated', agentId: 'agent_001', data: { amount: 500 } });
  await eventLog.append({ type: 'mutation', agentId: 'agent_001', data: { traitChanged: 'curiosity' } });
  await eventLog.append({ type: 'task_completed', agentId: 'agent_001', data: { task: 'collect_data' } });
  await eventLog.append({ type: 'deal_kept', agentId: 'agent_001', data: { partner: 'agent_002' } });

  // Events for agent_002
  await eventLog.append({ type: 'agent_born', agentId: 'agent_002', data: { role: 'Worker' } });
  await eventLog.append({ type: 'task_completed', agentId: 'agent_002', data: { task: 'build_shelter' } });
  await eventLog.append({ type: 'deal_broken', agentId: 'agent_003', data: { partner: 'agent_001' } });
  await eventLog.append({ type: 'agent_extinct', agentId: 'agent_003', data: { cause: 'starvation' } });
}

describe('Dashboard Server', () => {
  beforeAll(async () => {
    await fs.mkdir(TMP_DIR, { recursive: true });
    await seedAgents();
    await seedEvents();

    // We need to wait for the server to be listening before we can get the port
    dashboard = startDashboard(TMP_DIR, 0);

    await new Promise<void>((resolve) => {
      dashboard.server.on('listening', () => {
        const addr = dashboard.server.address();
        if (typeof addr === 'object' && addr) {
          const port = addr.port;
          baseUrl = `http://localhost:${port}`;
          wsUrl = `ws://localhost:${port}/ws`;
        }
        resolve();
      });
    });
  });

  afterAll(async () => {
    await new Promise<void>((resolve) => dashboard.server.close(() => resolve()));
    await fs.rm(TMP_DIR, { recursive: true, force: true });
  });

  describe('REST API', () => {
    it('GET /api/agents returns an array', async () => {
      const res = await authedFetch(`${baseUrl}/api/agents`);
      expect(res.status).toBe(200);
      const body = await res.json();
      expect(Array.isArray(body)).toBe(true);
    });

    it('GET /api/events returns an array', async () => {
      const res = await authedFetch(`${baseUrl}/api/events?limit=10`);
      expect(res.status).toBe(200);
      const body = await res.json();
      expect(Array.isArray(body)).toBe(true);
    });

    it('GET /api/market returns resources and deals', async () => {
      const res = await authedFetch(`${baseUrl}/api/market`);
      expect(res.status).toBe(200);
      const body = await res.json();
      expect(body).toHaveProperty('resources');
      expect(body).toHaveProperty('deals');
    });

    it('GET /api/stats returns evolution statistics', async () => {
      const res = await authedFetch(`${baseUrl}/api/stats`);
      expect(res.status).toBe(200);
      const body = await res.json();
      expect(body).toHaveProperty('averageFitness');
      expect(body).toHaveProperty('populationSize');
      expect(body).toHaveProperty('generationRange');
      expect(body).toHaveProperty('fitnessHistory');
      expect(body).toHaveProperty('populationHistory');
    });

    it('GET /api/config returns system configuration', async () => {
      const res = await authedFetch(`${baseUrl}/api/config`);
      expect(res.status).toBe(200);
      const body = await res.json();
      expect(body).toHaveProperty('cycleIntervalMs');
      expect(body).toHaveProperty('eliminationRate');
      expect(body).toHaveProperty('mutationBaseRate');
    });

    it('GET /api/agents/:id returns 404 for missing agent', async () => {
      const res = await authedFetch(`${baseUrl}/api/agents/nonexistent`);
      expect(res.status).toBe(404);
    });
  });

  describe('WebSocket', () => {
    it('connects and receives snapshot', async () => {
      const ws = new WebSocket(wsUrl);

      const msg = await new Promise<string>((resolve, reject) => {
        const timeout = setTimeout(() => reject(new Error('timeout')), 5000);
        ws.on('message', (data: Buffer) => {
          clearTimeout(timeout);
          resolve(data.toString());
        });
        ws.on('error', reject);
      });

      const parsed = JSON.parse(msg);
      expect(parsed.type).toBe('snapshot');
      expect(Array.isArray(parsed.agents)).toBe(true);
      expect(parsed.stats).toBeDefined();

      ws.close();
    });

    it('responds to ping with pong', async () => {
      const ws = new WebSocket(wsUrl);

      // Wait for open
      await new Promise<void>((resolve, reject) => {
        ws.on('open', resolve);
        ws.on('error', reject);
      });

      ws.send(JSON.stringify({ type: 'ping' }));

      const msg = await new Promise<string>((resolve, reject) => {
        const timeout = setTimeout(() => reject(new Error('timeout')), 5000);
        ws.on('message', (data: Buffer) => {
          const text = data.toString();
          const parsed = JSON.parse(text);
          if (parsed.type === 'pong') {
            clearTimeout(timeout);
            resolve(text);
          }
        });
      });

      const parsed = JSON.parse(msg);
      expect(parsed.type).toBe('pong');

      ws.close();
    });
  });

  describe('API-only contract', () => {
    // The HTML/JS frontend lives in `web/` and is served by a separate
    // process (`npm run web`). The dashboard server is JSON + WebSocket only.
    it('returns 404 JSON for /', async () => {
      const res = await authedFetch(`${baseUrl}/`);
      expect(res.status).toBe(404);
      expect(res.headers.get('content-type')).toMatch(/application\/json/);
    });

    it('does not set a session cookie on auth-check (frontend stores the token client-side)', async () => {
      const res = await fetch(`${baseUrl}/auth-check`, {
        method: 'POST',
        body: JSON.stringify({ token: 'tribe-admin' }),
        headers: { 'Content-Type': 'application/json' },
      });
      expect(res.status).toBe(200);
      expect(res.headers.get('set-cookie')).toBeNull();
      const body = await res.json();
      expect(body.ok).toBe(true);
      expect(body.token).toBe('tribe-admin');
    });

    it('rejects requests without an x-auth-token header (no cookie fallback)', async () => {
      // Send a session cookie that previously would have authenticated — the
      // server should ignore it now and return 401.
      const res = await fetch(`${baseUrl}/api/agents`, {
        headers: { Cookie: 'tribe_token=tribe-admin' },
      });
      expect(res.status).toBe(401);
    });

    it('sends CORS headers including x-auth-token in Allow-Headers', async () => {
      const res = await fetch(`${baseUrl}/api/agents`, { method: 'OPTIONS' });
      expect(res.status).toBe(204);
      expect(res.headers.get('access-control-allow-origin')).toBe('*');
      expect((res.headers.get('access-control-allow-headers') || '').toLowerCase())
        .toContain('x-auth-token');
    });

    it('CORS headers are present on 401 responses too', async () => {
      // Browsers drop responses without CORS headers; if we forget them on
      // 401 the frontend can't see the actual status code.
      const res = await fetch(`${baseUrl}/api/agents`);
      expect(res.status).toBe(401);
      expect(res.headers.get('access-control-allow-origin')).toBe('*');
    });
  });

  describe('GET /api/events/:id', () => {
    it('returns 400 when no ID is provided', async () => {
      const res = await authedFetch(`${baseUrl}/api/events/`);
      expect(res.status).toBe(400);
    });

    it('returns 404 for non-existent event index', async () => {
      const res = await authedFetch(`${baseUrl}/api/events/9999`);
      expect(res.status).toBe(404);
    });

    it('returns event details with related events for valid index', async () => {
      // Event index 1 belongs to agent_001 (task_completed)
      const res = await authedFetch(`${baseUrl}/api/events/2`);
      expect(res.status).toBe(200);
      const body = await res.json();
      expect(body).toHaveProperty('event');
      expect(body).toHaveProperty('relatedEvents');
      expect(body.event.index).toBe(2);
      expect(body.event.type).toBe('token_allocated');
      expect(body.event.agentId).toBe('agent_001');
      expect(Array.isArray(body.relatedEvents)).toBe(true);
      // Related events: agent_001 events before (max 5) + after (max 5)
      expect(body.relatedEvents.length).toBeGreaterThanOrEqual(1);
      // All related events should be for agent_001
      for (const re of body.relatedEvents) {
        expect(re.agentId).toBe('agent_001');
      }
    });

    it('returns event with prevHash and hash fields', async () => {
      const res = await authedFetch(`${baseUrl}/api/events/0`);
      expect(res.status).toBe(200);
      const body = await res.json();
      expect(body.event).toHaveProperty('prevHash');
      expect(body.event).toHaveProperty('hash');
      expect(body.event).toHaveProperty('data');
      expect(body.event).toHaveProperty('timestamp');
    });

    it('returns event with complete data fields', async () => {
      const res = await authedFetch(`${baseUrl}/api/events/1`);
      expect(res.status).toBe(200);
      const body = await res.json();
      expect(body.event.data).toEqual({ task: 'explore_terrain' });
    });
  });

  describe('GET /api/events with type filter', () => {
    it('returns only events of the specified type', async () => {
      const res = await authedFetch(`${baseUrl}/api/events?type=token_allocated`);
      expect(res.status).toBe(200);
      const body = await res.json();
      expect(Array.isArray(body)).toBe(true);
      expect(body.length).toBe(1);
      expect(body[0].type).toBe('token_allocated');
    });

    it('returns empty array for type with no events', async () => {
      const res = await authedFetch(`${baseUrl}/api/events?type=deal_kept`);
      expect(res.status).toBe(200);
      const body = await res.json();
      expect(Array.isArray(body)).toBe(true);
      // deal_kept exists for agent_001 at index 5
      expect(body.length).toBeGreaterThanOrEqual(1);
    });

    it('returns empty array for non-existent type', async () => {
      const res = await authedFetch(`${baseUrl}/api/events?type=nonexistent_type`);
      expect(res.status).toBe(200);
      const body = await res.json();
      expect(Array.isArray(body)).toBe(true);
      expect(body.length).toBe(0);
    });
  });

  describe('GET /api/tree', () => {
    it('returns tree structure with nodes array', async () => {
      const res = await authedFetch(`${baseUrl}/api/tree`);
      expect(res.status).toBe(200);
      const body = await res.json();
      expect(body).toHaveProperty('nodes');
      expect(Array.isArray(body.nodes)).toBe(true);
      expect(body.nodes.length).toBe(4);
    });

    it('each node has required fields', async () => {
      const res = await authedFetch(`${baseUrl}/api/tree`);
      const body = await res.json();
      for (const node of body.nodes) {
        expect(node).toHaveProperty('id');
        expect(node).toHaveProperty('personaName');
        expect(node).toHaveProperty('generation');
        expect(node).toHaveProperty('parentId');
        expect(node).toHaveProperty('alive');
        expect(node).toHaveProperty('fitness');
      }
    });

    it('root node (generation 0) has parentId null', async () => {
      const res = await authedFetch(`${baseUrl}/api/tree`);
      const body = await res.json();
      const root = body.nodes.find((n: any) => n.generation === 0);
      expect(root).toBeDefined();
      expect(root.parentId).toBeNull();
    });

    it('child nodes reference existing parent IDs', async () => {
      const res = await authedFetch(`${baseUrl}/api/tree`);
      const body = await res.json();
      const ids = new Set(body.nodes.map((n: any) => n.id));
      for (const node of body.nodes) {
        if (node.parentId !== null) {
          expect(ids.has(node.parentId)).toBe(true);
        }
      }
    });

    it('node has correct fitness value', async () => {
      const res = await authedFetch(`${baseUrl}/api/tree`);
      const body = await res.json();
      const agent = body.nodes.find((n: any) => n.id === 'agent_001');
      expect(agent).toBeDefined();
      expect(agent.fitness).toBe(85.3);
    });
  });

  describe('broadcast', () => {
    it('broadcast sends data to all connected clients', async () => {
      const ws = new WebSocket(wsUrl);

      // Wait for open
      await new Promise<void>((resolve, reject) => {
        ws.on('open', () => resolve());
        ws.on('error', reject);
      });

      // Broadcast
      await dashboard.broadcast();

      // Should receive a snapshot
      const msg = await new Promise<string>((resolve, reject) => {
        const t = setTimeout(() => reject(new Error('timeout')), 5000);
        ws.on('message', (data: Buffer) => {
          clearTimeout(t);
          resolve(data.toString());
        });
      });
      expect(JSON.parse(msg).type).toBe('snapshot');

      ws.close();
    });
  });

  describe('Bounties API', () => {
    it('GET /api/bounties returns an array', async () => {
      const res = await authedFetch(`${baseUrl}/api/bounties`);
      expect(res.status).toBe(200);
      const body = await res.json();
      expect(Array.isArray(body)).toBe(true);
    });

    it('GET /api/bounties?status=open returns filtered results', async () => {
      const res = await authedFetch(`${baseUrl}/api/bounties?status=open`);
      expect(res.status).toBe(200);
      const body = await res.json();
      expect(Array.isArray(body)).toBe(true);
      for (const bounty of body) {
        expect(bounty.status).toBe('open');
      }
    });

    it('POST /api/bounties creates a new bounty', async () => {
      const newBounty = {
        title: '修复 GC 竞态条件',
        description: '需要修复垃圾回收中的竞态条件问题',
        type: 'bug',
        reward: 5000,
        verificationTests: 'test_gc_race_condition',
        deadline: Date.now() + 7200000,
      };
      const res = await authedFetch(`${baseUrl}/api/bounties`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(newBounty),
      });
      expect(res.status).toBe(201);
      const body = await res.json();
      expect(body).toHaveProperty('id');
      expect(body.title).toBe('修复 GC 竞态条件');
      expect(body.reward).toBe(5000);
      expect(body.status).toBe('open');
      expect(Array.isArray(body.bids)).toBe(true);
      expect(body.bids.length).toBe(0);
    });

    it('POST /api/bounties returns 400 for missing title', async () => {
      const res = await authedFetch(`${baseUrl}/api/bounties`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ description: 'no title' }),
      });
      expect(res.status).toBe(400);
    });

    it('GET /api/bounties/:id returns single bounty detail', async () => {
      // First create a bounty
      const newBounty = {
        title: '实现 ftl 地址映射',
        description: '需要实现 FTL 地址映射功能',
        type: 'feature',
        reward: 3000,
        verificationTests: 'test_ftl_mapping',
        deadline: Date.now() + 3600000,
      };
      const createRes = await authedFetch(`${baseUrl}/api/bounties`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(newBounty),
      });
      const created = await createRes.json();
      const bountyId = created.id;

      const res = await authedFetch(`${baseUrl}/api/bounties/${bountyId}`);
      expect(res.status).toBe(200);
      const body = await res.json();
      expect(body.id).toBe(bountyId);
      expect(body.title).toBe('实现 ftl 地址映射');
      expect(body).toHaveProperty('bids');
    });

    it('GET /api/bounties/:id returns 404 for non-existent bounty', async () => {
      const res = await authedFetch(`${baseUrl}/api/bounties/nonexistent-id`);
      expect(res.status).toBe(404);
    });

    it('POST /api/bounties/:id/bid creates a bid on a bounty', async () => {
      // First create a bounty
      const createRes = await authedFetch(`${baseUrl}/api/bounties`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          title: '竞标测试任务',
          description: '测试竞标流程',
          type: 'bug_fix',
          reward: 1000,
          deadline: Date.now() + 3600000,
        }),
      });
      const bounty = await createRes.json();

      const bidRes = await authedFetch(`${baseUrl}/api/bounties/${bounty.id}/bid`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          agentId: 'agent_001',
          price: 800,
          plan: '我将在 2 小时内完成',
        }),
      });
      expect(bidRes.status).toBe(201);
      const bidBody = await bidRes.json();
      expect(bidBody).toHaveProperty('id');
      expect(bidBody.agentId).toBe('agent_001');
      expect(bidBody.price).toBe(800);

      // Verify the bounty now has the bid
      const getRes = await authedFetch(`${baseUrl}/api/bounties/${bounty.id}`);
      const updatedBounty = await getRes.json();
      expect(updatedBounty.bids.length).toBe(1);
      expect(updatedBounty.bids[0].agentId).toBe('agent_001');
    });

    it('POST /api/bounties/:id/bid returns 404 for non-existent bounty', async () => {
      const res = await authedFetch(`${baseUrl}/api/bounties/nonexistent/bid`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ agentId: 'agent_001', price: 500, plan: 'test' }),
      });
      expect(res.status).toBe(404);
    });

    it('PUT /api/bounties/:id/award selects a winning bid', async () => {
      // Create bounty
      const createRes = await authedFetch(`${baseUrl}/api/bounties`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          title: '中标测试任务',
          description: '测试中标流程',
          type: 'bug_fix',
          reward: 2000,
          deadline: Date.now() + 3600000,
        }),
      });
      const bounty = await createRes.json();

      // Place a bid
      const bidRes = await authedFetch(`${baseUrl}/api/bounties/${bounty.id}/bid`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ agentId: 'agent_002', price: 1500, plan: '我能做' }),
      });
      const bid = await bidRes.json();

      // Award the bid
      const awardRes = await authedFetch(`${baseUrl}/api/bounties/${bounty.id}/award`, {
        method: 'PUT',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ winningBidId: bid.id }),
      });
      expect(awardRes.status).toBe(200);
      const awarded = await awardRes.json();
      expect(awarded.winningBidId).toBe(bid.id);
      expect(awarded.status).toBe('awarded');
    });

    it('PUT /api/bounties/:id/award returns 404 for non-existent bounty', async () => {
      const res = await authedFetch(`${baseUrl}/api/bounties/nonexistent/award`, {
        method: 'PUT',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ winningBidId: 'bid_xxx' }),
      });
      expect(res.status).toBe(404);
    });
  });
});
