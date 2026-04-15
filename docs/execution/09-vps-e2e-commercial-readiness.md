# 09 - VPS Live E2E (Login -> Checkout -> Verify-Payment -> Webhook)

Dokumen ini adalah SOP uji end-to-end untuk backend live:
`https://apimotion.narrapedia.top/subscription`

Tujuan:
1. Memastikan alur autentikasi user berjalan.
2. Memastikan checkout membuat order/invoice valid.
3. Memastikan endpoint `verify-payment` berjalan dengan token login.
4. Memastikan webhook Midtrans tervalidasi signature dan memproses status.
5. Memastikan status akhir invoice/membership siap untuk rilis komersial.
6. Memastikan render gate (`/render/authorize`) menerbitkan job ticket valid.

## Prasyarat

1. Service backend harus healthy:
```bash
curl -s https://apimotion.narrapedia.top/subscription/health
```

2. Variabel env backend sudah benar di VPS:
`SUPABASE_URL`, `SUPABASE_SERVICE_ROLE_KEY`, `SUPABASE_ANON_KEY`, `MIDTRANS_SERVER_KEY`, `MIDTRANS_CLIENT_KEY`, `MIDTRANS_IS_PRODUCTION`.

3. Untuk test end-to-end awal, sangat disarankan pakai mode sandbox Midtrans.

4. Jalankan command dari VPS di folder project:
```bash
cd /opt/motion-video
sudo apt install -y jq
```

## 1) Setup variabel shell

```bash
export API_BASE="https://apimotion.narrapedia.top/subscription"
export ENV_FILE="/opt/motion-video/deploy/vps/subscription-api.env"

export SUPABASE_URL="$(grep '^SUPABASE_URL=' "$ENV_FILE" | cut -d= -f2-)"
export SUPABASE_ANON_KEY="$(grep '^SUPABASE_ANON_KEY=' "$ENV_FILE" | cut -d= -f2-)"
export SUPABASE_SERVICE_ROLE_KEY="$(grep '^SUPABASE_SERVICE_ROLE_KEY=' "$ENV_FILE" | cut -d= -f2-)"
export MIDTRANS_SERVER_KEY="$(grep '^MIDTRANS_SERVER_KEY=' "$ENV_FILE" | cut -d= -f2-)"
```

## 2) Login user test (Supabase Auth)

Siapkan user test:

```bash
export E2E_EMAIL="e2e.$(date +%s)@example.com"
export E2E_PASSWORD="Test12345!"
```

Register:

```bash
curl -sS -X POST "$SUPABASE_URL/auth/v1/signup" \
  -H "apikey: $SUPABASE_ANON_KEY" \
  -H "Content-Type: application/json" \
  -d "{\"email\":\"$E2E_EMAIL\",\"password\":\"$E2E_PASSWORD\",\"data\":{\"full_name\":\"E2E VPS User\"}}"
```

Login:

```bash
AUTH_JSON="$(curl -sS -X POST "$SUPABASE_URL/auth/v1/token?grant_type=password" \
  -H "apikey: $SUPABASE_ANON_KEY" \
  -H "Content-Type: application/json" \
  -d "{\"email\":\"$E2E_EMAIL\",\"password\":\"$E2E_PASSWORD\"}")"

echo "$AUTH_JSON" | jq .

export ACCESS_TOKEN="$(echo "$AUTH_JSON" | jq -r '.access_token')"
export USER_ID="$(echo "$AUTH_JSON" | jq -r '.user.id')"
```

Kriteria lulus:
1. `ACCESS_TOKEN` tidak kosong.
2. `USER_ID` terisi UUID.

## 3) Ambil plan aktif, lalu checkout

Ambil 1 plan aktif:

```bash
PLAN_JSON="$(curl -sS "$SUPABASE_URL/rest/v1/plans?select=id,code,name,price_idr,is_active&is_active=eq.true&order=price_idr.asc&limit=1" \
  -H "apikey: $SUPABASE_SERVICE_ROLE_KEY" \
  -H "Authorization: Bearer $SUPABASE_SERVICE_ROLE_KEY")"

echo "$PLAN_JSON" | jq .
export PLAN_ID="$(echo "$PLAN_JSON" | jq -r '.[0].id')"
```

Checkout:

```bash
CHECKOUT_JSON="$(curl -sS -X POST "$API_BASE/checkout" \
  -H "Authorization: Bearer $ACCESS_TOKEN" \
  -H "Content-Type: application/json" \
  -d "{\"planId\":\"$PLAN_ID\"}")"

echo "$CHECKOUT_JSON" | jq .

export ORDER_ID="$(echo "$CHECKOUT_JSON" | jq -r '.orderId')"
export INVOICE_ID="$(echo "$CHECKOUT_JSON" | jq -r '.invoiceId')"
export REDIRECT_URL="$(echo "$CHECKOUT_JSON" | jq -r '.redirectUrl')"
```

Kriteria lulus:
1. `ORDER_ID` dan `INVOICE_ID` terisi.
2. `redirectUrl` ada.

## 4) Verify-payment (post checkout)

```bash
VERIFY_JSON="$(curl -sS -X POST "$API_BASE/verify-payment" \
  -H "Authorization: Bearer $ACCESS_TOKEN" \
  -H "Content-Type: application/json" \
  -d "{\"order_id\":\"$ORDER_ID\"}")"

echo "$VERIFY_JSON" | jq .
```

