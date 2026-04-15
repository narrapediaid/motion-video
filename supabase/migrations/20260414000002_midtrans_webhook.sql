-- Midtrans webhook processor + status mapping
-- Depends on: 20260414000001_membership_core.sql

create table public.webhook_retry_logs (
  id bigserial primary key,
  idempotency_key text not null,
  attempt_no integer not null default 1 check (attempt_no > 0),
  error_message text not null,
  created_at timestamptz not null default now()
);

create index idx_webhook_retry_logs_key_created
  on public.webhook_retry_logs(idempotency_key, created_at desc);

create or replace function public.midtrans_payment_status(
  p_transaction_status text,
  p_fraud_status text default null
)
returns public.payment_status
language plpgsql
immutable
as $$
declare
  v_status text := lower(coalesce(p_transaction_status, 'pending'));
  v_fraud text := lower(coalesce(p_fraud_status, 'accept'));
begin
  if v_status = 'settlement' then
    return 'settlement';
  end if;

  if v_status = 'capture' then
    if v_fraud = 'challenge' then
      return 'pending';
    end if;
    return 'capture';
  end if;

  if v_status = 'pending' then
    return 'pending';
  end if;

  if v_status = 'deny' then
    return 'deny';
  end if;

  if v_status = 'cancel' then
    return 'cancel';
  end if;

  if v_status = 'expire' then
    return 'expire';
  end if;

  if v_status = 'refund' then
    return 'refund';
  end if;

  if v_status = 'partial_refund' then
    return 'partial_refund';
  end if;

  if v_status = 'chargeback' then
    return 'chargeback';
  end if;

  if v_status = 'partial_chargeback' then
    return 'partial_chargeback';
  end if;

  return 'failure';
end;
$$;

create or replace function public.midtrans_membership_status(
  p_transaction_status text,
  p_current_status public.membership_status
)
returns public.membership_status
language plpgsql
immutable
as $$
declare
  v_status text := lower(coalesce(p_transaction_status, 'pending'));
begin
  if coalesce(p_current_status, 'pending_payment') = 'lifetime_active' then
    return 'lifetime_active';
  end if;

  if v_status in ('settlement', 'capture') then
    return 'active';
  end if;

  if v_status = 'pending' then
    return 'pending_payment';
  end if;

  if v_status = 'cancel' then
    return 'canceled';
  end if;

  if v_status = 'expire' then
    return 'expired';
  end if;

  if v_status in ('deny', 'refund', 'partial_refund', 'chargeback', 'partial_chargeback') then
    return 'suspended';
  end if;

  return coalesce(p_current_status, 'pending_payment');
end;
$$;

create or replace function public.process_midtrans_webhook(
  p_payload jsonb,
  p_idempotency_key text
)
returns jsonb
language plpgsql
security definer
set search_path = public
as $$
declare
  v_order_id text;
  v_transaction_id text;
  v_transaction_status text;
  v_fraud_status text;
  v_event_type text;
  v_invoice public.invoices%rowtype;
  v_membership public.memberships%rowtype;
  v_payment_status public.payment_status;
  v_membership_status public.membership_status;
  v_now timestamptz := now();
  v_is_duplicate boolean := false;
