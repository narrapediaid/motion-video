import { createClient } from "https://esm.sh/@supabase/supabase-js@2.49.4";

type JsonValue =
  | string
  | number
  | boolean
  | null
  | JsonValue[]
  | { [key: string]: JsonValue };

type MidtransNotification = {
  order_id?: string;
  status_code?: string;
  gross_amount?: string;
  signature_key?: string;
  transaction_status?: string;
  transaction_id?: string;
  fraud_status?: string;
  payment_type?: string;
  settlement_time?: string;
  transaction_time?: string;
  [key: string]: JsonValue | undefined;
};

type VoucherDiscountResult = {
  discountIdr: number;
  finalAmountIdr: number;
};

type CheckoutVoucher = {
  voucher: Record<string, JsonValue>;
  voucherCode: string;
  planAmountIdr: number;
  discountIdr: number;
  finalAmountIdr: number;
};

const SUPABASE_URL = Deno.env.get("SUPABASE_URL")?.trim();
const SUPABASE_SERVICE_ROLE_KEY = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")?.trim();
const SUPABASE_ANON_KEY =
  Deno.env.get("SUPABASE_ANON_KEY")?.trim()
  || Deno.env.get("SUPABASE_PUBLISHABLE_KEY")?.trim()
  || SUPABASE_SERVICE_ROLE_KEY;
const MIDTRANS_SERVER_KEY = Deno.env.get("MIDTRANS_SERVER_KEY")?.trim();
const MIDTRANS_CLIENT_KEY = Deno.env.get("MIDTRANS_CLIENT_KEY")?.trim() || "";
const MIDTRANS_IS_PRODUCTION = ["1", "true", "yes"].includes(
  String(Deno.env.get("MIDTRANS_IS_PRODUCTION") || "").trim().toLowerCase(),
);

if (!SUPABASE_URL || !SUPABASE_SERVICE_ROLE_KEY || !SUPABASE_ANON_KEY || !MIDTRANS_SERVER_KEY) {
  throw new Error(
    "Missing required env: SUPABASE_URL, SUPABASE_SERVICE_ROLE_KEY, SUPABASE_ANON_KEY, MIDTRANS_SERVER_KEY",
  );
}

const serviceClient = createClient(SUPABASE_URL, SUPABASE_SERVICE_ROLE_KEY, {
  auth: {
    persistSession: false,
    autoRefreshToken: false,
  },
});

const authClient = createClient(SUPABASE_URL, SUPABASE_ANON_KEY, {
  auth: {
    persistSession: false,
    autoRefreshToken: false,
  },
});

const encoder = new TextEncoder();
const VOUCHER_CODE_PATTERN = /^[A-Z0-9-]{4,32}$/;
const ACTIVE_VOUCHER_REDEMPTION_STATUSES = ["reserved", "applied"];

const SUBSCRIPTION_PLAN_PRESETS = [
  { tier: "monthly", price_idr: 50000 },
  { tier: "yearly", price_idr: 250000 },
  { tier: "lifetime", price_idr: 750000 },
] as const;

const SUBSCRIPTION_PRICE_BY_TIER = Object.freeze(
  SUBSCRIPTION_PLAN_PRESETS.reduce<Record<string, number>>((acc, plan) => {
    acc[plan.tier] = plan.price_idr;
    return acc;
  }, {}),
);
const VALID_RENDER_MODES = new Set(["render", "test"]);
const VALID_RENDER_STATUSES = new Set(["running", "success", "failed", "stopped"]);

class HttpError extends Error {
  statusCode: number;

  constructor(statusCode: number, message: string) {
    super(message);
    this.name = "HttpError";
    this.statusCode = statusCode;
  }
}

const json = (status: number, body: Record<string, JsonValue>) =>
  new Response(JSON.stringify(body), {
    status,
    headers: {
      "Content-Type": "application/json",
      "Cache-Control": "no-store",
      "Access-Control-Allow-Origin": "*",
      "Access-Control-Allow-Headers": "authorization, content-type",
      "Access-Control-Allow-Methods": "GET, POST, OPTIONS",
    },
  });

