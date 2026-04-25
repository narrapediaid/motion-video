import { createClient } from "https://esm.sh/@supabase/supabase-js@2.49.4";

type JsonValue =
  | string
  | number
  | boolean
  | null
  | JsonValue[]
  | { [key: string]: JsonValue };

type SakurupiahPayload = {
  trx_id?: string;
  merchant_ref?: string;
  status?: string;
  status_kode?: number | string;
  payment_kode?: string;
  method?: string;
  via?: string;
  amount?: number | string;
  total?: number | string;
  checkout_url?: string;
  payment_no?: number | string;
  qr?: string;
  transaction_time?: string;
  settlement_time?: string;
  event?: string;
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

type RenderTicketPayload = {
  v: number;
  ticketId: string;
  userId: string;
  mode: string;
  issuedAtMs: number;
  expiresAtMs: number;
};

type ActiveRenderJobAuthorization = {
  ticketId: string;
  userId: string;
  mode: string;
  expiresAtMs: number;
};

const SUPABASE_URL = Deno.env.get("SUPABASE_URL")?.trim();
const SUPABASE_SERVICE_ROLE_KEY = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")?.trim();
const SUPABASE_ANON_KEY =
  Deno.env.get("SUPABASE_ANON_KEY")?.trim()
  || Deno.env.get("SUPABASE_PUBLISHABLE_KEY")?.trim()
  || SUPABASE_SERVICE_ROLE_KEY;
const SAKURUPIAH_API_ID = Deno.env.get("SAKURUPIAH_API_ID")?.trim();
const SAKURUPIAH_API_KEY = Deno.env.get("SAKURUPIAH_API_KEY")?.trim();
const SAKURUPIAH_CALLBACK_URL = Deno.env.get("SAKURUPIAH_CALLBACK_URL")?.trim();
const SAKURUPIAH_RETURN_URL = Deno.env.get("SAKURUPIAH_RETURN_URL")?.trim();
const SAKURUPIAH_IS_PRODUCTION = ["1", "true", "yes"].includes(
  String(Deno.env.get("SAKURUPIAH_IS_PRODUCTION") || "").trim().toLowerCase(),
);
const SAKURUPIAH_MERCHANT_FEE = String(Deno.env.get("SAKURUPIAH_MERCHANT_FEE") || "1").trim() || "1";
const SAKURUPIAH_DEFAULT_EXPIRED_HOURS = Math.max(
  1,
  Math.min(168, Number.parseInt(String(Deno.env.get("SAKURUPIAH_DEFAULT_EXPIRED_HOURS") || "24"), 10) || 24),
);

if (
  !SUPABASE_URL
  || !SUPABASE_SERVICE_ROLE_KEY
  || !SUPABASE_ANON_KEY
  || !SAKURUPIAH_API_ID
  || !SAKURUPIAH_API_KEY
  || !SAKURUPIAH_CALLBACK_URL
) {
  throw new Error(
    "Missing required env: SUPABASE_URL, SUPABASE_SERVICE_ROLE_KEY, SUPABASE_ANON_KEY, SAKURUPIAH_API_ID, SAKURUPIAH_API_KEY, SAKURUPIAH_CALLBACK_URL",
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
const ACTIVE_MEMBERSHIP_STATUSES = new Set(["active", "lifetime_active"]);
const RENDER_GATE_SECRET = Deno.env.get("RENDER_GATE_SECRET")?.trim() || SUPABASE_SERVICE_ROLE_KEY;
const RENDER_TICKET_TTL_SECONDS = Math.max(
  30,
  Math.min(900, Number.parseInt(String(Deno.env.get("RENDER_TICKET_TTL_SECONDS") || "120"), 10) || 120),
);
const RENDER_TICKET_GRACE_SECONDS = Math.max(
  0,
  Math.min(120, Number.parseInt(String(Deno.env.get("RENDER_TICKET_GRACE_SECONDS") || "15"), 10) || 15),
);
const RENDER_GATE_ENFORCE = !["0", "false", "no", "off"].includes(
  String(Deno.env.get("RENDER_GATE_ENFORCE") || "true").trim().toLowerCase(),
);
const renderAuthorizeTickets = new Map<string, RenderTicketPayload>();
const activeRenderJobs = new Map<string, ActiveRenderJobAuthorization>();

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
      "Access-Control-Allow-Headers": "authorization, content-type, x-callback-signature, x-callback-event",
      "Access-Control-Allow-Methods": "GET, POST, OPTIONS",
    },
  });

