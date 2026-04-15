import { createHash } from "node:crypto";
import { readFileSync, existsSync } from "node:fs";
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

const signature = ({ orderId, statusCode, grossAmount, serverKey }) => {
  const raw = `${orderId}${statusCode}${grossAmount}${serverKey}`;
  return createHash("sha512").update(raw).digest("hex");
};

loadEnv();
const args = parseArgs(process.argv.slice(2));

if (args.help === "true") {
  console.log([
    "Usage:",
    "  node scripts/midtrans-sandbox-payload.mjs [options]",
    "",
    "Options:",
    "  --order-id <value>           default: ORDER-SANDBOX-001",
    "  --transaction-id <value>     default: TX-SANDBOX-001",
    "  --status-code <value>        default: 200",
    "  --gross-amount <value>       default: 10000.00",
    "  --transaction-status <value> default: settlement",
    "  --fraud-status <value>       default: accept",
    "  --payment-type <value>       default: bank_transfer",
    "  --store <value>              default: bca",
    "  --server-key <value>         default: MIDTRANS_SERVER_KEY from .env",
  ].join("\n"));
  process.exit(0);
}

const serverKey = args["server-key"] ?? process.env.MIDTRANS_SERVER_KEY;
if (!serverKey) {
  console.error("Missing MIDTRANS_SERVER_KEY. Provide --server-key or .env variable.");
  process.exit(1);
}

const orderId = args["order-id"] ?? "ORDER-SANDBOX-001";
const transactionId = args["transaction-id"] ?? "TX-SANDBOX-001";
const statusCode = args["status-code"] ?? "200";
const grossAmount = args["gross-amount"] ?? "10000.00";
const transactionStatus = args["transaction-status"] ?? "settlement";
const fraudStatus = args["fraud-status"] ?? "accept";
const paymentType = args["payment-type"] ?? "bank_transfer";
const store = args.store ?? "bca";
const nowIso = new Date().toISOString();

const payload = {
  order_id: orderId,
  transaction_id: transactionId,
  status_code: statusCode,
  gross_amount: grossAmount,
  transaction_status: transactionStatus,
  fraud_status: fraudStatus,
  transaction_time: nowIso,
  settlement_time: transactionStatus === "settlement" ? nowIso : undefined,
  payment_type: paymentType,
  store,
};

payload.signature_key = signature({
  orderId,
  statusCode,
  grossAmount,
  serverKey,
});

console.log(JSON.stringify(payload, null, 2));