const digestHex = async (algorithm: "SHA-256" | "SHA-512", value: string): Promise<string> => {
  const digest = await crypto.subtle.digest(algorithm, encoder.encode(value));
  return Array.from(new Uint8Array(digest))
    .map((byte) => byte.toString(16).padStart(2, "0"))
    .join("");
};

const parseJsonBody = async (request: Request): Promise<Record<string, JsonValue>> => {
  try {
    return (await request.json()) as Record<string, JsonValue>;
  } catch {
    throw new HttpError(400, "Invalid JSON payload");
  }
};

const ROUTE_MARKERS = ["/subscription-api", "/subscription"];

const normalizeRoutePath = (value: string): string => {
  let route = value;
  if (!route) route = "/";
  if (!route.startsWith("/")) route = `/${route}`;
  return route;
};

const getRoutePath = (request: Request): string => {
  const { pathname } = new URL(request.url);

  for (const marker of ROUTE_MARKERS) {
    const idx = pathname.indexOf(marker);
    if (idx >= 0) {
      return normalizeRoutePath(pathname.slice(idx + marker.length));
    }
  }

  return normalizeRoutePath(pathname);
};

const getBearerToken = (request: Request): string => {
  const authHeader = String(request.headers.get("authorization") || "").trim();
  if (!authHeader.toLowerCase().startsWith("bearer ")) {
    throw new HttpError(401, "Missing bearer token");
  }

  const token = authHeader.slice(7).trim();
  if (!token) {
    throw new HttpError(401, "Missing bearer token");
  }

  return token;
};

const authenticateUser = async (request: Request, opts?: { allowAnonymousHealth?: boolean }) => {
  // Allow /health endpoint to be accessed without Authorization
  if (opts?.allowAnonymousHealth) {
    const route = getRoutePath(request);
    if (request.method === "GET" && route === "/health") {
      return { token: null, user: null };
    }
  }
  const token = getBearerToken(request);
  const { data, error } = await authClient.auth.getUser(token);
  if (error || !data?.user?.id) {
    throw new HttpError(401, "Session expired or invalid.");
  }
  return {
    token,
    user: data.user,
  };
};

const normalizePlanWithCanonicalPrice = (plan: Record<string, JsonValue>) => {
  const tier = String(plan.tier || "").toLowerCase();
  const canonicalPrice = SUBSCRIPTION_PRICE_BY_TIER[tier];

  if (!canonicalPrice) {
    return {
      ...plan,
      price_idr: Number(plan.price_idr || 0),
    };
  }

  return {
    ...plan,
    price_idr: canonicalPrice,
  };
};

const resolvePlanAmountIdr = (plan: Record<string, JsonValue>) => {
  const tier = String(plan.tier || "").toLowerCase();
  const canonicalPrice = SUBSCRIPTION_PRICE_BY_TIER[tier];

  if (canonicalPrice) {
    return canonicalPrice;
  }

  return Number(plan.price_idr || 0);
};

const fetchActivePlanById = async (planId: string): Promise<Record<string, JsonValue>> => {
  const { data, error } = await serviceClient
    .from("plans")
    .select("id,code,name,tier,billing_cycle_months,price_idr,is_active")
    .eq("id", planId)
    .eq("is_active", true)
    .limit(1)
    .maybeSingle();

  if (error) {
    throw new HttpError(502, `Failed to fetch plan: ${error.message}`);
  }

  if (!data) {
    throw new HttpError(404, "Plan not found or inactive");
  }

  return normalizePlanWithCanonicalPrice(data as unknown as Record<string, JsonValue>);
};

const normalizeVoucherCode = (value: unknown) => {
  const normalized = String(value || "").trim().toUpperCase();
  if (!normalized) {
    return "";
  }

  if (!VOUCHER_CODE_PATTERN.test(normalized)) {
    throw new HttpError(400, "Format voucher tidak valid.");
  }

  return normalized;
};

