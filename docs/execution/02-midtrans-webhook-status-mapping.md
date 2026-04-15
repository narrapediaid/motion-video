# Dokumen 2: Midtrans Webhook + Status Mapping Membership

## 1) Tujuan
Dokumen ini mendefinisikan implementasi webhook Midtrans yang aman, idempotent, dan deterministik untuk sinkronisasi status pembayaran ke invoice, payment, dan membership.

Implementasi teknis ada di:
- `supabase/migrations/20260414000002_midtrans_webhook.sql`
- `supabase/functions/midtrans-webhook/index.ts`

## 2) Komponen
- Edge Function endpoint:
  - `supabase/functions/midtrans-webhook/index.ts`
  - Tugas: verifikasi signature Midtrans, buat idempotency key, panggil RPC SQL processor.
- SQL RPC processor:
  - `public.process_midtrans_webhook(p_payload jsonb, p_idempotency_key text)`
  - Tugas: simpan event, cegah duplikasi, mutasi invoice/payment/membership, tulis audit.
- Retry observability:
  - `public.webhook_retry_logs`

## 3) Endpoint Contract
- Method: POST.
- Body: payload notifikasi Midtrans (JSON).
- Field minimum wajib:
  - `order_id`
  - `status_code`
  - `gross_amount`
  - `signature_key`

Response standar:
- `200`: event valid dan diproses (atau duplicate tetapi acknowledged).
- `400`: payload tidak valid.
- `401`: signature tidak valid.
- `500`: error internal processing.

## 4) Signature Verification
Rumus signature Midtrans:
- SHA512(`order_id + status_code + gross_amount + server_key`)

Implementasi:
- Edge function membentuk signature base string.
- Menghitung SHA-512 hex digest.
- Membandingkan dengan `signature_key` dari payload menggunakan timing-safe compare.

Jika mismatch:
- Request ditolak (`401 Invalid signature`).
- Tidak ada mutasi ke tabel billing/membership.

## 5) Idempotency Strategy
Karena Midtrans bisa mengirim notifikasi berulang, idempotency key dibentuk dari field stabil:
- `order_id|transaction_id|transaction_status|status_code|gross_amount|fraud_status`
- Di-hash SHA-256 menjadi `idempotency_key`.

Aturan proses:
- Insert ke `payment_events` dengan unique key `idempotency_key`.
- Jika konflik unique: event dianggap duplicate, return status duplicate, tanpa mutasi ulang.

## 6) Mapping Status Midtrans -> Payment
Didefinisikan fungsi:
- `public.midtrans_payment_status(transaction_status, fraud_status)`

Mapping inti:
- settlement -> settlement
- capture + challenge -> pending
- capture + accept -> capture
- pending -> pending
- deny -> deny
- cancel -> cancel
- expire -> expire
- refund -> refund
- partial_refund -> partial_refund
- chargeback -> chargeback
- partial_chargeback -> partial_chargeback
- selain itu -> failure

## 7) Mapping Status Midtrans -> Membership
Didefinisikan fungsi:
- `public.midtrans_membership_status(transaction_status, current_status)`

Mapping inti:
- settlement/capture -> active
- pending -> pending_payment
- cancel -> canceled
- expire -> expired
- deny/refund/chargeback/partial_chargeback -> suspended
- Jika `current_status = lifetime_active`: tetap lifetime_active (tidak downgrade)

## 8) Urutan Proses Webhook
Urutan dalam `process_midtrans_webhook`:
1. Validasi input + insert `payment_events` (guard idempotency).
2. Lock invoice by `external_order_id` (`FOR UPDATE`).
3. Upsert ke `payments` berdasarkan `external_transaction_id`.
4. Update status `invoices` berdasarkan mapping payment status.
5. Update status `memberships` berdasarkan mapping membership status.
6. Update `payment_events.process_result = applied`.
7. Tulis jejak ke `audit_logs`.
8. Jika error: tandai event gagal + simpan ke `webhook_retry_logs`.

## 9) Security & Access
- Edge function wajib jalan pakai service role key.
- Tabel `webhook_retry_logs` hanya bisa dibaca admin via RLS.
- User biasa tidak punya akses langsung ke mutation webhook tables.
- Signature verification dilakukan sebelum RPC dipanggil.

## 10) Acceptance Criteria (Doc 2)
Checklist lulus:
1. Webhook valid memutakhirkan invoice/payment/membership secara konsisten.
2. Payload duplicate tidak menyebabkan mutasi ganda.
3. Payload dengan signature salah selalu ditolak.
4. Error SQL tercatat di `webhook_retry_logs`.
5. `payment_events` menyimpan jejak lengkap event + hasil proses.
6. Invoice yang tidak ditemukan tidak merusak state data lain.

## 11) Runbook Uji Coba
1. Deploy migration kedua.
2. Deploy edge function Midtrans webhook.
3. Set secret environment:
   - `SUPABASE_URL`
   - `SUPABASE_SERVICE_ROLE_KEY`
   - `MIDTRANS_SERVER_KEY`
4. Kirim payload simulasi Midtrans:
   - skenario pending
   - settlement
   - cancel/expire
   - duplicate payload
5. Verifikasi state tabel:
   - `payment_events`
   - `payments`
   - `invoices`
   - `memberships`
   - `audit_logs`

## 12) Risiko & Mitigasi
- Risiko: field payload Midtrans berubah antar channel pembayaran.
  Mitigasi: simpan `raw_payload` penuh dan validasi kontrak minimal saja di edge.
- Risiko: duplicate event tidak memiliki `transaction_id`.
  Mitigasi: idempotency key memakai kombinasi beberapa field, bukan satu field tunggal.
- Risiko: invoice belum dibuat saat webhook datang lebih awal.
  Mitigasi: tandai `ignored/invoice_not_found`, jalankan reconciliation job periodik.
