// Shared protocol between the Lovable control-plane and the local Electron
// runner. Keep this file dependency-free so the runner can copy it verbatim.

export type RunnerJob = {
  id: string;
  createdAt: number;
  storeUrl: string;
  variantId: number;
  qty: number;
  profile: {
    email: string;
    first_name: string;
    last_name: string;
    address1: string;
    address2?: string | null;
    city: string;
    province: string;
    zip: string;
    country: string;
    phone: string;
  };
  card: {
    number: string;
    name: string;
    exp_month: string;
    exp_year: string;
    cvv: string;
  };
  proxy?: string | null;     // raw "ip:port" or "user:pass@ip:port"
  captchaToken?: string | null;
  dryRun: boolean;
};

export type RunnerStep =
  | "launch" | "cart_add" | "checkout_load" | "contact_fill"
  | "shipping_continue" | "shipping_method" | "payment_continue"
  | "card_fill" | "captcha_inject" | "submit" | "confirm";

export type RunnerStepRecord = { step: RunnerStep; t: number; ok: boolean; note?: string };

export type RunnerResult =
  | {
      jobId: string;
      ok: true;
      orderId: string | null;
      finalUrl: string;
      steps: RunnerStepRecord[];
      screenshotB64: string | null;
      elapsedMs: number;
      dryRun: boolean;
    }
  | {
      jobId: string;
      ok: false;
      failedStep: RunnerStep | "transport";
      error: string;
      steps: RunnerStepRecord[];
      screenshotB64: string | null;
      elapsedMs: number;
    };

// HTTP envelopes
export type PairRequest  = { pairingCode: string; deviceName?: string };
export type PairResponse = { deviceToken: string; deviceId: string };

export type PollResponse = { job: RunnerJob | null };
