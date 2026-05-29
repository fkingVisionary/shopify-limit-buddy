
CREATE TABLE public.runner_pairing_codes (
  code TEXT PRIMARY KEY,
  device_name TEXT NOT NULL DEFAULT 'Runner',
  created_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE TABLE public.runner_devices (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  token TEXT NOT NULL UNIQUE,
  name TEXT NOT NULL DEFAULT 'Runner',
  is_active BOOLEAN NOT NULL DEFAULT true,
  last_seen_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  created_at TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE INDEX runner_devices_active_idx ON public.runner_devices(is_active, created_at DESC);

CREATE TABLE public.runner_jobs (
  id TEXT PRIMARY KEY,
  device_id UUID NOT NULL REFERENCES public.runner_devices(id) ON DELETE CASCADE,
  store_url TEXT NOT NULL,
  dry_run BOOLEAN NOT NULL DEFAULT true,
  payload JSONB NOT NULL,
  claimed BOOLEAN NOT NULL DEFAULT false,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE INDEX runner_jobs_queue_idx ON public.runner_jobs(device_id, claimed, created_at);

CREATE TABLE public.runner_results (
  job_id TEXT PRIMARY KEY REFERENCES public.runner_jobs(id) ON DELETE CASCADE,
  ok BOOLEAN NOT NULL,
  order_id TEXT,
  error TEXT,
  payload JSONB NOT NULL,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

-- Server-only access (admin client via service_role). No end-user grants.
GRANT ALL ON public.runner_pairing_codes TO service_role;
GRANT ALL ON public.runner_devices TO service_role;
GRANT ALL ON public.runner_jobs TO service_role;
GRANT ALL ON public.runner_results TO service_role;

ALTER TABLE public.runner_pairing_codes ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.runner_devices ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.runner_jobs ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.runner_results ENABLE ROW LEVEL SECURITY;
