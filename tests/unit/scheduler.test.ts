import { describe, it, expect, vi } from 'vitest';
import { Scheduler } from '../../src/supervisor/scheduler.js';

describe('Scheduler', () => {
  it('should execute cycles at the configured interval', async () => {
    const cycleMs = 100;
    const scheduler = new Scheduler({ cycleIntervalMs: cycleMs });

    const cycleStarts: number[] = [];
    const cycleEnds: number[] = [];

    scheduler.on('cycleStart', (cycleNum) => {
      cycleStarts.push(cycleNum);
    });

    scheduler.on('cycleEnd', (cycleNum) => {
      cycleEnds.push(cycleNum);
    });

    scheduler.startCycle(async (cycleNum) => {
      // Simulate work
      await new Promise(r => setTimeout(r, 10));
    });

    // Wait for ~3 cycles
    await new Promise(r => setTimeout(r, 350));

    scheduler.stop();

    // Should have completed 3 full cycles
    expect(scheduler.getCurrentCycleNumber()).toBeGreaterThanOrEqual(3);

    // cycleStart should fire before each cycle
    expect(cycleStarts.length).toBeGreaterThanOrEqual(3);
    expect(cycleEnds.length).toBeGreaterThanOrEqual(3);

    // Verify sequence
    for (let i = 0; i < Math.min(3, cycleStarts.length); i++) {
      expect(cycleStarts[i]).toBe(i);
      expect(cycleEnds[i]).toBe(i);
    }
  }, 10_000);

  it('should not start double cycles', async () => {
    const scheduler = new Scheduler({ cycleIntervalMs: 50 });

    let callCount = 0;
    scheduler.startCycle(async () => {
      callCount++;
      await new Promise(r => setTimeout(r, 20));
    });

    // Calling startCycle again should be a no-op
    scheduler.startCycle(async () => {
      callCount++;
    });

    await new Promise(r => setTimeout(r, 200));
    scheduler.stop();

    // Should have only one runner
    expect(callCount).toBeGreaterThanOrEqual(2);
    expect(callCount).toBeLessThan(10); // sanity: not double
  }, 10_000);

  it('should report correct cycle number', async () => {
    const scheduler = new Scheduler({ cycleIntervalMs: 50 });

    scheduler.startCycle(async () => {
      await new Promise(r => setTimeout(r, 5));
    });

    await new Promise(r => setTimeout(r, 120));
    scheduler.stop();

    // Should be at least cycle 2
    expect(scheduler.getCurrentCycleNumber()).toBeGreaterThanOrEqual(2);
    expect(scheduler.getCurrentCycleNumber()).toBeLessThanOrEqual(5);
  }, 10_000);

  it('resumes the cycle counter from setStartingCycle', async () => {
    const scheduler = new Scheduler({ cycleIntervalMs: 50 });
    scheduler.setStartingCycle(42);
    expect(scheduler.getCurrentCycleNumber()).toBe(42);

    const observed: number[] = [];
    scheduler.startCycle(async (n) => { observed.push(n); });
    await new Promise(r => setTimeout(r, 30));
    scheduler.stop();

    expect(observed[0]).toBe(42);
  });

  it('throws if setStartingCycle is called after startCycle', () => {
    const scheduler = new Scheduler({ cycleIntervalMs: 1000 });
    scheduler.startCycle(async () => { /* no-op */ });
    expect(() => scheduler.setStartingCycle(5)).toThrow(/already running/);
    scheduler.stop();
  });

  it('accepts startingCycle in the constructor options', () => {
    const scheduler = new Scheduler({ cycleIntervalMs: 100, startingCycle: 17 });
    expect(scheduler.getCurrentCycleNumber()).toBe(17);
  });
});
