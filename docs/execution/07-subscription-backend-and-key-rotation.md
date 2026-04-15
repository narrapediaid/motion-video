# 07 - Public Subscription Backend and Key Rotation

Dokumen ini melengkapi hardening publik agar desktop app tidak menjalankan proses sensitif secara lokal.

## Tujuan

1. Pisahkan endpoint sensitif pembayaran ke backend (`subscription-api`).
2. Pastikan desktop publik hanya memakai key publik.
3. Rotasi semua server key lama yang sempat dipakai di mesin lokal/internal.

## Endpoint Backend

Function: `subscription-api`

Rute yang dipakai desktop app:
- `POST /checkout`
- `POST /verify-payment`
- `POST /voucher/validate`
- `POST /render/sync` (sinkron status job render per user)
- `GET /render/summary` (total proyek selesai per user)
- `GET /health`

Rute callback provider:
- `POST /webhook` (dipanggil Midtrans server-to-server, diverifikasi dengan signature Midtrans)

Base URL yang harus diisi ke env desktop publik:

```dotenv
SUBSCRIPTION_BACKEND_URL=https://YOUR_PROJECT.functions.supabase.co/functions/v1/subscription-api
```

## Deploy Steps

1. Export env deploy (PowerShell):

```powershell
$env:SUPABASE_PROJECT_REF="your_project_ref"
$env:SUPABASE_ACCESS_TOKEN="your_pat"
$env:SUPABASE_DB_PASSWORD="your_db_password"
$env:MIDTRANS_SERVER_KEY="your_midtrans_server_key"
$env:MIDTRANS_CLIENT_KEY="your_midtrans_client_key"
$env:MIDTRANS_IS_PRODUCTION="true"
```

2. Deploy migration + function:

```powershell
powershell -ExecutionPolicy Bypass -File scripts/supabase-deploy.ps1
```

3. Health check:

```console
curl https://YOUR_PROJECT.functions.supabase.co/functions/v1/subscription-api/health
```

Expected response:

```json
{"ok":true,"service":"subscription-api","mode":"production"}
```

## Public Desktop Env Policy

Yang boleh ada di app publik:
- `SUPABASE_URL`
- `SUPABASE_ANON_KEY` / `SUPABASE_PUBLISHABLE_KEY`
- `MIDTRANS_CLIENT_KEY`
- `MIDTRANS_IS_PRODUCTION`
- `SUBSCRIPTION_BACKEND_URL`

Yang tidak boleh ada di app publik:
- `SUPABASE_SERVICE_ROLE_KEY`
- `MIDTRANS_SERVER_KEY`
- `SUPABASE_ACCESS_TOKEN`
- `SUPABASE_DB_PASSWORD`

## Key Rotation Runbook

Lakukan segera setelah backend publik aktif.

1. Generate key baru di provider:
- Supabase: rotate `service_role` key.
- Midtrans: rotate `server key`.

2. Update secrets backend:
- Set key baru via `supabase secrets set`.
- Redeploy function (`midtrans-webhook` dan `subscription-api`).

3. Revoke key lama.

4. Validasi pasca-rotasi:
- Checkout berhasil membuat invoice.
- Verify payment memproses status dari Midtrans.
- Webhook Midtrans diterima dengan signature valid.
- Membership status berubah sesuai hasil pembayaran.

5. Audit akhir:
- Pastikan artefak distribusi tidak mengandung `.env`.
- Jalankan secret scan pada repo dan artefak build.
