# 08 - Step-by-Step Instalasi Backend di VPS Ubuntu

Panduan ini memasang backend subscription Motion Video di VPS Ubuntu dengan Nginx + HTTPS + systemd. Backend tetap memakai Supabase untuk database/auth dan Sakurupiah untuk payment gateway.

Domain contoh: `apimotion.narrapedia.top`  
Path backend publik: `https://apimotion.narrapedia.top/subscription`

## 1) Siapkan DNS dan Credential

1. Arahkan DNS `A record`:
```text
apimotion.narrapedia.top -> IP_PUBLIC_VPS
```

2. Siapkan credential berikut:
```text
SUPABASE_URL
SUPABASE_SERVICE_ROLE_KEY
SUPABASE_ANON_KEY atau SUPABASE_PUBLISHABLE_KEY
SAKURUPIAH_API_ID
SAKURUPIAH_API_KEY
```

3. Callback URL Sakurupiah yang dipakai:
```text
https://apimotion.narrapedia.top/subscription/webhook
```

## 2) Login ke VPS

```bash
ssh root@IP_PUBLIC_VPS
```

Jika memakai user non-root, tambahkan `sudo` pada command administrasi.

## 3) Update Ubuntu dan Install Paket Dasar

```bash
apt update && apt upgrade -y
apt install -y nginx certbot python3-certbot-nginx curl git ufw ca-certificates
```

Aktifkan firewall:

```bash
ufw allow OpenSSH
ufw allow 'Nginx Full'
ufw --force enable
ufw status
```

## 4) Buat User Aplikasi

```bash
useradd -m -s /bin/bash motionapi || true
mkdir -p /opt/motion-video
chown -R motionapi:motionapi /opt/motion-video
```

## 5) Clone Project ke VPS

Ganti `<URL_REPO_ANDA>` dengan URL repository project.

```bash
sudo -u motionapi git clone <URL_REPO_ANDA> /opt/motion-video
```

Jika folder sudah berisi repo:

```bash
sudo -u motionapi git -C /opt/motion-video pull
```

## 6) Install Deno

```bash
sudo -u motionapi bash -lc "curl -fsSL https://deno.land/install.sh | sh"
ln -sf /home/motionapi/.deno/bin/deno /usr/local/bin/deno
deno --version
```

Buat cache Deno yang writable oleh service:

```bash
mkdir -p /opt/motion-video/.deno_cache
chown -R motionapi:motionapi /opt/motion-video/.deno_cache
```

## 7) Isi Environment Backend

```bash
cp /opt/motion-video/deploy/vps/subscription-api.env.example /opt/motion-video/deploy/vps/subscription-api.env
nano /opt/motion-video/deploy/vps/subscription-api.env
```

Isi seperti ini, dengan value asli:

```dotenv
SUPABASE_URL=https://your_project_ref.supabase.co
SUPABASE_SERVICE_ROLE_KEY=your_service_role_key
SUPABASE_ANON_KEY=your_anon_key_or_publishable_key

SAKURUPIAH_API_ID=your_sakurupiah_api_id
SAKURUPIAH_API_KEY=your_sakurupiah_api_key
SAKURUPIAH_CALLBACK_URL=https://apimotion.narrapedia.top/subscription/webhook
SAKURUPIAH_RETURN_URL=https://apimotion.narrapedia.top/subscription
SAKURUPIAH_IS_PRODUCTION=true
SAKURUPIAH_MERCHANT_FEE=1
SAKURUPIAH_DEFAULT_EXPIRED_HOURS=24

RENDER_GATE_SECRET=replace_with_long_random_secret
RENDER_GATE_ENFORCE=true
RENDER_TICKET_TTL_SECONDS=120
```

Amankan permission file env:

```bash
chown root:motionapi /opt/motion-video/deploy/vps/subscription-api.env
chmod 640 /opt/motion-video/deploy/vps/subscription-api.env
```

## 8) Jalankan Database Migration Supabase

Migration wajib dijalankan agar enum provider `sakurupiah` dan RPC `process_sakurupiah_callback` tersedia.

Opsi yang paling aman: jalankan dari komputer lokal yang sudah punya Node/npm dan Supabase access token:

```powershell
$env:SUPABASE_PROJECT_REF="your_project_ref"
$env:SUPABASE_ACCESS_TOKEN="your_supabase_pat"
$env:SUPABASE_DB_PASSWORD="your_supabase_db_password"
$env:SAKURUPIAH_API_ID="your_sakurupiah_api_id"
$env:SAKURUPIAH_API_KEY="your_sakurupiah_api_key"
$env:SAKURUPIAH_CALLBACK_URL="https://apimotion.narrapedia.top/subscription/webhook"
$env:SAKURUPIAH_IS_PRODUCTION="true"

powershell -ExecutionPolicy Bypass -File scripts/supabase-deploy.ps1
```

Jika ingin menjalankan dari VPS, install Node.js dulu lalu pakai Supabase CLI:

```bash
apt install -y nodejs npm
cd /opt/motion-video
npx supabase login --token "YOUR_SUPABASE_PAT"
npx supabase link --project-ref "YOUR_PROJECT_REF" --password "YOUR_DB_PASSWORD"
npx supabase db push --linked
```

## 9) Test Backend Langsung Tanpa Nginx

Jalankan sementara:

```bash
sudo -u motionapi DENO_DIR=/opt/motion-video/.deno_cache deno run \
  --allow-net \
  --allow-env \
  --env-file=/opt/motion-video/deploy/vps/subscription-api.env \
  /opt/motion-video/supabase/functions/subscription-api/index.ts
```

