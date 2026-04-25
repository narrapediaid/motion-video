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
- `POST /render/authorize` (server-side render gate: issue job ticket)
- `POST /render/sync` (sinkron status job render per user)
- `GET /render/summary` (total proyek selesai per user)
- `GET /health`

Rute callback provider:
- `POST /webhook` (dipanggil Sakurupiah server-to-server, diverifikasi dengan `X-Callback-Signature`)

Base URL yang harus diisi ke env desktop publik:

```dotenv
SUBSCRIPTION_BACKEND_URL=https://YOUR_PROJECT.functions.supabase.co/functions/v1/subscription-api
```

Env tambahan backend (disarankan untuk hardening render gate):

```dotenv
RENDER_GATE_SECRET=long_random_secret
RENDER_GATE_ENFORCE=true
RENDER_TICKET_TTL_SECONDS=120
```

## Deploy Steps

1. Export env deploy (PowerShell):

```powershell
$env:SUPABASE_PROJECT_REF="your_project_ref"
$env:SUPABASE_ACCESS_TOKEN="your_pat"
$env:SUPABASE_DB_PASSWORD="your_db_password"
$env:SAKURUPIAH_API_ID="your_sakurupiah_api_id"
$env:SAKURUPIAH_API_KEY="your_sakurupiah_api_key"
$env:SAKURUPIAH_CALLBACK_URL="https://YOUR_PROJECT.functions.supabase.co/functions/v1/subscription-api/webhook"
$env:SAKURUPIAH_IS_PRODUCTION="true"
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
{"ok":true,"service":"subscription-api","paymentProvider":"sakurupiah","mode":"production"}
```

## Public Desktop Env Policy

Yang boleh ada di app publik:
- `SUPABASE_URL`
- `SUPABASE_ANON_KEY` / `SUPABASE_PUBLISHABLE_KEY`
- `SUBSCRIPTION_BACKEND_URL`

Yang tidak boleh ada di app publik:
- `SUPABASE_SERVICE_ROLE_KEY`
- `SAKURUPIAH_API_ID`
- `SAKURUPIAH_API_KEY`
- `SUPABASE_ACCESS_TOKEN`
- `SUPABASE_DB_PASSWORD`
- `RENDER_GATE_SECRET`

## Key Rotation Runbook

Lakukan segera setelah backend publik aktif.

1. Generate key baru di provider:
- Supabase: rotate `service_role` key.
- Sakurupiah: rotate `api key`.

2. Update secrets backend:
- Set key baru via `supabase secrets set`.
- Redeploy function `subscription-api`.

3. Revoke key lama.

4. Validasi pasca-rotasi:
- Checkout berhasil membuat invoice.
- Verify payment memproses status dari Sakurupiah.
- Webhook Sakurupiah diterima dengan signature valid.
- Membership status berubah sesuai hasil pembayaran.

5. Audit akhir:
- Pastikan artefak distribusi tidak mengandung `.env`.
- Jalankan secret scan pada repo dan artefak build.