const calculateVoucherDiscount = ({
  voucher,
  planAmountIdr,
}: {
  voucher: Record<string, JsonValue>;
  planAmountIdr: number;
}): VoucherDiscountResult => {
  const amount = Math.max(0, Number(planAmountIdr || 0));
  const type = String(voucher.discount_type || "").toLowerCase();
  const rawValue = Number(voucher.discount_value || 0);

  let discountIdr = 0;
  if (type === "percentage") {
    discountIdr = Math.round((amount * rawValue) / 100);
  } else if (type === "fixed_amount") {
    discountIdr = Math.round(rawValue);
  }

  const maxDiscount = Number(voucher.max_discount_idr);
  if (Number.isFinite(maxDiscount) && maxDiscount >= 0) {
    discountIdr = Math.min(discountIdr, Math.round(maxDiscount));
  }

  discountIdr = Math.max(0, Math.min(discountIdr, amount));
  return {
    discountIdr,
    finalAmountIdr: Math.max(0, amount - discountIdr),
  };
};

const resolveVoucherForCheckout = async ({
  userId,
  plan,
  rawVoucherCode,
}: {
  userId: string;
  plan: Record<string, JsonValue>;
  rawVoucherCode: unknown;
}): Promise<CheckoutVoucher | null> => {
  const voucherCode = normalizeVoucherCode(rawVoucherCode);
  if (!voucherCode) {
    return null;
  }

  const { data: voucherRows, error: voucherError } = await serviceClient
    .from("vouchers")
    .select("id,code,name,description,discount_type,discount_value,max_discount_idr,min_purchase_idr,max_redemptions,per_user_limit,starts_at,ends_at,is_active,allowed_tiers")
    .eq("code", voucherCode)
    .eq("is_active", true)
    .limit(1);

  if (voucherError) {
    throw new HttpError(502, `Failed to fetch voucher: ${voucherError.message}`);
  }

  const voucher = Array.isArray(voucherRows) ? (voucherRows[0] as Record<string, JsonValue> | undefined) : undefined;
  if (!voucher) {
    throw new HttpError(404, "Voucher tidak ditemukan atau sudah tidak aktif.");
  }

  const now = Date.now();
  const startsAtMs = Date.parse(String(voucher.starts_at || ""));
  const endsAtMs = Date.parse(String(voucher.ends_at || ""));

  if (Number.isFinite(startsAtMs) && now < startsAtMs) {
    throw new HttpError(400, "Voucher belum dapat digunakan.");
  }

  if (Number.isFinite(endsAtMs) && now > endsAtMs) {
    throw new HttpError(400, "Voucher sudah kedaluwarsa.");
  }

  const allowedTiers = Array.isArray(voucher.allowed_tiers)
    ? voucher.allowed_tiers.map((entry) => String(entry || "").toLowerCase()).filter(Boolean)
    : [];
  const planTier = String(plan.tier || "").toLowerCase();
  if (allowedTiers.length > 0 && !allowedTiers.includes(planTier)) {
    throw new HttpError(400, "Voucher tidak berlaku untuk paket yang dipilih.");
  }

  const planAmountIdr = resolvePlanAmountIdr(plan);
  const minPurchaseIdr = Math.max(0, Number(voucher.min_purchase_idr || 0));
  if (planAmountIdr < minPurchaseIdr) {
    throw new HttpError(400, `Voucher berlaku untuk minimum belanja Rp${minPurchaseIdr.toLocaleString("id-ID")}.`);
  }

  const { discountIdr, finalAmountIdr } = calculateVoucherDiscount({
    voucher,
    planAmountIdr,
  });

  if (discountIdr <= 0) {
    throw new HttpError(400, "Voucher tidak menghasilkan potongan harga untuk paket ini.");
  }

  const maxRedemptions = Number(voucher.max_redemptions);
  if (Number.isFinite(maxRedemptions) && maxRedemptions > 0) {
    const { count, error } = await serviceClient
      .from("voucher_redemptions")
      .select("id", { count: "exact", head: true })
      .eq("voucher_id", String(voucher.id))
      .in("status", ACTIVE_VOUCHER_REDEMPTION_STATUSES);

    if (error) {
      throw new HttpError(502, `Failed to check voucher quota: ${error.message}`);
    }

    if (Number(count || 0) >= maxRedemptions) {
      throw new HttpError(400, "Kuota voucher sudah habis.");
    }
  }

  const perUserLimit = Number(voucher.per_user_limit || 1);
  if (Number.isFinite(perUserLimit) && perUserLimit > 0) {
    const { count, error } = await serviceClient
      .from("voucher_redemptions")
      .select("id", { count: "exact", head: true })
      .eq("voucher_id", String(voucher.id))
      .eq("user_id", userId)
      .in("status", ACTIVE_VOUCHER_REDEMPTION_STATUSES);

    if (error) {
      throw new HttpError(502, `Failed to check voucher usage: ${error.message}`);
    }

    if (Number(count || 0) >= perUserLimit) {
      throw new HttpError(400, "Batas penggunaan voucher untuk akun ini sudah tercapai.");
    }
  }

  return {
    voucher,
    voucherCode,
    planAmountIdr,
    discountIdr,
    finalAmountIdr,
  };
};

