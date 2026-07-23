// IMAP app-password OTP waiter — store-agnostic.
// Uses imapflow. Secrets come from Desktop Settings / task payload — never log them.
//
// Hide My Email / catchall: many aliases forward into one IMAP inbox. Always pass
// `to` (signup address) so the OTP is bound to that task's recipient, not the
// newest Bandai mail in the shared mailbox.

import { ImapFlow } from "imapflow";

function sleep(ms) {
  return new Promise((r) => setTimeout(r, ms));
}

function redactUser(user) {
  const s = String(user || "");
  const at = s.indexOf("@");
  if (at <= 0) return "***";
  return `${s.slice(0, 2)}…@${s.slice(at + 1)}`;
}

/**
 * Extract first capture group (or full match) from text.
 * @param {string} text
 * @param {RegExp|string} regex
 */
export function extractCode(text, regex) {
  const re =
    regex instanceof RegExp
      ? regex
      : new RegExp(regex || "\\b(\\d{6})\\b");
  const m = String(text || "").match(re);
  if (!m) return null;
  return String(m[1] || m[0]);
}

/** Normalize email for comparison. */
export function normalizeEmail(addr) {
  return String(addr || "")
    .trim()
    .toLowerCase()
    .replace(/^<|>$/g, "");
}

/**
 * Collect recipient addresses from envelope + common forward headers.
 * Hide My Email keeps the alias on To: while Original-recipient is the primary inbox.
 */
export function collectRecipients(envelope = {}, source = "") {
  const out = new Set();
  for (const field of ["to", "cc", "bcc"]) {
    for (const a of envelope[field] || []) {
      if (a?.address) out.add(normalizeEmail(a.address));
    }
  }
  const raw = String(source || "");
  const headerRe =
    /^(?:To|Cc|Delivered-To|X-Original-To|X-Forwarded-To|X-Envelope-To):\s*(.+)$/gim;
  let m;
  while ((m = headerRe.exec(raw))) {
    const line = m[1];
    for (const addr of line.match(/[A-Z0-9._%+-]+@[A-Z0-9.-]+\.[A-Z]{2,}/gi) || []) {
      out.add(normalizeEmail(addr));
    }
  }
  // Apple: "Original-recipient: rfc822;primary@icloud.com" — keep but do not rely on alone
  const orig = raw.match(/^Original-recipient:\s*rfc822;([^\s\r\n]+)/im);
  if (orig?.[1]) out.add(normalizeEmail(orig[1]));
  return [...out];
}

/**
 * True when message is addressed to expected signup email (Hide My Email alias, etc.).
 */
export function recipientMatches(expected, envelope, source) {
  const want = normalizeEmail(expected);
  if (!want) return true; // no filter configured
  const recips = collectRecipients(envelope, source);
  if (recips.includes(want)) return true;
  // Also accept substring in To: header line (display-name wrappers)
  const raw = String(source || "");
  if (raw && new RegExp(`(?:^|[\\s<;,])${want.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}(?:[\\s>;,]|$)`, "i").test(raw)) {
    // Prefer To:/Delivered-To lines only to avoid matching body mentions
    const toLines = raw.match(/^(?:To|Cc|Delivered-To|X-Original-To|X-Forwarded-To):.+$/gim) || [];
    return toLines.some((line) => line.toLowerCase().includes(want));
  }
  return false;
}

/**
 * Wait for an OTP email via IMAP (poll).
 *
 * @param {object} opts
 * @param {string} opts.host
 * @param {number|string} [opts.port=993]
 * @param {boolean} [opts.secure=true]
 * @param {string} opts.user
 * @param {string} opts.appPassword — provider app password (not the Bandai password)
 * @param {string} [opts.mailbox="INBOX"]
 * @param {string} [opts.to] — required signup/recipient email when using shared inbox / HME
 * @param {string|RegExp} [opts.from] — filter From contains
 * @param {string|RegExp} [opts.subject] — filter Subject contains
 * @param {RegExp|string} [opts.regex] — code extractor (default 6 digits)
 * @param {Date|number} [opts.since] — only messages after this time
 * @param {number} [opts.timeoutMs=180000]
 * @param {number} [opts.intervalMs=5000]
 * @returns {Promise<{ok:boolean, code?:string, subject?:string, from?:string, to?:string, uid?:number, error?:string}>}
 */
