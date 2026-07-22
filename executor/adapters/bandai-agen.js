// Premium Bandai AU — account generation (email IMAP OTP + OnlineSim SMS).
// Does not touch Kmart / Toymate paths.

import { waitForCode } from "../otp/imapInbox.js";
import {
  createOnlinesimClient,
  toBandaiPhone1,
  normalizeAuMsisdn,
} from "../otp/onlinesim.js";
import { validateBandaiPassword, generateBandaiPassword } from "./bandai-password.js";
import { createBandaiSession, profileFromTask, BANDAI_BASE } from "./bandai-session.js";

function uniquifyEmail(email) {
  const raw = String(email || "").trim().toLowerCase();
  const m = raw.match(/^([^@]+)@(.+)$/);
  if (!m) return raw || `buyer${Date.now().toString(36)}@example.com`;
  const local = m[1].replace(/\+.*$/, "");
  const domain = m[2];
  const stamp = Date.now().toString(36) + Math.random().toString(36).slice(2, 5);
  if (/^(gmail|googlemail)\.com$/i.test(domain)) {
    const base = local.replace(/\./g, "");
    return `${base.slice(0, 2)}.${stamp}.${base.slice(2) || "x"}@${domain}`;
  }
  return `${local}+${stamp}@${domain}`;
}

function otpConfigFromTask(task) {
  const o = task?.otp || task?.bandaiOtp || {};
  return {
    onlinesimApiKey: String(o.onlinesimApiKey || task?.onlinesimApiKey || "").trim(),
    onlinesimMode: String(o.onlinesimMode || task?.onlinesimMode || "rent").toLowerCase(),
    onlinesimServiceSlug: String(o.onlinesimServiceSlug || task?.onlinesimServiceSlug || "other"),
    onlinesimCountry: Number(o.onlinesimCountry || task?.onlinesimCountry || 61),
    imapHost: String(o.imapHost || task?.imapHost || "").trim(),
    imapPort: Number(o.imapPort || task?.imapPort || 993),
    imapUser: String(o.imapUser || task?.imapUser || "").trim(),
    imapAppPassword: String(o.imapAppPassword || task?.imapAppPassword || "").trim(),
    imapMailbox: String(o.imapMailbox || task?.imapMailbox || "INBOX"),
  };
}

function adultDob() {
  // Fixed ≥18 DOB
  return { dobYear: 1995, dobMonth: 6, dobDay: 15 };
}

/**
 * Full AU signup → login → shipping → vault-ready account.
 *
 * @param {object} task
 * @param {object} ctx — http ctx with jar/dispatcher/steps
 * @param {object} [opts]
 */
