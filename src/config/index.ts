import dotenv from 'dotenv';
// Load .env from project root
dotenv.config({ path: '/Users/zifengyang/tribe-evolution/.env' });

export interface Config {
  deepseekApiKey: string;
  braveApiKey: string;
  ecosystemDir: string;
  cycleIntervalMs: number;
  defaultTokenPerCycle: number;
  maxAgents: number;
  eliminationRate: number;
  mutationBaseRate: number;
  newAgentProtectionRounds: number;
  dashboardPort: number;
}

export function loadConfig(): Config {
  return {
    deepseekApiKey: process.env.DEEPSEEK_API_KEY || '',
    braveApiKey: process.env.BRAVE_API_KEY || '',
    ecosystemDir: process.env.ECOSYSTEM_DIR || './ecosystem',
    cycleIntervalMs: parseInt(process.env.CYCLE_INTERVAL_MS || '14400000', 10),
    defaultTokenPerCycle: parseInt(process.env.DEFAULT_TOKEN || '1000000', 10),
    maxAgents: parseInt(process.env.MAX_AGENTS || '20', 10),
    eliminationRate: parseFloat(process.env.ELIMINATION_RATE || '0.3'),
    mutationBaseRate: parseFloat(process.env.MUTATION_RATE || '0.1'),
    newAgentProtectionRounds: parseInt(process.env.NEW_AGENT_PROTECTION || '3', 10),
    dashboardPort: parseInt(process.env.DASHBOARD_PORT || '3000', 10),
  };
}
