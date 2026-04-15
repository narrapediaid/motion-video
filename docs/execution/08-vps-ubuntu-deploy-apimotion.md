# 08 - Deploy Backend ke VPS Ubuntu (`apimotion.narrapedia.top`)

Dokumen ini memindahkan backend subscription dari mode Supabase Function-only ke mode VPS Ubuntu (Nginx + systemd), sambil tetap memakai database/auth Supabase.

## 1) Struktur Project yang Dipakai

1. Source backend utama: `supabase/functions/subscription-api/index.ts`
2. Template env VPS: `deploy/vps/subscription-api.env.example`
3. Template service systemd: `deploy/vps/subscription-api.service`
4. Template Nginx domain: `deploy/vps/nginx-apimotion.narrapedia.top.conf`

Catatan:
1. Route backend sudah kompatibel untuk prefix `/subscription-api/*` dan `/subscription/*`.
2. Desktop/public app tetap mengarah ke `SUBSCRIPTION_BACKEND_URL`.

## 2) Prasyarat

1. VPS Ubuntu 22.04/24.04 (public IP aktif).
2. DNS `A record` domain `apimotion.narrapedia.top` mengarah ke IP VPS.
3. Key produksi sudah siap:
`SUPABASE_URL`, `SUPABASE_SERVICE_ROLE_KEY`, `SUPABASE_ANON_KEY` (atau publishable key), `MIDTRANS_SERVER_KEY`, `MIDTRANS_CLIENT_KEY`.
4. Repo ini sudah bisa di-clone dari VPS.

## 3) Setup Awal di VPS

Jalankan sebagai root (atau pakai `sudo`):

```bash
apt update && apt upgrade -y
apt install -y nginx certbot python3-certbot-nginx curl git ufw
ufw allow OpenSSH
ufw allow 'Nginx Full'
ufw --force enable
```

## 4) Buat User dan Clone Project

```bash
useradd -m -s /bin/bash motionapi || true
mkdir -p /opt/motion-video
chown -R motionapi:motionapi /opt/motion-video
sudo -u motionapi git clone <URL_REPO_ANDA> /opt/motion-video
```

Jika repo sudah ada:

```bash
sudo -u motionapi git -C /opt/motion-video pull
```

## 5) Install Deno

```bash
sudo -u motionapi bash -lc "curl -fsSL https://deno.land/install.sh | sh"
ln -sf /home/motionapi/.deno/bin/deno /usr/local/bin/deno
deno --version
```

## 6) Isi Environment Backend

```bash
cp /opt/motion-video/deploy/vps/subscription-api.env.example /opt/motion-video/deploy/vps/subscription-api.env
nano /opt/motion-video/deploy/vps/subscription-api.env
```

Isi semua value asli (jangan placeholder).

## 7) Pasang Service `systemd`

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

## 8) Konfigurasi Nginx Domain

```bash
cp /opt/motion-video/deploy/vps/nginx-apimotion.narrapedia.top.conf /etc/nginx/sites-available/apimotion.narrapedia.top.conf
ln -sf /etc/nginx/sites-available/apimotion.narrapedia.top.conf /etc/nginx/sites-enabled/apimotion.narrapedia.top.conf
nginx -t
systemctl reload nginx
```

## 9) Aktifkan HTTPS (Let's Encrypt)

```bash
certbot --nginx -d apimotion.narrapedia.top --redirect -m admin@narrapedia.top --agree-tos -n
```

## 10) Uji Endpoint Backend

```bash
curl https://apimotion.narrapedia.top/subscription/health
```

Expected minimal:

```json
{"ok":true,"service":"subscription-api","mode":"production"}
```

## 11) Update Konfigurasi App Publik

Pada `.env.public` app desktop:

```dotenv
SUBSCRIPTION_BACKEND_URL=https://apimotion.narrapedia.top/subscription
```

Endpoint lokal app akan meneruskan:
1. `POST /checkout`
2. `POST /verify-payment`
3. `POST /voucher/validate`
4. `POST /webhook`

## 12) Update Midtrans Webhook URL

Set webhook URL di Midtrans Dashboard:

```text
https://apimotion.narrapedia.top/subscription/webhook
```

## 13) Prosedur Update Backend ke Depan

```bash
sudo -u motionapi git -C /opt/motion-video pull
systemctl restart subscription-api
systemctl status subscription-api --no-pager
```

## 14) Checklist Keamanan Minimum

1. Jangan simpan `SUPABASE_SERVICE_ROLE_KEY` dan `MIDTRANS_SERVER_KEY` di app publik.
2. File env backend hanya readable oleh root/motionapi:
`chmod 640 /opt/motion-video/deploy/vps/subscription-api.env`
3. Pastikan hanya port `22`, `80`, `443` yang terbuka ke publik.
4. Lakukan rotasi key jika pernah dipakai di mesin dev/public build.
