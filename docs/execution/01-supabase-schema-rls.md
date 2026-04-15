# Dokumen 1: Supabase Schema + RLS (Fondasi Data & Security)

## 1) Tujuan
Dokumen ini menetapkan fondasi data untuk desktop app berbayar berbasis membership.
Ruang lingkup dokumen ini:
- Desain tabel inti membership, billing, device, entitlement, dan audit.
- Relasi PK/FK dan indeks performa.
- RLS policy per role: user, admin, system.
- Acceptance criteria verifikasi keamanan akses data.

Implementasi SQL ada di:
- `supabase/migrations/20260414000001_membership_core.sql`

## 2) Entitas Inti
Entitas utama yang dibangun:
- `profiles`: mirror data user dari `auth.users` + `app_role`.
- `plans`: katalog plan (monthly/yearly/lifetime).
- `memberships`: snapshot membership aktif per user.
- `subscriptions`: data langganan periodik provider.
- `invoices`: invoice/order pembayaran.
- `payments`: transaksi pembayaran aktual.
- `payment_events`: ledger event webhook + idempotency key.
- `devices`: registrasi device aktif user.
- `entitlement_snapshots`: token signed untuk offline entitlement.
- `audit_logs`: jejak audit perubahan sistem.

## 3) Enum Kontrak Status
Enum yang dipakai sebagai kontrak lintas layanan:
- `membership_tier`: monthly, yearly, lifetime.
- `membership_status`: pending_payment, active, grace_period, expired, suspended, canceled, lifetime_active.
- `subscription_status`: trialing, active, past_due, canceled, incomplete, incomplete_expired.
- `invoice_status`: draft, open, paid, void, uncollectible, expired.
- `payment_status`: pending, settlement, capture, deny, cancel, expire, refund, partial_refund, chargeback, partial_chargeback, failure.
- `device_status`: active, revoked.
- `provider_name`: midtrans.

## 4) Relasi Data Utama
- `profiles.id` -> FK ke `auth.users.id` (cascade delete).
- `memberships.user_id` -> `profiles.id` (unique per user, snapshot tunggal).
- `memberships.plan_id` -> `plans.id`.
- `subscriptions.membership_id` -> `memberships.id` (unique).
- `invoices.user_id` -> `profiles.id`.
- `invoices.membership_id` -> `memberships.id`.
- `payments.invoice_id` -> `invoices.id`.
- `payments.user_id` -> `profiles.id`.
- `devices.user_id` -> `profiles.id`.
- `entitlement_snapshots.user_id` -> `profiles.id`.
- `entitlement_snapshots.membership_id` -> `memberships.id`.

## 5) RLS Matrix
### User (authenticated)
- Bisa baca/update profil sendiri.
- Bisa baca plan aktif.
- Bisa baca membership/subscription/invoice/payment/device/entitlement milik sendiri.
- Bisa insert/update device milik sendiri.
- Tidak bisa write data billing kritikal (invoice/payment/membership) kecuali melalui service flow.

### Admin (`profiles.app_role = 'admin'`)
- Baca/tulis penuh di tabel operasional (`plans`, `memberships`, `subscriptions`, `invoices`, `payments`, `payment_events`, `entitlement_snapshots`).
- Baca log (`audit_logs`, `webhook_retry_logs` di Dokumen 2).

### System (service role)
- Menjalankan webhook, mutation billing, dan sinkronisasi entitlement melalui service key.
- Service role Supabase bypass RLS, tetapi seluruh mutasi penting tetap diaudit di `audit_logs`.

## 6) Fungsi Sistem Penting
- `public.set_updated_at()`: trigger helper untuk konsistensi `updated_at`.
- `public.is_admin()`: helper policy evaluator (security definer).
- `public.handle_new_auth_user()`: auto-mirror user baru dari `auth.users` ke `profiles`.

## 7) Indexing & Performa
Index yang disiapkan untuk query kritikal:
- Membership lookup: `idx_memberships_user_status`.
- Invoice lookup: `idx_invoices_user_status`, `idx_invoices_external_order`.
- Payment lookup: `idx_payments_invoice_status`, `idx_payments_external_transaction`.
- Event stream lookup: `idx_payment_events_order`, `idx_payment_events_received_at`.
- Entitlement lookup: `idx_entitlement_user_expires`.
- Audit observability: `idx_audit_logs_entity`, `idx_audit_logs_created_at`.

## 8) Kebijakan Data Lifecycle
- `memberships` disimpan sebagai snapshot status terkini user.
- `payment_events` dipakai sebagai immutable-ish ingestion ledger (hasil proses tercatat di `process_result`).
- `entitlement_snapshots` mendukung mode hybrid offline (token bertanda tangan + TTL).
- `audit_logs` menyimpan perubahan state penting untuk compliance dan forensik.

## 9) Acceptance Criteria (Doc 1)
Checklist lulus review:
1. User A tidak bisa membaca data User B pada semua tabel personal.
2. Admin bisa melakukan manajemen plan dan membership lintas user.
3. Event webhook tersimpan dengan idempotency key unik.
4. Trigger `on_auth_user_created` membuat profile otomatis saat user baru register.
5. Seluruh tabel dengan kolom `updated_at` ter-update otomatis via trigger.
6. Query dashboard user tetap cepat pada skala 100k user (berkat indeks inti).

## 10) Langkah Deploy
1. Jalankan migration pertama:
   - `supabase db push` atau mekanisme migration pipeline internal.
2. Verifikasi tabel + enum + policy terbuat:
   - Cek di Supabase SQL editor atau migration logs.
3. Jalankan smoke test RLS:
   - Akses user-self vs cross-user.
   - Akses admin.
   - Akses service role dari edge function.

## 11) Risiko & Mitigasi
- Risiko: role admin tidak terset pada `profiles` setelah onboarding.
  Mitigasi: sediakan admin bootstrap script one-time.
- Risiko: policy terlalu ketat dan memblokir flow onboarding.
  Mitigasi: jalankan test matrix role-based sebelum production cutover.
- Risiko: masa aktif membership periodik butuh perhitungan siklus lebih presisi.
  Mitigasi: finalisasi aturan periode di webhook processor (Dokumen 2).
