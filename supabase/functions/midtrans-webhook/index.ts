import { createClient } from "https://esm.sh/@supabase/supabase-js@2.49.4";

type JsonValue = string | number | boolean | null | JsonValue[] | { [key: string]: JsonValue };

type MidtransNotification = {
  order_id?: string;
  status_code?: string;
  gross_amount?: string;
  signature_key?: string;
  transaction_status?: string;
  transaction_id?: string;
  fraud_status?: string;
  [key: string]: JsonValue;
};

const SUPABASE_URL = Deno.env.get("SUPABASE_URL");
const SUPABASE_SERVICE_ROLE_KEY = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY");
const MIDTRANS_SERVER_KEY = Deno.env.get("MIDTRANS_SERVER_KEY");

if (!SUPABASE_URL || !SUPABASE_SERVICE_ROLE_KEY || !MIDTRANS_SERVER_KEY) {
  throw new Error("Missing SUPABASE_URL, SUPABASE_SERVICE_ROLE_KEY, or MIDTRANS_SERVER_KEY");
}

const supabase = createClient(SUPABASE_URL, SUPABASE_SERVICE_ROLE_KEY, {
  auth: {
    persistSession: false,
    autoRefreshToken: false,
  },
});

const encoder = new TextEncoder();

const json = (status: number, body: Record<string, JsonValue>) =>
  new Response(JSON.stringify(body), {
    status,
    headers: {
      "Content-Type": "application/json",
    },
  });

const digestHex = async (algorithm: AlgorithmIdentifier, value: string): Promise<string> => {
  const digest = await crypto.subtle.digest(algorithm, encoder.encode(value));
  return Array.from(new Uint8Array(digest))
    .map((byte) => byte.toString(16).padStart(2, "0"))
    .join("");
};

const buildMidtransSignatureBase = (payload: MidtransNotification): string => {
  return `${payload.order_id ?? ""}${payload.status_code ?? ""}${payload.gross_amount ?? ""}${MIDTRANS_SERVER_KEY}`;
};

const timingSafeEqual = (left: string, right: string): boolean => {
  if (left.length !== right.length) return false;

  let mismatch = 0;
  for (let i = 0; i < left.length; i += 1) {
    mismatch |= left.charCodeAt(i) ^ right.charCodeAt(i);
  }

  return mismatch === 0;
};

const buildIdempotencyKey = async (payload: MidtransNotification): Promise<string> => {
  const stable = [
    payload.order_id ?? "",
    payload.transaction_id ?? "",
    payload.transaction_status ?? "",
    payload.status_code ?? "",
    payload.gross_amount ?? "",
    payload.fraud_status ?? "",
  ].join("|");

  return digestHex("SHA-256", stable);
};

Deno.serve(async (request) => {
  if (request.method !== "POST") {
    return json(405, { error: "Method not allowed" });
  }

  let payload: MidtransNotification;

  try {
    payload = (await request.json()) as MidtransNotification;
  } catch {
    return json(400, { error: "Invalid JSON body" });
  }

  if (!payload.order_id || !payload.status_code || !payload.gross_amount || !payload.signature_key) {
    return json(400, {
      error: "Missing required Midtrans fields",
      required_fields: ["order_id", "status_code", "gross_amount", "signature_key"],
    });
  }

  const expectedSignature = await digestHex("SHA-512", buildMidtransSignatureBase(payload));
  const incomingSignature = String(payload.signature_key).toLowerCase();

  if (!timingSafeEqual(expectedSignature, incomingSignature)) {
    return json(401, { error: "Invalid signature" });
  }

  const idempotencyKey = await buildIdempotencyKey(payload);

  const { data, error } = await supabase.rpc("process_midtrans_webhook", {
    p_payload: payload,
    p_idempotency_key: idempotencyKey,
  });

  if (error) {
    return json(500, {
      error: "Failed to process webhook",
      detail: error.message,
      idempotency_key: idempotencyKey,
    });
  }

  return json(200, {
    ok: true,
    idempotency_key: idempotencyKey,
    result: data as JsonValue,
  });
});
