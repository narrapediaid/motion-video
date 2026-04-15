# Dokumen 3: Midtrans Status Mapping Matrix + Test Cases

## 1) Tujuan
Dokumen ini memformalkan mapping status Midtrans ke state internal platform untuk memastikan transisi membership deterministik, mudah diuji, dan aman terhadap event duplikat atau out-of-order.

Ruang lingkup:
- Matrix status Midtrans ke status pembayaran internal.
- Matrix status Midtrans ke status membership internal.
- Rule prioritas transisi.
- Skenario uji per transisi (happy path dan edge cases).

Implementasi terkait:
- [supabase/migrations/20260414000002_midtrans_webhook.sql](supabase/migrations/20260414000002_midtrans_webhook.sql)

## 2) Terminologi
- Midtrans status: nilai dari field transaction_status / fraud_status.
- Payment status internal: enum public.payment_status.
- Membership status internal: enum public.membership_status.
- Terminal state: state yang tidak boleh di-rollback oleh event lebih lemah.

## 3) Mapping Midtrans -> Payment Status
| Midtrans transaction_status | fraud_status | payment_status internal | Sifat |
|---|---|---|---|
| settlement | any | settlement | final sukses |
| capture | accept | capture | final sukses kartu |
| capture | challenge | pending | menunggu review |
| pending | any | pending | interim |
| deny | any | deny | gagal |
| cancel | any | cancel | final gagal |
| expire | any | expire | final gagal |
| refund | any | refund | final reversal |
| partial_refund | any | partial_refund | partial reversal |
| chargeback | any | chargeback | final reversal |
| partial_chargeback | any | partial_chargeback | partial reversal |
| unknown lainnya | any | failure | fallback aman |

## 4) Mapping Midtrans -> Membership Status
| Midtrans status | Membership status internal | Catatan |
|---|---|---|
| settlement | active | aktivasi/renew berhasil |
| capture (accept) | active | aktivasi/renew berhasil |
| capture (challenge) | pending_payment | belum final |
| pending | pending_payment | menunggu pelunasan |
| cancel | canceled | dibatalkan |
| expire | expired | pembayaran kedaluwarsa |
| deny | suspended | ditahan/gagal berisiko |
| refund | suspended | akses dihentikan sementara |
| partial_refund | suspended | konservatif: treat as risk |
| chargeback | suspended | risiko tinggi |
| partial_chargeback | suspended | risiko tinggi |

Rule khusus:
- Jika current_status sudah lifetime_active, hasil mapping selalu lifetime_active (anti downgrade).
- Untuk status yang tidak dikenali, fallback ke status saat ini.

## 5) Prioritas Transisi (State Guard)
Urutan kekuatan status untuk mencegah rollback oleh event terlambat:
1. lifetime_active (absolute lock)
2. active
3. pending_payment
4. suspended / canceled / expired

Aturan:
- Event pending tidak boleh menurunkan active.
- Event sukses (settlement/capture accept) boleh menaikkan pending_payment -> active.
- Event reversal (refund/chargeback) boleh menurunkan active -> suspended.
- Event duplicate harus no-op (idempotency guard dari payment_events.idempotency_key).

## 6) Matrix Skenario End-to-End
| No | Skenario | Urutan event | Hasil akhir invoice | Hasil akhir payment | Hasil akhir membership |
|---|---|---|---|---|---|
| 1 | Pembayaran sukses normal | pending -> settlement | paid | settlement | active |
| 2 | Kartu challenge lalu sukses | capture(challenge) -> capture(accept) | paid | capture | active |
| 3 | Pending lalu expire | pending -> expire | expired | expire | expired |
| 4 | Sukses lalu refund penuh | settlement -> refund | void | refund | suspended |
| 5 | Sukses lalu chargeback | settlement -> chargeback | void | chargeback | suspended |
| 6 | Event duplikat | settlement -> settlement (same key) | paid | settlement | active (tanpa mutasi ke-2) |
| 7 | Out-of-order lemah | settlement -> pending | paid | settlement | active |
| 8 | Invoice tidak ditemukan | pending (order tidak ada) | none | none | none (event ignored) |
| 9 | Membership lifetime | settlement (current lifetime_active) | paid | settlement | lifetime_active |

## 7) Test Cases Per Transisi
### TC-01 Aktivasi pertama
- Precondition: membership pending_payment, invoice open.
- Input: settlement.
- Expected:
  - invoices.status = paid
  - payments.status = settlement
  - memberships.status = active
  - memberships.starts_at terisi jika null

### TC-02 Duplicate notification
- Precondition: event dengan idempotency_key yang sama sudah diproses.
- Input: payload identik.
- Expected:
  - return status duplicate
  - tidak ada kenaikan membership.version

### TC-03 Expired payment
- Precondition: membership pending_payment.
- Input: expire.
- Expected:
  - invoices.status = expired
  - memberships.status = expired

### TC-04 Refund after active
- Precondition: membership active.
- Input: refund.
- Expected:
  - invoices.status = void
  - memberships.status = suspended

### TC-05 Out-of-order pending after settlement
- Precondition: membership active akibat settlement lebih dulu.
- Input: pending terlambat.
- Expected:
  - membership tetap active
  - audit log tetap tercatat untuk forensic

### TC-06 Unknown transaction status
- Precondition: invoice open.
- Input: transaction_status = random_value.
- Expected:
  - payment_status = failure
  - invoice tidak transisi ke paid
  - event tetap tercatat

## 8) Acceptance Criteria Doc 3
1. Semua skenario pada section 6 menghasilkan state final sesuai matrix.
2. Duplicate event tidak menghasilkan side effect kedua.
3. Out-of-order event tidak melakukan rollback status yang lebih kuat.
4. Lifetime membership tidak pernah turun akibat event Midtrans.
5. Setiap transisi memiliki jejak di audit_logs atau payment_events.

## 9) Rekomendasi Penguatan Berikutnya
- Tambah state precedence checker eksplisit dalam SQL function untuk hard-guard out-of-order.
- Tambah reconciliation job periodik untuk invoice_not_found.
- Tambah integration test otomatis via Supabase test runner/CI pipeline.
