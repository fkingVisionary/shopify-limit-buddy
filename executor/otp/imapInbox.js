// IMAP app-password OTP waiter — store-agnostic.
// Uses imapflow. Secrets come from Desktop Settings / task payload — never log them.

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
 * @param {string|RegExp} [opts.from] — filter From contains
 * @param {string|RegExp} [opts.subject] — filter Subject contains
 * @param {RegExp|string} [opts.regex] — code extractor (default 6 digits)
 * @param {Date|number} [opts.since] — only messages after this time
 * @param {number} [opts.timeoutMs=180000]
 * @param {number} [opts.intervalMs=5000]
 * @param {string[]} [opts.searchOr] — extra OR search terms
 * @returns {Promise<{ok:boolean, code?:string, subject?:string, from?:string, uid?:number, error?:string}>}
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
  const seenUids = new Set();

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
        // Search recent UNSEEN / since — imapflow accepts Date for SINCE
        const uids = await client.search({ since }, { uid: true });
        const list = Array.isArray(uids) ? uids : [];
        // Newest first
        list.sort((a, b) => Number(b) - Number(a));

        // Prefer fetch iterator — iCloud often returns empty bodies from fetchOne(+uid).
        const batch = list.slice(0, 40);
        for await (const msg of client.fetch(
          batch,
          { envelope: true, source: true },
          { uid: true },
        )) {
          const uid = msg.uid;
          if (uid != null) {
            if (seenUids.has(uid)) continue;
            seenUids.add(uid);
          }

          const envelope = msg.envelope || {};
          const fromAddr = (envelope.from || [])
            .map((a) => `${a.name || ""} <${a.address || ""}>`)
            .join(" ");
          const subject = String(envelope.subject || "");
          const date = envelope.date ? new Date(envelope.date) : null;
          if (date && date < since) continue;

          if (fromFilter) {
            const re =
              fromFilter instanceof RegExp
                ? fromFilter
                : new RegExp(String(fromFilter), "i");
            // Hide My Email rewrites From to *@icloud.com but keeps "PREMIUM BANDAI" in the name
            // and "p-bandai" in the local-part — also accept subject match alone for Bandai.
            const fromOk = re.test(fromAddr);
            const subjectBandai = /premium\s*bandai|p-?bandai|bandai/i.test(subject);
            if (!fromOk && !subjectBandai) continue;
          }
          if (subjectFilter) {
            const re =
              subjectFilter instanceof RegExp
                ? subjectFilter
                : new RegExp(String(subjectFilter), "i");
            if (!re.test(subject)) continue;
          }

          const source = msg.source ? String(msg.source) : "";
          if (!source) continue;
          const bodyText = decodeMailBody(source);
          const code =
            extractCode(bodyText, /Authentication\s*Code\s*(\d{4,8})/i) ||
            extractCode(`${subject}\n${bodyText}`, regex);
          if (code) {
            return {
              ok: true,
              code,
              subject,
              from: fromAddr,
              uid,
              userHint: redactUser(user),
            };
          }
        }
      } finally {
        lock.release();
      }
      await client.logout().catch(() => client.close());
      client = null;
    } catch (e) {
      lastError = e?.message || String(e);
      // Auth failures should stop the batch — surface immediately
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
  };
}

/** Best-effort decode of raw RFC822 source to searchable text. */
function decodeMailBody(source) {
  const raw = String(source || "");
  // Prefer body after headers when present
  const splitAt = raw.search(/\r?\n\r?\n/);
  let s = splitAt >= 0 ? raw.slice(splitAt) : raw;
  // Strip quoted-printable soft breaks + hex
  s = s.replace(/=\r?\n/g, "");
  s = s.replace(/=([0-9A-Fa-f]{2})/g, (_, h) => String.fromCharCode(parseInt(h, 16)));
  // Drop CSS / tags so "Authentication Code 123456" is contiguous
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

export default { waitForCode, probeImap, extractCode };
