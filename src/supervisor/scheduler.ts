import { EventEmitter } from 'node:events';

export interface SchedulerOptions {
  cycleIntervalMs: number;
}

export interface CycleCallback {
  (cycleNumber: number): Promise<void>;
}

/**
 * Scheduler that runs cycles at a configurable interval.
 * Emits 'cycleStart' and 'cycleEnd' events with the cycle number.
 */
export class Scheduler extends EventEmitter {
  private cycleIntervalMs: number;
  private currentCycle = 0;
  private running = false;
  private timer: ReturnType<typeof setTimeout> | null = null;
  private callback: CycleCallback | null = null;

  constructor(options: SchedulerOptions) {
    super();
    this.cycleIntervalMs = options.cycleIntervalMs;
  }

  /**
   * Start the scheduler. Only one runner is active at a time.
   */
  startCycle(callback: CycleCallback): void {
    if (this.running) return;
    this.running = true;
    this.callback = callback;
    // Fire first cycle immediately, then wait interval for subsequent
    this.runCycle();
  }

  /**
   * Stop the scheduler gracefully.
   */
  stop(): void {
    this.running = false;
    if (this.timer !== null) {
      clearTimeout(this.timer);
      this.timer = null;
    }
  }

  /**
   * Get the current (completed) cycle number.
   */
  getCurrentCycleNumber(): number {
    return this.currentCycle;
  }

  private scheduleNext(): void {
    if (!this.running) return;
    this.timer = setTimeout(() => this.runCycle(), this.cycleIntervalMs);
  }

  private async runCycle(): Promise<void> {
    if (!this.running) return;

    const cycleNum = this.currentCycle;

    try {
      this.emit('cycleStart', cycleNum);
      if (this.callback) {
        await this.callback(cycleNum);
      }
      this.currentCycle++;
      this.emit('cycleEnd', cycleNum);
    } catch (err) {
      // Log error but continue the cycle counter
      console.error(`[Scheduler] Cycle ${cycleNum} failed:`, err);
      this.currentCycle++;
      this.emit('cycleEnd', cycleNum);
    }

    // Schedule next cycle
    this.scheduleNext();
  }
}
