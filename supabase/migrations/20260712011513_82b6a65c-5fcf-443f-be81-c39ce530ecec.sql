CREATE TABLE public.exec_run_dumps (
  id UUID NOT NULL DEFAULT gen_random_uuid() PRIMARY KEY,
  task_id TEXT NOT NULL,
  status INTEGER,
  body TEXT NOT NULL,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now()
);
GRANT ALL ON public.exec_run_dumps TO service_role;
ALTER TABLE public.exec_run_dumps ENABLE ROW LEVEL SECURITY;
CREATE POLICY "no client access" ON public.exec_run_dumps FOR ALL USING (false);
CREATE INDEX exec_run_dumps_created_at_idx ON public.exec_run_dumps (created_at DESC);