const html = (status: number, body: string) =>
  new Response(body, {
    status,
    headers: {
      "Content-Type": "text/html; charset=utf-8",
      "Cache-Control": "no-store",
      "Access-Control-Allow-Origin": "*",
    },
  });

const digestHex = async (algorithm: "SHA-256" | "SHA-512", value: string): Promise<string> => {
  const digest = await crypto.subtle.digest(algorithm, encoder.encode(value));
  return Array.from(new Uint8Array(digest))
    .map((byte) => byte.toString(16).padStart(2, "0"))
    .join("");
};

const hmacHex = async (algorithm: "SHA-256", secret: string, value: string): Promise<string> => {
  const key = await crypto.subtle.importKey(
    "raw",
    encoder.encode(secret),
    { name: "HMAC", hash: algorithm },
    false,
    ["sign"],
  );
  const signature = await crypto.subtle.sign("HMAC", key, encoder.encode(value));
  return Array.from(new Uint8Array(signature))
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
  route = route.replace(/\/{2,}/g, "/");
  if (route.length > 1) {
    route = route.replace(/\/+$/, "");
  }
  return route || "/";
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

const parseHttpUrl = (value: string): URL | null => {
  try {
    const url = new URL(value);
    return ["http:", "https:"].includes(url.protocol) ? url : null;
  } catch {
    return null;
  }
};

const isLocalOrPrivateHost = (hostname: string): boolean => {
  const host = hostname.trim().toLowerCase().replace(/^\[(.*)\]$/, "$1");
  if (!host || host === "localhost" || host === "::1" || host.endsWith(".local")) {
    return true;
  }
  if (/^(127|10|0)\./.test(host) || /^192\.168\./.test(host)) {
    return true;
  }
  const private172 = /^172\.(\d{1,2})\./.exec(host);
  return Boolean(private172 && Number(private172[1]) >= 16 && Number(private172[1]) <= 31);
};

const isValidProductionReturnUrl = (value: string): boolean => {
  const url = parseHttpUrl(value);
  return Boolean(url && url.protocol === "https:" && !isLocalOrPrivateHost(url.hostname));
};

const defaultSakurupiahReturnUrl = (requestUrl: URL): string => {
  if (SAKURUPIAH_RETURN_URL) {
    return SAKURUPIAH_RETURN_URL;
  }

  const callbackUrl = parseHttpUrl(SAKURUPIAH_CALLBACK_URL || "");
  if (callbackUrl) {
    callbackUrl.search = "";
    callbackUrl.hash = "";
    const basePath = (callbackUrl.pathname.replace(/\/(?:webhook|callback)\/?$/i, "") || "/subscription")
      .replace(/\/+$/, "");
    callbackUrl.pathname = `${basePath}/return`;
    return callbackUrl.toString();
  }

  return `${requestUrl.origin}/subscription/return`;
};

const resolveSakurupiahReturnUrl = (value: unknown, requestUrl: URL): string => {
  const fallback = defaultSakurupiahReturnUrl(requestUrl);
  const requested = String(value || "").trim();
  const candidate = requested || fallback;

  if (SAKURUPIAH_IS_PRODUCTION) {
    if (isValidProductionReturnUrl(candidate)) {
      return parseHttpUrl(candidate)?.toString() || candidate;
    }
    if (isValidProductionReturnUrl(fallback)) {
      return parseHttpUrl(fallback)?.toString() || fallback;
    }
    throw new HttpError(500, "SAKURUPIAH_RETURN_URL must be a public https URL in production.");
  }

  if (!parseHttpUrl(candidate)) {
    throw new HttpError(400, "returnUrl must be an absolute http(s) URL.");
  }
  return parseHttpUrl(candidate)?.toString() || candidate;
};

const renderPaymentReturnPage = (request: Request) => {
  const url = new URL(request.url);
  const orderId =
    url.searchParams.get("merchant_ref")
    || url.searchParams.get("order_id")
    || url.searchParams.get("orderId")
    || "";

  return html(200, `<!doctype html>
<html lang="id">
  <head>
    <meta charset="utf-8" />
    <meta name="viewport" content="width=device-width, initial-scale=1" />
    <title>Status Pembayaran</title>
    <style>
      :root { color-scheme: dark; }
      * { box-sizing: border-box; }
      body {
        min-height: 100vh;
        margin: 0;
        display: grid;
        place-items: center;
        padding: 24px;
        font-family: "Segoe UI", Arial, sans-serif;
        color: #e9f1ff;
        background:
          radial-gradient(70% 55% at 80% 0%, rgba(45, 212, 191, 0.16), transparent 70%),
          linear-gradient(145deg, #0c1a2d, #07101b 64%);
      }
      main {
        width: min(560px, 100%);
        border: 1px solid rgba(125, 189, 248, 0.28);
        border-radius: 18px;
        background: rgba(10, 22, 38, 0.92);
        box-shadow: 0 18px 42px rgba(0, 0, 0, 0.34);
        padding: 24px;
      }
      .eyebrow {
        margin: 0 0 8px;
        color: #7dd3fc;
        font-size: 12px;
        font-weight: 700;
        letter-spacing: 1px;
        text-transform: uppercase;
      }
      h1 {
        margin: 0;
        font-size: 1.55rem;
        line-height: 1.25;
      }
      p {
        color: #a9bad3;
        line-height: 1.6;
      }
      .order {
        margin: 16px 0;
        border: 1px dashed rgba(125, 189, 248, 0.38);
        border-radius: 12px;
        padding: 12px;
        color: #dff2ff;
        overflow-wrap: anywhere;
      }
      .actions {
        display: flex;
        gap: 10px;
        flex-wrap: wrap;
        margin-top: 18px;
      }
      button,
      a {
        border: 1px solid rgba(121, 189, 246, 0.55);
        border-radius: 12px;
        min-height: 42px;
        padding: 10px 14px;
        color: #dff2ff;
        background: rgba(45, 212, 191, 0.18);
        font: inherit;
        font-weight: 700;
        text-decoration: none;
        cursor: pointer;
      }
      .muted {
        background: rgba(7, 18, 31, 0.5);
        color: #a9bad3;
      }
    </style>
  </head>
  <body>
    <main>
      <p class="eyebrow">Sakurupiah</p>
      <h1>Pembayaran sedang diproses</h1>
      <p>Silakan kembali ke aplikasi Narrapedia reMotion Batch, lalu tekan tombol <strong>Cek Status</strong> pada invoice untuk memperbarui keanggotaan.</p>
      ${orderId ? `<div class="order">Order ID: ${orderId.replace(/[<>&"]/g, "")}</div>` : ""}
      <div class="actions">
        <button type="button" onclick="window.close()">Tutup Halaman</button>
        <a class="muted" href="https://narrapedia.top/tools/narrapedia-motion-batch">Buka Halaman Aplikasi</a>
      </div>
    </main>
  </body>
</html>`);
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

const toBase64Url = (value: string) =>
  btoa(value)
    .replace(/\+/g, "-")
    .replace(/\//g, "_")
    .replace(/=+$/g, "");

const fromBase64Url = (value: string) => {
  const normalized = value.replace(/-/g, "+").replace(/_/g, "/");
  const padded = normalized + "=".repeat((4 - (normalized.length % 4 || 4)) % 4);
  return atob(padded);
};

const encodeRenderTicketPayload = (payload: RenderTicketPayload): string => {
  return toBase64Url(JSON.stringify(payload));
};

const decodeRenderTicketPayload = (encoded: string): RenderTicketPayload => {
  try {
    return JSON.parse(fromBase64Url(encoded)) as RenderTicketPayload;
  } catch {
    throw new HttpError(401, "Invalid render ticket payload");
  }
};

const importRenderGateKey = async () => {
  return await crypto.subtle.importKey(
    "raw",
    encoder.encode(RENDER_GATE_SECRET),
    { name: "HMAC", hash: "SHA-256" },
    false,
    ["sign"],
  );
};

const hmacSignBase64Url = async (value: string): Promise<string> => {
  const key = await importRenderGateKey();
  const signatureBuffer = await crypto.subtle.sign("HMAC", key, encoder.encode(value));
  const signatureBytes = new Uint8Array(signatureBuffer);
  let binary = "";
  for (const byte of signatureBytes) {
    binary += String.fromCharCode(byte);
  }
  return toBase64Url(binary);
};

const pruneRenderGateState = () => {
  const now = Date.now();
  const graceMs = RENDER_TICKET_GRACE_SECONDS * 1000;

  for (const [ticketId, payload] of renderAuthorizeTickets.entries()) {
    if (payload.expiresAtMs + graceMs < now) {
      renderAuthorizeTickets.delete(ticketId);
    }
  }

  for (const [jobId, authorization] of activeRenderJobs.entries()) {
    if (authorization.expiresAtMs + graceMs < now) {
      activeRenderJobs.delete(jobId);
    }
  }
};

const issueRenderAuthorizeTicket = async ({
  userId,
  mode,
}: {
  userId: string;
  mode: string;
}) => {
  const now = Date.now();
  const payload: RenderTicketPayload = {
    v: 1,
    ticketId: crypto.randomUUID(),
    userId,
    mode,
    issuedAtMs: now,
    expiresAtMs: now + RENDER_TICKET_TTL_SECONDS * 1000,
  };
  const encodedPayload = encodeRenderTicketPayload(payload);
  const signature = await hmacSignBase64Url(encodedPayload);
  const ticket = `${encodedPayload}.${signature}`;

  pruneRenderGateState();
  renderAuthorizeTickets.set(payload.ticketId, payload);

  return {
    ticket,
    payload,
  };
};

const verifyRenderAuthorizeTicket = async ({
  ticket,
  userId,
  mode,
}: {
  ticket: string;
  userId: string;
  mode: string;
}): Promise<RenderTicketPayload> => {
  pruneRenderGateState();

  const normalizedTicket = String(ticket || "").trim();
  if (!normalizedTicket) {
    throw new HttpError(403, "Missing render job ticket");
  }

  const splitIndex = normalizedTicket.lastIndexOf(".");
  if (splitIndex <= 0) {
    throw new HttpError(401, "Invalid render job ticket format");
  }

  const encodedPayload = normalizedTicket.slice(0, splitIndex);
  const incomingSignature = normalizedTicket.slice(splitIndex + 1);
  const expectedSignature = await hmacSignBase64Url(encodedPayload);

  if (!timingSafeEqual(expectedSignature, incomingSignature)) {
    throw new HttpError(401, "Invalid render job ticket signature");
  }

  const payload = decodeRenderTicketPayload(encodedPayload);
  if (payload.v !== 1 || !payload.ticketId || !payload.userId || !payload.mode) {
    throw new HttpError(401, "Invalid render job ticket payload");
  }

  if (payload.userId !== userId) {
    throw new HttpError(403, "Render job ticket does not belong to this user");
  }

  if (payload.mode !== mode) {
    throw new HttpError(403, "Render job ticket mode mismatch");
  }

  const now = Date.now();
  if (payload.expiresAtMs + RENDER_TICKET_GRACE_SECONDS * 1000 < now) {
    throw new HttpError(401, "Render job ticket expired");
  }

  const serverSidePayload = renderAuthorizeTickets.get(payload.ticketId);
  if (!serverSidePayload) {
    throw new HttpError(401, "Render job ticket is unknown or already expired");
  }

  if (
    serverSidePayload.userId !== payload.userId
    || serverSidePayload.mode !== payload.mode
    || serverSidePayload.expiresAtMs !== payload.expiresAtMs
  ) {
    throw new HttpError(401, "Render job ticket has been revoked");
  }

  return payload;
};

const isMembershipRowActive = (membership: Record<string, JsonValue>) => {
  const status = String(membership.status || "").toLowerCase();
  if (!ACTIVE_MEMBERSHIP_STATUSES.has(status)) {
    return false;
  }

  if (status === "lifetime_active") {
    return true;
  }

  const now = Date.now();
  const graceEndsAtMs = Date.parse(String(membership.grace_ends_at || ""));
  const endsAtMs = Date.parse(String(membership.ends_at || ""));

  if (Number.isFinite(graceEndsAtMs)) {
    return graceEndsAtMs >= now;
  }

  if (Number.isFinite(endsAtMs)) {
    return endsAtMs >= now;
  }

  return true;
};

const requireActiveMembership = async (userId: string) => {
  const { data, error } = await serviceClient
    .from("memberships")
    .select("id,status,starts_at,ends_at,grace_ends_at,updated_at")
    .eq("user_id", userId)
    .order("updated_at", { ascending: false })
    .limit(10);

  if (error) {
    throw new HttpError(502, `Failed to read memberships: ${error.message}`);
  }

  const memberships = (Array.isArray(data) ? data : []) as Array<Record<string, JsonValue>>;
  const activeMembership = memberships.find((membership) => isMembershipRowActive(membership));

  if (!activeMembership) {
    throw new HttpError(403, "Active membership required. Please complete payment first.");
  }

  return activeMembership;
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

const timingSafeEqual = (left: string, right: string): boolean => {
  if (left.length !== right.length) return false;

  let mismatch = 0;
  for (let i = 0; i < left.length; i += 1) {
    mismatch |= left.charCodeAt(i) ^ right.charCodeAt(i);
  }

  return mismatch === 0;
};

const normalizeSakurupiahBaseUrl = () => {
  return SAKURUPIAH_IS_PRODUCTION
    ? "https://sakurupiah.id/api"
    : "https://sakurupiah.id/api-sanbox";
};

const normalizeSakurupiahPhone = (value: unknown) => {
  const phone = String(value || "").replace(/[\s\-()+.]/g, "").trim();
  if (!/^(?:0|62|60)\d{7,15}$/.test(phone)) {
    throw new HttpError(400, "Nomor HP wajib diisi dengan format Indonesia/Malaysia, contoh 08xxx atau 62xxx.");
  }
  return phone;
};

const normalizeSakurupiahPaymentMethod = (value: unknown) => {
  const method = String(value || "").trim();
  if (!/^[A-Za-z0-9_-]{2,32}$/.test(method)) {
    throw new HttpError(400, "paymentMethod Sakurupiah tidak valid.");
  }
  return method;
};

const parseSakurupiahJsonResponse = async (response: Response) => {
  const raw = await response.text();
  try {
    return raw ? (JSON.parse(raw) as Record<string, JsonValue>) : {};
  } catch {
    return { raw };
  }
};

const firstSakurupiahData = (data: Record<string, JsonValue>): Record<string, JsonValue> => {
  const rows = data.data;
  if (Array.isArray(rows) && rows.length > 0 && rows[0] && typeof rows[0] === "object") {
    return rows[0] as Record<string, JsonValue>;
  }
  return {};
};

const createSakurupiahInvoice = async ({
  orderId,
  paymentMethod,
  customerName,
  customerEmail,
  customerPhone,
  amountIdr,
  plan,
  returnUrl,
}: {
  orderId: string;
  paymentMethod: string;
  customerName: string;
  customerEmail: string;
  customerPhone: string;
  amountIdr: number;
  plan: Record<string, JsonValue>;
  returnUrl: string;
}) => {
  const amount = String(Math.round(amountIdr));
  const signature = await hmacHex(
    "SHA-256",
    SAKURUPIAH_API_KEY || "",
    `${SAKURUPIAH_API_ID}${paymentMethod}${orderId}${amount}`,
  );

  const params = new URLSearchParams();
  params.set("api_id", SAKURUPIAH_API_ID || "");
  params.set("method", paymentMethod);
  params.set("name", customerName || "Customer");
  params.set("email", customerEmail || "");
  params.set("phone", customerPhone);
  params.set("amount", amount);
  params.set("merchant_fee", SAKURUPIAH_MERCHANT_FEE);
  params.set("merchant_ref", orderId);
  params.set("expired", String(SAKURUPIAH_DEFAULT_EXPIRED_HOURS));
  params.append("produk[]", String(plan.name || plan.code || "Subscription"));
  params.append("qty[]", "1");
  params.append("harga[]", amount);
  params.append("size[]", String(plan.tier || "subscription"));
  params.append("note[]", `Plan ${String(plan.code || plan.id || "")}`);
  params.set("callback_url", SAKURUPIAH_CALLBACK_URL || "");
  params.set("return_url", returnUrl);
  params.set("signature", signature);

  const response = await fetch(`${normalizeSakurupiahBaseUrl()}/create.php`, {
    method: "POST",
    headers: {
      Accept: "application/json",
      "Content-Type": "application/x-www-form-urlencoded",
      Authorization: `Bearer ${SAKURUPIAH_API_KEY}`,
    },
    body: params.toString(),
  });

  const data = await parseSakurupiahJsonResponse(response);
  if (!response.ok || String(data.status || "") !== "200") {
    throw new HttpError(502, `Sakurupiah checkout request failed (${response.status}): ${JSON.stringify(data)}`);
  }

  const invoiceData = firstSakurupiahData(data);
  if (!invoiceData.checkout_url || !invoiceData.trx_id) {
    throw new HttpError(502, `Sakurupiah response is missing checkout_url/trx_id: ${JSON.stringify(data)}`);
  }

  return {
    response: data,
    invoice: invoiceData,
  };
};

const checkSakurupiahStatus = async (trxId: string) => {
  const params = new URLSearchParams();
  params.set("api_id", SAKURUPIAH_API_ID || "");
  params.set("method", "status");
  params.set("trx_id", trxId);

  const response = await fetch(`${normalizeSakurupiahBaseUrl()}/status-transaction.php`, {
    method: "POST",
    headers: {
      Accept: "application/json",
      "Content-Type": "application/x-www-form-urlencoded",
      Authorization: `Bearer ${SAKURUPIAH_API_KEY}`,
    },
    body: params.toString(),
  });

  const data = await parseSakurupiahJsonResponse(response);
  if (!response.ok || String(data.status || "") !== "200") {
    throw new HttpError(502, `Sakurupiah status request failed (${response.status}): ${JSON.stringify(data)}`);
  }

  return data;
};

const listSakurupiahPaymentChannels = async () => {
  const params = new URLSearchParams();
  params.set("api_id", SAKURUPIAH_API_ID || "");
  params.set("method", "list");

  const response = await fetch(`${normalizeSakurupiahBaseUrl()}/list-payment.php`, {
    method: "POST",
    headers: {
      Accept: "application/json",
      "Content-Type": "application/x-www-form-urlencoded",
      Authorization: `Bearer ${SAKURUPIAH_API_KEY}`,
    },
    body: params.toString(),
  });

  const data = await parseSakurupiahJsonResponse(response);
  if (!response.ok || String(data.status || "") !== "200") {
    throw new HttpError(502, `Sakurupiah channel request failed (${response.status}): ${JSON.stringify(data)}`);
  }

  const channels = Array.isArray(data.data)
    ? data.data.map((channel) => {
      const row = channel && typeof channel === "object" ? channel as Record<string, JsonValue> : {};
      return {
        code: String(row.kode || ""),
        name: String(row.nama || row.kode || ""),
        type: String(row.tipe || ""),
        min: Number(row.minimal || 0),
        max: Number(row.maksimal || 0),
        fee: String(row.biaya || ""),
        feeType: String(row.percent || ""),
        status: String(row.status || ""),
        logo: String(row.logo || ""),
      };
    }).filter((channel) => channel.code)
    : [];

  return json(200, {
    channels,
    source: "sakurupiah",
  });
};

const buildSakurupiahIdempotencyKey = async (payload: SakurupiahPayload): Promise<string> => {
  const stable = [
    payload.merchant_ref ?? "",
    payload.trx_id ?? "",
    payload.status ?? "",
    payload.status_kode ?? "",
    payload.event ?? "payment_status",
  ].join("|");

  return digestHex("SHA-256", stable);
};

const invokeProcessSakurupiahCallback = async (payload: SakurupiahPayload) => {
  const idempotencyKey = await buildSakurupiahIdempotencyKey(payload);

  const { data, error } = await serviceClient.rpc("process_sakurupiah_callback", {
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

  const paymentMethod = normalizeSakurupiahPaymentMethod(body.paymentMethod);
  const customerPhone = normalizeSakurupiahPhone(body.customerPhone);
  const requestUrl = new URL(request.url);
  const returnUrl = resolveSakurupiahReturnUrl(body.returnUrl, requestUrl);

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
          source: "sakurupiah",
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
        provider: "sakurupiah",
        external_order_id: orderId,
        currency: "IDR",
        amount_idr: payableAmount,
        status: "open",
        raw_payload: {
          source: "subscription-api",
          plan_id: String(plan.id),
          plan_code: String(plan.code),
          sakurupiah: {
            payment_method: paymentMethod,
            callback_url: SAKURUPIAH_CALLBACK_URL,
            return_url: returnUrl,
          },
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

  const sakurupiahResponse = await createSakurupiahInvoice({
    orderId,
    paymentMethod,
    customerName: String(displayName),
    customerEmail: user.email || "",
    customerPhone,
    amountIdr: payableAmount,
    plan,
    returnUrl,
  });

  const { error: patchInvoiceError } = await serviceClient
    .from("invoices")
    .update({
      raw_payload: {
        source: "subscription-api",
        plan_id: String(plan.id),
        plan_code: String(plan.code),
        sakurupiah: {
          payment_method: paymentMethod,
          trx_id: String(sakurupiahResponse.invoice.trx_id || ""),
          checkout_url: String(sakurupiahResponse.invoice.checkout_url || ""),
          payment_no: sakurupiahResponse.invoice.payment_no ?? null,
          qr: sakurupiahResponse.invoice.qr ?? null,
          via: sakurupiahResponse.invoice.via ?? null,
          payment_kode: sakurupiahResponse.invoice.payment_kode ?? paymentMethod,
          callback_url: SAKURUPIAH_CALLBACK_URL,
          return_url: returnUrl,
          response: sakurupiahResponse.response,
        },
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
    })
    .eq("id", String(invoice.id));

  if (patchInvoiceError) {
    throw new HttpError(502, `Failed to patch invoice payload: ${patchInvoiceError.message}`);
  }

  return json(200, {
    orderId,
    invoiceId: String(invoice.id),
    membershipId: String(membership.id),
    trxId: String(sakurupiahResponse.invoice.trx_id || ""),
    checkoutUrl: String(sakurupiahResponse.invoice.checkout_url || ""),
    redirectUrl: String(sakurupiahResponse.invoice.checkout_url || ""),
    paymentNo: sakurupiahResponse.invoice.payment_no ?? null,
    qr: sakurupiahResponse.invoice.qr ?? null,
    paymentMethod,
    sakurupiahMode: SAKURUPIAH_IS_PRODUCTION ? "production" : "sandbox",
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

  const directNotification = body.notification as SakurupiahPayload | undefined;
  const orderIdFromNotification = directNotification?.merchant_ref
    ? String(directNotification.merchant_ref).trim()
    : "";
  const orderId = String(body.order_id || body.merchant_ref || orderIdFromNotification || "").trim();

  if (!orderId) {
    throw new HttpError(400, "order_id is required");
  }

  if (directNotification && typeof directNotification === "object" && directNotification.merchant_ref) {
    const processResult = await invokeProcessSakurupiahCallback({
      ...directNotification,
      event: String(directNotification.event || "payment_status"),
    });

    return json(200, {
      ok: true,
      source: "direct-notification",
      orderId,
      idempotency_key: processResult.idempotencyKey,
      result: processResult.result,
    });
  }

  const { data: invoice, error } = await serviceClient
    .from("invoices")
    .select("id,external_order_id,amount_idr,raw_payload")
    .eq("external_order_id", orderId)
    .limit(1)
    .maybeSingle();

  if (error) {
    throw new HttpError(502, `Failed to read invoice: ${error.message}`);
  }

  const rawPayload = (invoice?.raw_payload || {}) as Record<string, JsonValue>;
  const sakurupiahPayload = (rawPayload.sakurupiah || {}) as Record<string, JsonValue>;
  const trxId = String(body.trx_id || sakurupiahPayload.trx_id || "").trim();
  if (!invoice || !trxId) {
    throw new HttpError(404, "Invoice Sakurupiah/trx_id tidak ditemukan untuk order ini.");
  }

  const verification = await checkSakurupiahStatus(trxId);
  const statusData = firstSakurupiahData(verification);
  const status = String(statusData.status || "").trim().toLowerCase();
  if (!status) {
    throw new HttpError(502, `Sakurupiah status response is missing status: ${JSON.stringify(verification)}`);
  }

  const statusCode = status === "berhasil" ? 1 : status === "expired" ? 2 : 0;
  const processPayload: SakurupiahPayload = {
    ...sakurupiahPayload,
    ...statusData,
    trx_id: trxId,
    merchant_ref: orderId,
    status,
    status_kode: statusData.status_kode ?? statusCode,
    amount: invoice.amount_idr as JsonValue,
    event: "payment_status",
  };

  const processResult = await invokeProcessSakurupiahCallback(processPayload);

  return json(200, {
    ok: true,
    source: "sakurupiah-status",
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

const handleRenderAuthorize = async (request: Request) => {
  const { user } = await authenticateUser(request);
  const body = await parseJsonBody(request);
  const mode = String(body.mode || "").trim().toLowerCase();

  if (!VALID_RENDER_MODES.has(mode)) {
    throw new HttpError(400, "mode must be one of: render, test");
  }

  await requireActiveMembership(user.id);

  const { ticket, payload } = await issueRenderAuthorizeTicket({
    userId: user.id,
    mode,
  });

  return json(200, {
    ok: true,
    mode,
    jobTicket: ticket,
    ticketType: "render-job-v1",
    issuedAt: new Date(payload.issuedAtMs).toISOString(),
    expiresAt: new Date(payload.expiresAtMs).toISOString(),
    expiresInSeconds: RENDER_TICKET_TTL_SECONDS,
    enforce: RENDER_GATE_ENFORCE,
  });
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
    .select("id,user_id,mode,status")
    .eq("job_id", jobId)
    .limit(1)
    .maybeSingle();

  if (existingError) {
    throw new HttpError(502, `Failed to read render job: ${existingError.message}`);
  }

  if (RENDER_GATE_ENFORCE) {
    if (status === "running") {
      const ticket =
        String(body.jobTicket || body.job_ticket || body.ticket || body.renderTicket || "").trim();
      const payload = await verifyRenderAuthorizeTicket({
        ticket,
        userId: user.id,
        mode,
      });
      activeRenderJobs.set(jobId, {
        ticketId: payload.ticketId,
        userId: user.id,
        mode,
        expiresAtMs: payload.expiresAtMs,
      });
    } else {
      const activeAuthorization = activeRenderJobs.get(jobId);
      if (activeAuthorization) {
        if (activeAuthorization.userId !== user.id || activeAuthorization.mode !== mode) {
          throw new HttpError(403, "Render authorization mismatch for this job");
        }
      } else {
        const hasMatchingRunningRow =
          Boolean(existingRow?.id)
          && String(existingRow.user_id || "") === user.id
          && String(existingRow.mode || "") === mode
          && String(existingRow.status || "").toLowerCase() === "running";

        if (!hasMatchingRunningRow) {
          throw new HttpError(
            403,
            "Missing render authorization for this job. Call /render/authorize before rendering.",
          );
        }
      }
    }
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

  if (status === "success" || status === "failed" || status === "stopped") {
    activeRenderJobs.delete(jobId);
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
  const rawBody = await request.text();
  const incomingSignature = String(request.headers.get("x-callback-signature") || "").trim().toLowerCase();
  const callbackEvent = String(request.headers.get("x-callback-event") || "").trim();

  if (callbackEvent !== "payment_status") {
    throw new HttpError(400, `Unrecognized callback event: ${callbackEvent || "(empty)"}`);
  }

  if (!incomingSignature) {
    throw new HttpError(401, "Missing X-Callback-Signature");
  }

  const expectedSignature = await hmacHex("SHA-256", SAKURUPIAH_API_KEY || "", rawBody);
  if (!timingSafeEqual(expectedSignature, incomingSignature)) {
    throw new HttpError(401, "Invalid signature");
  }

  let payload: SakurupiahPayload;
  try {
    payload = JSON.parse(rawBody) as SakurupiahPayload;
  } catch {
    throw new HttpError(400, "Invalid JSON payload");
  }

  if (!payload.trx_id || !payload.merchant_ref || !payload.status) {
    throw new HttpError(400, "Missing required Sakurupiah callback fields");
  }

  const processResult = await invokeProcessSakurupiahCallback({
    ...payload,
    event: callbackEvent,
  });

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
        paymentProvider: "sakurupiah",
        mode: SAKURUPIAH_IS_PRODUCTION ? "production" : "sandbox",
      });
    }

    if (
      request.method === "GET"
      && ["/", "/return", "/payment-return", "/checkout-return"].includes(routePath)
    ) {
      return renderPaymentReturnPage(request);
    }

    // All other endpoints require authentication
    if (request.method === "GET" && routePath === "/payment-channels") {
      return await listSakurupiahPaymentChannels();
    }

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

    if (request.method === "POST" && routePath === "/render/authorize") {
      await authenticateUser(request); // enforce auth
      return await handleRenderAuthorize(request);
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
      // Sakurupiah callback does not send Supabase bearer token.
      // Security is enforced by X-Callback-Signature verification in handleWebhook().
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