const reserveVoucherRedemption = async ({
  checkoutVoucher,
  userId,
  invoiceId,
  orderId,
}: {
  checkoutVoucher: CheckoutVoucher;
  userId: string;
  invoiceId: string;
  orderId: string;
}) => {
  const { error } = await serviceClient
    .from("voucher_redemptions")
    .insert([
      {
        voucher_id: String(checkoutVoucher.voucher.id),
        user_id: userId,
        invoice_id: invoiceId,
        order_id: orderId,
        voucher_code: checkoutVoucher.voucherCode,
        status: "reserved",
        base_amount_idr: checkoutVoucher.planAmountIdr,
        discount_idr: checkoutVoucher.discountIdr,
        final_amount_idr: checkoutVoucher.finalAmountIdr,
        metadata: {
          source: "subscription-api",
        },
      },
    ]);

  if (error) {
    throw new HttpError(502, `Failed to reserve voucher redemption: ${error.message}`);
  }
};

const createCheckoutOrderId = () => {
  const stamp = Date.now();
  const salt = Math.floor(Math.random() * 1_000_000)
    .toString()
    .padStart(6, "0");
  return `ORDER-SUB-${stamp}-${salt}`;
};

const createMidtransTransaction = async ({
  payload,
}: {
  payload: Record<string, JsonValue>;
}) => {
  const baseUrl = MIDTRANS_IS_PRODUCTION
    ? "https://app.midtrans.com/snap/v1/transactions"
    : "https://app.sandbox.midtrans.com/snap/v1/transactions";

  const basicAuth = btoa(`${MIDTRANS_SERVER_KEY}:`);
  const response = await fetch(baseUrl, {
    method: "POST",
    headers: {
      Accept: "application/json",
      "Content-Type": "application/json",
      Authorization: `Basic ${basicAuth}`,
    },
    body: JSON.stringify(payload),
  });

  const raw = await response.text();
  let data: Record<string, JsonValue> | null = null;
  try {
    data = raw ? (JSON.parse(raw) as Record<string, JsonValue>) : null;
  } catch {
    data = { raw };
  }

  if (!response.ok) {
    throw new HttpError(502, `Midtrans checkout request failed (${response.status}): ${JSON.stringify(data)}`);
  }

  if (!data?.redirect_url || !data?.token) {
    throw new HttpError(502, `Midtrans response is missing redirect_url/token: ${JSON.stringify(data)}`);
  }

  return data;
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

const invokeProcessMidtransWebhook = async (payload: MidtransNotification) => {
  const idempotencyKey = await buildIdempotencyKey(payload);

  const { data, error } = await serviceClient.rpc("process_midtrans_webhook", {
    p_payload: payload,
    p_idempotency_key: idempotencyKey,
  });

  if (error) {
    throw new HttpError(500, `Failed to process webhook: ${error.message}`);
  }

  return {
    idempotencyKey,
    result: data as JsonValue,
  };
};

const verifyMidtransPayment = async ({
  orderId,
}: {
  orderId: string;
}): Promise<{ data: MidtransNotification; source: string } | null> => {
  const candidates = MIDTRANS_IS_PRODUCTION
    ? [
      { label: "production", baseUrl: "https://api.midtrans.com/v2" },
      { label: "sandbox", baseUrl: "https://api.sandbox.midtrans.com/v2" },
    ]
    : [
      { label: "sandbox", baseUrl: "https://api.sandbox.midtrans.com/v2" },
      { label: "production", baseUrl: "https://api.midtrans.com/v2" },
    ];

  const basicAuth = btoa(`${MIDTRANS_SERVER_KEY}:`);

  for (const candidate of candidates) {
    const response = await fetch(`${candidate.baseUrl}/${orderId}/status`, {
      method: "GET",
      headers: {
        Accept: "application/json",
        Authorization: `Basic ${basicAuth}`,
      },
    });

    if (response.status === 404) {
      continue;
    }

    const raw = await response.text();
    let data: MidtransNotification | null = null;
    try {
      data = raw ? (JSON.parse(raw) as MidtransNotification) : null;
    } catch {
      data = { order_id: orderId };
    }

    if (!response.ok || !data) {
      throw new HttpError(
        502,
        `Midtrans status request failed on ${candidate.label} (${response.status}): ${raw}`,
      );
    }

    return {
      data,
      source: candidate.label,
    };
  }

  return null;
};

const handleVoucherValidate = async (request: Request) => {
  const { user } = await authenticateUser(request);
  const body = await parseJsonBody(request);

  const planId = String(body.planId || "").trim();
  if (!planId) {
    throw new HttpError(400, "planId is required");
  }

  const plan = await fetchActivePlanById(planId);
  const checkoutVoucher = await resolveVoucherForCheckout({
    userId: user.id,
    plan,
    rawVoucherCode: body.voucherCode,
  });

  if (!checkoutVoucher) {
    throw new HttpError(400, "voucherCode is required");
  }

  return json(200, {
    valid: true,
    voucher: {
      id: String(checkoutVoucher.voucher.id),
      code: String(checkoutVoucher.voucher.code),
      name: String(checkoutVoucher.voucher.name || ""),
      description: String(checkoutVoucher.voucher.description || ""),
      discountType: String(checkoutVoucher.voucher.discount_type || ""),
      discountValue: Number(checkoutVoucher.voucher.discount_value || 0),
      maxDiscountIdr: Number(checkoutVoucher.voucher.max_discount_idr || 0),
      minPurchaseIdr: Number(checkoutVoucher.voucher.min_purchase_idr || 0),
      planAmountIdr: checkoutVoucher.planAmountIdr,
      discountIdr: checkoutVoucher.discountIdr,
      finalAmountIdr: checkoutVoucher.finalAmountIdr,
    },
  });
};

const handleCheckout = async (request: Request) => {
  const { user } = await authenticateUser(request);
  const body = await parseJsonBody(request);

  const planId = String(body.planId || "").trim();
  if (!planId) {
    throw new HttpError(400, "planId is required");
  }

  const voucherCode = body.voucherCode;
  const plan = await fetchActivePlanById(planId);
  const planAmount = resolvePlanAmountIdr(plan);

  const checkoutVoucher = await resolveVoucherForCheckout({
    userId: user.id,
    plan,
    rawVoucherCode: voucherCode,
  });

  const payableAmount = checkoutVoucher?.finalAmountIdr ?? planAmount;

  const { data: membershipRows, error: membershipError } = await serviceClient
    .from("memberships")
    .upsert(
      [
        {
          user_id: user.id,
          plan_id: String(plan.id),
          status: "pending_payment",
          source: "midtrans",
        },
      ],
      { onConflict: "user_id" },
    )
    .select("id")
    .limit(1);

  if (membershipError) {
    throw new HttpError(502, `Unable to upsert membership: ${membershipError.message}`);
  }

  const membership = Array.isArray(membershipRows) ? membershipRows[0] : null;
  if (!membership?.id) {
    throw new HttpError(502, "Unable to upsert membership");
  }

  const orderId = createCheckoutOrderId();
  const { data: invoiceRows, error: invoiceError } = await serviceClient
    .from("invoices")
    .insert([
      {
        user_id: user.id,
        membership_id: String(membership.id),
        provider: "midtrans",
        external_order_id: orderId,
        currency: "IDR",
        amount_idr: payableAmount,
        status: "open",
        raw_payload: {
          source: "subscription-api",
          plan_id: String(plan.id),
          plan_code: String(plan.code),
          voucher: checkoutVoucher
            ? {
              id: String(checkoutVoucher.voucher.id),
              code: checkoutVoucher.voucherCode,
              discount_type: String(checkoutVoucher.voucher.discount_type || ""),
              discount_value: Number(checkoutVoucher.voucher.discount_value || 0),
              discount_idr: checkoutVoucher.discountIdr,
              base_amount_idr: planAmount,
              final_amount_idr: checkoutVoucher.finalAmountIdr,
            }
            : null,
        },
      },
    ])
    .select("id")
    .limit(1);

  if (invoiceError) {
    throw new HttpError(502, `Unable to create invoice: ${invoiceError.message}`);
  }

  const invoice = Array.isArray(invoiceRows) ? invoiceRows[0] : null;
  if (!invoice?.id) {
    throw new HttpError(502, "Unable to create invoice");
  }

  if (checkoutVoucher) {
    await reserveVoucherRedemption({
      checkoutVoucher,
      userId: user.id,
      invoiceId: String(invoice.id),
      orderId,
    });
  }

  const displayName =
    user.user_metadata?.full_name
    || user.email?.split("@")[0]
    || "Customer";

  const midtransPayload: Record<string, JsonValue> = {
    transaction_details: {
      order_id: orderId,
      gross_amount: payableAmount,
    },
    customer_details: {
      first_name: displayName,
      email: user.email || "",
    },
    item_details: [
      {
        id: checkoutVoucher ? `${String(plan.code)}-discounted` : String(plan.code),
        name: checkoutVoucher ? `${String(plan.name)} + Voucher` : String(plan.name),
        price: payableAmount,
        quantity: 1,
      },
    ],
    custom_expiry: {
      expiry_duration: 60,
      unit: "minute",
    },
  };

  const midtransResponse = await createMidtransTransaction({
    payload: midtransPayload,
  });

  const { error: patchInvoiceError } = await serviceClient
    .from("invoices")
    .update({
      raw_payload: {
        source: "subscription-api",
        plan_id: String(plan.id),
        plan_code: String(plan.code),
        voucher: checkoutVoucher
          ? {
            id: String(checkoutVoucher.voucher.id),
            code: checkoutVoucher.voucherCode,
            discount_type: String(checkoutVoucher.voucher.discount_type || ""),
            discount_value: Number(checkoutVoucher.voucher.discount_value || 0),
            discount_idr: checkoutVoucher.discountIdr,
            base_amount_idr: planAmount,
            final_amount_idr: checkoutVoucher.finalAmountIdr,
          }
          : null,
        midtrans: midtransResponse,
      },
    })
    .eq("id", String(invoice.id));

  if (patchInvoiceError) {
    throw new HttpError(502, `Failed to patch invoice payload: ${patchInvoiceError.message}`);
  }

  return json(200, {
    orderId,
    invoiceId: String(invoice.id),
    membershipId: String(membership.id),
    token: String(midtransResponse.token || ""),
    redirectUrl: String(midtransResponse.redirect_url || ""),
    midtransMode: MIDTRANS_IS_PRODUCTION ? "production" : "sandbox",
    midtransClientKey: MIDTRANS_CLIENT_KEY,
    voucher: checkoutVoucher
      ? {
        code: checkoutVoucher.voucherCode,
        discountIdr: checkoutVoucher.discountIdr,
        baseAmountIdr: planAmount,
        finalAmountIdr: checkoutVoucher.finalAmountIdr,
      }
      : null,
  });
};

const handleVerifyPayment = async (request: Request) => {
  await authenticateUser(request);
  const body = await parseJsonBody(request);

  const directNotification = body.notification as MidtransNotification | undefined;
  const orderIdFromNotification = directNotification?.order_id
    ? String(directNotification.order_id).trim()
    : "";
  const orderId = String(body.order_id || orderIdFromNotification || "").trim();

  if (!orderId) {
    throw new HttpError(400, "order_id is required");
  }

  const verification = await verifyMidtransPayment({ orderId });
  if (!verification?.data) {
    throw new HttpError(
      404,
      "Transaction not found in Midtrans status API (cek MIDTRANS_IS_PRODUCTION dan server key).",
    );
  }

  const processResult = await invokeProcessMidtransWebhook(verification.data);

  return json(200, {
    ok: true,
    source: verification.source,
    orderId,
    idempotency_key: processResult.idempotencyKey,
    result: processResult.result,
  });
};

const normalizeOptionalIsoTimestamp = (value: unknown, label: string) => {
  const raw = String(value || "").trim();
  if (!raw) {
    return null;
  }

  const timestampMs = Date.parse(raw);
  if (!Number.isFinite(timestampMs)) {
    throw new HttpError(400, `${label} must be a valid ISO datetime`);
  }

  return new Date(timestampMs).toISOString();
};

const handleRenderSync = async (request: Request) => {
  const { user } = await authenticateUser(request);
  const body = await parseJsonBody(request);

  const jobId = String(body.jobId || body.job_id || "").trim();
  const mode = String(body.mode || "").trim().toLowerCase();
  const status = String(body.status || "").trim().toLowerCase();

  if (!jobId) {
    throw new HttpError(400, "jobId is required");
  }

  if (!VALID_RENDER_MODES.has(mode)) {
    throw new HttpError(400, "mode must be one of: render, test");
  }

  if (!VALID_RENDER_STATUSES.has(status)) {
    throw new HttpError(400, "status must be one of: running, success, failed, stopped");
  }

  const { data: existingRow, error: existingError } = await serviceClient
    .from("render_jobs")
    .select("id,status")
    .eq("job_id", jobId)
    .limit(1)
    .maybeSingle();

  if (existingError) {
    throw new HttpError(502, `Failed to read render job: ${existingError.message}`);
  }

  const payload = {
    job_id: jobId,
    user_id: user.id,
    mode,
    input_path: String(body.inputPath || body.input_path || "").trim() || null,
    output_path: String(body.outputPath || body.output_path || "").trim() || null,
    file_name: String(body.fileName || body.file_name || "").trim() || null,
    status,
    started_at: normalizeOptionalIsoTimestamp(body.startedAt || body.started_at, "startedAt"),
    finished_at: normalizeOptionalIsoTimestamp(body.finishedAt || body.finished_at, "finishedAt"),
    error: String(body.error || "").trim() || null,
  };

  if (existingRow?.id) {
    const { error: updateError } = await serviceClient
      .from("render_jobs")
      .update(payload)
      .eq("id", String(existingRow.id));

    if (updateError) {
      throw new HttpError(502, `Failed to update render job: ${updateError.message}`);
    }
  } else {
    const { error: insertError } = await serviceClient
      .from("render_jobs")
      .insert([payload]);

    if (insertError) {
      throw new HttpError(502, `Failed to insert render job: ${insertError.message}`);
    }
  }

  if (status === "success" && String(existingRow?.status || "") !== "success") {
    const { error: incrementError } = await serviceClient.rpc("increment_user_render_total", {
      p_user_id: user.id,
    });

    if (incrementError) {
      throw new HttpError(502, `Failed to increment user render total: ${incrementError.message}`);
    }

    const { data: existingAuditLog, error: auditReadError } = await serviceClient
      .from("audit_logs")
      .select("id")
      .eq("actor_user_id", user.id)
      .eq("entity_type", "render_job")
      .eq("action", "render_success")
      .eq("request_id", jobId)
      .limit(1)
      .maybeSingle();

    if (auditReadError) {
      throw new HttpError(502, `Failed to read render audit log: ${auditReadError.message}`);
    }

    if (!existingAuditLog) {
      const { error: auditInsertError } = await serviceClient
        .from("audit_logs")
        .insert([
          {
            actor_user_id: user.id,
            actor_role: "user",
            entity_type: "render_job",
            entity_id: jobId,
            action: "render_success",
            after_state: {
              mode,
              file_name: payload.file_name,
              output_path: payload.output_path,
              started_at: payload.started_at,
              finished_at: payload.finished_at,
            },
            request_id: jobId,
          },
        ]);

      if (auditInsertError) {
        throw new HttpError(502, `Failed to insert render audit log: ${auditInsertError.message}`);
      }
    }
  }

  const { data: statsRow, error: statsError } = await serviceClient
    .from("user_render_stats")
    .select("completed_projects_total,last_completed_at")
    .eq("user_id", user.id)
    .limit(1)
    .maybeSingle();

  if (statsError) {
    throw new HttpError(502, `Failed to read user render stats: ${statsError.message}`);
  }

  return json(200, {
    ok: true,
    jobId,
    status,
    completedProjectsTotal: Number(statsRow?.completed_projects_total || 0),
    lastCompletedAt: String(statsRow?.last_completed_at || ""),
  });
};

const handleRenderSummary = async (request: Request) => {
  const { user } = await authenticateUser(request);

  const { data: statsRow, error: statsError } = await serviceClient
    .from("user_render_stats")
    .select("completed_projects_total,last_completed_at")
    .eq("user_id", user.id)
    .limit(1)
    .maybeSingle();

  if (statsError) {
    throw new HttpError(502, `Failed to read user render stats: ${statsError.message}`);
  }

  if (statsRow && Number.isFinite(Number(statsRow.completed_projects_total))) {
    return json(200, {
      ok: true,
      completedProjectsTotal: Number(statsRow.completed_projects_total || 0),
      lastCompletedAt: String(statsRow.last_completed_at || ""),
      source: "user_render_stats",
    });
  }

  const { count, error: auditCountError } = await serviceClient
    .from("audit_logs")
    .select("id", { count: "exact", head: true })
    .eq("actor_user_id", user.id)
    .eq("entity_type", "render_job")
    .eq("action", "render_success");

  if (auditCountError) {
    throw new HttpError(502, `Failed to count render audit logs: ${auditCountError.message}`);
  }

  return json(200, {
    ok: true,
    completedProjectsTotal: Number(count || 0),
    lastCompletedAt: "",
    source: "audit_logs",
  });
};

const handleWebhook = async (request: Request) => {
  const body = await parseJsonBody(request);
  const payload = body as MidtransNotification;

  if (!payload.order_id || !payload.status_code || !payload.gross_amount || !payload.signature_key) {
    throw new HttpError(400, "Missing required Midtrans fields");
  }

  const expectedSignature = await digestHex("SHA-512", buildMidtransSignatureBase(payload));
  const incomingSignature = String(payload.signature_key).toLowerCase();

  if (!timingSafeEqual(expectedSignature, incomingSignature)) {
    throw new HttpError(401, "Invalid signature");
  }

  const processResult = await invokeProcessMidtransWebhook(payload);

  return json(200, {
    ok: true,
    idempotency_key: processResult.idempotencyKey,
    result: processResult.result,
  });
};

Deno.serve(async (request) => {
  if (request.method === "OPTIONS") {
    return json(200, { ok: true });
  }

  try {
    const routePath = getRoutePath(request);

    // Allow /health endpoint to be accessed without Authorization
    if (request.method === "GET" && routePath === "/health") {
      return json(200, {
        ok: true,
        service: "subscription-api",
        mode: MIDTRANS_IS_PRODUCTION ? "production" : "sandbox",
      });
    }

    // All other endpoints require authentication
    if (
      request.method === "POST"
      && ["/voucher/validate", "/voucher/check", "/voucher/claim"].includes(routePath)
    ) {
      await authenticateUser(request); // enforce auth
      return await handleVoucherValidate(request);
    }

    if (request.method === "POST" && routePath === "/checkout") {
      await authenticateUser(request); // enforce auth
      return await handleCheckout(request);
    }

    if (request.method === "POST" && routePath === "/verify-payment") {
      await authenticateUser(request); // enforce auth
      return await handleVerifyPayment(request);
    }

    if (request.method === "POST" && routePath === "/render/sync") {
      await authenticateUser(request); // enforce auth
      return await handleRenderSync(request);
    }

    if (request.method === "GET" && routePath === "/render/summary") {
      await authenticateUser(request); // enforce auth
      return await handleRenderSummary(request);
    }

    if (request.method === "POST" && routePath === "/webhook") {
      // Midtrans webhook does not send Supabase bearer token.
      // Security is enforced by Midtrans signature verification in handleWebhook().
      return await handleWebhook(request);
    }

    return json(404, { error: "Not found", route: routePath });
  } catch (error) {
    if (error instanceof HttpError) {
      return json(error.statusCode, { error: error.message });
    }

    return json(500, {
      error: error instanceof Error ? error.message : String(error),
    });
  }
});
