/**
 * Simple email sender for agent notifications.
 * Sends agent proposals and messages to user via SMTP.
 *
 * All credentials come from the caller — nothing hardcoded.
 */
import nodemailer from 'nodemailer';
import { computeApprovalToken } from './email-approval.js';

export interface NotifyConfig {
  smtpHost: string;
  smtpPort: number;
  emailUser: string;
  emailPass: string;
  notifyEmail: string;
  /** HMAC secret for email-approval tokens. When empty, the email body
   *  notes that email approval is disabled. */
  emailApprovalSecret?: string;
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
 * Create (or return cached) transporter for the given config.
 */
function getTransporter(cfg: NotifyConfig): nodemailer.Transporter {
  return nodemailer.createTransport({
    host: cfg.smtpHost,
    port: cfg.smtpPort,
    secure: cfg.smtpPort === 465,
    auth: { user: cfg.emailUser, pass: cfg.emailPass },
  });
}

/**
 * Send an email notification about an agent's message/proposal.
 */
export async function notifyUser(cfg: NotifyConfig, msg: AgentMessage): Promise<void> {
  // Skip if email is not configured
  if (!cfg.emailUser || !cfg.notifyEmail) {
    console.log('  📧 Email skipped (not configured)');
    return;
  }

  const subject = `🤖 [${msg.agentId}] ${msg.title}`;
  // With a secret + proposalId, derive the approval HMAC and embed it in the
  // reply instructions. Without either, render a "disabled" note so an
  // operator doesn't expect their reply to take effect.
  const approvalToken = (cfg.emailApprovalSecret && msg.proposalId)
    ? computeApprovalToken(msg.proposalId, cfg.emailApprovalSecret)
    : null;
  const replyInstruction = approvalToken && msg.proposalId
    ? `回复 "approve ${msg.proposalId} ${approvalToken}" 或 "reject ${msg.proposalId} ${approvalToken} <原因>" 来审批\nApproval token: ${approvalToken}`
    : '邮件审批未启用（未配置 EMAIL_APPROVAL_SECRET）。请通过 dashboard 审批。';

  const body = [
    `来自 Agent: ${msg.agentId}`,
    `类型: ${msg.type}`,
    `标题: ${msg.title}`,
    msg.description ? `\n详情:\n${msg.description}` : '',
    msg.tokenCost ? `\nToken 成本: ${msg.tokenCost}` : '',
    msg.proposalId ? `\nProposal ID: ${msg.proposalId}` : '',
    '\n---',
    replyInstruction,
  ].join('\n');

  try {
    const t = getTransporter(cfg);
    await t.sendMail({
      from: cfg.emailUser,
      to: cfg.notifyEmail,
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
export async function sendEvolutionSummary(cfg: NotifyConfig, summary: string): Promise<void> {
  if (!cfg.emailUser || !cfg.notifyEmail) return;
  try {
    const t = getTransporter(cfg);
    await t.sendMail({
      from: cfg.emailUser,
      to: cfg.notifyEmail,
      subject: '🧬 Tribe Evolution — 进化摘要',
      text: summary,
    });
  } catch (err: unknown) {
    const msg_err = err instanceof Error ? err.message : String(err);
    console.warn(`⚠️ Summary email failed: ${msg_err}`);
  }
}