export async function createBandaiAccount(task, ctx, opts = {}) {
  const steps = ctx.steps || (ctx.steps = []);
  const profile = profileFromTask(task);
  const otp = otpConfigFromTask(task);
  const session = createBandaiSession(ctx);
  const tStep = opts.tStep || defaultStep(steps, ctx);

  if (!otp.onlinesimApiKey) {
    return fail("otp_config", "OnlineSim API key missing — paste in Desktop Settings");
  }
  if (!otp.imapHost || !otp.imapUser || !otp.imapAppPassword) {
    return fail("otp_config", "IMAP settings incomplete — host/user/app password required");
  }

  // Email for Bandai memberId: prefer IMAP mailbox (receives OTP), allow uniquify when pool.
  const allowUniquify = task?.uniquifyEmail === true || task?.bandaiUniquifyEmail === true;
  let email = String(otp.imapUser || profile.email || "").trim().toLowerCase();
  if (allowUniquify && profile.email) {
    email = uniquifyEmail(profile.email);
  }
  if (!email || !email.includes("@")) {
    return fail("otp_config", "imapUser / email required for Bandai memberId");
  }

  const password =
    (typeof task.accountPassword === "string" && task.accountPassword.trim()) ||
    generateBandaiPassword(email);
  const pwCheck = validateBandaiPassword(password, email);
  if (!pwCheck.ok) {
    return fail("password_rules", `Password fails Bandai rules: ${pwCheck.errors.join(",")}`);
  }

  const onlinesim = createOnlinesimClient({ apikey: otp.onlinesimApiKey });

  await tStep("onlinesim_balance", async () => {
    const bal = await onlinesim.getBalance();
    if (!bal.ok) {
      return { ok: false, status: bal.status, note: bal.error || "balance_failed" };
    }
    return { ok: true, status: bal.status, note: `balance ${bal.balance}` };
  });

  const warm = await tStep("warm", async () => session.warm());
  if (!warm.ok) {
    return fail("warm", warm.note || "warm failed", steps);
  }

  // ── Email OTP ──────────────────────────────────────────────────────────
  const emailSince = new Date();
  const emailAuth = await tStep("email_auth", async () => {
    const { res, json, status } = await session.apiJson("POST", "/api/signUp/email/auth", {
      body: { email, agreeAgeTerms: true },
      referer: `${BANDAI_BASE}/register`,
    });
    const authSn = json?.authSn || json?.data?.authSn || null;
    const detail = json?.detail || json?.message || json?.error || null;
    if (/already|exist|registered|duplicat/i.test(String(detail || "")) || status === 409) {
      return { ok: false, status, note: "email_already_registered", authSn, json };
    }
    return {
      ok: status >= 200 && status < 300 && Boolean(authSn),
      status,
      note: authSn ? `authSn ${String(authSn).slice(0, 8)}…` : String(detail || status),
      authSn,
      json,
    };
  });

  if (!emailAuth.ok) {
    return {
      ok: false,
      accountGen: true,
      failedStep: "email_auth",
      error: emailAuth.note || "email_auth_failed",
      steps,
      checkoutStage: "agen",
      account: { email, status: "burned" },
    };
  }

  const emailCode = await tStep("email_otp_imap", async () => {
    const got = await waitForCode({
      host: otp.imapHost,
      port: otp.imapPort,
      user: otp.imapUser,
      appPassword: otp.imapAppPassword,
      mailbox: otp.imapMailbox,
      since: emailSince,
      timeoutMs: Number(task.emailOtpTimeoutMs) || 180_000,
      regex: /\b(\d{6})\b/,
    });
    if (!got.ok) {
      return { ok: false, status: null, note: got.error || "imap_failed", detail: got.detail };
    }
    return { ok: true, status: null, note: "code received", code: got.code };
  });

  if (!emailCode.ok) {
    return fail("email_otp_imap", emailCode.note || emailCode.detail || "IMAP OTP failed", steps);
  }

  const emailValidate = await tStep("email_validate", async () => {
    const { res, json, status } = await session.apiJson("POST", "/api/signUp/email/validate", {
      body: { authCode: emailCode.code, authSn: emailAuth.authSn },
      referer: `${BANDAI_BASE}/register/mailaddress/auth`,
    });
    const err = json?.detail || json?.message || json?.errorCode || null;
    return {
      ok: status >= 200 && status < 300,
      status,
      note: err ? String(err) : `validate ${status}`,
      json,
    };
  });
  if (!emailValidate.ok) {
    return fail("email_validate", emailValidate.note, steps);
  }

  // ── Phone (OnlineSim) ──────────────────────────────────────────────────
  let phoneAcq = null;
  let phone1 = null;
  for (let attempt = 0; attempt < 3; attempt++) {
    phoneAcq = await tStep(attempt === 0 ? "sms_acquire" : `sms_acquire_retry_${attempt}`, async () => {
      const got = await onlinesim.acquireNumber({
        mode: otp.onlinesimMode,
        country: otp.onlinesimCountry,
        service: otp.onlinesimServiceSlug,
      });
      if (!got.ok) {
        return { ok: false, status: null, note: got.error || "acquire_failed" };
      }
      return {
        ok: true,
        status: null,
        note: `${got.mode} …${String(got.number).slice(-4)}`,
        tzid: got.tzid,
        number: got.number,
        mode: got.mode,
      };
    });
    if (!phoneAcq.ok) {
      if (/LOW_BALANCE|WRONG_KEY/i.test(String(phoneAcq.note))) {
        return fail("sms_acquire", phoneAcq.note, steps);
      }
      continue;
    }
    phone1 = toBandaiPhone1(phoneAcq.number);

    const exists = await tStep("phone_unique", async () => {
      // Research path is `api/phoneNo` (sometimes without leading slash in JS)
      const { status, json } = await session.apiJson("POST", "/api/phoneNo", {
        body: phone1,
        referer: `${BANDAI_BASE}/register/memberregistration`,
      });
      const existsFlag = Boolean(json?.exists ?? json?.data?.exists);
      return {
        ok: status >= 200 && status < 300 && !existsFlag,
        status,
        note: existsFlag ? "PHONE_NUMBER_DUPLICATED" : `unique ${status}`,
        exists: existsFlag,
        json,
      };
    });

    if (exists.ok) break;

    await onlinesim.release(phoneAcq.tzid, { mode: phoneAcq.mode }).catch(() => {});
    phoneAcq = null;
    phone1 = null;
  }

  if (!phoneAcq?.ok || !phone1) {
    return fail("phone_unique", "Could not acquire unique AU phone", steps);
  }

  // Terms
  const terms = await tStep("terms", async () => {
    const { status, json } = await session.apiJson("GET", "/api/terms/termsofuse", {
      referer: `${BANDAI_BASE}/register/memberregistration`,
    });
    const version = json?.termsVersion || json?.version || json?.data?.termsVersion || "1.7";
    const termsCode = json?.termsCode || "termsofuse";
    const areaCode = json?.areaCode || "au";
    return {
      ok: status >= 200 && status < 300,
      status,
      note: `${termsCode} v${version}`,
      termsAgreeList: [
        { termsCode, version: String(version), areaCode, agree: true },
      ],
      json,
    };
  });
  if (!terms.ok) {
    await onlinesim.release(phoneAcq.tzid, { mode: phoneAcq.mode }).catch(() => {});
    return fail("terms", terms.note, steps);
  }

  // SMS send + validate
  const smsAuth = await tStep("sms_auth", async () => {
    const { status, json } = await session.apiJson("POST", "/api/phoneNo/auth", {
      body: { phoneNo: phone1 },
      referer: `${BANDAI_BASE}/sms/auth`,
    });
    const authSn = json?.authSn || json?.data?.authSn || null;
    const err = json?.detail || json?.errorCode || json?.message || null;
    if (/SmsRateLimit|TOO_MANY_REQUEST|SMS_AUTH_FAIL/i.test(String(err || ""))) {
      return { ok: false, status, note: String(err), authSn };
    }
    return {
      ok: status >= 200 && status < 300 && Boolean(authSn),
      status,
      note: authSn ? "sms sent" : String(err || status),
      authSn,
      json,
    };
  });

  if (!smsAuth.ok) {
    await onlinesim.release(phoneAcq.tzid, { mode: phoneAcq.mode }).catch(() => {});
    return fail("sms_auth", smsAuth.note, steps);
  }

  const smsCode = await tStep("sms_otp", async () => {
    const got = await onlinesim.waitForSms({
      tzid: phoneAcq.tzid,
      mode: phoneAcq.mode,
      timeoutMs: Number(task.smsOtpTimeoutMs) || 180_000,
      regex: /\b(\d{4,8})\b/,
    });
    if (!got.ok) {
      return { ok: false, status: null, note: got.error || "sms_timeout" };
    }
    return { ok: true, status: null, note: "sms code", code: got.code };
  });

  if (!smsCode.ok) {
    await onlinesim.release(phoneAcq.tzid, { mode: phoneAcq.mode }).catch(() => {});
    return fail("sms_otp", smsCode.note, steps);
  }

  const smsValidate = await tStep("sms_validate", async () => {
    const { status, json } = await session.apiJson("POST", "/api/phoneNo/validate", {
      body: { authCode: smsCode.code, authSn: smsAuth.authSn },
      referer: `${BANDAI_BASE}/sms/auth`,
    });
    const authResultCode =
      json?.authResultCode ||
      json?.smsAuthResult?.authResultCode ||
      json?.data?.authResultCode ||
      json?.resultCode ||
      "OK";
    const authSn = json?.authSn || smsAuth.authSn;
    return {
      ok: status >= 200 && status < 300,
      status,
      note: `sms validated`,
      smsAuthInfo: { authSn, authResultCode },
      json,
    };
  });

  if (!smsValidate.ok) {
    await onlinesim.release(phoneAcq.tzid, { mode: phoneAcq.mode }).catch(() => {});
    return fail("sms_validate", smsValidate.note, steps);
  }

  await onlinesim.release(phoneAcq.tzid, { mode: phoneAcq.mode }).catch(() => {});

  const dob = adultDob();
  const homeAddress = {
    areaCode: "au",
    homeAddressArea: profile.province || "NSW",
    homeAddressDetail: profile.city || "Sydney",
  };
  const address = {
    countryCode: "AU",
    zipCode: String(profile.zip || "2000").slice(0, 4),
    address1: profile.address1 || "1 George Street",
    address2: "",
    address3: profile.city || "Sydney",
    address4: "",
    address5: profile.province || "NSW",
  };

  const signUpData = {
    memberId: email,
    memberPassword: password,
    emailAddress: email,
    name: {
      name1: profile.first_name || "Alex",
      name2: profile.last_name || "Buyer",
    },
    phone1,
    address,
    homeAddress,
    gender: task.gender || "NotSelected",
    dobYear: dob.dobYear,
    dobMonth: dob.dobMonth,
    dobDay: dob.dobDay,
    multiAuth: true,
    marketingConsent: {
      marketingPreference1: false,
      marketingPreference2: false,
      marketingPreference3: false,
    },
    termsAgreeList: terms.termsAgreeList,
    smsAuthInfo: smsValidate.smsAuthInfo,
  };

  const registered = await tStep("registerVerification", async () => {
    const { status, json } = await session.apiJson("POST", "/api/signUp/registerVerification", {
      body: signUpData,
      referer: `${BANDAI_BASE}/register/confirm`,
    });
    const err = json?.detail || json?.errorCode || json?.message || null;
    return {
      ok: status >= 200 && status < 300,
      status,
      note: err ? String(err) : `register ${status}`,
      json,
    };
  });

  if (!registered.ok) {
    return {
      ok: false,
      accountGen: true,
      failedStep: "registerVerification",
      error: registered.note,
      steps,
      checkoutStage: "agen",
      account: {
        email,
        password,
        phone: phone1.phoneNo,
        status: "banned",
      },
    };
  }

  // Auto-login
  const login = await tStep("login", async () => session.loginPassword(email, password));
  let vaultStatus = "ready";
  if (!login.ok) {
    if (/SMSVerification/i.test(String(login.restrictedType || ""))) {
      vaultStatus = "needs_sms";
    } else if (/Terms/i.test(String(login.restrictedType || ""))) {
      vaultStatus = "needs_sms"; // treat terms as not-ready
    } else {
      vaultStatus = "needs_sms";
    }
  }

  // Shipping address (best-effort when login ok)
  let shipping = null;
  if (login.ok) {
    const ship = await tStep("shipping", async () => {
      const body = {
        name: { name1: profile.first_name || "Alex", name2: profile.last_name || "Buyer" },
        phone1,
        address,
        areaCode: "AU",
      };
      const { status, json } = await session.apiJson("POST", "/api/my/shippingAddresses", {
        body,
        referer: `${BANDAI_BASE}/mypage`,
      });
      return {
        ok: status >= 200 && status < 300,
        status,
        note: `shipping ${status}`,
        json,
        shipping: body,
      };
    });
    shipping = ship.shipping || address;
    if (!ship.ok) {
      // Still vault as ready if login cleared — shipping can be added later
      vaultStatus = vaultStatus === "ready" ? "ready" : vaultStatus;
    }
  }

  const account = {
    email,
    password,
    phone: phone1.phoneNo,
    phoneCountry: "+61",
    status: vaultStatus,
    shipping: shipping || address,
    storeId: "bandai",
    createdAt: Date.now(),
  };

  return {
    ok: vaultStatus === "ready",
    accountGen: true,
    account,
    steps,
    checkoutStage: "agen",
    dryRun: true,
    finalUrl: `${BANDAI_BASE}/`,
    cookies: ctx.jar?.dump?.() ?? {},
    note:
      vaultStatus === "ready"
        ? `Vault ready: ${email}`
        : `Account created but status=${vaultStatus} (${login.restrictedType || login.note})`,
  };
}

function defaultStep(steps, ctx) {
  return async (name, fn) => {
    const s0 = Date.now();
    try {
      const out = await fn();
      const row = {
        step: name,
        ok: out?.ok !== false,
        status: out?.status ?? null,
        ms: Date.now() - s0,
        note: out?.note ?? null,
      };
      steps.push(row);
      ctx.onProgress?.(name, out?.note || null);
      return out;
    } catch (e) {
      const row = {
        step: name,
        ok: false,
        status: null,
        ms: Date.now() - s0,
        note: e?.message || String(e),
      };
      steps.push(row);
      throw e;
    }
  };
}

function fail(step, error, steps = []) {
  return {
    ok: false,
    accountGen: true,
    failedStep: step,
    error: String(error || step),
    steps,
    checkoutStage: "agen",
    dryRun: true,
  };
}

export { uniquifyEmail, otpConfigFromTask, normalizeAuMsisdn };
export default { createBandaiAccount };
