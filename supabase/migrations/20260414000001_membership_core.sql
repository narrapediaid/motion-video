-- Membership core schema + RLS baseline
-- Doc reference: docs/execution/01-supabase-schema-rls.md

create extension if not exists pgcrypto;
create extension if not exists citext;

do $$
begin
  if not exists (
    select 1
    from pg_type t
    join pg_namespace n on n.oid = t.typnamespace
    where n.nspname = 'public' and t.typname = 'membership_tier'
  ) then
    create type public.membership_tier as enum ('monthly', 'yearly', 'lifetime');
  end if;

  if not exists (
    select 1
    from pg_type t
    join pg_namespace n on n.oid = t.typnamespace
    where n.nspname = 'public' and t.typname = 'membership_status'
  ) then
    create type public.membership_status as enum (
      'pending_payment',
      'active',
      'grace_period',
      'expired',
      'suspended',
      'canceled',
      'lifetime_active'
    );
  end if;

  if not exists (
    select 1
    from pg_type t
    join pg_namespace n on n.oid = t.typnamespace
    where n.nspname = 'public' and t.typname = 'subscription_status'
  ) then
    create type public.subscription_status as enum (
      'trialing',
      'active',
      'past_due',
      'canceled',
      'incomplete',
      'incomplete_expired'
    );
  end if;

  if not exists (
    select 1
    from pg_type t
    join pg_namespace n on n.oid = t.typnamespace
    where n.nspname = 'public' and t.typname = 'invoice_status'
  ) then
    create type public.invoice_status as enum (
      'draft',
      'open',
      'paid',
      'void',
      'uncollectible',
      'expired'
    );
  end if;

  if not exists (
    select 1
    from pg_type t
    join pg_namespace n on n.oid = t.typnamespace
    where n.nspname = 'public' and t.typname = 'payment_status'
  ) then
    create type public.payment_status as enum (
      'pending',
      'settlement',
      'capture',
      'deny',
      'cancel',
      'expire',
      'refund',
      'partial_refund',
      'chargeback',
      'partial_chargeback',
      'failure'
    );
  end if;

  if not exists (
    select 1
    from pg_type t
    join pg_namespace n on n.oid = t.typnamespace
    where n.nspname = 'public' and t.typname = 'device_status'
  ) then
    create type public.device_status as enum ('active', 'revoked');
  end if;

  if not exists (
    select 1
    from pg_type t
    join pg_namespace n on n.oid = t.typnamespace
    where n.nspname = 'public' and t.typname = 'provider_name'
  ) then
    create type public.provider_name as enum ('midtrans');
  end if;
end;
$$;