Buka terminal SSH kedua, lalu test:

```bash
curl http://127.0.0.1:8000/health
```

Expected:

```json
{"ok":true,"service":"subscription-api","paymentProvider":"sakurupiah","mode":"production"}
```

Tekan `Ctrl+C` di terminal pertama setelah test selesai.

## 10) Pasang systemd Service

```bash
cp /opt/motion-video/deploy/vps/subscription-api.service /etc/systemd/system/subscription-api.service
systemctl daemon-reload
systemctl enable subscription-api
systemctl start subscription-api
systemctl status subscription-api --no-pager
```

Cek log:

```bash
journalctl -u subscription-api -f
```

Test service lokal:

```bash
curl http://127.0.0.1:8000/health
```

## 11) Pasang Konfigurasi Nginx

```bash
cp /opt/motion-video/deploy/vps/nginx-apimotion.narrapedia.top.conf /etc/nginx/sites-available/apimotion.narrapedia.top.conf
ln -sf /etc/nginx/sites-available/apimotion.narrapedia.top.conf /etc/nginx/sites-enabled/apimotion.narrapedia.top.conf
nginx -t
systemctl reload nginx
```

Test HTTP:

```bash
curl http://apimotion.narrapedia.top/subscription/health
```

## 12) Aktifkan HTTPS Let's Encrypt

Ganti email jika perlu:

```bash
certbot --nginx -d apimotion.narrapedia.top --redirect -m admin@narrapedia.top --agree-tos -n
```

Test HTTPS:

```bash
curl https://apimotion.narrapedia.top/subscription/health
```

Expected:

```json
{"ok":true,"service":"subscription-api","paymentProvider":"sakurupiah","mode":"production"}
```

## 13) Set Callback di Sakurupiah

Di dashboard/merchant Sakurupiah, gunakan:

```text
https://apimotion.narrapedia.top/subscription/webhook
```

Backend juga mengirim `callback_url` ini saat membuat invoice checkout.

## 14) Set App Desktop/Public Env

Di `.env.public` atau `.env.public.txt` app desktop:

```dotenv
SUPABASE_URL=https://your_project_ref.supabase.co
SUPABASE_ANON_KEY=your_anon_key_or_publishable_key
SUPABASE_PUBLISHABLE_KEY=your_anon_key_or_publishable_key
SAKURUPIAH_IS_PRODUCTION=true
SUBSCRIPTION_BACKEND_URL=https://apimotion.narrapedia.top/subscription
```

Jangan masukkan `SUPABASE_SERVICE_ROLE_KEY`, `SAKURUPIAH_API_ID`, atau `SAKURUPIAH_API_KEY` ke app publik.

## 15) Smoke Test Payment Channel

```bash
curl https://apimotion.narrapedia.top/subscription/payment-channels | jq .
```

Jika `jq` belum ada:

```bash
apt install -y jq
```

Expected: response berisi array `channels`.

## 16) Smoke Test Callback Signature

Dari folder repo di VPS:

```bash
cd /opt/motion-video
export SAKURUPIAH_API_KEY="$(grep '^SAKURUPIAH_API_KEY=' deploy/vps/subscription-api.env | cut -d= -f2-)"

node scripts/sakurupiah-callback-payload.mjs \
  --merchant-ref "ORDER-TEST-001" \
  --trx-id "SBX-TEST-001" \
  --status "pending" \
  --api-key "$SAKURUPIAH_API_KEY"
```

Untuk test callback end-to-end butuh invoice/order yang benar-benar ada. Setelah checkout membuat `ORDER_ID`, jalankan:

```bash
PAYLOAD="$(node scripts/sakurupiah-callback-payload.mjs \
  --merchant-ref "$ORDER_ID" \
  --trx-id "$TRX_ID" \
  --status "pending" \
  --api-key "$SAKURUPIAH_API_KEY")"

curl -sS -X POST https://apimotion.narrapedia.top/subscription/webhook \
  -H "Content-Type: application/json" \
  -H "X-Callback-Event: payment_status" \
  -H "X-Callback-Signature: $(echo "$PAYLOAD" | jq -r '.headers."X-Callback-Signature"')" \
  -d "$(echo "$PAYLOAD" | jq -c '.body')" | jq .
```

## 17) Prosedur Update Backend

```bash
sudo -u motionapi git -C /opt/motion-video pull
chown -R motionapi:motionapi /opt/motion-video/.deno_cache
systemctl restart subscription-api
systemctl status subscription-api --no-pager
curl https://apimotion.narrapedia.top/subscription/health
```

Jika ada migration baru, ulangi langkah database migration sebelum restart service.

## 18) Troubleshooting Cepat

1. Service gagal start:
```bash
journalctl -u subscription-api -n 120 --no-pager
```

2. Nginx error:
```bash
nginx -t
journalctl -u nginx -n 120 --no-pager
```

3. Port Deno tidak aktif:
```bash
ss -ltnp | grep 8000
```

4. HTTPS/certbot gagal:
```bash
dig +short apimotion.narrapedia.top
certbot certificates
```

5. Callback Sakurupiah 401:
Pastikan `SAKURUPIAH_API_KEY` di VPS sama dengan merchant Sakurupiah yang mengirim callback.

## 19) Checklist Keamanan

1. File env backend:
```bash
ls -l /opt/motion-video/deploy/vps/subscription-api.env
```
Harus `root:motionapi` dan permission `640`.

2. App publik hanya berisi public env.

3. Firewall hanya membuka port penting:
```bash
ufw status
```

4. Rotasi key jika pernah terlanjur masuk app publik atau log.