Catatan:
1. Jika pembayaran belum selesai, status bisa `pending`.
2. Jika transaksi belum terlihat di Midtrans, response bisa `404` sementara.

## 4b) Uji Render Gate Authorize

```bash
curl -sS -X POST "$API_BASE/render/authorize" \
  -H "Authorization: Bearer $ACCESS_TOKEN" \
  -H "Content-Type: application/json" \
  -d '{"mode":"render"}' | jq .
```

Kriteria lulus:
1. response `ok: true`.
2. ada `jobTicket`.
3. ada `expiresAt`.

## 5) Selesaikan pembayaran di Midtrans

Buka URL berikut di browser untuk menyelesaikan pembayaran test:

```bash
echo "$REDIRECT_URL"
```

Setelah bayar sukses/pending, jalankan lagi langkah verify:

```bash
curl -sS -X POST "$API_BASE/verify-payment" \
  -H "Authorization: Bearer $ACCESS_TOKEN" \
  -H "Content-Type: application/json" \
  -d "{\"order_id\":\"$ORDER_ID\"}" | jq .
```

## 6) Uji webhook endpoint (signature valid)

Ambil nominal invoice:

```bash
INVOICE_JSON="$(curl -sS "$SUPABASE_URL/rest/v1/invoices?select=id,external_order_id,amount_idr,status,user_id&external_order_id=eq.$ORDER_ID&limit=1" \
  -H "apikey: $SUPABASE_SERVICE_ROLE_KEY" \
  -H "Authorization: Bearer $SUPABASE_SERVICE_ROLE_KEY")"

echo "$INVOICE_JSON" | jq .
export AMOUNT_IDR="$(echo "$INVOICE_JSON" | jq -r '.[0].amount_idr')"
export GROSS_AMOUNT="${AMOUNT_IDR}.00"
```

Generate payload signature valid:

```bash
WEBHOOK_PAYLOAD="$(node scripts/midtrans-sandbox-payload.mjs \
  --order-id "$ORDER_ID" \
  --transaction-id "TX-$ORDER_ID" \
  --status-code "200" \
  --gross-amount "$GROSS_AMOUNT" \
  --transaction-status "settlement" \
  --fraud-status "accept" \
  --server-key "$MIDTRANS_SERVER_KEY")"

echo "$WEBHOOK_PAYLOAD" | jq .
```

Kirim webhook:

```bash
curl -sS -X POST "$API_BASE/webhook" \
  -H "Content-Type: application/json" \
  -d "$WEBHOOK_PAYLOAD" | jq .
```

Kriteria lulus:
1. response `ok: true`.
2. ada `idempotency_key`.

## 7) Verifikasi data akhir di database

Cek invoice:

```bash
curl -sS "$SUPABASE_URL/rest/v1/invoices?select=id,status,paid_at,external_order_id&external_order_id=eq.$ORDER_ID&limit=1" \
  -H "apikey: $SUPABASE_SERVICE_ROLE_KEY" \
  -H "Authorization: Bearer $SUPABASE_SERVICE_ROLE_KEY" | jq .
```

Cek membership user:

```bash
curl -sS "$SUPABASE_URL/rest/v1/memberships?select=id,status,starts_at,ends_at,grace_ends_at,updated_at&user_id=eq.$USER_ID&order=updated_at.desc&limit=1" \
  -H "apikey: $SUPABASE_SERVICE_ROLE_KEY" \
  -H "Authorization: Bearer $SUPABASE_SERVICE_ROLE_KEY" | jq .
```

Cek payment_events:

```bash
curl -sS "$SUPABASE_URL/rest/v1/payment_events?select=id,external_order_id,idempotency_key,process_result,created_at&external_order_id=eq.$ORDER_ID&order=created_at.desc&limit=5" \
  -H "apikey: $SUPABASE_SERVICE_ROLE_KEY" \
  -H "Authorization: Bearer $SUPABASE_SERVICE_ROLE_KEY" | jq .
```

Kriteria lulus final:
1. Invoice status `paid`.
2. Membership status `active` atau `lifetime_active` sesuai plan.
3. Payment event tercatat minimal 1.

## 8) Uji negatif minimal (wajib untuk hardening)

Tanpa token ke endpoint protected:

```bash
curl -i -X POST "$API_BASE/checkout" -H "Content-Type: application/json" -d '{}'
curl -i -X POST "$API_BASE/verify-payment" -H "Content-Type: application/json" -d '{}'
```

Expected:
1. status `401` atau `403`.
2. Bukan `200`.

Webhook signature invalid:

```bash
INVALID_PAYLOAD="$(echo "$WEBHOOK_PAYLOAD" | jq '.signature_key="invalid-signature"')"
curl -i -X POST "$API_BASE/webhook" -H "Content-Type: application/json" -d "$INVALID_PAYLOAD"
```

Expected:
1. status `401`.
2. pesan `Invalid signature`.

## 9) Checklist rilis komersial

1. `health` endpoint 200.
2. Checkout, verify, webhook sukses end-to-end.
3. Endpoint protected menolak anonymous.
4. Tidak ada secret server di `.env.public` desktop.
5. Backup + monitoring log systemd aktif:
```bash
sudo journalctl -u subscription-api -f
```
