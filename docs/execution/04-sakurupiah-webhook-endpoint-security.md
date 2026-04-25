# Dokumen 4: Sakurupiah Callback Endpoint Security

## Endpoint
- `POST /subscription/webhook`
- Handler aktif: `supabase/functions/subscription-api/index.ts` atau VPS `scripts/batch-ui.mjs`.

## Controls
- Wajib verifikasi `X-Callback-Signature = HMAC-SHA256(raw body, SAKURUPIAH_API_KEY)`.
- Wajib `X-Callback-Event: payment_status`.
- Idempotency tersimpan di `payment_events.idempotency_key`.
- Payload mentah disimpan di `payment_events.payload` dan `payments.raw_payload`.

## Failure Handling
- Signature invalid -> 401.
- Event tidak dikenal -> 400.
- Invoice belum ditemukan -> event ditandai ignored.
- Error processor -> tercatat di `webhook_retry_logs`.