export async function waitForCode(opts = {}) {
  const host = String(opts.host || "").trim();
  const user = String(opts.user || "").trim();
  const pass = String(opts.appPassword || opts.password || "").trim();
  const port = Number(opts.port) || 993;
  const secure = opts.secure !== false;
  const mailbox = String(opts.mailbox || "INBOX");
  const timeoutMs = Number(opts.timeoutMs) || 180_000;
  const intervalMs = Number(opts.intervalMs) || 5_000;
  const since = opts.since
    ? opts.since instanceof Date
      ? opts.since
      : new Date(opts.since)
    : new Date(Date.now() - 2 * 60_000);
  const toFilter = normalizeEmail(opts.to || opts.recipient || opts.toEmail || "");
  const fromFilter = opts.from || /p-?bandai|bandai|premium\s*bandai/i;
  const subjectFilter = opts.subject || null;
  const regex = opts.regex || /\b(\d{6})\b/;

  if (!host || !user || !pass) {
    return {
      ok: false,
      error: "imap_config_missing",
      hint: "Set imapHost, imapUser, imapAppPassword in Desktop Settings",
    };
  }

  const deadline = Date.now() + timeoutMs;
  let lastError = null;
  /** UIDs that were fully inspected (had source) and rejected / already used. */
  const settledUids = new Set();

  while (Date.now() < deadline) {
    let client = null;
    try {
      client = new ImapFlow({
        host,
        port,
        secure,
        auth: { user, pass },
        logger: false,
        emitLogs: false,
      });
      await client.connect();
      const lock = await client.getMailboxLock(mailbox);
      try {
        // IMAP SINCE is date-granular; we still filter by envelope.date below.
        let list = await client.search({ since }, { uid: true });
        if (!Array.isArray(list)) list = [];
        list.sort((a, b) => Number(b) - Number(a));

        let messages = [];
        // UID fetch (preferred). iCloud sometimes yields empty source — fall back to seq.
        if (list.length) {
          for await (const msg of client.fetch(
            list.slice(0, 50),
            { envelope: true, source: true },
            { uid: true },
          )) {
            messages.push(msg);
          }
        }
        const emptySources = messages.length > 0 && messages.every((m) => !m.source);
        if (!messages.length || emptySources) {
          // Sequence-number search/fetch — proven reliable on iCloud Hide My Email.
          const seqs = await client.search({ since });
          const seqList = Array.isArray(seqs) ? seqs.slice(-50) : [];
          messages = [];
          if (seqList.length) {
            for await (const msg of client.fetch(seqList, { envelope: true, source: true })) {
              messages.push(msg);
            }
          }
        }

        // Newest first
        messages.sort((a, b) => {
          const da = a.envelope?.date ? new Date(a.envelope.date).getTime() : 0;
          const db = b.envelope?.date ? new Date(b.envelope.date).getTime() : 0;
          return db - da;
        });

        for (const msg of messages) {
          const uid = msg.uid;
          if (uid != null && settledUids.has(uid)) continue;

          const envelope = msg.envelope || {};
          const fromAddr = (envelope.from || [])
            .map((a) => `${a.name || ""} <${a.address || ""}>`)
            .join(" ");
          const subject = String(envelope.subject || "");
          const date = envelope.date ? new Date(envelope.date) : null;
          // Allow small clock skew (mail servers vs local)
          if (date && date.getTime() < since.getTime() - 15_000) {
            if (uid != null) settledUids.add(uid);
            continue;
          }

          if (fromFilter) {
            const re =
              fromFilter instanceof RegExp
                ? fromFilter
                : new RegExp(String(fromFilter), "i");
            const fromOk = re.test(fromAddr);
            const subjectBandai = /premium\s*bandai|p-?bandai|bandai/i.test(subject);
            if (!fromOk && !subjectBandai) {
              if (uid != null) settledUids.add(uid);
              continue;
            }
          }
          if (subjectFilter) {
            const re =
              subjectFilter instanceof RegExp
                ? subjectFilter
                : new RegExp(String(subjectFilter), "i");
            if (!re.test(subject)) {
              if (uid != null) settledUids.add(uid);
              continue;
            }
          }

          const source = msg.source ? String(msg.source) : "";
          if (!source) {
            // Do not settle — retry next poll (iCloud empty-body flake)
            continue;
          }

          // Critical for shared inbox / Hide My Email: bind OTP to this task's alias.
          if (toFilter && !recipientMatches(toFilter, envelope, source)) {
            if (uid != null) settledUids.add(uid);
            continue;
          }

          const bodyText = decodeMailBody(source);
          const code =
            extractCode(bodyText, /Authentication\s*Code\s*(\d{4,8})/i) ||
            extractCode(`${subject}\n${bodyText}`, regex);
          if (code) {
            const toAddr =
              (envelope.to || []).map((a) => a.address).filter(Boolean)[0] || toFilter || null;
            if (uid != null) settledUids.add(uid);
            return {
              ok: true,
              code,
              subject,
              from: fromAddr,
              to: toAddr,
              uid,
              userHint: redactUser(user),
              recipientFilter: toFilter || null,
            };
          }
          if (uid != null) settledUids.add(uid);
        }
      } finally {
        lock.release();
      }
      await client.logout().catch(() => client.close());
      client = null;
    } catch (e) {
      lastError = e?.message || String(e);
      if (/auth|invalid credentials|LOGIN failed|AUTHENTICATIONFAILED/i.test(lastError)) {
        return {
          ok: false,
          error: "imap_auth_failed",
          detail: lastError.slice(0, 200),
          userHint: redactUser(user),
        };
      }
      try {
        await client?.logout?.();
      } catch {
        try {
          client?.close?.();
        } catch {
          /* ignore */
        }
      }
      client = null;
    }

    await sleep(intervalMs);
  }

  return {
    ok: false,
    error: "imap_timeout",
    detail: lastError ? String(lastError).slice(0, 200) : null,
    userHint: redactUser(user),
    recipientFilter: toFilter || null,
  };
}

