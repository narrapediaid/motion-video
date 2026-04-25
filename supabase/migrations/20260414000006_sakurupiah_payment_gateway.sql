-- Sakurupiah payment processor + status mapping
-- Depends on: membership core, webhook retry log baseline, voucher system, Sakurupiah provider enum

create or replace function public.sakurupiah_payment_status(
  p_status text,
  p_status_kode integer default null
)
returns public.payment_status
language plpgsql
immutable
as $$
declare
  v_status text := lower(coalesce(p_status, 'pending'));
  v_status_kode integer := coalesce(p_status_kode, -1);
begin
  if v_status = 'berhasil' or v_status_kode = 1 then
    return 'settlement';
  end if;

  if v_status = 'expired' or v_status_kode = 2 then
    return 'expire';
  end if;

  if v_status = 'pending' or v_status_kode = 0 then
    return 'pending';
  end if;

  return 'failure';
end;
$$;

create or replace function public.sakurupiah_membership_status(
  p_status text,
  p_status_kode integer default null,
  p_current_status public.membership_status default 'pending_payment'
)
returns public.membership_status
language plpgsql
immutable
as $$
declare
  v_payment_status public.payment_status := public.sakurupiah_payment_status(p_status, p_status_kode);
begin
  if coalesce(p_current_status, 'pending_payment') = 'lifetime_active' then
    return 'lifetime_active';
  end if;

  if v_payment_status = 'settlement' then
    return 'active';
  end if;

  if v_payment_status = 'pending' then
    return 'pending_payment';
  end if;

  if v_payment_status = 'expire' then
    return 'expired';
  end if;

  return coalesce(p_current_status, 'pending_payment');
end;
$$;

create or replace function public.process_sakurupiah_callback(
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
  v_status text;
  v_status_kode integer;
  v_event_type text;
  v_invoice public.invoices%rowtype;
  v_membership public.memberships%rowtype;
  v_plan public.plans%rowtype;
  v_payment_status public.payment_status;
  v_invoice_status public.invoice_status;
  v_membership_status public.membership_status;
  v_now timestamptz := now();
  v_is_paid boolean := false;
  v_is_duplicate boolean := false;
  v_months integer := 1;
  v_is_lifetime boolean := false;
begin
  if p_idempotency_key is null or length(trim(p_idempotency_key)) = 0 then
    raise exception 'p_idempotency_key is required';
  end if;

  v_order_id := p_payload ->> 'merchant_ref';
  v_transaction_id := p_payload ->> 'trx_id';
  v_status := lower(coalesce(p_payload ->> 'status', 'pending'));
  v_status_kode := nullif(p_payload ->> 'status_kode', '')::integer;
  v_event_type := coalesce(p_payload ->> 'event', 'payment_status');

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
    'sakurupiah',
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
      set process_result = 'ignored',
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

  v_payment_status := public.sakurupiah_payment_status(v_status, v_status_kode);
  v_is_paid := v_payment_status = 'settlement';
  v_invoice_status := case
    when v_payment_status = 'settlement' then 'paid'::public.invoice_status
    when v_payment_status = 'expire' then 'expired'::public.invoice_status
    when v_payment_status = 'failure' then 'expired'::public.invoice_status
    else 'open'::public.invoice_status
  end;

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
    'sakurupiah',
    nullif(v_transaction_id, ''),
    coalesce(p_payload ->> 'payment_kode', p_payload ->> 'method'),
    coalesce(p_payload ->> 'via', p_payload ->> 'payment_kode', p_payload ->> 'method'),
    coalesce(
      nullif(p_payload ->> 'amount', '')::bigint,
      nullif(p_payload ->> 'total', '')::bigint,
      v_invoice.amount_idr
    ),
    v_payment_status,
    coalesce(nullif(p_payload ->> 'transaction_time', '')::timestamptz, v_now),
    case when v_is_paid then coalesce(nullif(p_payload ->> 'settlement_time', '')::timestamptz, v_now) else null end,
    null,
    p_payload
  )
  on conflict (external_transaction_id) do update
  set
    status = excluded.status,
    payment_method = excluded.payment_method,
    payment_channel = excluded.payment_channel,
    settlement_time = excluded.settlement_time,
    raw_payload = excluded.raw_payload,
    updated_at = now();

  update public.invoices
    set status = v_invoice_status,
        paid_at = case when v_is_paid then coalesce(v_invoice.paid_at, v_now) else v_invoice.paid_at end,
        expires_at = case when v_invoice_status = 'expired' then coalesce(v_invoice.expires_at, v_now) else v_invoice.expires_at end,
        raw_payload = coalesce(v_invoice.raw_payload, '{}'::jsonb) || jsonb_build_object(
          'sakurupiah_callback',
          p_payload
        ),
        updated_at = now()
  where id = v_invoice.id;

  update public.voucher_redemptions
    set status = case
          when v_is_paid then 'applied'::public.voucher_redemption_status
          when v_invoice_status in ('expired', 'void', 'uncollectible') then 'released'::public.voucher_redemption_status
          else status
        end,
        updated_at = now()
  where invoice_id = v_invoice.id
    and (
      (v_is_paid and status <> 'applied')
      or (v_invoice_status in ('expired', 'void', 'uncollectible') and status = 'reserved')
    );

  if v_invoice.membership_id is not null then
    select *
    into v_membership
    from public.memberships
    where id = v_invoice.membership_id
    for update;

    if found then
      v_membership_status := public.sakurupiah_membership_status(
        v_status,
        v_status_kode,
        v_membership.status
      );

      if v_membership.plan_id is not null then
        select *
        into v_plan
        from public.plans
        where id = v_membership.plan_id;

        if found then
          v_months := case
            when v_plan.tier = 'lifetime' then 0
            when v_plan.billing_cycle_months is not null and v_plan.billing_cycle_months >= 0 then v_plan.billing_cycle_months
            else 1
          end;
          v_is_lifetime := v_plan.tier = 'lifetime' or v_months = 0;
        end if;
      end if;

      update public.memberships
        set status = case
              when v_membership_status = 'active' and v_is_lifetime then 'lifetime_active'::public.membership_status
              else v_membership_status
            end,
            starts_at = case
              when v_membership_status = 'active' and starts_at is null then v_now
              else starts_at
            end,
            ends_at = case
              when v_membership_status = 'active' and v_is_lifetime then null
              when v_membership_status = 'active' then coalesce(v_membership.ends_at, v_now + make_interval(months => greatest(v_months, 1)))
              when v_membership_status = 'expired' then coalesce(v_membership.ends_at, v_now)
              else ends_at
            end,
            grace_ends_at = case
              when v_membership_status = 'active' and v_is_lifetime then null
              else grace_ends_at
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
    'sakurupiah_callback_applied',
    jsonb_build_object(
      'idempotency_key', p_idempotency_key,
      'order_id', v_order_id,
      'transaction_id', v_transaction_id,
      'status', v_status,
      'status_kode', v_status_kode,
      'payment_status', v_payment_status
    )
  );

  return jsonb_build_object(
    'status', 'applied',
    'duplicate', v_is_duplicate,
    'idempotency_key', p_idempotency_key,
    'order_id', v_order_id,
    'transaction_id', v_transaction_id,
    'invoice_id', v_invoice.id,
    'payment_status', v_payment_status,
    'invoice_status', v_invoice_status
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

comment on function public.process_sakurupiah_callback(jsonb, text)
  is 'Consumes Sakurupiah callback/status payload with idempotency guard and mutates invoice/payment/membership state.';
