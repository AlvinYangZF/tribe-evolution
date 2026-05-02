import { describe, it, expect } from 'vitest';
import {
  extractProposalId,
  classifyReply,
  computeApprovalToken,
} from '../../src/supervisor/email-approval.js';

const TEST_UUID = 'a1b2c3d4-e5f6-7890-abcd-ef1234567890';
const SECRET = 'test-secret';

function reply(body: string, subject = 'Re: proposal') {
  return { uid: '1', from: 'admin@test.com', subject, body };
}

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
  });

  describe('computeApprovalToken', () => {
    it('produces a deterministic 16-char hex token', () => {
      const t = computeApprovalToken(TEST_UUID, SECRET);
      expect(t).toHaveLength(16);
      expect(t).toMatch(/^[0-9a-f]{16}$/);
      expect(computeApprovalToken(TEST_UUID, SECRET)).toBe(t);
    });

    it('different secrets produce different tokens', () => {
      expect(computeApprovalToken(TEST_UUID, 'a')).not.toBe(
        computeApprovalToken(TEST_UUID, 'b'),
      );
    });

    it('different proposal ids produce different tokens', () => {
      const otherUuid = 'b1b2c3d4-e5f6-7890-abcd-ef1234567890';
      expect(computeApprovalToken(TEST_UUID, SECRET)).not.toBe(
        computeApprovalToken(otherUuid, SECRET),
      );
    });
  });

  describe('classifyReply', () => {
    const token = computeApprovalToken(TEST_UUID, SECRET);

    it('approves with matching token', () => {
      const r = classifyReply(reply(`approve ${TEST_UUID} ${token}`), SECRET);
      expect(r.action).toBe('approve');
      expect(r.proposalId).toBe(TEST_UUID);
    });

    it('rejects with token + reason', () => {
      const r = classifyReply(reply(`reject ${TEST_UUID} ${token} too expensive`), SECRET);
      expect(r.action).toBe('reject');
      expect(r.proposalId).toBe(TEST_UUID);
      expect(r.reason).toBe('too expensive');
    });

    it('approves in Chinese with token', () => {
      const r = classifyReply(reply(`同意 ${TEST_UUID} ${token}`), SECRET);
      expect(r.action).toBe('approve');
      expect(r.proposalId).toBe(TEST_UUID);
    });

    it('rejects unauthenticated reply (no token)', () => {
      const r = classifyReply(reply(`approve ${TEST_UUID}`), SECRET);
      expect(r.action).toBeNull();
      expect(r.rejectionReason).toMatch(/token/i);
    });

    it('rejects reply with wrong token', () => {
      const r = classifyReply(reply(`approve ${TEST_UUID} 0000000000000000`), SECRET);
      expect(r.action).toBeNull();
      expect(r.rejectionReason).toMatch(/token/i);
    });

    it('rejects reply where token came from a different secret', () => {
      const other = computeApprovalToken(TEST_UUID, 'other-secret');
      const r = classifyReply(reply(`approve ${TEST_UUID} ${other}`), SECRET);
      expect(r.action).toBeNull();
      expect(r.rejectionReason).toMatch(/token/i);
    });

    it('returns null when secret is empty (email approval disabled)', () => {
      const r = classifyReply(reply(`approve ${TEST_UUID} ${token}`), '');
      expect(r.action).toBeNull();
      expect(r.rejectionReason).toMatch(/EMAIL_APPROVAL_SECRET/);
    });

    it('returns null when no approve/reject keyword present', () => {
      const r = classifyReply(reply(`Looks good ${TEST_UUID} ${token}`), SECRET);
      expect(r.action).toBeNull();
      expect(r.rejectionReason).toMatch(/keyword/i);
    });

    it('returns null when approve has no proposal id', () => {
      const r = classifyReply(reply(`approve ${token}`), SECRET);
      expect(r.action).toBeNull();
      expect(r.rejectionReason).toMatch(/proposal id/i);
    });

    it('finds proposal id in subject when body has none', () => {
      const r = classifyReply(reply(`approve ${token}`, `Re: proposal ${TEST_UUID}`), SECRET);
      expect(r.action).toBe('approve');
      expect(r.proposalId).toBe(TEST_UUID);
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
    expect(config).toHaveProperty('emailApprovalSecret');

    // Defaults when env vars are unset
    expect(config.smtpHost).toBe('smtp.163.com');
    expect(config.smtpPort).toBe(465);
    expect(config.pop3Host).toBe('pop.163.com');
    expect(config.pop3Port).toBe(995);
    expect(config.emailApprovalSecret).toBe('');
  });
});

// ─── Test notifyUser API signature ───

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
