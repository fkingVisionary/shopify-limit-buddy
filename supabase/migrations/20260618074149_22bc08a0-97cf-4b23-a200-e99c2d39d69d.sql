
CREATE TABLE public.checkout_jobs (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  status text NOT NULL DEFAULT 'pending',
  stage text NOT NULL DEFAULT 'queued',
  input jsonb NOT NULL DEFAULT '{}'::jsonb,
  result jsonb,
  error text,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now()
);

GRANT ALL ON public.checkout_jobs TO service_role;

ALTER TABLE public.checkout_jobs ENABLE ROW LEVEL SECURITY;

CREATE OR REPLACE FUNCTION public.touch_checkout_jobs_updated_at()
RETURNS TRIGGER
LANGUAGE plpgsql
SET search_path = public
AS $$
BEGIN
  NEW.updated_at = now();
  RETURN NEW;
END;
$$;

CREATE TRIGGER checkout_jobs_set_updated_at
BEFORE UPDATE ON public.checkout_jobs
FOR EACH ROW EXECUTE FUNCTION public.touch_checkout_jobs_updated_at();
