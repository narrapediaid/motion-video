# Dokumen 6: Midtrans Sandbox Payload Generator + E2E Function Test

## Tujuan
Dokumen ini mendefinisikan cara menjalankan:
- Generator payload Midtrans sandbox dengan signature valid.
- Uji end-to-end function webhook dari setup data sampai verifikasi status dan cleanup.

## File Script
- [scripts/midtrans-sandbox-payload.mjs](scripts/midtrans-sandbox-payload.mjs)
- [scripts/midtrans-sandbox-e2e.mjs](scripts/midtrans-sandbox-e2e.mjs)

## NPM Commands
- npm run midtrans:payload
- npm run midtrans:test:e2e
- npm run midtrans:test:e2e:cleanup-fault

## Environment Minimum
Variabel yang harus ada di file env lokal:
- SUPABASE_URL
- SUPABASE_ANON_KEY
- SUPABASE_SERVICE_ROLE_KEY
- MIDTRANS_SERVER_KEY

Opsional:
- MIDTRANS_CLIENT_KEY

## 1) Payload Generator
Contoh jalankan default:
- npm run midtrans:payload

Contoh custom:
- node scripts/midtrans-sandbox-payload.mjs --order-id ORDER-123 --transaction-id TX-123 --transaction-status settlement --gross-amount 10000.00

Output script:
- JSON payload Midtrans yang sudah mengandung signature_key valid.

## 2) End-to-End Test
Jalankan:
- npm run midtrans:test:e2e

Mode fault injection (untuk uji jalur gagal di CI):
- npm run midtrans:test:e2e:cleanup-fault

Alur test otomatis:
1. Membuat auth user test.
2. Membuat/menjamin profile user.
3. Membuat plan, membership, dan invoice.
4. Mengirim webhook valid (expect applied).
5. Mengirim webhook duplikat (expect duplicate).
6. Mengirim webhook signature invalid (expect 401).
7. Verifikasi status invoice paid.
8. Verifikasi status membership active.
9. Verifikasi payment_events tercatat.
10. Cleanup semua data test.
11. Verifikasi strict cleanup: script akan fail jika masih ada residu data test.

## Kriteria Lulus
- Script menampilkan [E2E] PASS.
- Script menampilkan [E2E] Cleanup done and verified.
- Tidak ada data test tertinggal setelah cleanup.

## Kriteria Fault-Injection (CI)
- Command `npm run midtrans:test:e2e:cleanup-fault` harus exit dengan code non-zero.
- Log harus memuat `[E2E] CLEANUP FAIL` dan minimal satu baris `[E2E] CLEANUP ISSUE`.
- Tujuan mode ini adalah menguji jalur kegagalan cleanup secara deterministik, bukan untuk lulus test.

## Perilaku Strict Cleanup
- Jika ada operasi delete yang gagal, script menampilkan [E2E] CLEANUP FAIL dan exit code non-zero.
- Jika setelah cleanup masih ditemukan record test (invoice, membership, plan, profile, payment_events, auth user), script menampilkan daftar [E2E] CLEANUP ISSUE dan exit code non-zero.
- Jika fault injection aktif (`--fault-cleanup` atau env `E2E_FAULT_INJECT_CLEANUP=1|true|force-issue`), script mensimulasikan cleanup issue dan exit code non-zero secara deterministik.

## Troubleshooting
- Jika gagal pada create user:
  - pastikan service role key valid dan belum di-rotate.
- Jika gagal pada function call:
  - pastikan function midtrans-webhook sudah dideploy.
- Jika signature mismatch:
  - pastikan MIDTRANS_SERVER_KEY di env sama dengan key sandbox aktif.

## Security Note
Karena PAT dan service-role key pernah dibagikan di chat, lakukan rotasi kredensial setelah validasi sandbox selesai:
1. Rotate SUPABASE_ACCESS_TOKEN.
2. Rotate SUPABASE_SERVICE_ROLE_KEY.
3. Update env lokal dan Supabase function secrets setelah rotasi.