begin
  if p_idempotency_key is null or length(trim(p_idempotency_key)) = 0 then
    raise exception 'p_idempotency_key is required';
  end if;

  v_order_id := p_payload ->> 'order_id';
  v_transaction_id := p_payload ->> 'transaction_id';
  v_transaction_status := lower(coalesce(p_payload ->> 'transaction_status', 'pending'));
  v_fraud_status := lower(coalesce(p_payload ->> 'fraud_status', 'accept'));
  v_event_type := coalesce(p_payload ->> 'transaction_type', 'unknown');

  insert into public.payment_events (
    provider,
    idempotency_key,
    external_order_id,
    external_transaction_id,
    event_type,
    payload,
    process_result,
    received_at
  ) values (
    'midtrans',
    p_idempotency_key,
    v_order_id,
    v_transaction_id,
    v_event_type,
    p_payload,
    'pending',
    v_now
  )
  on conflict (idempotency_key) do nothing;

  if not found then
    v_is_duplicate := true;
    return jsonb_build_object(
      'status', 'duplicate',
      'idempotency_key', p_idempotency_key,
      'order_id', v_order_id
    );
  end if;

  select *
  into v_invoice
  from public.invoices
  where external_order_id = v_order_id
  for update;

  if not found then
    update public.payment_events
      set process_result = 'failed',
          error_message = 'invoice_not_found',
          processed_at = now(),
          updated_at = now()
    where idempotency_key = p_idempotency_key;

    return jsonb_build_object(
      'status', 'ignored',
      'reason', 'invoice_not_found',
      'order_id', v_order_id
    );
  end if;

  v_payment_status := public.midtrans_payment_status(v_transaction_status, v_fraud_status);

  insert into public.payments (
    invoice_id,
    user_id,
    provider,
    external_transaction_id,
    payment_method,
    payment_channel,
    gross_amount_idr,
    status,
    transaction_time,
    settlement_time,
    fraud_status,
    raw_payload
  ) values (
    v_invoice.id,
    v_invoice.user_id,
    'midtrans',
    nullif(v_transaction_id, ''),
    p_payload ->> 'payment_type',
    coalesce(p_payload ->> 'store', p_payload ->> 'channel_response_code'),
    coalesce((nullif(p_payload ->> 'gross_amount', ''))::numeric::bigint, v_invoice.amount_idr),
    v_payment_status,
    coalesce((p_payload ->> 'transaction_time')::timestamptz, v_now),
    (p_payload ->> 'settlement_time')::timestamptz,
    v_fraud_status,
    p_payload
  )
  on conflict (external_transaction_id) do update
  set
    status = excluded.status,
    settlement_time = excluded.settlement_time,
    fraud_status = excluded.fraud_status,
    raw_payload = excluded.raw_payload,
    updated_at = now();

  update public.invoices
    set status = case
      when v_payment_status in ('settlement', 'capture') then 'paid'::public.invoice_status
      when v_payment_status in ('cancel', 'expire', 'deny', 'failure') then 'expired'::public.invoice_status
      when v_payment_status in ('refund', 'partial_refund', 'chargeback', 'partial_chargeback') then 'void'::public.invoice_status
      else status
    end,
    paid_at = case
      when v_payment_status in ('settlement', 'capture') then coalesce((p_payload ->> 'settlement_time')::timestamptz, v_now)
      else paid_at
    end,
    raw_payload = p_payload,
    updated_at = now()
  where id = v_invoice.id;

  if v_invoice.membership_id is not null then
    select *
    into v_membership
    from public.memberships
    where id = v_invoice.membership_id
    for update;

    if found then
      v_membership_status := public.midtrans_membership_status(v_transaction_status, v_membership.status);

      update public.memberships
        set status = v_membership_status,
            starts_at = case
              when v_membership_status in ('active', 'lifetime_active') and starts_at is null then v_now
              else starts_at
            end,
            ends_at = case
              when v_membership_status = 'active' and v_membership.plan_id is not null then
                coalesce(v_membership.ends_at, v_now + interval '30 days')
              when v_membership_status in ('expired', 'canceled', 'suspended') then coalesce(v_membership.ends_at, v_now)
              else ends_at
            end,
            canceled_at = case
              when v_membership_status = 'canceled' then coalesce(canceled_at, v_now)
              else canceled_at
            end,
            version = version + 1,
            updated_at = now()
      where id = v_membership.id;
    end if;
  end if;

  update public.payment_events
    set process_result = 'applied',
        error_message = null,
        processed_at = now(),
        updated_at = now()
  where idempotency_key = p_idempotency_key;

  insert into public.audit_logs (
    actor_user_id,
    actor_role,
    entity_type,
    entity_id,
    action,
    after_state
  )
  values (
    null,
    'system',
    'invoice',
    v_invoice.id::text,
    'midtrans_webhook_applied',
    jsonb_build_object(
      'idempotency_key', p_idempotency_key,
      'order_id', v_order_id,
      'transaction_status', v_transaction_status,
      'payment_status', v_payment_status
    )
  );

  return jsonb_build_object(
    'status', 'applied',
    'duplicate', v_is_duplicate,
    'idempotency_key', p_idempotency_key,
    'order_id', v_order_id,
    'invoice_id', v_invoice.id,
    'payment_status', v_payment_status
  );

exception
  when others then
    update public.payment_events
      set process_result = 'failed',
          error_message = sqlerrm,
          processed_at = now(),
          updated_at = now()
    where idempotency_key = p_idempotency_key;

    insert into public.webhook_retry_logs (idempotency_key, error_message)
    values (p_idempotency_key, sqlerrm);

    raise;
end;
$$;

alter table public.webhook_retry_logs enable row level security;

drop policy if exists webhook_retry_logs_admin_read on public.webhook_retry_logs;
create policy webhook_retry_logs_admin_read
  on public.webhook_retry_logs for select
  to authenticated
  using (public.is_admin());

comment on function public.process_midtrans_webhook(jsonb, text)
  is 'Consumes Midtrans notification payload with idempotency guard and mutates invoice/payment/membership state.';
