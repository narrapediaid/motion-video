# Dokumen 6: Sakurupiah Sandbox Payload Generator + E2E Callback Test

## Scripts
- `npm run sakurupiah:payload`
- `npm run sakurupiah:test:e2e`

## Env
- `SAKURUPIAH_API_KEY`
- `SUBSCRIPTION_BACKEND_URL` atau `SAKURUPIAH_TEST_WEBHOOK_URL`

## Generate Callback Payload

```bash
npm run sakurupiah:payload -- --merchant-ref ORDER-123 --trx-id SBX-123 --status berhasil
```

Output berisi `headers`, `body`, dan `rawBody` untuk dipakai pada `curl`.

## Smoke Callback

```bash
SAKURUPIAH_TEST_MERCHANT_REF=ORDER-123 \
SAKURUPIAH_TEST_TRX_ID=SBX-123 \
SAKURUPIAH_TEST_STATUS=pending \
npm run sakurupiah:test:e2e
```

Script mengirim callback bertanda tangan ke `/webhook` dan exit non-zero jika response bukan 2xx.
