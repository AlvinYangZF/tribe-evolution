import dotenv from 'dotenv';
// Load .env from the current working directory.
dotenv.config();

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
  // Email / SMTP (for sending notifications)
  smtpHost: string;
  smtpPort: number;
  emailUser: string;
  emailPass: string;
  notifyEmail: string;
  // POP3 (for checking email replies)
  pop3Host: string;
  pop3Port: number;
  // Bounty system
  bountyVerifierAgentId: string;
  bountyDepositRate: number;
  bountyMaxRetries: number;
}

/** Decode a value if it looks like base64, otherwise return as-is. */
function maybeDecodeBase64(val: string): string {
  if (!val) return val;
  // Heuristic: base64 is alphanumeric + '+' + '/' + '=' padding, no spaces
  if (/^[A-Za-z0-9+/]+=*$/.test(val) && val.length >= 4) {
    try {
      return Buffer.from(val, 'base64').toString('utf-8');
    } catch {
      return val;
    }
  }
  return val;
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
    smtpHost: process.env.SMTP_HOST || 'smtp.163.com',
    smtpPort: parseInt(process.env.SMTP_PORT || '465', 10),
    emailUser: process.env.EMAIL_USER || '',
    emailPass: maybeDecodeBase64(process.env.EMAIL_PASS || ''),
    notifyEmail: process.env.NOTIFY_EMAIL || '',
    pop3Host: process.env.POP3_HOST || 'pop.163.com',
    pop3Port: parseInt(process.env.POP3_PORT || '995', 10),
    bountyVerifierAgentId: process.env.BOUNTY_VERIFIER_AGENT_ID || 'supervisor',
    bountyDepositRate: parseFloat(process.env.BOUNTY_DEPOSIT_RATE || '0.5'),
    bountyMaxRetries: parseInt(process.env.BOUNTY_MAX_RETRIES || '3', 10),
  };
}
