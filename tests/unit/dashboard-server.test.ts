import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import fs from 'node:fs/promises';
import path from 'node:path';
import os from 'node:os';
import { WebSocket } from 'ws';
import { startDashboard } from '../../src/dashboard/server.js';

const TMP_DIR = path.join(os.tmpdir(), `tribe-dashboard-test-${Date.now()}`);
let dashboard: ReturnType<typeof startDashboard>;
let baseUrl: string;
let wsUrl: string;

describe('Dashboard Server', () => {
  beforeAll(async () => {
    await fs.mkdir(TMP_DIR, { recursive: true });

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
      const res = await fetch(`${baseUrl}/api/agents`);
      expect(res.status).toBe(200);
      const body = await res.json();
      expect(Array.isArray(body)).toBe(true);
    });

    it('GET /api/events returns an array', async () => {
      const res = await fetch(`${baseUrl}/api/events?limit=10`);
      expect(res.status).toBe(200);
      const body = await res.json();
      expect(Array.isArray(body)).toBe(true);
    });

    it('GET /api/market returns resources and deals', async () => {
      const res = await fetch(`${baseUrl}/api/market`);
      expect(res.status).toBe(200);
      const body = await res.json();
      expect(body).toHaveProperty('resources');
      expect(body).toHaveProperty('deals');
    });

    it('GET /api/stats returns evolution statistics', async () => {
      const res = await fetch(`${baseUrl}/api/stats`);
      expect(res.status).toBe(200);
      const body = await res.json();
      expect(body).toHaveProperty('averageFitness');
      expect(body).toHaveProperty('populationSize');
      expect(body).toHaveProperty('generationRange');
      expect(body).toHaveProperty('fitnessHistory');
    });

    it('GET /api/config returns system configuration', async () => {
      const res = await fetch(`${baseUrl}/api/config`);
      expect(res.status).toBe(200);
      const body = await res.json();
      expect(body).toHaveProperty('cycleIntervalMs');
      expect(body).toHaveProperty('eliminationRate');
      expect(body).toHaveProperty('mutationBaseRate');
    });

    it('GET /api/agents/:id returns 404 for missing agent', async () => {
      const res = await fetch(`${baseUrl}/api/agents/nonexistent`);
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

  describe('static files', () => {
    it('serves index.html', async () => {
      const res = await fetch(`${baseUrl}/`);
      expect(res.status).toBe(200);
      const text = await res.text();
      expect(text).toContain('Tribe Evolution Dashboard');
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
});