/** Best-effort decode of raw RFC822 source to searchable text. */
function decodeMailBody(source) {
  const raw = String(source || "");
  const splitAt = raw.search(/\r?\n\r?\n/);
  let s = splitAt >= 0 ? raw.slice(splitAt) : raw;
  s = s.replace(/=\r?\n/g, "");
  s = s.replace(/=([0-9A-Fa-f]{2})/g, (_, h) => String.fromCharCode(parseInt(h, 16)));
  s = s.replace(/<style[\s\S]*?<\/style>/gi, " ");
  s = s.replace(/<script[\s\S]*?<\/script>/gi, " ");
  s = s.replace(/<[^>]+>/g, " ");
  s = s.replace(/Content-[^\n]+\n/gi, " ");
  return s.replace(/\s+/g, " ").slice(0, 50_000);
}

/**
 * Quick connectivity check (login + select mailbox).
 * Does not search mail.
 */
export async function probeImap(opts = {}) {
  const host = String(opts.host || "").trim();
  const user = String(opts.user || "").trim();
  const pass = String(opts.appPassword || opts.password || "").trim();
  const port = Number(opts.port) || 993;
  const secure = opts.secure !== false;
  const mailbox = String(opts.mailbox || "INBOX");
  if (!host || !user || !pass) {
    return { ok: false, error: "imap_config_missing" };
  }
  const client = new ImapFlow({
    host,
    port,
    secure,
    auth: { user, pass },
    logger: false,
    emitLogs: false,
  });
  try {
    await client.connect();
    const lock = await client.getMailboxLock(mailbox);
    lock.release();
    await client.logout().catch(() => client.close());
    return { ok: true, userHint: redactUser(user), host, mailbox };
  } catch (e) {
    try {
      await client.logout();
    } catch {
      try {
        client.close();
      } catch {
        /* ignore */
      }
    }
    return {
      ok: false,
      error: "imap_probe_failed",
      detail: String(e?.message || e).slice(0, 200),
      userHint: redactUser(user),
    };
  }
}

export default { waitForCode, probeImap, extractCode, collectRecipients, recipientMatches };
