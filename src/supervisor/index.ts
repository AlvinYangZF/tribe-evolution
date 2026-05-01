import { EventEmitter } from 'node:events';
import path from 'node:path';
import { EventLog } from './event-log.js';
import { Scheduler } from './scheduler.js';
import type { Config } from '../config/index.js';
import { ensureDir } from '../shared/filesystem.js';

/**
 * Supervisor main loop.
 * - Loads event log → rebuilds state
 * - Each cycle: broadcast token_refresh → wait for responses → life-cycle → broadcast next_cycle
 */
export class Supervisor extends EventEmitter {
  private config: Config;
  private eventLog: EventLog;
  private scheduler: Scheduler;
  private started = false;

  constructor(config: Config) {
    super();
    this.config = config;
    this.eventLog = new EventLog(config.ecosystemDir);
    this.scheduler = new Scheduler({
      cycleIntervalMs: config.cycleIntervalMs,
    });

    // Forward scheduler events
    this.scheduler.on('cycleStart', (cycleNum: number) => {
      this.emit('cycleStart', cycleNum);
    });
    this.scheduler.on('cycleEnd', (cycleNum: number) => {
      this.emit('cycleEnd', cycleNum);
    });
  }

  /**
   * Start the supervisor lifecycle.
   */
  async start(): Promise<void> {
    if (this.started) return;
    this.started = true;

    // Ensure ecosystem directories exist
    await ensureDir(path.join(this.config.ecosystemDir, 'event-log'));
    await ensureDir(path.join(this.config.ecosystemDir, 'agents'));

    // Log startup event
    await this.eventLog.append({
      type: 'agent_born',
      agentId: 'supervisor',
      data: { action: 'start' },
    });

    // Start the scheduler
    this.scheduler.startCycle((cycleNum) => this.runCycle(cycleNum));
  }

  /**
   * Execute a single cycle.
   */
  private async runCycle(cycleNum: number): Promise<void> {
    // Record cycle start
    await this.eventLog.append({
      type: 'token_allocated',
      agentId: 'supervisor',
      data: {
        cycle: cycleNum,
        action: 'cycle_start',
        timestamp: Date.now(),
      },
    });

    // TODO: In full implementation, this would:
    // 1. Load agent states from disk
    // 2. Broadcast token_refresh message to agents
    // 3. Wait for agent responses (with timeout)
    // 4. Evaluate fitness
    // 5. Eliminate bottom N%
    // 6. Reproduce with mutations
    // 7. Broadcast next_cycle

    // For now, emit lifecycle events
    this.emit('tokenRefresh', cycleNum);

    // Record cycle end
    await this.eventLog.append({
      type: 'task_completed',
      agentId: 'supervisor',
      data: {
        cycle: cycleNum,
        action: 'cycle_end',
        timestamp: Date.now(),
      },
    });
  }

  /**
   * Gracefully shut down the supervisor.
   */
  async shutdown(): Promise<void> {
    this.scheduler.stop();

    if (this.started) {
      await this.eventLog.append({
        type: 'agent_extinct',
        agentId: 'supervisor',
        data: { action: 'shutdown' },
      });
    }

    this.started = false;
  }

  /**
   * Get the event log instance (for testing/verification).
   */
  getEventLog(): EventLog {
    return this.eventLog;
  }

  /**
   * Get current cycle number.
   */
  getCurrentCycleNumber(): number {
    return this.scheduler.getCurrentCycleNumber();
  }
}
