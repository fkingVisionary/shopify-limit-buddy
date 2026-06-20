ALTER TABLE public.checkout_jobs
  ADD COLUMN IF NOT EXISTS notify_webhook text,
  ADD COLUMN IF NOT EXISTS notify_events jsonb,
  ADD COLUMN IF NOT EXISTS webhook_fired_at timestamptz;