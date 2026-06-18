
DROP TRIGGER IF EXISTS checkout_jobs_invoke_worker ON public.checkout_jobs;
DROP FUNCTION IF EXISTS public.invoke_checkout_worker();

CREATE OR REPLACE FUNCTION public.request_checkout_worker(
  p_job_id uuid,
  p_url text,
  p_token text
)
RETURNS bigint
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public, extensions
AS $$
DECLARE
  req_id bigint;
BEGIN
  SELECT net.http_post(
    url := p_url,
    headers := jsonb_build_object(
      'content-type', 'application/json',
      'x-executor-token', p_token
    ),
    body := jsonb_build_object('jobId', p_job_id)
  ) INTO req_id;
  RETURN req_id;
END;
$$;

REVOKE ALL ON FUNCTION public.request_checkout_worker(uuid, text, text) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.request_checkout_worker(uuid, text, text) TO service_role;
