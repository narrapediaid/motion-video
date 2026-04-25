# Dokumen 3: Sakurupiah Status Mapping Matrix

| Sakurupiah status | status_kode | payment_status | invoice_status | membership_status |
| --- | ---: | --- | --- | --- |
| pending | 0 | pending | open | pending_payment |
| berhasil | 1 | settlement | paid | active / lifetime_active |
| expired | 2 | expire | expired | expired |

## Notes
- Lifetime membership tidak diturunkan oleh callback berikutnya.
- Voucher `reserved` berubah ke `applied` saat invoice paid dan `released` saat invoice expired.
- `verify-payment` membaca `trx_id` dari `invoices.raw_payload.sakurupiah` lalu memanggil `status-transaction.php`.
