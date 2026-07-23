// Premium Bandai AU — account generation (email IMAP OTP + SMSPool / OnlineSim SMS).
// Does not touch Kmart / Toymate paths.
//
// SMS: prefer SMSPool (US/UK numbers work on AU Bandai — owner-validated).
// OnlineSim remains a fallback when no SMSPool key is set.

import { waitForCode } from "../otp/imapInbox.js";
import {
  createOnlinesimClient,
  toBandaiPhone1 as toBandaiPhone1Au,
  normalizeAuMsisdn,
} from "../otp/onlinesim.js";
import {
  createSmspoolClient,
  toBandaiPhone1 as toBandaiPhone1Intl,
  SMSPOOL_SERVICE_BANDAI,
  resolveSmspoolCountry,
} from "../otp/smspool.js";
import { validateBandaiPassword, generateBandaiPassword } from "./bandai-password.js";
import { createBandaiSession, profileFromTask, resolveBandaiArea, bandaiBaseFor } from "./bandai-session.js";

const CATCHALL_DOMAINS = new Set(["bullposted.com"]);

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
  const smsProvider = String(
    o.smsProvider || task?.smsProvider || process.env.BANDAI_SMS_PROVIDER || "auto",
  )
    .trim()
    .toLowerCase();
  return {
    smsProvider,
    smspoolApiKey: String(
      o.smspoolApiKey || task?.smspoolApiKey || process.env.SMSPOOL_API_KEY || "",
    ).trim(),
    smspoolCountry: String(
      o.smspoolCountry || task?.smspoolCountry || process.env.SMSPOOL_COUNTRY || "GB",
    ).trim(),
    smspoolCountries: Array.isArray(o.smspoolCountries || task?.smspoolCountries)
      ? o.smspoolCountries || task.smspoolCountries
      : null,
    smspoolService: Number(
      o.smspoolService || task?.smspoolService || SMSPOOL_SERVICE_BANDAI,
    ),
    smspoolMaxPrice:
      o.smspoolMaxPrice != null
        ? Number(o.smspoolMaxPrice)
        : task?.smspoolMaxPrice != null
          ? Number(task.smspoolMaxPrice)
          : null,
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

function resolveSmsProvider(otp) {
  const pref = otp.smsProvider || "auto";
  if (pref === "smspool") return otp.smspoolApiKey ? "smspool" : null;
  if (pref === "onlinesim") return otp.onlinesimApiKey ? "onlinesim" : null;
  // auto
  if (otp.smspoolApiKey) return "smspool";
  if (otp.onlinesimApiKey) return "onlinesim";
  return null;
}

function smspoolCountryQueue(otp) {
  if (Array.isArray(otp.smspoolCountries) && otp.smspoolCountries.length) {
    return otp.smspoolCountries.map((c) => resolveSmspoolCountry(c).short);
  }
  const primary = resolveSmspoolCountry(otp.smspoolCountry).short;
  // Owner tip: US or UK work for AU Bandai — try configured first, then the other.
  const fallback = primary === "US" ? "GB" : "US";
  return [primary, fallback];
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
  const area = resolveBandaiArea({ ...task, bandaiArea: opts.area || task.bandaiArea });
  const base = bandaiBaseFor(area);
  const profile = profileFromTask({ ...task, bandaiArea: area });
  const otp = otpConfigFromTask(task);
  const session = createBandaiSession(ctx, { area });
  const tStep = opts.tStep || defaultStep(steps, ctx);

  const provider = resolveSmsProvider(otp);
  if (!provider) {
    return fail(
      "otp_config",
      "SMS API key missing — paste SMSPool (preferred) or OnlineSim key in Desktop Settings",
    );
  }
  if (!otp.imapHost || !otp.imapUser || !otp.imapAppPassword) {
    return fail("otp_config", "IMAP settings incomplete — host/user/app password required");
  }

  // Email for Bandai memberId: prefer IMAP mailbox (receives OTP), allow uniquify when pool/catchall.
  const emailDomain = String(profile.email || otp.imapUser || "")
    .split("@")[1]
    ?.toLowerCase();
  const allowUniquify =
    task?.uniquifyEmail === true ||
    task?.bandaiUniquifyEmail === true ||
    (emailDomain && CATCHALL_DOMAINS.has(emailDomain));
  let email = String(otp.imapUser || profile.email || "").trim().toLowerCase();
  if (allowUniquify && (profile.email || otp.imapUser)) {
    email = uniquifyEmail(profile.email || otp.imapUser);
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

  const sms =
    provider === "smspool"
      ? createSmspoolClient({ apikey: otp.smspoolApiKey })
      : createOnlinesimClient({ apikey: otp.onlinesimApiKey });

  await tStep("sms_balance", async () => {
    const bal = await sms.getBalance();
    if (!bal.ok) {
      return { ok: false, status: bal.status, note: bal.error || "balance_failed" };
    }
    return {
      ok: true,
      status: bal.status,
      note: `${provider} balance ${bal.balance}`,
    };
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
      referer: `${base}/register`,
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
      referer: `${base}/register/mailaddress/auth`,
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

  // ── Phone (SMSPool US/UK or OnlineSim AU) ───────────────────────────────
  let phoneAcq = null;
  let phone1 = null;
  const countryQueue =
    provider === "smspool" ? smspoolCountryQueue(otp) : [String(otp.onlinesimCountry || 61)];

  for (let attempt = 0; attempt < 4; attempt++) {
    const countryPick = countryQueue[attempt % countryQueue.length];
    phoneAcq = await tStep(attempt === 0 ? "sms_acquire" : `sms_acquire_retry_${attempt}`, async () => {
      if (provider === "smspool") {
        // Default soft cap keeps cheap UK/US Bandai pools (~$0.04–$0.15); override via smspoolMaxPrice.
        const maxPrice =
          otp.smspoolMaxPrice != null && !Number.isNaN(otp.smspoolMaxPrice)
            ? otp.smspoolMaxPrice
            : 0.25;
        const got = await sms.acquireNumber({
          country: countryPick,
          service: otp.smspoolService,
          maxPrice,
        });
        if (!got.ok) {
          return { ok: false, status: null, note: got.error || "acquire_failed" };
        }
        return {
          ok: true,
          status: null,
          note: `smspool ${got.country} …${String(got.number).slice(-4)}`,
          tzid: got.orderId,
          orderId: got.orderId,
          number: got.number,
          mode: "smspool",
          country: got.country,
          phone1: got.phone1,
        };
      }
      const got = await sms.acquireNumber({
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
        country: "AU",
        phone1: toBandaiPhone1Au(got.number),
      };
    });
    if (!phoneAcq.ok) {
      if (/LOW_BALANCE|WRONG_KEY|balance|invalid.?key/i.test(String(phoneAcq.note))) {
        return fail("sms_acquire", phoneAcq.note, steps);
      }
      continue;
    }
    phone1 =
      phoneAcq.phone1 ||
      (provider === "smspool"
        ? toBandaiPhone1Intl(phoneAcq.number, phoneAcq.country || countryPick)
        : toBandaiPhone1Au(phoneAcq.number));

    const exists = await tStep("phone_unique", async () => {
      const { status, json } = await session.apiJson("POST", "/api/phoneNo", {
        body: phone1,
        referer: `${base}/register/memberregistration`,
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

    await sms.release(phoneAcq.tzid || phoneAcq.orderId, { mode: phoneAcq.mode }).catch(() => {});
    phoneAcq = null;
    phone1 = null;
  }

  if (!phoneAcq?.ok || !phone1) {
    return fail("phone_unique", "Could not acquire unique phone number", steps);
  }

  // Terms
  const terms = await tStep("terms", async () => {
    const { status, json } = await session.apiJson("GET", "/api/terms/termsofuse", {
      referer: `${base}/register/memberregistration`,
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
    await sms.release(phoneAcq.tzid || phoneAcq.orderId, { mode: phoneAcq.mode }).catch(() => {});
    return fail("terms", terms.note, steps);
  }

  // SMS send + validate
  const smsAuth = await tStep("sms_auth", async () => {
    const { status, json } = await session.apiJson("POST", "/api/phoneNo/auth", {
      body: { phoneNo: phone1 },
      referer: `${base}/sms/auth`,
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
    await sms.release(phoneAcq.tzid || phoneAcq.orderId, { mode: phoneAcq.mode }).catch(() => {});
    return fail("sms_auth", smsAuth.note, steps);
  }

  const smsCode = await tStep("sms_otp", async () => {
    const got = await sms.waitForSms({
      tzid: phoneAcq.tzid || phoneAcq.orderId,
      orderId: phoneAcq.orderId || phoneAcq.tzid,
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
    await sms.release(phoneAcq.tzid || phoneAcq.orderId, { mode: phoneAcq.mode }).catch(() => {});
    return fail("sms_otp", smsCode.note, steps);
  }

  const smsValidate = await tStep("sms_validate", async () => {
    const { status, json } = await session.apiJson("POST", "/api/phoneNo/validate", {
      body: { authCode: smsCode.code, authSn: smsAuth.authSn },
      referer: `${base}/sms/auth`,
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
    await sms.release(phoneAcq.tzid || phoneAcq.orderId, { mode: phoneAcq.mode }).catch(() => {});
    return fail("sms_validate", smsValidate.note, steps);
  }

  await sms.release(phoneAcq.tzid || phoneAcq.orderId, { mode: phoneAcq.mode }).catch(() => {});

  const dob = adultDob();
  const homeAddress = {
    areaCode: area,
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
      referer: `${base}/register/confirm`,
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
        areaCode: String(area || "au").toUpperCase(),
      };
      const { status, json } = await session.apiJson("POST", "/api/my/shippingAddresses", {
        body,
        referer: `${base}/mypage`,
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
    phoneCountry: phone1.countryNo || "+61",
    smsProvider: provider,
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
    finalUrl: `${base}/`,
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
