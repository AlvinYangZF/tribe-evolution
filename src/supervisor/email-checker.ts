/**
 * POP3-based email reply checker (Node.js, no external scripts).
 *
 * Replaces the old Python-based execSync approach.
 * Uses poplib for POP3 connections and zod for reply validation.
 */
import POP3Client from 'poplib';
import { z } from 'zod/v4';
import * as fs from 'node:fs';
import * as path from 'node:path';
import * as crypto from 'node:crypto';

// ─── Zod schemas ─────────────────────────────────────────────────────────

const EmailReplySchema = z.object({
  uid: z.string(),
  subject: z.string(),
  from: z.string(),
  body: z.string(),
});

export type EmailReply = z.infer<typeof EmailReplySchema>;

// ─── Config ──────────────────────────────────────────────────────────────

export interface EmailCheckerConfig {
  pop3Host: string;
  pop3Port: number;
  emailUser: string;
  emailPass: string;
  stateFile: string; // path to track processed UIDs
  checkWindow: number; // number of recent emails to scan
}

// ─── Source-filter ───────────────────────────────────────────────────────

/**
 * Simple email parsing — extracts headers and body from a raw email string.
 * Uses a stateful approach to handle the header/body boundary.
 */
function parseSimpleEmail(raw: string): {
  subject: string;
  from: string;
  body: string;
} {
  const lines = raw.split(/\r?\n/);
  let inHeaders = true;
  let subject = '';
  let from = '';
  const bodyLines: string[] = [];

  for (const line of lines) {
    if (inHeaders) {
      if (line === '') {
        inHeaders = false;
        continue;
      }
      const lc = line.toLowerCase();
      if (lc.startsWith('subject:')) {
        subject = line.slice(8).trim();
      } else if (lc.startsWith('from:')) {
        from = line.slice(5).trim();
      }
    } else {
      bodyLines.push(line);
    }
  }

  return { subject, from, body: bodyLines.join('\n') };
}

/**
 * Decode base64-encoded subject lines (=?UTF-8?B?...?=).
 */
function decodeSubject(raw: string): string {
  // Handle RFC 2047 encoded words
  return raw.replace(/=\?[^?]+\?[Bb]\?([^?]*)\?=/g, (_, encoded) => {
    try {
      return Buffer.from(encoded, 'base64').toString('utf-8');
    } catch {
      return encoded;
    }
  });
}

// ─── State management ────────────────────────────────────────────────────

function loadProcessed(stateFile: string): Set<string> {
  try {
    const raw = fs.readFileSync(stateFile, 'utf-8');
    const arr: string[] = JSON.parse(raw);
    return new Set(arr);
  } catch {
    return new Set();
  }
}

function saveProcessed(stateFile: string, uids: Set<string>): void {
  const dir = path.dirname(stateFile);
  if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(stateFile, JSON.stringify([...uids]), 'utf-8');
}

// ─── Main check function ─────────────────────────────────────────────────

/**
 * Connect to POP3, fetch recent emails, return new unseen replies from the user.
 */
export async function checkEmailReplies(
  cfg: EmailCheckerConfig,
  sourceFilter?: (from: string) => boolean,
): Promise<EmailReply[]> {
  if (!cfg.emailUser || !cfg.emailPass) return [];

  return new Promise<EmailReply[]>((resolve, reject) => {
    const client = new POP3Client(cfg.pop3Port, cfg.pop3Host, {
      enabletls: true,
      ignoretlserrs: false,
      debug: false,
    });

    const processed = loadProcessed(cfg.stateFile);
    const replies: EmailReply[] = [];
    const messageBodies: Map<number, string> = new Map();
    let totalCount = 0;
    let fetchIndex = 0;
    const toFetch: number[] = [];

    client.on('connect', () => {
      client.login(cfg.emailUser, cfg.emailPass);
    });

    client.on('login', (status: boolean) => {
      if (!status) {
        client.quit();
        reject(new Error('POP3 login failed'));
        return;
      }
      client.list();
    });

    client.on('list', (status: boolean, data: { Count: number }) => {
      if (!status) {
        client.quit();
        resolve([]);
        return;
      }
      totalCount = data.Count;
      if (totalCount === 0) {
        client.quit();
        resolve([]);
        return;
      }

      // Fetch the last checkWindow messages
      const start = Math.max(1, totalCount - cfg.checkWindow + 1);
      for (let i = start; i <= totalCount; i++) {
        toFetch.push(i);
      }
      if (toFetch.length === 0) {
        client.quit();
        resolve([]);
        return;
      }
      fetchNext();
    });

    function fetchNext() {
      if (fetchIndex >= toFetch.length) {
        // All fetched — parse and filter
        for (const [seqNum, raw] of messageBodies) {
          const parsed = parseSimpleEmail(raw);
          const subject = decodeSubject(parsed.subject);

          // Apply source filter
          if (sourceFilter && !sourceFilter(parsed.from)) continue;

          const uid = crypto
            .createHash('md5')
            .update(`${seqNum}:${subject}`)
            .digest('hex');

          if (!processed.has(uid)) {
            const body = parsed.body.slice(0, 500);
            replies.push({ uid, subject, from: parsed.from, body });
            processed.add(uid);
          }
        }
        saveProcessed(cfg.stateFile, processed);
        client.quit();
        resolve(replies);
        return;
      }

      client.retr(toFetch[fetchIndex]);
    }

    client.on('retr', (status: boolean, msgnumber: number, data: string) => {
      if (status) {
        messageBodies.set(msgnumber, data);
      }
      fetchIndex++;
      fetchNext();
    });

    client.on('error', (err: Error) => {
      try { client.quit(); } catch { /* ignore */ }
      reject(err);
    });
  });
}
