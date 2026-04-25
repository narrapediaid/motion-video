# Remotion video

<p align="center">
  <a href="https://github.com/remotion-dev/logo">
    <picture>
      <source media="(prefers-color-scheme: dark)" srcset="https://github.com/remotion-dev/logo/raw/main/animated-logo-banner-dark.apng">
      <img alt="Animated Remotion Logo" src="https://github.com/remotion-dev/logo/raw/main/animated-logo-banner-light.gif">
    </picture>
  </a>
</p>

Welcome to your Remotion project!

## Commands

**Install Dependencies**

```console
npm i
```

**Start Preview**

```console
npm run dev
```

**Render video**

```console
npx remotion render
```

**Batch render from .tsk**

```console
npm run batch:render
```

**Quick batch test (1 item, short frames)**

```console
npm run batch:test
```

**Open batch processing UI**

```console
npm run batch:ui
```

**Run Desktop App (Electron)**

```console
npm run desktop:dev
```

**Public desktop env placement (packaged app)**

- Letakkan file `.env.public` (atau `.env.public.txt`) di salah satu lokasi ini:
  1) `%APPDATA%\Narrapedia reMotion Batch\`
  2) folder yang sama dengan file `.exe`
- Alternatif: set `BATCH_UI_ENV_FILE` ke path absolut file env.
- App juga menerima alias key `VITE_SUPABASE_URL` dan `VITE_SUPABASE_ANON_KEY`.

Catatan startup desktop:
- Pada launch pertama (atau saat package-lock berubah), aplikasi akan menjalankan bootstrap dependency otomatis terlebih dahulu (`npm install`) sebelum server API/UI dijalankan.
- Ini memastikan semua dependensi yang dibutuhkan sudah siap sebelum dashboard dibuka.

**Setup sistem lebih dulu (opsional, sebelum launch API/UI)**

```console
npm run setup:desktop
```

Gunakan perintah ini bila Anda ingin memastikan seluruh dependency terpasang lebih dulu pada instalasi awal, lalu jalankan aplikasi desktop setelah setup selesai.

**Build Desktop Artifacts (Windows NSIS + Portable)**

```console
npm run desktop:build
```

## Public Hardening Checklist

Gunakan checklist ini sebelum project dibagikan ke publik:

1. Secrets server-side tidak boleh ada di desktop app.
2. `SUPABASE_SERVICE_ROLE_KEY`, `SAKURUPIAH_API_ID`, dan `SAKURUPIAH_API_KEY` hanya dipakai di backend/webhook server.
3. Desktop app hanya memakai key publik: `SUPABASE_URL`, `SUPABASE_ANON_KEY`/`SUPABASE_PUBLISHABLE_KEY`, dan `SUBSCRIPTION_BACKEND_URL`.
4. File `.env` tidak boleh dibundle ke installer/portable.
5. Endpoint sensitif (checkout, verify payment, voucher write, webhook) harus diproses oleh backend terpisah.
6. Set `SUBSCRIPTION_BACKEND_URL` untuk mengarahkan proses pembayaran ke backend.
7. Rotasi semua key lama yang pernah dipakai untuk debug/build internal.
8. Jalankan pengecekan secret sebelum rilis (`git grep`, secret scan CI, audit artefak).

Template env publik yang aman untuk distribusi (tanpa server secret):

```dotenv
SUPABASE_URL=https://YOUR_PROJECT.supabase.co
SUPABASE_ANON_KEY=YOUR_SUPABASE_ANON_KEY
SUPABASE_PUBLISHABLE_KEY=YOUR_SUPABASE_ANON_KEY
SAKURUPIAH_IS_PRODUCTION=true
SUBSCRIPTION_BACKEND_URL=https://YOUR_BACKEND_DOMAIN/subscription
```

Contoh siap pakai tersedia di `.env.public.example` (copy sebagai `.env.public` saat distribusi).

## Troubleshooting Missing Env

Jika log menampilkan:
`[ERROR] Subscription UI env is not ready. Missing: SUPABASE_URL, SUPABASE_ANON_KEY`

cek langkah berikut:
1. Pastikan file `.env.public` berada satu folder dengan `.exe` (untuk app publik).
2. Pastikan key ini terisi: `SUPABASE_URL`, `SUPABASE_ANON_KEY`, `SUBSCRIPTION_BACKEND_URL`.
3. Buka endpoint diagnostik lokal: `http://127.0.0.1:<PORT>/api/subscription/env-check`.
4. Jika env di lokasi lain, set `BATCH_UI_ENV_FILE=<absolute_path_to_env_file>`.
5. Pastikan nilainya bukan placeholder seperti `YOUR_*` dan `replace_with*`.

## Deploy Subscription Backend (Supabase Edge Functions)

Untuk mode publik, endpoint sensitif diarahkan ke Edge Function `subscription-api`.

1. Set environment variable di mesin deploy:

