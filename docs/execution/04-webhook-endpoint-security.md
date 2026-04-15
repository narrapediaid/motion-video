# Dokumen 4: Webhook Endpoint Security Hardening

## 1) Tujuan
Dokumen ini mendetailkan hardening endpoint webhook Midtrans untuk mencegah pemalsuan request, replay attack, pemrosesan ganda, dan kegagalan observability.

Implementasi baseline terkait:
- [supabase/functions/midtrans-webhook/index.ts](supabase/functions/midtrans-webhook/index.ts)
- [supabase/migrations/20260414000002_midtrans_webhook.sql](supabase/migrations/20260414000002_midtrans_webhook.sql)

## 2) Threat Model Ringkas
Ancaman utama:
- Signature spoofing: request palsu menyerupai Midtrans.
- Replay attack: payload valid dikirim ulang berkali-kali.
- Duplicate delivery: notifikasi sah dikirim berulang oleh provider.
- Out-of-order event: event status lebih lama datang belakangan.
- Burst traffic: lonjakan request menyebabkan timeout/partial failure.
- Silent failure: event gagal tapi tidak termonitor.

## 3) Security Controls Wajib
### 3.1 Signature Verification
- Wajib verifikasi signature Midtrans (SHA512 order_id + status_code + gross_amount + server_key).
- Tolak request jika signature invalid dengan HTTP 401.
- Jangan lanjut ke SQL processor sebelum signature valid.

### 3.2 Idempotency Guard
- Bentuk idempotency key dari field stabil payload.
- Simpan di payment_events.idempotency_key (unique).
- Duplicate key wajib diperlakukan sebagai no-op dan return sukses operasional.

### 3.3 Replay Protection Window
- Tambahkan validasi umur event berbasis transaction_time/settlement_time.
- Rekomendasi:
  - Soft reject jika event lebih tua dari 7 hari dan status sudah final.
  - Tetap simpan event untuk audit dengan process_result = ignored.

### 3.4 Principle of Least Privilege
- Endpoint function hanya menerima POST.
- RLS tetap aktif untuk tabel observability.
- Secret disimpan di Supabase project secrets, bukan hardcoded file.

### 3.5 Payload Validation Minimum
Wajib ada:
- order_id
- status_code
- gross_amount
- signature_key

Opsional tapi direkomendasikan:
- transaction_id
- transaction_status
- fraud_status
- transaction_time

## 4) Retry Policy
### 4.1 Retry dari Midtrans (Provider-side)
- Endpoint harus selalu return response deterministik dan cepat.
- Untuk duplicate: tetap 200 agar provider berhenti retry.

### 4.2 Retry Internal (System-side)
- Jika SQL processor error, catat ke webhook_retry_logs.
- Jalankan worker reconcile berkala untuk retry idempotent.

Backoff yang direkomendasikan:
- attempt 1: immediate
- attempt 2: +30 detik
- attempt 3: +2 menit
- attempt 4: +10 menit
- setelah itu: masuk dead-letter queue

## 5) Dead-Letter Contract
Dead-letter dipakai untuk event yang gagal diproses berulang kali.

Kontrak minimal record DLQ:
- idempotency_key
- payload_raw
- reason_code
- error_message
- failed_attempts
- first_seen_at
- last_attempt_at
- next_action (manual_review atau auto_reconcile)

Reason code standar:
- signature_invalid
- invoice_not_found
- db_timeout
- state_conflict
- unknown_error

## 6) Audit & Observability
### 6.1 Wajib dicatat
- payment_events: semua event masuk.
- audit_logs: semua mutasi state sukses.
- webhook_retry_logs: semua kegagalan pemrosesan.

### 6.2 Metrics yang dipantau
- webhook_requests_total
- webhook_signature_invalid_total
- webhook_duplicate_total
- webhook_applied_total
- webhook_failed_total
- webhook_p95_latency_ms
- dlq_size

### 6.3 Alert rekomendasi
- failed_total > threshold 5 menit.
- signature_invalid melonjak signifikan.
- p95 latency > 2 detik konsisten.
- dlq_size bertambah terus selama > 15 menit.

## 7) Hardening Checklist Implementasi
1. Signature check dilakukan sebelum RPC call.
2. Idempotency unique constraint aktif dan tervalidasi.
3. Event duplicate diproses no-op.
4. Error path menulis retry logs.
5. Tidak ada secret di source code dan dokumen publik.
6. Endpoint menolak method non-POST.
7. Monitoring metric + alert terpasang.
8. Jalur DLQ tersedia untuk manual intervention.

## 8) Acceptance Criteria Doc 4
1. Request dengan signature salah tidak mengubah state apa pun.
2. Replay payload valid tidak menyebabkan mutasi ganda.
3. Kegagalan SQL tidak hilang, selalu tercatat di retry logs.
4. Event gagal berkali-kali dapat dipindah ke DLQ dengan reason jelas.
5. Waktu respons endpoint stabil pada skenario beban normal.

## 9) Action Items Teknis Lanjutan
- Tambah tabel khusus dead_letter_events (jika dipilih DB-based DLQ).
- Tambah scheduled function untuk retry reconcile otomatis.
- Tambah state precedence checker SQL untuk out-of-order hard guard.
- Tambah integration test security di pipeline CI.
