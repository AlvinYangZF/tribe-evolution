/**
 * Email approval parsing + HMAC verification.
 *
 * Operators reply to proposal-notification emails with `approve <id> <token>`
 * or `reject <id> <token> <reason>`. The token is an HMAC-SHA256 over the
 * proposal id, truncated to 16 hex chars. Without a valid token, the reply is
 * ignored — preventing spoofed `From:` headers from approving proposals.
 *
 * Email approval is **disabled by default**. When `EMAIL_APPROVAL_SECRET` is
 * unset or empty, classifyReply returns `{ action: null }` for any reply.
 */

import { createHmac } from 'node:crypto';

export interface EmailReply {
  uid: string;
  subject: string;
  from: string;
  body: string;
}

export interface ClassifiedReply {
  action: 'approve' | 'reject' | null;
  proposalId: string | null;
  reason: string;
  /** Why the reply was rejected (for logging). Only set when action === null. */
  rejectionReason?: string;
}

const UUID_RE = /[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}/i;
const TOKEN_LENGTH = 16; // hex chars
const TOKEN_RE = new RegExp(`\\b[0-9a-f]{${TOKEN_LENGTH}}\\b`, 'i');

export function extractProposalId(text: string): string | null {
  const m = text.match(UUID_RE);
  return m ? m[0] : null;
}

/** Compute the HMAC-SHA256 approval token for a given proposal. */
export function computeApprovalToken(proposalId: string, secret: string): string {
  return createHmac('sha256', secret).update(proposalId).digest('hex').slice(0, TOKEN_LENGTH);
}

function extractApprovalToken(text: string, expected: string): boolean {
  const matches = text.match(new RegExp(TOKEN_RE.source, 'gi'));
  if (!matches) return false;
  return matches.some(m => m.toLowerCase() === expected.toLowerCase());
}

/**
 * Classify an email reply as approve / reject / null.
 *
 * Requires a valid HMAC token in the body. If `secret` is empty, no reply is
 * ever classified as actionable (email approval is disabled).
 */
export function classifyReply(reply: EmailReply, secret: string): ClassifiedReply {
  const body = reply.body.trim();
  const bodyLower = body.toLowerCase();
  const subject = reply.subject;

  const proposalId = extractProposalId(body) ?? extractProposalId(subject);

  const approved =
    bodyLower.startsWith('approve') ||
    bodyLower.startsWith('同意') ||
    bodyLower.startsWith('批准');
  const rejected =
    bodyLower.startsWith('reject') ||
    bodyLower.startsWith('拒绝') ||
    bodyLower.startsWith('不同意');

  if (!approved && !rejected) {
    return { action: null, proposalId: null, reason: '', rejectionReason: 'no approve/reject keyword' };
  }

  if (!secret) {
    return { action: null, proposalId, reason: '', rejectionReason: 'EMAIL_APPROVAL_SECRET not configured' };
  }

  if (!proposalId) {
    return { action: null, proposalId: null, reason: '', rejectionReason: 'no proposal id in body or subject' };
  }

  const expected = computeApprovalToken(proposalId, secret);
  if (!extractApprovalToken(body, expected)) {
    return { action: null, proposalId, reason: '', rejectionReason: 'missing or invalid approval token' };
  }

  if (approved) {
    return { action: 'approve', proposalId, reason: '' };
  }

  // Reject — strip the keyword, the proposal id, and the token from the body
  // to leave a free-form reason.
  const reason = body
    .replace(/^(reject|拒绝|不同意)\s*/i, '')
    .replace(UUID_RE, '')
    .replace(TOKEN_RE, '')
    .trim() || '用户拒绝';
  return { action: 'reject', proposalId, reason };
}
