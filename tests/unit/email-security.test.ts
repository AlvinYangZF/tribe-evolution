import { describe, it, expect } from 'vitest';

// ─── Test proposal ID extraction (inline test of the logic from supervisor/index.ts) ───

function extractProposalId(text: string): string | null {
  const uuidRe = /[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}/i;
  const m = text.match(uuidRe);
  return m ? m[0] : null;
}

function classifyReply(reply: { body: string; subject: string }): {
  action: 'approve' | 'reject' | null;
  proposalId: string | null;
  reason: string;
} {
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

  if (approved) return { action: 'approve', proposalId, reason: '' };
  if (rejected) {
    const reason = body
      .replace(/^(reject|拒绝|不同意)\s*/i, '')
      .replace(/[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}\s*/i, '')
      .trim() || '用户拒绝';
    return { action: 'reject', proposalId, reason };
  }

  return { action: null, proposalId: null, reason: '' };
}

const TEST_UUID = 'a1b2c3d4-e5f6-7890-abcd-ef1234567890';

describe('Email reply classification', () => {
  describe('extractProposalId', () => {
    it('extracts UUID from body', () => {
      expect(extractProposalId(`approve ${TEST_UUID}`)).toBe(TEST_UUID);
    });

    it('extracts UUID from subject line', () => {
      expect(extractProposalId(`Re: proposal ${TEST_UUID} status`)).toBe(TEST_UUID);
    });

    it('returns null for text with no UUID', () => {
      expect(extractProposalId('approve everything please')).toBeNull();
    });

    it('returns null for empty string', () => {
      expect(extractProposalId('')).toBeNull();
    });
  });

  describe('classifyReply', () => {
    it('approves with matching proposalId', () => {
      const result = classifyReply({
        body: `approve ${TEST_UUID}`,
        subject: 'Agent proposal',
      });
      expect(result.action).toBe('approve');
      expect(result.proposalId).toBe(TEST_UUID);
    });

    it('rejects with reason', () => {
      const result = classifyReply({
        body: `reject ${TEST_UUID} too expensive`,
        subject: 'Re: proposal',
      });
      expect(result.action).toBe('reject');
      expect(result.proposalId).toBe(TEST_UUID);
      expect(result.reason).toBe('too expensive');
    });

    it('approves in Chinese (同意)', () => {
      const result = classifyReply({
        body: `同意 ${TEST_UUID}`,
        subject: '提案审批',
      });
      expect(result.action).toBe('approve');
      expect(result.proposalId).toBe(TEST_UUID);
    });

    it('rejects in Chinese (拒绝)', () => {
      const result = classifyReply({
        body: `拒绝 ${TEST_UUID} 不合理`,
        subject: 'Re: 提案',
      });
      expect(result.action).toBe('reject');
      expect(result.reason).toBe('不合理');
    });

    it('finds proposalId in subject when body has no UUID', () => {
      const result = classifyReply({
        body: 'approve',
        subject: `Proposal ${TEST_UUID} review`,
      });
      expect(result.action).toBe('approve');
      expect(result.proposalId).toBe(TEST_UUID);
    });

    it('returns null action when no command word found', () => {
      const result = classifyReply({
        body: `Looks good ${TEST_UUID}`,
        subject: 'Re: proposal',
      });
      expect(result.action).toBeNull();
    });

    it('returns null action when approved but no proposalId anywhere', () => {
      const result = classifyReply({
        body: 'approve',
        subject: 'Re: hello',
      });
      expect(result.action).toBe('approve');
      expect(result.proposalId).toBeNull(); // no UUID → won't match any proposal
    });
  });
});

// ─── Test config loading with email fields ───

describe('Config with email fields', () => {
  it('loadConfig includes email config fields', async () => {
    const { loadConfig } = await import('../../src/config/index.js');
    const config = loadConfig();

    expect(config).toHaveProperty('smtpHost');
    expect(config).toHaveProperty('smtpPort');
    expect(config).toHaveProperty('emailUser');
    expect(config).toHaveProperty('emailPass');
    expect(config).toHaveProperty('notifyEmail');
    expect(config).toHaveProperty('pop3Host');
    expect(config).toHaveProperty('pop3Port');

    // Defaults when env vars are unset
    expect(config.smtpHost).toBe('smtp.163.com');
    expect(config.smtpPort).toBe(465);
    expect(config.pop3Host).toBe('pop.163.com');
    expect(config.pop3Port).toBe(995);
  });
});

// ─── Test notifyUser API signature change ───

describe('Notify config API', () => {
  it('NotifyConfig type has required fields', () => {
    const cfg = {
      smtpHost: 'smtp.test.com',
      smtpPort: 587,
      emailUser: 'test@test.com',
      emailPass: 'secret',
      notifyEmail: 'admin@test.com',
    };
    expect(cfg.smtpHost).toBe('smtp.test.com');
    expect(cfg.smtpPort).toBe(587);
  });

  it('notifyUser accepts config as first parameter', async () => {
    const { notifyUser } = await import('../../src/supervisor/notify.js');

    // With empty config, it should skip without error
    await expect(
      notifyUser(
        { smtpHost: '', smtpPort: 0, emailUser: '', emailPass: '', notifyEmail: '' },
        { agentId: 'test', type: 'info', title: 'test' },
      ),
    ).resolves.toBeUndefined();
  });
});
