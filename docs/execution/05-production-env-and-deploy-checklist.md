# Dokumen 5: Production Env & Deploy Checklist

## 1) Tujuan
Dokumen ini menjadi checklist operasional sebelum dan saat deploy migration + function ke Supabase project production.

## 2) Environment Variables Wajib
### Project-level
- SUPABASE_PROJECT_REF
- SUPABASE_URL
- SUPABASE_ACCESS_TOKEN (PAT)
- SUPABASE_DB_PASSWORD

### Function-level (Secrets)
- SUPABASE_URL
- SUPABASE_SERVICE_ROLE_KEY
- MIDTRANS_SERVER_KEY

### Client-level (Public)
- VITE_SUPABASE_URL
- VITE_SUPABASE_ANON_KEY

## 3) File Konfigurasi Workspace
- [supabase/config.toml](supabase/config.toml)
- [.env](.env) (lokal, ignored)
- [.env.example](.env.example)
- [supabase/functions/.env](supabase/functions/.env) (lokal, ignored)
- [supabase/functions/.env.example](supabase/functions/.env.example)
- [scripts/supabase-deploy.ps1](scripts/supabase-deploy.ps1)

## 4) Pre-Deploy Checklist
1. PAT aktif dan memiliki akses ke project target.
2. DB password project valid.
3. MIDTRANS_SERVER_KEY production sudah tersedia.
4. Semua migration SQL sudah final dan direview.
5. Edge function lint/type-check lulus.
6. Tidak ada secret di file yang di-track git.
7. Backup/snapshot database sebelum migrasi major.

## 5) Deploy Sequence (Recommended)
1. Link project remote.
2. Push migration DB.
3. Set function secrets.
4. Deploy function midtrans-webhook.
5. Smoke test webhook endpoint.
6. Verifikasi tabel event/audit.

## 6) Smoke Test Minimal Setelah Deploy
1. Kirim payload signature invalid -> harus 401.
2. Kirim payload valid pending -> event tercatat.
3. Kirim payload settlement -> invoice paid + membership active.
4. Kirim payload duplikat -> no-op.
5. Cek audit_logs dan payment_events.

## 7) Rollback Strategy Ringkas
- Jika function bermasalah: redeploy versi terakhir stabil.
- Jika migration bermasalah:
  - hentikan webhook traffic sementara,
  - jalankan script mitigasi SQL terkontrol,
  - lakukan reconcile data dari payment_events.

## 8) Kepemilikan Operasional
- Owner backend: migration + SQL processor.
- Owner platform/ops: secret management + deploy execution.
- Owner QA: scenario matrix verification.
