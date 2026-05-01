/**
 * Simple email sender for agent notifications.
 * Sends agent proposals and messages to user via 163 SMTP.
 */
import nodemailer from 'nodemailer';

const EMAIL_USER = 'momser@163.com';
const EMAIL_PASS = Buffer.from('UUpUcHZaZjg5Slh5Q21GUQ==', 'base64').toString();
const TO_EMAIL = 'yangzifeng.alvin@bytedance.com';

// Lazy transporter (created on first use)
let transporter: nodemailer.Transporter | null = null;

function getTransporter(): nodemailer.Transporter {
  if (!transporter) {
    transporter = nodemailer.createTransport({
      host: 'smtp.163.com',
      port: 465,
      secure: true,
      auth: { user: EMAIL_USER, pass: EMAIL_PASS },
    });
  }
  return transporter;
}

export interface AgentMessage {
  agentId: string;
  type: string;
  title: string;
  description?: string;
  tokenCost?: number;
  proposalId?: string;
}

/**
 * Send an email notification about an agent's message/proposal.
 */
export async function notifyUser(msg: AgentMessage): Promise<void> {
  const subject = `🤖 [${msg.agentId}] ${msg.title}`;
  const body = [
    `来自 Agent: ${msg.agentId}`,
    `类型: ${msg.type}`,
    `标题: ${msg.title}`,
    msg.description ? `\n详情:\n${msg.description}` : '',
    msg.tokenCost ? `\nToken 成本: ${msg.tokenCost}` : '',
    msg.proposalId ? `\nProposal ID: ${msg.proposalId}` : '',
    '\n---',
    '回复 "approve <proposalId>" 或 "reject <proposalId> <原因>" 来审批',
  ].join('\n');

  try {
    const t = getTransporter();
    await t.sendMail({
      from: EMAIL_USER,
      to: TO_EMAIL,
      subject,
      text: body,
    });
    console.log(`  📧 Email sent: ${subject}`);
  } catch (err: unknown) {
    const msg_err = err instanceof Error ? err.message : String(err);
    console.warn(`  ⚠️ Email failed: ${msg_err}`);
  }
}

/**
 * Send a daily/weekly evolution summary.
 */
export async function sendEvolutionSummary(summary: string): Promise<void> {
  try {
    const t = getTransporter();
    await t.sendMail({
      from: EMAIL_USER,
      to: TO_EMAIL,
      subject: '🧬 Tribe Evolution — 进化摘要',
      text: summary,
    });
  } catch (err: unknown) {
    const msg_err = err instanceof Error ? err.message : String(err);
    console.warn(`⚠️ Summary email failed: ${msg_err}`);
  }
}