create table public.profiles (
  id uuid primary key references auth.users(id) on delete cascade,
  email citext unique not null,
  full_name text,
  app_role text not null default 'user' check (app_role in ('user', 'admin')),
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

create table public.plans (
  id uuid primary key default gen_random_uuid(),
  code text unique not null,
  name text not null,
  tier public.membership_tier not null,
  billing_cycle_months integer not null default 0 check (billing_cycle_months >= 0),
  price_idr bigint not null check (price_idr >= 0),
  is_active boolean not null default true,
  metadata jsonb not null default '{}'::jsonb,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

create table public.memberships (
  id uuid primary key default gen_random_uuid(),
  user_id uuid not null unique references public.profiles(id) on delete cascade,
  plan_id uuid references public.plans(id),
  status public.membership_status not null default 'pending_payment',
  starts_at timestamptz,
  ends_at timestamptz,
  grace_ends_at timestamptz,
  canceled_at timestamptz,
  source public.provider_name not null default 'midtrans',
  version integer not null default 1,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

create table public.subscriptions (
  id uuid primary key default gen_random_uuid(),
  user_id uuid not null references public.profiles(id) on delete cascade,
  membership_id uuid unique not null references public.memberships(id) on delete cascade,
  provider public.provider_name not null default 'midtrans',
  provider_subscription_id text unique,
  status public.subscription_status not null default 'incomplete',
  current_period_start timestamptz,
  current_period_end timestamptz,
  cancel_at timestamptz,
  canceled_at timestamptz,
  next_billing_at timestamptz,
  metadata jsonb not null default '{}'::jsonb,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

create table public.invoices (
  id uuid primary key default gen_random_uuid(),
  user_id uuid not null references public.profiles(id) on delete cascade,
  membership_id uuid references public.memberships(id) on delete set null,
  subscription_id uuid references public.subscriptions(id) on delete set null,
  provider public.provider_name not null default 'midtrans',
  external_order_id text unique not null,
  currency char(3) not null default 'IDR',
  amount_idr bigint not null check (amount_idr >= 0),
  status public.invoice_status not null default 'open',
  due_at timestamptz,
  paid_at timestamptz,
  expires_at timestamptz,
  raw_payload jsonb not null default '{}'::jsonb,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

create table public.payments (
  id uuid primary key default gen_random_uuid(),
  invoice_id uuid not null references public.invoices(id) on delete cascade,
  user_id uuid not null references public.profiles(id) on delete cascade,
  provider public.provider_name not null default 'midtrans',
  external_transaction_id text unique,
  payment_method text,
  payment_channel text,
  gross_amount_idr bigint not null check (gross_amount_idr >= 0),
  status public.payment_status not null default 'pending',
  transaction_time timestamptz,
  settlement_time timestamptz,
  fraud_status text,
  raw_payload jsonb not null default '{}'::jsonb,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

create table public.payment_events (
  id uuid primary key default gen_random_uuid(),
  provider public.provider_name not null default 'midtrans',
  idempotency_key text unique not null,
  external_order_id text,
  external_transaction_id text,
  event_type text not null,
  payload jsonb not null,
  process_result text not null default 'pending' check (process_result in ('pending', 'applied', 'ignored', 'failed')),
  error_message text,
  received_at timestamptz not null default now(),
  processed_at timestamptz,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

create table public.devices (
  id uuid primary key default gen_random_uuid(),
  user_id uuid not null references public.profiles(id) on delete cascade,
  device_fingerprint text not null,
  device_name text,
  status public.device_status not null default 'active',
  last_seen_at timestamptz,
  revoked_at timestamptz,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  unique (user_id, device_fingerprint)
);

create table public.entitlement_snapshots (
  id uuid primary key default gen_random_uuid(),
  user_id uuid not null references public.profiles(id) on delete cascade,
  membership_id uuid not null references public.memberships(id) on delete cascade,
  entitlement_token text unique not null,
  version integer not null default 1,
  payload jsonb not null,
  signature text not null,
  ttl_seconds integer not null check (ttl_seconds > 0),
  issued_at timestamptz not null default now(),
  expires_at timestamptz not null,
  revoked_at timestamptz,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

create table public.audit_logs (
  id bigserial primary key,
  actor_user_id uuid references public.profiles(id) on delete set null,
  actor_role text,
  entity_type text not null,
  entity_id text,
  action text not null,
  before_state jsonb,
  after_state jsonb,
  request_id text,
  ip_address inet,
  created_at timestamptz not null default now()
);

create index idx_profiles_app_role on public.profiles(app_role);
create index idx_plans_tier_active on public.plans(tier, is_active);
create index idx_memberships_user_status on public.memberships(user_id, status);
create index idx_subscriptions_user_status on public.subscriptions(user_id, status);
create index idx_invoices_user_status on public.invoices(user_id, status);
create index idx_invoices_external_order on public.invoices(external_order_id);
create index idx_payments_invoice_status on public.payments(invoice_id, status);
create index idx_payments_external_transaction on public.payments(external_transaction_id);
create index idx_payment_events_order on public.payment_events(external_order_id);
create index idx_payment_events_received_at on public.payment_events(received_at);
create index idx_devices_user_status on public.devices(user_id, status);
create index idx_entitlement_user_expires on public.entitlement_snapshots(user_id, expires_at desc);
create index idx_audit_logs_entity on public.audit_logs(entity_type, entity_id);
create index idx_audit_logs_created_at on public.audit_logs(created_at desc);

create or replace function public.set_updated_at()
returns trigger
language plpgsql
as $$
begin
  new.updated_at = now();
  return new;
end;
$$;

create or replace function public.is_admin()
returns boolean
language sql
stable
security definer
set search_path = public
as $$
  select exists (
    select 1
    from public.profiles p
    where p.id = auth.uid()
      and p.app_role = 'admin'
  );
$$;

create or replace function public.handle_new_auth_user()
returns trigger
language plpgsql
security definer
set search_path = public
as $$
begin
  insert into public.profiles (id, email, full_name)
  values (
    new.id,
    coalesce(new.email, concat(new.id::text, '@placeholder.local')),
    coalesce(new.raw_user_meta_data ->> 'full_name', null)
  )
  on conflict (id) do update
    set email = excluded.email,
        full_name = coalesce(excluded.full_name, public.profiles.full_name),
        updated_at = now();
  return new;
end;
$$;

drop trigger if exists on_auth_user_created on auth.users;
create trigger on_auth_user_created
after insert on auth.users
for each row
execute function public.handle_new_auth_user();

create trigger trg_profiles_updated_at
before update on public.profiles
for each row execute function public.set_updated_at();

create trigger trg_plans_updated_at
before update on public.plans
for each row execute function public.set_updated_at();

create trigger trg_memberships_updated_at
before update on public.memberships
for each row execute function public.set_updated_at();

create trigger trg_subscriptions_updated_at
before update on public.subscriptions
for each row execute function public.set_updated_at();

create trigger trg_invoices_updated_at
before update on public.invoices
for each row execute function public.set_updated_at();

create trigger trg_payments_updated_at
before update on public.payments
for each row execute function public.set_updated_at();

create trigger trg_payment_events_updated_at
before update on public.payment_events
for each row execute function public.set_updated_at();

create trigger trg_devices_updated_at
before update on public.devices
for each row execute function public.set_updated_at();

create trigger trg_entitlement_snapshots_updated_at
before update on public.entitlement_snapshots
for each row execute function public.set_updated_at();

alter table public.profiles enable row level security;
alter table public.plans enable row level security;
alter table public.memberships enable row level security;
alter table public.subscriptions enable row level security;
alter table public.invoices enable row level security;
alter table public.payments enable row level security;
alter table public.payment_events enable row level security;
alter table public.devices enable row level security;
alter table public.entitlement_snapshots enable row level security;
alter table public.audit_logs enable row level security;

drop policy if exists profiles_select_self_or_admin on public.profiles;
create policy profiles_select_self_or_admin
  on public.profiles for select
  to authenticated
  using (auth.uid() = id or public.is_admin());

drop policy if exists profiles_insert_self_or_admin on public.profiles;
create policy profiles_insert_self_or_admin
  on public.profiles for insert
  to authenticated
  with check (auth.uid() = id or public.is_admin());

drop policy if exists profiles_update_self_or_admin on public.profiles;
create policy profiles_update_self_or_admin
  on public.profiles for update
  to authenticated
  using (auth.uid() = id or public.is_admin())
  with check (auth.uid() = id or public.is_admin());

drop policy if exists plans_read_authenticated on public.plans;
create policy plans_read_authenticated
  on public.plans for select
  to authenticated
  using (is_active = true or public.is_admin());

drop policy if exists plans_admin_write on public.plans;
create policy plans_admin_write
  on public.plans for all
  to authenticated
  using (public.is_admin())
  with check (public.is_admin());

drop policy if exists memberships_select_self_or_admin on public.memberships;
create policy memberships_select_self_or_admin
  on public.memberships for select
  to authenticated
  using (auth.uid() = user_id or public.is_admin());

drop policy if exists memberships_admin_write on public.memberships;
create policy memberships_admin_write
  on public.memberships for all
  to authenticated
  using (public.is_admin())
  with check (public.is_admin());

drop policy if exists subscriptions_select_self_or_admin on public.subscriptions;
create policy subscriptions_select_self_or_admin
  on public.subscriptions for select
  to authenticated
  using (auth.uid() = user_id or public.is_admin());

drop policy if exists subscriptions_admin_write on public.subscriptions;
create policy subscriptions_admin_write
  on public.subscriptions for all
  to authenticated
  using (public.is_admin())
  with check (public.is_admin());

drop policy if exists invoices_select_self_or_admin on public.invoices;
create policy invoices_select_self_or_admin
  on public.invoices for select
  to authenticated
  using (auth.uid() = user_id or public.is_admin());

drop policy if exists invoices_admin_write on public.invoices;
create policy invoices_admin_write
  on public.invoices for all
  to authenticated
  using (public.is_admin())
  with check (public.is_admin());

drop policy if exists payments_select_self_or_admin on public.payments;
create policy payments_select_self_or_admin
  on public.payments for select
  to authenticated
  using (auth.uid() = user_id or public.is_admin());

drop policy if exists payments_admin_write on public.payments;
create policy payments_admin_write
  on public.payments for all
  to authenticated
  using (public.is_admin())
  with check (public.is_admin());

drop policy if exists payment_events_admin_read on public.payment_events;
create policy payment_events_admin_read
  on public.payment_events for select
  to authenticated
  using (public.is_admin());

drop policy if exists payment_events_admin_write on public.payment_events;
create policy payment_events_admin_write
  on public.payment_events for all
  to authenticated
  using (public.is_admin())
  with check (public.is_admin());

drop policy if exists devices_select_self_or_admin on public.devices;
create policy devices_select_self_or_admin
  on public.devices for select
  to authenticated
  using (auth.uid() = user_id or public.is_admin());

drop policy if exists devices_insert_self_or_admin on public.devices;
create policy devices_insert_self_or_admin
  on public.devices for insert
  to authenticated
  with check (auth.uid() = user_id or public.is_admin());

drop policy if exists devices_update_self_or_admin on public.devices;
create policy devices_update_self_or_admin
  on public.devices for update
  to authenticated
  using (auth.uid() = user_id or public.is_admin())
  with check (auth.uid() = user_id or public.is_admin());

drop policy if exists entitlement_select_self_or_admin on public.entitlement_snapshots;
create policy entitlement_select_self_or_admin
  on public.entitlement_snapshots for select
  to authenticated
  using (auth.uid() = user_id or public.is_admin());

drop policy if exists entitlement_admin_write on public.entitlement_snapshots;
create policy entitlement_admin_write
  on public.entitlement_snapshots for all
  to authenticated
  using (public.is_admin())
  with check (public.is_admin());

drop policy if exists audit_logs_admin_read on public.audit_logs;
create policy audit_logs_admin_read
  on public.audit_logs for select
  to authenticated
  using (public.is_admin());

comment on table public.profiles is 'Auth profile mirror and app role authority.';
comment on table public.memberships is 'Current membership snapshot for each user.';
comment on table public.payment_events is 'Webhook ingestion ledger with idempotency key.';
comment on table public.entitlement_snapshots is 'Signed offline entitlement snapshots for desktop app.';
