
CREATE EXTENSION IF NOT EXISTS pg_net WITH SCHEMA extensions;

CREATE OR REPLACE FUNCTION public.invoke_checkout_worker()
RETURNS TRIGGER
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public, extensions
AS $$
DECLARE
  worker_url text := current_setting('app.run_checkout_url', true);
  exec_token text := current_setting('app.executor_token', true);
BEGIN
  IF worker_url IS NULL OR worker_url = '' OR exec_token IS NULL OR exec_token = '' THEN
    RAISE WARNING 'invoke_checkout_worker: app.run_checkout_url or app.executor_token not configured';
    RETURN NEW;
  END IF;
  PERFORM net.http_post(
    url := worker_url,
    headers := jsonb_build_object(
      'content-type', 'application/json',
      'x-executor-token', exec_token
    ),
    body := jsonb_build_object('jobId', NEW.id)
  );
  RETURN NEW;
END;
$$;

DROP TRIGGER IF EXISTS checkout_jobs_invoke_worker ON public.checkout_jobs;
CREATE TRIGGER checkout_jobs_invoke_worker
AFTER INSERT ON public.checkout_jobs
FOR EACH ROW EXECUTE FUNCTION public.invoke_checkout_worker();
