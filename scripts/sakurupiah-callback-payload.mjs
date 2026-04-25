import { createHmac } from "node:crypto";
import { existsSync, readFileSync } from "node:fs";
import { resolve } from "node:path";

const parseArgs = (argv) => {
  const args = {};
  for (let i = 0; i < argv.length; i += 1) {
    const item = argv[i];
    if (!item.startsWith("--")) continue;
    const key = item.slice(2);
    const next = argv[i + 1];
    if (!next || next.startsWith("--")) {
      args[key] = "true";
      continue;
    }
    args[key] = next;
    i += 1;
  }
  return args;
};

const loadEnv = () => {
  const envPath = resolve(process.cwd(), ".env");
  if (!existsSync(envPath)) return;
  const lines = readFileSync(envPath, "utf8").split(/\r?\n/);
  for (const line of lines) {
    if (!line || line.trim().startsWith("#") || !line.includes("=")) continue;
    const idx = line.indexOf("=");
    const key = line.slice(0, idx).trim();
    const value = line.slice(idx + 1).trim();
    if (!process.env[key]) {
      process.env[key] = value;
    }
  }
};

const signature = ({ rawBody, apiKey }) => {
  return createHmac("sha256", apiKey).update(rawBody).digest("hex");
};

loadEnv();
const args = parseArgs(process.argv.slice(2));

if (args.help === "true") {
  console.log([
    "Usage:",
    "  node scripts/sakurupiah-callback-payload.mjs [options]",
    "",
    "Options:",
    "  --merchant-ref <value> default: ORDER-SUB-SANDBOX-001",
    "  --trx-id <value>       default: SBX-SANDBOX-001",
    "  --status <value>       default: berhasil (pending|berhasil|expired)",
    "  --status-kode <value>  default follows status (pending=0, berhasil=1, expired=2)",
    "  --api-key <value>      default: SAKURUPIAH_API_KEY from .env",
    "",
    "Output includes raw JSON body and curl headers for local webhook testing.",
  ].join("\n"));
  process.exit(0);
}

const apiKey = args["api-key"] ?? process.env.SAKURUPIAH_API_KEY;
if (!apiKey) {
  console.error("Missing SAKURUPIAH_API_KEY. Provide --api-key or .env variable.");
  process.exit(1);
}

const status = String(args.status ?? "berhasil").toLowerCase();
const defaultStatusCode = status === "berhasil" ? 1 : status === "expired" ? 2 : 0;
const payload = {
  trx_id: args["trx-id"] ?? "SBX-SANDBOX-001",
  merchant_ref: args["merchant-ref"] ?? "ORDER-SUB-SANDBOX-001",
  status,
  status_kode: Number(args["status-kode"] ?? defaultStatusCode),
};

const rawBody = JSON.stringify(payload);
const callbackSignature = signature({ rawBody, apiKey });

console.log(JSON.stringify({
  headers: {
    "Content-Type": "application/json",
    "X-Callback-Event": "payment_status",
    "X-Callback-Signature": callbackSignature,
  },
  body: payload,
  rawBody,
}, null, 2));
