-- Per-user render metrics for batch dashboard
-- Depends on: 20260414000001_membership_core.sql

create table if not exists public.render_jobs (
  id uuid primary key default gen_random_uuid(),
  job_id text not null unique,
  user_id uuid not null references public.profiles(id) on delete cascade,
  mode text not null check (mode in ('render', 'test')),
  input_path text,
  output_path text,
  file_name text,
  status text not null check (status in ('running', 'success', 'failed', 'stopped')),
  started_at timestamptz,
  finished_at timestamptz,
  error text,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

create table if not exists public.user_render_stats (
  user_id uuid primary key references public.profiles(id) on delete cascade,
  completed_projects_total bigint not null default 0 check (completed_projects_total >= 0),
  last_completed_at timestamptz,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

create index if not exists idx_render_jobs_user_status
  on public.render_jobs(user_id, status, created_at desc);

create index if not exists idx_render_jobs_job_id
  on public.render_jobs(job_id);

create or replace function public.increment_user_render_total(p_user_id uuid)
returns bigint
language plpgsql
security definer
set search_path = public
as $$
declare
  v_total bigint;
begin
  if p_user_id is null then
    raise exception 'p_user_id is required';
  end if;

  insert into public.user_render_stats (
    user_id,
    completed_projects_total,
    last_completed_at,
    updated_at
  )
  values (
    p_user_id,
    1,
    now(),
    now()
  )
  on conflict (user_id)
  do update set
    completed_projects_total = public.user_render_stats.completed_projects_total + 1,
    last_completed_at = now(),
    updated_at = now()
  returning completed_projects_total into v_total;

  return v_total;
end;
$$;

drop trigger if exists trg_render_jobs_updated_at on public.render_jobs;
create trigger trg_render_jobs_updated_at
before update on public.render_jobs
for each row execute function public.set_updated_at();

drop trigger if exists trg_user_render_stats_updated_at on public.user_render_stats;
create trigger trg_user_render_stats_updated_at
before update on public.user_render_stats
for each row execute function public.set_updated_at();

alter table public.render_jobs enable row level security;
alter table public.user_render_stats enable row level security;

drop policy if exists render_jobs_select_self_or_admin on public.render_jobs;
create policy render_jobs_select_self_or_admin
  on public.render_jobs for select
  to authenticated
  using (auth.uid() = user_id or public.is_admin());

drop policy if exists user_render_stats_select_self_or_admin on public.user_render_stats;
create policy user_render_stats_select_self_or_admin
  on public.user_render_stats for select
  to authenticated
  using (auth.uid() = user_id or public.is_admin());
