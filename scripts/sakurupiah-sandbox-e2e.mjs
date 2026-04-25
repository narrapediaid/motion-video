import { createHmac } from "node:crypto";
import { existsSync, readFileSync } from "node:fs";
import { resolve } from "node:path";

const loadEnv = () => {
  const envPath = resolve(process.cwd(), ".env");
  if (!existsSync(envPath)) return;
  const lines = readFileSync(envPath, "utf8").split(/\r?\n/);
  for (const line of lines) {
    if (!line || line.trim().startsWith("#") || !line.includes("=")) continue;
    const idx = line.indexOf("=");
    const key = line.slice(0, idx).trim();
    const value = line.slice(idx + 1).trim();
    if (!process.env[key]) process.env[key] = value;
  }
};

const required = (name) => {
  const value = process.env[name]?.trim();
  if (!value) throw new Error(`Missing ${name}`);
  return value;
};

loadEnv();

const apiKey = required("SAKURUPIAH_API_KEY");
const baseUrl = (
  process.env.SUBSCRIPTION_BACKEND_URL
  || process.env.SAKURUPIAH_TEST_WEBHOOK_URL
  || ""
).replace(/\/+$/, "");

if (!baseUrl) {
  throw new Error("Missing SUBSCRIPTION_BACKEND_URL or SAKURUPIAH_TEST_WEBHOOK_URL");
}

const merchantRef = process.env.SAKURUPIAH_TEST_MERCHANT_REF || `ORDER-SUB-E2E-${Date.now()}`;
const trxId = process.env.SAKURUPIAH_TEST_TRX_ID || `SBX-E2E-${Date.now()}`;
const status = process.env.SAKURUPIAH_TEST_STATUS || "pending";
const statusKode = status === "berhasil" ? 1 : status === "expired" ? 2 : 0;
const body = JSON.stringify({
  trx_id: trxId,
  merchant_ref: merchantRef,
  status,
  status_kode: statusKode,
});
const signature = createHmac("sha256", apiKey).update(body).digest("hex");

const targetUrl = baseUrl.endsWith("/webhook") ? baseUrl : `${baseUrl}/webhook`;
const response = await fetch(targetUrl, {
  method: "POST",
  headers: {
    "Content-Type": "application/json",
    "X-Callback-Event": "payment_status",
    "X-Callback-Signature": signature,
  },
  body,
});

const text = await response.text();
let data = text;
try {
  data = JSON.parse(text);
} catch {
  // keep raw text
}

console.log(JSON.stringify({
  ok: response.ok,
  status: response.status,
  targetUrl,
  request: JSON.parse(body),
  response: data,
}, null, 2));

if (!response.ok) {
  process.exit(1);
}
