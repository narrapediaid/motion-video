# Dokumen 2: Sakurupiah Callback + Status Mapping Membership

Callback Sakurupiah diproses oleh `subscription-api` route `POST /webhook`.

## Security
- Header wajib: `Content-Type: application/json`, `X-Callback-Event: payment_status`, `X-Callback-Signature`.
- Signature: `HMAC-SHA256(raw JSON body, SAKURUPIAH_API_KEY)`.
- Body minimal: `trx_id`, `merchant_ref`, `status`, `status_kode`.

## Processor
- Migration: `supabase/migrations/20260414000005_sakurupiah_provider_enum.sql` dan `supabase/migrations/20260414000006_sakurupiah_payment_gateway.sql`.
- RPC: `public.process_sakurupiah_callback(p_payload jsonb, p_idempotency_key text)`.
- Idempotency key dibentuk dari `merchant_ref|trx_id|status|status_kode|event`.

## Mapping
- `berhasil` / `1` -> payment `settlement`, invoice `paid`, membership `active` atau `lifetime_active`.
- `pending` / `0` -> payment `pending`, invoice `open`, membership `pending_payment`.
- `expired` / `2` -> payment `expire`, invoice `expired`, membership `expired`.

## Acceptance
- Signature invalid ditolak dengan 401.
- Callback valid membuat/menyinkronkan `payment_events`, `payments`, `invoices`, `memberships`, `voucher_redemptions`, dan `audit_logs`.
- Callback duplikat menjadi no-op berdasarkan idempotency key.