```powershell
$env:SUPABASE_PROJECT_REF="your_project_ref"
$env:SUPABASE_ACCESS_TOKEN="your_pat"
$env:SUPABASE_DB_PASSWORD="your_db_password"
$env:SAKURUPIAH_API_ID="your_sakurupiah_api_id"
$env:SAKURUPIAH_API_KEY="your_sakurupiah_api_key"
$env:SAKURUPIAH_CALLBACK_URL="https://your_backend_domain/subscription/webhook"
$env:SAKURUPIAH_IS_PRODUCTION="true"
$env:SAKURUPIAH_MERCHANT_FEE="1"
$env:SAKURUPIAH_DEFAULT_EXPIRED_HOURS="24"
```

2. Jalankan deploy script:

```console
powershell -ExecutionPolicy Bypass -File scripts/supabase-deploy.ps1
```

3. Set `SUBSCRIPTION_BACKEND_URL` untuk desktop app publik:

```dotenv
SUBSCRIPTION_BACKEND_URL=https://YOUR_PROJECT.functions.supabase.co/functions/v1/subscription-api
```

4. Verifikasi endpoint health:

```console
curl https://YOUR_PROJECT.functions.supabase.co/functions/v1/subscription-api/health
```

## Deploy Subscription Backend (VPS Ubuntu + Domain)

Untuk backend di VPS Ubuntu dengan domain `apimotion.narrapedia.top`, gunakan panduan lengkap:

- [docs/execution/08-vps-ubuntu-deploy-apimotion.md](docs/execution/08-vps-ubuntu-deploy-apimotion.md)

Nilai env publik desktop app:

```dotenv
SUBSCRIPTION_BACKEND_URL=https://apimotion.narrapedia.top/subscription
```

Skenario uji end-to-end readiness (login, checkout, verify-payment, webhook) ada di:
- [docs/execution/09-vps-e2e-commercial-readiness.md](docs/execution/09-vps-e2e-commercial-readiness.md)

## Key Rotation (Server Secrets)

Setelah hardening publik aktif, rotasi key internal yang pernah dipakai di desktop/debug build:

1. Generate key baru: `SUPABASE_SERVICE_ROLE_KEY` dan `SAKURUPIAH_API_KEY`.
2. Update secrets di Supabase project dan sistem backend.
3. Redeploy function `subscription-api`.
4. Revoke key lama.
5. Jalankan smoke test pembayaran dan webhook sebelum rilis publik.

**Upgrade Remotion**

```console
npx remotion upgrade
```

## Docs

Get started with Remotion by reading the [fundamentals page](https://www.remotion.dev/docs/the-fundamentals).

## Batch .tsk format

Create or edit [batch/tasks.tsk](batch/tasks.tsk) as JSON.

```json
{
  "columns": [
    {
      "name": "Kolom Produk",
      "lists": [
        {
          "name": "List April",
          "items": [
            {
              "title": "Promo Launch Video",
              "content": "Buka dengan headline utama"
            },
            "Fitur Utama",
            "Closing CTA"
          ]
        }
      ]
    }
  ]
}
```

Processing order is automatic from top to bottom:
1. Column order
2. List order in each column
3. Item order in each list

Each item is rendered into a separate video file.

## Automatic rename

Output files are renamed automatically using this pattern:

```text
001-column-name-list-name-item-title.mp4
```

If the name already exists, the renderer appends a numeric suffix:

```text
001-column-name-list-name-item-title-2.mp4
```

This guarantees unique names and keeps output order deterministic.

## Batch UI workflow

After running `npm run batch:ui`, open the URL shown in terminal (default: `http://localhost:3210`).

Subscription interface (Supabase + Sakurupiah) is available at:
- http://localhost:3210/subscription

Desktop app uses Electron shell and loads:
- http://127.0.0.1:<dynamic-port>/subscription

Inside the interface you can:
1. Load and edit your `.tsk` file as JSON
2. Format JSON automatically
3. Save file without leaving the page
4. Run Test mode (1 item) or Full batch mode
5. Open output folder with one click
6. Monitor realtime logs, process status, and per-job render history

Inside subscription interface you can:
1. Login or sign up with Supabase auth
2. Load active plans from Supabase
3. Choose Sakurupiah payment channel and enter customer phone
4. Open Sakurupiah checkout page
5. Check membership, invoices, and recent payments

This makes batch processing easier without typing multiple CLI commands.

## Public Release Output

Untuk menyiapkan file final siap share ke folder `share-final`:

1. Build artefak desktop:

```console
npm run desktop:build
```

2. Copy hasil build ke folder distribusi:

```console
copy release\Narrapedia reMotion Batch-Setup-1.0.0.exe share-final\desktop-app\
copy release\Narrapedia reMotion Batch-Portable-1.0.0.exe share-final\desktop-app\
```

3. Sertakan file env publik (tanpa server secret) sebagai panduan pengguna, misalnya `share-final/desktop-app/.env.public.example`.

## Help

We provide help on our [Discord server](https://discord.gg/6VzzNDwUwV).

## Issues

Found an issue with Remotion? [File an issue here](https://github.com/remotion-dev/remotion/issues/new).

## License

Note that for some entities a company license is needed. [Read the terms here](https://github.com/remotion-dev/remotion/blob/main/LICENSE.md).
