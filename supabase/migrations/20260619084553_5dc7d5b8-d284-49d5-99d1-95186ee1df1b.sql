ALTER TABLE public.checkout_jobs
  ADD COLUMN IF NOT EXISTS phase text NOT NULL DEFAULT 'A',
  ADD COLUMN IF NOT EXISTS session jsonb,
  ADD COLUMN IF NOT EXISTS phase_attempts integer NOT NULL DEFAULT 0;