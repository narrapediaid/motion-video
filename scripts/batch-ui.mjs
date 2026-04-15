#!/usr/bin/env node

import fs from "node:fs";
import path from "node:path";
import {spawn} from "node:child_process";
import http from "node:http";
import crypto from "node:crypto";
import {fileURLToPath} from "node:url";

const projectRoot = process.cwd();
const scriptDir = path.dirname(fileURLToPath(import.meta.url));
const appRoot = path.resolve(scriptDir, "..");
const defaultInputPath = path.join("batch", "tasks.tsk");
const defaultOutputPath = path.join("out", "batch");
const port = Number(process.env.BATCH_UI_PORT || 3210);
const host = process.env.BATCH_UI_HOST || "127.0.0.1";
const envLoadDiagnostics = {
  checkedFiles: [],
  loadedFiles: [],
};

const state = {
  running: false,
  stopRequested: false,
  exitCode: null,
  startedAt: null,
  finishedAt: null,
  command: null,
  logs: [],
  history: [],
  child: null,
};

const MAX_HISTORY = 200;
let renderStatsStorageDisabled = false;

const SUBSCRIPTION_PLAN_PRESETS = [
  {
    code: "membership-monthly",
    name: "Bulanan",
    tier: "monthly",
    billing_cycle_months: 1,
    price_idr: 50000,
  },
  {
    code: "membership-yearly",
    name: "Tahunan",
    tier: "yearly",
    billing_cycle_months: 12,
    price_idr: 250000,
  },
  {
    code: "membership-lifetime",
    name: "Lifetime",
    tier: "lifetime",
    billing_cycle_months: 0,
    price_idr: 750000,
  },
];

const SUBSCRIPTION_PRICE_BY_TIER = Object.freeze(
  SUBSCRIPTION_PLAN_PRESETS.reduce((acc, plan) => {
    acc[plan.tier] = plan.price_idr;
    return acc;
  }, {}),
);

const VOUCHER_CODE_PATTERN = /^[A-Z0-9-]{4,32}$/;
const ACTIVE_VOUCHER_REDEMPTION_STATUSES = "in.(reserved,applied)";

const ACTIVE_MEMBERSHIP_STATUSES = new Set([
  "active",
  "lifetime_active",
]);

class HttpError extends Error {
  constructor(statusCode, message) {
    super(message);
    this.name = "HttpError";
    this.statusCode = statusCode;
  }
}

const isPlaceholderLike = (value) => {
  const normalized = String(value || "").trim().toLowerCase();
  if (!normalized) return true;
  return (
    normalized.startsWith("your_")
    || normalized.startsWith("replace_with")
    || normalized.includes("your_project")
    || normalized.includes("<your")
    || normalized === "changeme"
  );
};

const loadEnvFromFile = () => {
  const appendEnvCandidatesFromDir = (candidates, startDir, maxDepth = 8) => {
    if (!startDir) {
      return;
    }

    const envNames = [
      ".env.local",
      ".env.public.local",
      ".env.public",
      ".env.public.txt",
      ".env",
    ];

    let current = path.resolve(startDir);
    for (let depth = 0; depth <= maxDepth; depth += 1) {
      envNames.forEach((fileName) => {
        candidates.push(path.resolve(current, fileName));
      });

      const parent = path.dirname(current);
      if (parent === current) {
        break;
      }

      current = parent;
    }
  };

  const runtimeDir = path.dirname(process.execPath);
  const envFileFromVar = process.env.BATCH_UI_ENV_FILE?.trim();
  const candidates = [];

  if (envFileFromVar) {
    candidates.push(path.resolve(envFileFromVar));
  }

  appendEnvCandidatesFromDir(candidates, projectRoot);
  appendEnvCandidatesFromDir(candidates, appRoot);
  appendEnvCandidatesFromDir(candidates, runtimeDir);
  appendEnvCandidatesFromDir(candidates, process.env.APPDATA, 3);
  appendEnvCandidatesFromDir(candidates, process.env.LOCALAPPDATA, 3);
  appendEnvCandidatesFromDir(candidates, process.env.USERPROFILE, 2);

  const runtimeAppName = path.basename(process.execPath, path.extname(process.execPath)).trim();
  if (runtimeAppName) {
    if (process.env.APPDATA) {
      appendEnvCandidatesFromDir(candidates, path.resolve(process.env.APPDATA, runtimeAppName), 1);
    }
    if (process.env.LOCALAPPDATA) {
      appendEnvCandidatesFromDir(candidates, path.resolve(process.env.LOCALAPPDATA, runtimeAppName), 1);
    }
  }

  const uniqueCandidates = [...new Set(candidates)];
  envLoadDiagnostics.checkedFiles = uniqueCandidates;

  for (const envPath of uniqueCandidates) {
    if (!fs.existsSync(envPath)) {
      continue;
    }

    envLoadDiagnostics.loadedFiles.push(envPath);

    const lines = fs.readFileSync(envPath, "utf8").split(/\r?\n/);
    for (const line of lines) {
      if (!line || line.trim().startsWith("#") || !line.includes("=")) {
        continue;
      }

      const sep = line.indexOf("=");
      const key = line.slice(0, sep).trim().replace(/^export\s+/i, "");
      const rawValue = line.slice(sep + 1).trim();
      const normalized = rawValue.replace(/^['"]|['"]$/g, "");
      const currentValue = process.env[key];

      if (!key || isPlaceholderLike(normalized)) {
        continue;
      }

      if (currentValue && !isPlaceholderLike(currentValue)) {
        continue;
      }

      process.env[key] = normalized;
    }
  }
};

loadEnvFromFile();

const parseBoolEnv = (value) => {
  if (!value) {
    return false;
  }

  const normalized = String(value).trim().toLowerCase();
  return normalized === "1" || normalized === "true" || normalized === "yes";
};

const parseJsonResponse = async (response) => {
  const raw = await response.text();

  if (!raw) {
    return null;
  }

  try {
    return JSON.parse(raw);
  } catch {
    return {raw};
  }
};

const isLikelySupabaseJwtKey = (value) => {
  const normalized = String(value || "").trim();
  const parts = normalized.split(".");
  return parts.length === 3 && parts.every((part) => part.length > 0);
};

const isLikelySupabasePublishableKey = (value) => {
  return String(value || "").trim().startsWith("sb_publishable_");
};

const detectSupabaseApiKeyKind = (value) => {
  if (isLikelySupabasePublishableKey(value)) {
    return "publishable";
  }

  if (isLikelySupabaseJwtKey(value)) {
    return "anon-jwt";
  }

  return "invalid-format";
};

const resolveSupabaseApiKey = () => {
  const candidates = [
    {name: "SUPABASE_ANON_KEY", value: process.env.SUPABASE_ANON_KEY?.trim() || ""},
    {name: "SUPABASE_PUBLISHABLE_KEY", value: process.env.SUPABASE_PUBLISHABLE_KEY?.trim() || ""},
    {name: "VITE_SUPABASE_ANON_KEY", value: process.env.VITE_SUPABASE_ANON_KEY?.trim() || ""},
    {name: "NEXT_PUBLIC_SUPABASE_ANON_KEY", value: process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY?.trim() || ""},
    {name: "NEXT_PUBLIC_SUPABASE_PUBLISHABLE_KEY", value: process.env.NEXT_PUBLIC_SUPABASE_PUBLISHABLE_KEY?.trim() || ""},
  ]
    .map((entry) => ({
      ...entry,
      kind: detectSupabaseApiKeyKind(entry.value),
      hasValue: entry.value.length > 0,
      placeholderLike: isPlaceholderLike(entry.value),
    }))
    .filter((entry) => entry.hasValue && !entry.placeholderLike);

  const valid = candidates.filter((entry) => entry.kind !== "invalid-format");
  const selected = valid[0] || candidates[0] || null;

  return {
    value: selected?.value || "",
    source: selected?.name || "",
    kind: selected?.kind || "missing",
    candidates,
  };
};

const getSubscriptionConfig = () => {
  const rawSupabaseUrl =
    process.env.SUPABASE_URL?.trim()
    || process.env.VITE_SUPABASE_URL?.trim()
    || process.env.NEXT_PUBLIC_SUPABASE_URL?.trim()
    || "";
  const supabaseApiKey = resolveSupabaseApiKey();
  const supabaseUrl = isPlaceholderLike(rawSupabaseUrl) ? "" : rawSupabaseUrl;
  const supabaseAnonKey = supabaseApiKey.value;
  const midtransClientKey = process.env.MIDTRANS_CLIENT_KEY?.trim() || "";
  const isMidtransProduction = parseBoolEnv(process.env.MIDTRANS_IS_PRODUCTION);
  const backendBaseUrl = process.env.SUBSCRIPTION_BACKEND_URL?.trim() || "";
  const supabaseServiceRoleKey = process.env.SUPABASE_SERVICE_ROLE_KEY?.trim() || "";
  const midtransServerKey = process.env.MIDTRANS_SERVER_KEY?.trim() || "";

  const missing = [];
  if (!supabaseUrl) missing.push("SUPABASE_URL");
  if (!supabaseAnonKey) missing.push("SUPABASE_ANON_KEY");

  if (missing.length > 0) {
    const checked = envLoadDiagnostics.checkedFiles.length > 0
      ? envLoadDiagnostics.checkedFiles.join("; ")
      : "(none)";
    const loaded = envLoadDiagnostics.loadedFiles.length > 0
      ? envLoadDiagnostics.loadedFiles.join("; ")
      : "(none)";

    throw new HttpError(
      503,
      `Subscription UI env is not ready. Missing: ${missing.join(", ")}. Loaded env files: ${loaded}. Checked env files: ${checked}. Supabase key source: ${supabaseApiKey.source || "(none)"} (${supabaseApiKey.kind}). For public app, put .env.public/.env.public.txt in %APPDATA%\\Motion Video Batch UI or next to the .exe, or set BATCH_UI_ENV_FILE.`,
    );
  }

  const midtransSnapUrl =
    process.env.MIDTRANS_SNAP_URL?.trim() ||
    (isMidtransProduction
      ? "https://app.midtrans.com/snap/v1/transactions"
      : "https://app.sandbox.midtrans.com/snap/v1/transactions");

  return {
    supabaseUrl,
    supabaseAnonKey,
    supabaseServiceRoleKey,
    midtransServerKey,
    midtransClientKey,
    midtransSnapUrl,
    isMidtransProduction,
    backendBaseUrl,
    supabaseApiKeySource: supabaseApiKey.source,
    supabaseApiKeyKind: supabaseApiKey.kind,
  };
};

const hasInternalSubscriptionConfig = (config) => {
  return Boolean(config?.supabaseServiceRoleKey && config?.midtransServerKey);
};

const requireInternalSubscriptionConfig = (config) => {
  const missing = [];
  if (!config?.supabaseServiceRoleKey) missing.push("SUPABASE_SERVICE_ROLE_KEY");
  if (!config?.midtransServerKey) missing.push("MIDTRANS_SERVER_KEY");

  if (missing.length > 0) {
    throw new HttpError(
      503,
      `Fitur ini dinonaktifkan pada build publik. Missing internal env: ${missing.join(", ")}. Gunakan backend subscription terpisah.`,
    );
  }

  return config;
};

const supabaseRequest = async ({
  config,
  endpointPath,
  method = "GET",
  body,
  prefer,
  apikey,
  bearerToken,
}) => {
  const response = await fetch(`${config.supabaseUrl}${endpointPath}`, {
    method,
    headers: {
      apikey,
      Authorization: `Bearer ${bearerToken}`,
      ...(prefer ? {Prefer: prefer} : {}),
      ...(body !== undefined ? {"Content-Type": "application/json"} : {}),
    },
    body: body !== undefined ? JSON.stringify(body) : undefined,
  });

  const data = await parseJsonResponse(response);

  if (!response.ok) {
    if (String(data?.message || data?.error || "").toLowerCase().includes("invalid api key")) {
      throw new HttpError(
        401,
        "Invalid API key. Gunakan SUPABASE_ANON_KEY atau SUPABASE_PUBLISHABLE_KEY yang valid dari Supabase Project Settings > API.",
      );
    }

    throw new HttpError(
      502,
      `Supabase request failed (${response.status}) on ${endpointPath}: ${JSON.stringify(data)}`,
    );
  }

  return data;
};

const supabaseAdminRequest = async ({config, endpointPath, method = "GET", body, prefer}) => {
  const internalConfig = requireInternalSubscriptionConfig(config);
  return supabaseRequest({
    config: internalConfig,
    endpointPath,
    method,
    body,
    prefer,
    apikey: internalConfig.supabaseServiceRoleKey,
    bearerToken: internalConfig.supabaseServiceRoleKey,
  });
};

const supabaseUserRequest = async ({config, accessToken, endpointPath, method = "GET", body, prefer}) => {
  const token = String(accessToken || "").trim();
  if (!token) {
    throw new HttpError(401, "Missing bearer token");
  }

  return supabaseRequest({
    config,
    endpointPath,
    method,
    body,
    prefer,
    apikey: config.supabaseAnonKey,
    bearerToken: token,
  });
};

const getBearerToken = (req) => {
  const header = req.headers.authorization || "";

  if (!header.toLowerCase().startsWith("bearer ")) {
    throw new HttpError(401, "Missing bearer token");
  }

  const token = header.slice(7).trim();
  if (!token) {
    throw new HttpError(401, "Missing bearer token");
  }

  return token;
};

const getBearerTokenOptional = (req) => {
  const header = String(req.headers.authorization || "").trim();
  if (!header.toLowerCase().startsWith("bearer ")) {
    return "";
  }

  return header.slice(7).trim();
};

const getCookieValue = (req, cookieName) => {
  const rawCookie = String(req.headers.cookie || "");
  if (!rawCookie) {
    return "";
  }

  const parts = rawCookie.split(";");
  for (const part of parts) {
    const separatorIndex = part.indexOf("=");
    if (separatorIndex < 0) {
      continue;
    }

    const key = part.slice(0, separatorIndex).trim();
    if (key !== cookieName) {
      continue;
    }

    const value = part.slice(separatorIndex + 1).trim();
    try {
      return decodeURIComponent(value);
    } catch {
      return value;
    }
  }

  return "";
};

const buildSubscriptionBackendUrl = (config, endpointPath) => {
  const baseUrl = String(config?.backendBaseUrl || "").trim();
  if (!baseUrl) {
    throw new HttpError(
      503,
      "Checkout diproses di backend terpisah. Set SUBSCRIPTION_BACKEND_URL pada app publik.",
    );
  }

  return `${baseUrl.replace(/\/$/, "")}${endpointPath}`;
};

const requestSubscriptionBackend = async ({
  config,
  endpointPath,
  method = "POST",
  body,
  bearerToken = "",
}) => {
  const targetUrl = buildSubscriptionBackendUrl(config, endpointPath);
  const normalizedToken = String(bearerToken || "").trim();

  const response = await fetch(targetUrl, {
    method,
    headers: {
      "Content-Type": "application/json",
      ...(normalizedToken ? {Authorization: `Bearer ${normalizedToken}`} : {}),
    },
    body: body === undefined ? undefined : JSON.stringify(body),
  });

  const data = await parseJsonResponse(response);
  if (!response.ok) {
    throw new HttpError(
      response.status,
      data?.error
      || data?.message
      || `Backend subscription request failed (${response.status}) on ${endpointPath}`,
    );
  }

  return data;
};

const forwardSubscriptionRequest = async ({config, req, endpointPath, method = "POST", body}) => {
  const headerToken = getBearerTokenOptional(req);
  const cookieToken = getCookieValue(req, "sb_access_token");
  const bearerToken = headerToken || cookieToken;

  return requestSubscriptionBackend({
    config,
    endpointPath,
    method,
    body,
    bearerToken,
  });
};

const authenticateUserFromToken = async (token, config) => {
  if (!token || !String(token).trim()) {
    throw new HttpError(401, "Missing bearer token");
  }

  const response = await fetch(`${config.supabaseUrl}/auth/v1/user`, {
    method: "GET",
    headers: {
      apikey: config.supabaseAnonKey,
      Authorization: `Bearer ${String(token).trim()}`,
    },
  });

  const user = await parseJsonResponse(response);

  if (!response.ok || !user?.id) {
    if (String(user?.message || user?.error || "").toLowerCase().includes("invalid api key")) {
      throw new HttpError(
        401,
        "Invalid API key. Periksa SUPABASE_ANON_KEY / SUPABASE_PUBLISHABLE_KEY pada .env.public.",
      );
    }

    throw new HttpError(401, "Session expired or invalid. Please login again.");
  }

  return {user};
};

const authenticateUserFromRequest = async (req, config) => {
  const token = getBearerToken(req);
  const {user} = await authenticateUserFromToken(token, config);

  return {token, user};
};

const requireLoggedInSession = async (req) => {
  const config = getSubscriptionConfig();
  const bearerToken = getBearerTokenOptional(req);
  const cookieToken = getCookieValue(req, "sb_access_token");
  const token = bearerToken || cookieToken;

  if (!token) {
    throw new HttpError(401, "Login required. Please login from /subscription first.");
  }

  const {user} = await authenticateUserFromToken(token, config);
  return {config, token, user};
};

const requireActiveMembershipSession = async (req) => {
  const session = await requireLoggedInSession(req);
  const activeMembership = await hasActiveMembership({
    config: session.config,
    userId: session.user.id,
    accessToken: session.token,
  });

  if (!activeMembership) {
    throw new HttpError(
      403,
      "Active membership required. Please activate your plan from /subscription.",
    );
  }

  return session;
};

const isMembershipRowActive = (membership) => {
  const normalizedStatus = String(membership?.status || "").toLowerCase();
  if (!ACTIVE_MEMBERSHIP_STATUSES.has(normalizedStatus)) {
    return false;
  }

  if (normalizedStatus === "lifetime_active") {
    return true;
  }

  const now = Date.now();
  const graceEndsAtMs = Date.parse(String(membership?.grace_ends_at || ""));
  const endsAtMs = Date.parse(String(membership?.ends_at || ""));

  if (Number.isFinite(graceEndsAtMs)) {
    return graceEndsAtMs >= now;
  }

  if (Number.isFinite(endsAtMs)) {
    return endsAtMs >= now;
  }

  return true;
};

const hasActiveMembership = async ({config, userId, accessToken}) => {
  const params = new URLSearchParams({
    select: "id,status,starts_at,ends_at,grace_ends_at,updated_at",
    user_id: `eq.${userId}`,
    order: "updated_at.desc",
    limit: "5",
  });

  const memberships = await supabaseUserRequest({
    config,
    accessToken,
    endpointPath: `/rest/v1/memberships?${params.toString()}`,
  });

  if (!Array.isArray(memberships) || memberships.length === 0) {
    return false;
  }

  return memberships.some((membership) => isMembershipRowActive(membership));
};

const registerUserWithServiceRole = async ({config, email, password, fullName}) => {
  const response = await fetch(`${config.supabaseUrl}/auth/v1/admin/users`, {
    method: "POST",
    headers: {
      apikey: config.supabaseServiceRoleKey,
      Authorization: `Bearer ${config.supabaseServiceRoleKey}`,
      "Content-Type": "application/json",
    },
    body: JSON.stringify({
      email,
      password,
      email_confirm: true,
      user_metadata: {
        full_name: fullName,
      },
    }),
  });

  const data = await parseJsonResponse(response);

  if (!response.ok) {
    const message = JSON.stringify(data);
    if (
      response.status === 422 ||
      /already|exists|registered|duplicate/i.test(message)
    ) {
      throw new HttpError(409, "Email sudah terdaftar. Silakan login.");
    }

    throw new HttpError(
      502,
      `Supabase admin signup failed (${response.status}): ${message}`,
    );
  }

  if (!data?.id || !data?.email) {
    throw new HttpError(502, "Supabase admin signup response tidak valid.");
  }

  return data;
};

const createMidtransTransaction = async ({config, payload}) => {
  const basicAuth = Buffer.from(`${config.midtransServerKey}:`).toString("base64");

  const response = await fetch(config.midtransSnapUrl, {
    method: "POST",
    headers: {
      Accept: "application/json",
      "Content-Type": "application/json",
      Authorization: `Basic ${basicAuth}`,
    },
    body: JSON.stringify(payload),
  });

  const data = await parseJsonResponse(response);

  if (!response.ok) {
    throw new HttpError(
      502,
      `Midtrans checkout request failed (${response.status}): ${JSON.stringify(data)}`,
    );
  }

  if (!data?.redirect_url || !data?.token) {
    throw new HttpError(502, `Midtrans response is missing redirect_url/token: ${JSON.stringify(data)}`);
  }

  return data;
};

const verifyMidtransPayment = async ({config, orderId}) => {
  const candidates = config.isMidtransProduction
    ? [
      {label: "production", baseUrl: "https://api.midtrans.com/v2"},
      {label: "sandbox", baseUrl: "https://api.sandbox.midtrans.com/v2"},
    ]
    : [
      {label: "sandbox", baseUrl: "https://api.sandbox.midtrans.com/v2"},
      {label: "production", baseUrl: "https://api.midtrans.com/v2"},
    ];

  const basicAuth = Buffer.from(`${config.midtransServerKey}:`).toString("base64");
  let notFoundIn = [];

  for (const candidate of candidates) {
    const response = await fetch(`${candidate.baseUrl}/${orderId}/status`, {
      headers: {
        Accept: "application/json",
        Authorization: `Basic ${basicAuth}`,
      },
    });

    if (response.status === 404) {
      notFoundIn = [...notFoundIn, candidate.label];
      continue;
    }

    const data = await parseJsonResponse(response);
    if (!response.ok) {
      throw new HttpError(
        502,
        `Midtrans status request failed on ${candidate.label} (${response.status}): ${JSON.stringify(data)}`,
      );
    }

    return {
      data,
      source: candidate.label,
    };
  }

  if (notFoundIn.length > 0) {
    return null;
  }

  return null;
};

const processMidtransNotification = async ({config, notification}) => {
  const orderId = notification.order_id;
  const statusCode = notification.status_code;
  const transactionStatus = notification.transaction_status;
  const fraudStatus = notification.fraud_status;
  const grossAmount = notification.gross_amount;
  const normalizedTxStatus = String(transactionStatus || "pending").toLowerCase();
  const normalizedFraudStatus = String(fraudStatus || "accept").toLowerCase();

  // Verify signature if provided instead of trust blindly
  if (notification.signature_key) {
    const expectedSig = crypto
      .createHash("sha512")
      .update(orderId + statusCode + grossAmount + config.midtransServerKey)
      .digest("hex");
    if (expectedSig !== notification.signature_key) {
      throw new HttpError(403, "Invalid signature key");
    }
  }

  const invoices = await supabaseAdminRequest({
    config,
    endpointPath: `/rest/v1/invoices?external_order_id=eq.${encodeURIComponent(orderId)}&select=id,status,user_id,membership_id,amount_idr`,
  });
  const invoice = Array.isArray(invoices) ? invoices[0] : null;
  if (!invoice) return {message: "Invoice not found", orderId};

  let nextStatus = invoice.status;
  let isPaid = false;
  let paymentStatus = "failure";

  if (normalizedTxStatus === "capture") {
    paymentStatus = normalizedFraudStatus === "challenge" ? "pending" : "capture";
    if (normalizedFraudStatus === "challenge") {
      nextStatus = "open";
    } else {
      nextStatus = "paid";
      isPaid = true;
    }
  } else if (normalizedTxStatus === "settlement") {
    paymentStatus = "settlement";
    nextStatus = "paid";
    isPaid = true;
  } else if (normalizedTxStatus === "pending") {
    paymentStatus = "pending";
    nextStatus = "open";
  } else if (
    [
      "deny",
      "cancel",
      "expire",
      "refund",
      "partial_refund",
      "chargeback",
      "partial_chargeback",
      "failure",
    ].includes(normalizedTxStatus)
  ) {
    paymentStatus = normalizedTxStatus;
    nextStatus = ["refund", "partial_refund", "chargeback", "partial_chargeback"].includes(
      normalizedTxStatus,
    )
      ? "uncollectible"
      : "expired";
  }

  const invoiceStatusChanged = invoice.status !== nextStatus;
  if (invoiceStatusChanged) {
    const patchInvoice = {
      status: nextStatus,
      updated_at: new Date().toISOString(),
    };

    if (isPaid) patchInvoice.paid_at = notification.settlement_time || new Date().toISOString();

    await supabaseAdminRequest({
      config,
      endpointPath: `/rest/v1/invoices?id=eq.${encodeURIComponent(invoice.id)}`,
      method: "PATCH",
      body: patchInvoice,
    });
  }

  try {
    await syncVoucherRedemptionStatusForInvoice({
      config,
      invoiceId: invoice.id,
      isPaid,
      nextInvoiceStatus: nextStatus,
    });
  } catch (error) {
    console.error("Failed to sync voucher redemption status:", error instanceof Error ? error.message : String(error));
  }

  if (isPaid) {
    const memberships = await supabaseAdminRequest({
      config,
      endpointPath: `/rest/v1/memberships?id=eq.${encodeURIComponent(invoice.membership_id)}&select=id,plan_id,status,ends_at`,
    });
    const membership = Array.isArray(memberships) ? memberships[0] : null;
    
    if (membership) {
      const plans = await supabaseAdminRequest({
        config,
        endpointPath: `/rest/v1/plans?id=eq.${encodeURIComponent(membership.plan_id)}&select=tier,billing_cycle_months`,
      });
      const plan = Array.isArray(plans) ? plans[0] : null;
      const tier = String(plan?.tier || "").toLowerCase();
      const parsedMonths = Number(plan?.billing_cycle_months);
      const months = Number.isFinite(parsedMonths) && parsedMonths >= 0
        ? parsedMonths
        : tier === "lifetime"
          ? 0
          : 1;
      const isLifetimePlan = tier === "lifetime" || months === 0;
      const normalizedMembershipStatus = String(membership.status || "").toLowerCase();

      const shouldPatchMembership = isLifetimePlan
        ? normalizedMembershipStatus !== "lifetime_active"
        : normalizedMembershipStatus !== "active" || !membership.ends_at;

      if (shouldPatchMembership) {
        const startsAt = new Date();
        const membershipPatch = {
          status: isLifetimePlan ? "lifetime_active" : "active",
          starts_at: startsAt.toISOString(),
          updated_at: new Date().toISOString(),
        };

        if (isLifetimePlan) {
          membershipPatch.ends_at = null;
          membershipPatch.grace_ends_at = null;
        } else {
          const endsAt = new Date(startsAt);
          endsAt.setMonth(endsAt.getMonth() + months);
          membershipPatch.ends_at = endsAt.toISOString();
        }

        await supabaseAdminRequest({
          config,
          endpointPath: `/rest/v1/memberships?id=eq.${encodeURIComponent(membership.id)}`,
          method: "PATCH",
          body: membershipPatch,
        });
      }
    }
  }

  const externalTransactionId =
    typeof notification.transaction_id === "string" ? notification.transaction_id.trim() : "";

  let existPayments = [];
  if (externalTransactionId) {
    existPayments = await supabaseAdminRequest({
      config,
      endpointPath: `/rest/v1/payments?external_transaction_id=eq.${encodeURIComponent(externalTransactionId)}&select=id`,
    });
  } else {
    existPayments = await supabaseAdminRequest({
      config,
      endpointPath: `/rest/v1/payments?invoice_id=eq.${encodeURIComponent(invoice.id)}&provider=eq.midtrans&order=created_at.desc&limit=1&select=id`,
    });
  }

  const parsedGrossAmount = Number(grossAmount);
  const grossAmountIdr = Number.isFinite(parsedGrossAmount)
    ? Math.round(parsedGrossAmount)
    : Number(invoice.amount_idr || 0);

  const pData = {
    user_id: invoice.user_id,
    invoice_id: invoice.id,
    provider: "midtrans",
    external_transaction_id: externalTransactionId || null,
    status: paymentStatus,
    payment_method: notification.payment_type || null,
    payment_channel: notification.store || notification.channel_response_code || notification.payment_type || null,
    gross_amount_idr: grossAmountIdr,
    transaction_time: notification.transaction_time || new Date().toISOString(),
    settlement_time: notification.settlement_time || (isPaid ? new Date().toISOString() : null),
    fraud_status: notification.fraud_status || null,
    raw_payload: notification,
  };

  if (existPayments && existPayments.length > 0) {
    pData.updated_at = new Date().toISOString();
    await supabaseAdminRequest({
      config,
      endpointPath: `/rest/v1/payments?id=eq.${encodeURIComponent(existPayments[0].id)}`,
      method: "PATCH",
      body: pData,
    });
  } else {
    await supabaseAdminRequest({
      config,
      endpointPath: `/rest/v1/payments`,
      method: "POST",
      prefer: "return=minimal",
      body: pData,
    });
  }

  return {
    message: invoiceStatusChanged ? "Processed payment state update" : "Payment synced without invoice change",
    orderId,
    invoiceStatus: nextStatus,
    paymentStatus,
  };
};

const createCheckoutOrderId = () => {
  const stamp = Date.now();
  const salt = Math.floor(Math.random() * 1_000_000)
    .toString()
    .padStart(6, "0");
  return `ORDER-SUB-${stamp}-${salt}`;
};

const normalizePlanWithCanonicalPrice = (plan) => {
  if (!plan || typeof plan !== "object") {
    return plan;
  }

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

const getPublicFallbackPlans = () => {
  return SUBSCRIPTION_PLAN_PRESETS.map((plan) => ({
    id: plan.code,
    code: plan.code,
    name: plan.name,
    tier: plan.tier,
    billing_cycle_months: plan.billing_cycle_months,
    price_idr: plan.price_idr,
    is_active: true,
    metadata: {
      source: "public-fallback",
    },
  }));
};

const resolvePlanAmountIdr = (plan) => {
  const tier = String(plan?.tier || "").toLowerCase();
  const canonicalPrice = SUBSCRIPTION_PRICE_BY_TIER[tier];

  if (canonicalPrice) {
    return canonicalPrice;
  }

  return Number(plan?.price_idr || 0);
};

const normalizeVoucherCode = (value) => {
  const normalized = String(value || "").trim().toUpperCase();
  if (!normalized) {
    return "";
  }

  if (!VOUCHER_CODE_PATTERN.test(normalized)) {
    throw new HttpError(400, "Format voucher tidak valid.");
  }

  return normalized;
};

const calculateVoucherDiscount = ({voucher, planAmountIdr}) => {
  const amount = Math.max(0, Number(planAmountIdr || 0));
  const type = String(voucher?.discount_type || "").toLowerCase();
  const rawValue = Number(voucher?.discount_value || 0);

  let discountIdr = 0;
  if (type === "percentage") {
    discountIdr = Math.round((amount * rawValue) / 100);
  } else if (type === "fixed_amount") {
    discountIdr = Math.round(rawValue);
  }

  const maxDiscount = Number(voucher?.max_discount_idr);
  if (Number.isFinite(maxDiscount) && maxDiscount >= 0) {
    discountIdr = Math.min(discountIdr, Math.round(maxDiscount));
  }

  discountIdr = Math.max(0, Math.min(discountIdr, amount));
  return {
    discountIdr,
    finalAmountIdr: Math.max(0, amount - discountIdr),
  };
};

const resolveVoucherForCheckout = async ({config, userId, plan, rawVoucherCode}) => {
  const voucherCode = normalizeVoucherCode(rawVoucherCode);
  if (!voucherCode) {
    return null;
  }

  const voucherParams = new URLSearchParams({
    select: "id,code,name,description,discount_type,discount_value,max_discount_idr,min_purchase_idr,max_redemptions,per_user_limit,starts_at,ends_at,is_active,allowed_tiers",
    code: `eq.${voucherCode}`,
    is_active: "eq.true",
    limit: "1",
  });

  const voucherRows = await supabaseAdminRequest({
    config,
    endpointPath: `/rest/v1/vouchers?${voucherParams.toString()}`,
  });

  const voucher = Array.isArray(voucherRows) ? voucherRows[0] : null;
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
  const planTier = String(plan?.tier || "").toLowerCase();
  if (allowedTiers.length > 0 && !allowedTiers.includes(planTier)) {
    throw new HttpError(400, "Voucher tidak berlaku untuk paket yang dipilih.");
  }

  const planAmountIdr = resolvePlanAmountIdr(plan);
  const minPurchaseIdr = Math.max(0, Number(voucher.min_purchase_idr || 0));
  if (planAmountIdr < minPurchaseIdr) {
    throw new HttpError(400, `Voucher berlaku untuk minimum belanja Rp${minPurchaseIdr.toLocaleString("id-ID")}.`);
  }

  const {discountIdr, finalAmountIdr} = calculateVoucherDiscount({
    voucher,
    planAmountIdr,
  });

  if (discountIdr <= 0) {
    throw new HttpError(400, "Voucher tidak menghasilkan potongan harga untuk paket ini.");
  }

  const maxRedemptions = Number(voucher.max_redemptions);
  if (Number.isFinite(maxRedemptions) && maxRedemptions > 0) {
    const globalUsageParams = new URLSearchParams({
      select: "id",
      voucher_id: `eq.${voucher.id}`,
      status: ACTIVE_VOUCHER_REDEMPTION_STATUSES,
      limit: String(Math.max(1, Math.trunc(maxRedemptions))),
    });

    const globalUsages = await supabaseAdminRequest({
      config,
      endpointPath: `/rest/v1/voucher_redemptions?${globalUsageParams.toString()}`,
    });

    if (Array.isArray(globalUsages) && globalUsages.length >= maxRedemptions) {
      throw new HttpError(400, "Kuota voucher sudah habis.");
    }
  }

  const perUserLimit = Number(voucher.per_user_limit || 1);
  if (Number.isFinite(perUserLimit) && perUserLimit > 0) {
    const userUsageParams = new URLSearchParams({
      select: "id",
      voucher_id: `eq.${voucher.id}`,
      user_id: `eq.${userId}`,
      status: ACTIVE_VOUCHER_REDEMPTION_STATUSES,
      limit: String(Math.max(1, Math.trunc(perUserLimit))),
    });

    const userUsages = await supabaseAdminRequest({
      config,
      endpointPath: `/rest/v1/voucher_redemptions?${userUsageParams.toString()}`,
    });

    if (Array.isArray(userUsages) && userUsages.length >= perUserLimit) {
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

const syncVoucherRedemptionStatusForInvoice = async ({config, invoiceId, isPaid, nextInvoiceStatus}) => {
  const redemptionRows = await supabaseAdminRequest({
    config,
    endpointPath: `/rest/v1/voucher_redemptions?invoice_id=eq.${encodeURIComponent(invoiceId)}&select=id,status`,
  });

  if (!Array.isArray(redemptionRows) || redemptionRows.length === 0) {
    return;
  }

  let targetStatus = "";
  if (isPaid) {
    targetStatus = "applied";
  } else if (["expired", "void", "uncollectible"].includes(String(nextInvoiceStatus || "").toLowerCase())) {
    targetStatus = "released";
  }

  if (!targetStatus) {
    return;
  }

  await Promise.all(
    redemptionRows
      .filter((row) => String(row?.status || "").toLowerCase() !== targetStatus)
      .map((row) =>
        supabaseAdminRequest({
          config,
          endpointPath: `/rest/v1/voucher_redemptions?id=eq.${encodeURIComponent(row.id)}`,
          method: "PATCH",
          body: {
            status: targetStatus,
          },
        }),
      ),
  );
};

const reserveVoucherRedemption = async ({config, checkoutVoucher, userId, invoiceId, orderId}) => {
  if (!checkoutVoucher?.voucher?.id) {
    return;
  }

  await supabaseAdminRequest({
    config,
    endpointPath: "/rest/v1/voucher_redemptions",
    method: "POST",
    prefer: "return=minimal",
    body: [
      {
        voucher_id: checkoutVoucher.voucher.id,
        user_id: userId,
        invoice_id: invoiceId,
        order_id: orderId,
        voucher_code: checkoutVoucher.voucherCode,
        status: "reserved",
        base_amount_idr: checkoutVoucher.planAmountIdr,
        discount_idr: checkoutVoucher.discountIdr,
        final_amount_idr: checkoutVoucher.finalAmountIdr,
        metadata: {
          source: "subscription-ui",
        },
      },
    ],
  });
};

const ensureSubscriptionPlansCatalog = async (config) => {
  await supabaseAdminRequest({
    config,
    endpointPath: "/rest/v1/plans?on_conflict=code",
    method: "POST",
    prefer: "resolution=merge-duplicates,return=minimal",
    body: SUBSCRIPTION_PLAN_PRESETS.map((plan) => ({
      ...plan,
      is_active: true,
      metadata: {
        source: "subscription-ui",
      },
    })),
  });
};

const fetchActivePlanById = async ({config, planId}) => {
  const params = new URLSearchParams({
    select: "id,code,name,tier,billing_cycle_months,price_idr,is_active",
    id: `eq.${planId}`,
    is_active: "eq.true",
    limit: "1",
  });

  const rows = await supabaseAdminRequest({
    config,
    endpointPath: `/rest/v1/plans?${params.toString()}`,
  });

  const plan = Array.isArray(rows) ? rows[0] : null;
  if (!plan) {
    throw new HttpError(404, "Plan not found or inactive");
  }

  return normalizePlanWithCanonicalPrice(plan);
};

const appendLog = (message) => {
  const timestamp = new Date().toISOString();
  state.logs.push(`[${timestamp}] ${message}`);

  if (state.logs.length > 400) {
    state.logs = state.logs.slice(-400);
  }
};

const sendJson = (res, statusCode, body, extraHeaders = {}) => {
  res.writeHead(statusCode, {
    "Content-Type": "application/json; charset=utf-8",
    "Cache-Control": "no-store",
    ...extraHeaders,
  });
  res.end(JSON.stringify(body));
};

const sendHtml = (res, html) => {
  res.writeHead(200, {
    "Content-Type": "text/html; charset=utf-8",
    "Cache-Control": "no-store",
  });
  res.end(html);
};

const sendRedirect = (res, location) => {
  res.writeHead(302, {
    Location: location,
    "Cache-Control": "no-store",
  });
  res.end();
};

const readRequestBody = (req) => {
  return new Promise((resolve, reject) => {
    let body = "";

    req.on("data", (chunk) => {
      body += chunk.toString("utf8");

      if (body.length > 2_000_000) {
        reject(new Error("Request body is too large"));
      }
    });

    req.on("end", () => {
      resolve(body);
    });

    req.on("error", (error) => {
      reject(error);
    });
  });
};

const resolveInputPath = (inputPath) => {
  const candidate = typeof inputPath === "string" && inputPath.trim().length > 0
    ? inputPath.trim()
    : defaultInputPath;

  return {
    relative: candidate,
    absolute: path.resolve(projectRoot, candidate),
  };
};

const loadTaskFile = (inputPath) => {
  const {relative, absolute} = resolveInputPath(inputPath);

  if (!fs.existsSync(absolute)) {
    throw new Error(`File not found: ${relative}`);
  }

  return {
    path: relative,
    content: fs.readFileSync(absolute, "utf8"),
  };
};

const saveTaskFile = (inputPath, content) => {
  if (typeof content !== "string") {
    throw new Error("Content must be a string");
  }

  try {
    JSON.parse(content);
  } catch (error) {
    throw new Error(`Invalid JSON: ${error.message}`);
  }

  const {relative, absolute} = resolveInputPath(inputPath);
  const dir = path.dirname(absolute);

  fs.mkdirSync(dir, {recursive: true});
  fs.writeFileSync(absolute, content, "utf8");

  return {
    path: relative,
  };
};

const addNamedRemotionImport = (code, importName) => {
  if (!code.includes("from 'remotion'") && !code.includes('from "remotion"')) {
    return `import { ${importName} } from 'remotion';\n${code}`;
  }

  return code.replace(/import\s*\{([^}]*)\}\s*from\s*["']remotion["'];?/, (full, importsBlock) => {
    const imports = importsBlock
      .split(",")
      .map((entry) => entry.trim())
      .filter(Boolean);

    if (imports.includes(importName)) {
      return full;
    }

    imports.push(importName);
    return `import { ${imports.join(", ")} } from 'remotion';`;
  });
};

const ensureUseVideoConfigVars = (code) => {
  const hookMatch = code.match(/const\s*\{([^}]*)\}\s*=\s*useVideoConfig\(\);/);

  if (hookMatch) {
    const names = hookMatch[1]
      .split(",")
      .map((entry) => entry.trim())
      .filter(Boolean);

    if (!names.includes("width")) {
      names.push("width");
    }

    if (!names.includes("height")) {
      names.push("height");
    }

    return code.replace(hookMatch[0], `const { ${names.join(", ")} } = useVideoConfig();`);
  }

  const frameLineMatch = code.match(/const\s+\w+\s*=\s*useCurrentFrame\(\);/);

  if (frameLineMatch) {
    return code.replace(
      frameLineMatch[0],
      `${frameLineMatch[0]}\n  const { width, height } = useVideoConfig();`,
    );
  }

  const componentStartMatch = code.match(/export\s+const\s+\w+[^\n]*=>\s*\{/);
  if (componentStartMatch) {
    return code.replace(
      componentStartMatch[0],
      `${componentStartMatch[0]}\n  const { width, height } = useVideoConfig();`,
    );
  }

  return code;
};

const patchFixedStageContainerToResponsive = (code) => {
  let patched = false;

  const nextCode = code.replace(/<div\b([\s\S]*?)style=\{\{([\s\S]*?)\}\}([\s\S]*?)>/m, (full, before, style, after) => {
    let nextStyle = style;

    const widthPattern = /\bwidth\s*:\s*(?:["']1920(?:px)?["']|1920)\s*,?/;
    const heightPattern = /\bheight\s*:\s*(?:["']1080(?:px)?["']|1080)\s*,?/;

    if (widthPattern.test(nextStyle)) {
      nextStyle = nextStyle.replace(widthPattern, "width,");
      patched = true;
    }

    if (heightPattern.test(nextStyle)) {
      nextStyle = nextStyle.replace(heightPattern, "height,");
      patched = true;
    }

    return `<div${before}style={{${nextStyle}}}${after}>`;
  });

  return {
    patched,
    code: nextCode,
  };
};

const patchFirstSvgToResponsive = (code) => {
  let patched = false;

  const nextCode = code.replace(/<svg\b([\s\S]*?)>/m, (full, attrs) => {
    let nextAttrs = attrs;

    const widthPattern = /\bwidth\s*=\s*(\{?\s*1920\s*\}?|["']1920["'])/;
    const heightPattern = /\bheight\s*=\s*(\{?\s*1080\s*\}?|["']1080["'])/;

    if (widthPattern.test(nextAttrs)) {
      nextAttrs = nextAttrs.replace(widthPattern, "width={width}");
      patched = true;
    }

    if (heightPattern.test(nextAttrs)) {
      nextAttrs = nextAttrs.replace(heightPattern, "height={height}");
      patched = true;
    }

    if (patched && !/\bviewBox\s*=/.test(nextAttrs)) {
      nextAttrs = `${nextAttrs} viewBox=\"0 0 1920 1080\"`;
    }

    return `<svg${nextAttrs}>`;
  });

  return {
    patched,
    code: nextCode,
  };
};

const autoFixResponsiveTemplate = (templateCode) => {
  const notes = [];
  let code = templateCode;

  const svgPatch = patchFirstSvgToResponsive(code);
  code = svgPatch.code;
  const containerPatch = patchFixedStageContainerToResponsive(code);
  code = containerPatch.code;

  if (!svgPatch.patched && !containerPatch.patched) {
    return {
      code,
      autoFixed: false,
      notes,
    };
  }

  code = addNamedRemotionImport(code, "useVideoConfig");
  code = ensureUseVideoConfigVars(code);

  if (svgPatch.patched) {
    notes.push("Auto-fixed first SVG to responsive width/height via useVideoConfig().");
  }

  if (containerPatch.patched) {
    notes.push("Auto-fixed root container from fixed 1920x1080 to width/height from useVideoConfig().");
  }

  return {
    code,
    autoFixed: true,
    notes,
  };
};

const escapeRegExp = (value) => {
  return value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
};

const toComponentIdentifier = (value) => {
  const cleaned = String(value)
    .replace(/[^a-zA-Z0-9_$]+/g, " ")
    .trim();

  if (!cleaned) {
    return "TemplateComponent";
  }

  const identifier = cleaned
    .split(/\s+/)
    .map((part) => part[0].toUpperCase() + part.slice(1))
    .join("");

  if (!identifier) {
    return "TemplateComponent";
  }

  if (!/^[A-Za-z_$]/.test(identifier)) {
    return `Template${identifier}`;
  }

  return identifier;
};

const normalizeRootCode = ({rootCode, templateName, compositionId}) => {
  const templateBaseName = path.basename(templateName, path.extname(templateName));
  const componentName = toComponentIdentifier(templateBaseName);
  const compositionName = typeof compositionId === "string" && compositionId.trim().length > 0
    ? compositionId.trim()
    : templateBaseName;

  const generatedRootCode = `import React from "react";
import {Composition} from "remotion";
import {${componentName}} from "./${templateBaseName}";

export const RemotionRoot: React.FC = () => {
  return (
    <>
      <Composition
        id="${compositionName}"
        component={${componentName}}
        durationInFrames={210}
        fps={60}
        width={1920}
        height={1080}
        defaultProps={{}}
      />
    </>
  );
};
`;

  const rawRootCode = typeof rootCode === "string" ? rootCode.trim() : "";

  if (!rawRootCode) {
    return generatedRootCode;
  }

  const normalizedImportPath = rawRootCode.replace(
    /from\s+(["'])\.\/compositions\/([^"']+)\1/g,
    (full, quote, importPath) => {
      const withoutIndex = String(importPath).replace(/\/index$/, "");
      return `from ${quote}./${withoutIndex}${quote}`;
    },
  );

  const exactTemplateImportPattern = new RegExp(
    `from\\s+(["'])\\.\\/compositions\\/${escapeRegExp(templateBaseName)}(?:\\/index)?\\1`,
    "g",
  );

  return `${normalizedImportPath.replace(
    exactTemplateImportPattern,
    `from "./${templateBaseName}"`,
  )}\n`;
};

const IMPORT_EXTENSIONS = [
  "",
  ".ts",
  ".tsx",
  ".js",
  ".jsx",
  ".mjs",
  ".cjs",
  ".css",
  ".json",
];

const hasImportTarget = (importPath, sourceDir, extraExistingPaths = new Set()) => {
  const absoluteBasePath = path.resolve(sourceDir, importPath);
  const candidates = [];

  IMPORT_EXTENSIONS.forEach((extension) => {
    candidates.push(`${absoluteBasePath}${extension}`);
  });

  IMPORT_EXTENSIONS.forEach((extension) => {
    candidates.push(path.join(absoluteBasePath, `index${extension}`));
  });

  return candidates.some((candidatePath) => {
    return extraExistingPaths.has(candidatePath) || fs.existsSync(candidatePath);
  });
};

const findMissingRelativeImports = (code, sourceFilePath, extraExistingPaths = new Set()) => {
  const sourceDir = path.dirname(sourceFilePath);
  const missing = new Set();
  const importPattern = /(import|export)\s+(?:[^"']+?\s+from\s+)?["']([^"']+)["']/g;

  let match;
  while ((match = importPattern.exec(code)) !== null) {
    const importPath = match[2];

    if (!importPath.startsWith(".")) {
      continue;
    }

    if (!hasImportTarget(importPath, sourceDir, extraExistingPaths)) {
      missing.add(importPath);
    }
  }

  return [...missing];
};

const pushHistory = (entry) => {
  state.history.push(entry);

  if (state.history.length > MAX_HISTORY) {
    state.history = state.history.slice(-MAX_HISTORY);
  }
};

const updateHistory = (jobId, patch) => {
  const job = state.history.find((entry) => entry.jobId === jobId);

  if (!job) {
    return;
  }

  Object.assign(job, patch);
};

const markJobDoneIfRunning = (jobId, status) => {
  if (!jobId) {
    return null;
  }

  const job = state.history.find((entry) => entry.jobId === jobId);

  if (!job || job.status !== "running") {
    return null;
  }

  updateHistory(jobId, {
    status,
    finishedAt: new Date().toISOString(),
  });

  return job;
};

const disableRenderStatsStorage = (error) => {
  if (renderStatsStorageDisabled) {
    return;
  }

  renderStatsStorageDisabled = true;
  appendLog(
    "WARN: Statistik render DB dinonaktifkan. Jalankan migrasi Supabase terbaru untuk mengaktifkan total proyek kumulatif.",
  );
  console.warn("Render stats storage disabled:", error instanceof Error ? error.message : error);
};

const shouldDisableRenderStats = (error) => {
  const message = String(error?.message || error || "");
  return /(render_jobs|user_render_stats|increment_user_render_total|PGRST204|42P01)/i.test(message);
};

const parseContentRangeTotal = (value) => {
  if (!value) {
    return null;
  }

  const slashIndex = value.lastIndexOf("/");
  if (slashIndex < 0) {
    return null;
  }

  const totalRaw = value.slice(slashIndex + 1).trim();
  const total = Number(totalRaw);
  return Number.isFinite(total) ? total : null;
};

const getAuditLogCompletedProjectsTotalForUser = async ({config, userId, accessToken = ""}) => {
  if (!config || !userId) {
    return null;
  }

  const internalEnabled = hasInternalSubscriptionConfig(config);
  const normalizedAccessToken = String(accessToken || "").trim();
  if (!internalEnabled && !normalizedAccessToken) {
    return null;
  }

  const endpointPath = `/rest/v1/audit_logs?actor_user_id=eq.${encodeURIComponent(userId)}&entity_type=eq.render_job&action=eq.render_success&select=id&limit=1`;

  try {
    const apikey = internalEnabled ? config.supabaseServiceRoleKey : config.supabaseAnonKey;
    const bearerToken = internalEnabled ? config.supabaseServiceRoleKey : normalizedAccessToken;
    if (!apikey || !bearerToken) {
      return null;
    }

    const response = await fetch(`${config.supabaseUrl}${endpointPath}`, {
      method: "GET",
      headers: {
        apikey,
        Authorization: `Bearer ${bearerToken}`,
        Prefer: "count=exact",
      },
    });

    if (!response.ok) {
      const raw = await response.text();
      if (!internalEnabled && (response.status === 401 || response.status === 403)) {
        return null;
      }
      throw new HttpError(
        502,
        `Supabase request failed (${response.status}) on ${endpointPath}: ${raw}`,
      );
    }

    const total = parseContentRangeTotal(response.headers.get("content-range"));
    return Number.isFinite(total) ? total : null;
  } catch (error) {
    if (internalEnabled) {
      appendLog(`WARN: Gagal membaca total proyek dari audit log: ${error instanceof Error ? error.message : String(error)}`);
    }
    return null;
  }
};

const syncRenderHistoryEntryViaBackend = async ({config, entry, accessToken = ""}) => {
  const normalizedAccessToken = String(accessToken || "").trim();
  if (!config?.backendBaseUrl || !normalizedAccessToken) {
    return;
  }

  try {
    await requestSubscriptionBackend({
      config,
      endpointPath: "/render/sync",
      method: "POST",
      bearerToken: normalizedAccessToken,
      body: {
        jobId: entry.jobId,
        mode: entry.mode,
        inputPath: entry.inputPath || null,
        outputPath: entry.outputPath || null,
        fileName: entry.fileName || null,
        status: entry.status,
        startedAt: entry.startedAt || null,
        finishedAt: entry.finishedAt || null,
        error: entry.error || null,
      },
    });
  } catch (error) {
    if (error instanceof HttpError && [401, 403].includes(error.statusCode)) {
      return;
    }
    appendLog(`WARN: Gagal sinkron proyek ke backend: ${error instanceof Error ? error.message : String(error)}`);
  }
};

const getCompletedProjectsTotalViaBackend = async ({config, accessToken = ""}) => {
  const normalizedAccessToken = String(accessToken || "").trim();
  if (!config?.backendBaseUrl || !normalizedAccessToken) {
    return null;
  }

  try {
    const summary = await requestSubscriptionBackend({
      config,
      endpointPath: "/render/summary",
      method: "GET",
      bearerToken: normalizedAccessToken,
    });

    const total = Number(summary?.completedProjectsTotal);
    return Number.isFinite(total) ? total : null;
  } catch (error) {
    if (error instanceof HttpError && [401, 403].includes(error.statusCode)) {
      return null;
    }
    appendLog(`WARN: Gagal membaca total proyek dari backend: ${error instanceof Error ? error.message : String(error)}`);
    return null;
  }
};

const syncRenderSuccessAuditLog = async ({config, entry}) => {
  if (!config || !entry?.userId || !entry?.jobId || entry.status !== "success") {
    return;
  }

  if (!hasInternalSubscriptionConfig(config)) {
    return;
  }

  try {
    const existing = await supabaseAdminRequest({
      config,
      endpointPath: `/rest/v1/audit_logs?actor_user_id=eq.${encodeURIComponent(entry.userId)}&entity_type=eq.render_job&action=eq.render_success&request_id=eq.${encodeURIComponent(entry.jobId)}&select=id&limit=1`,
    });

    if (Array.isArray(existing) && existing.length > 0) {
      return;
    }

    await supabaseAdminRequest({
      config,
      endpointPath: "/rest/v1/audit_logs",
      method: "POST",
      prefer: "return=minimal",
      body: [
        {
          actor_user_id: entry.userId,
          actor_role: "user",
          entity_type: "render_job",
          entity_id: entry.jobId,
          action: "render_success",
          after_state: {
            mode: entry.mode,
            file_name: entry.fileName || null,
            output_path: entry.outputPath || null,
            started_at: entry.startedAt || null,
            finished_at: entry.finishedAt || null,
          },
          request_id: entry.jobId,
        },
      ],
    });
  } catch (error) {
    appendLog(`WARN: Gagal simpan audit proyek selesai: ${error instanceof Error ? error.message : String(error)}`);
  }
};

const syncRenderHistoryEntry = async ({config, entry, accessToken = ""}) => {
  if (!config) {
    return;
  }

  if (!entry?.userId || !entry?.jobId) {
    return;
  }

  if (!hasInternalSubscriptionConfig(config)) {
    await syncRenderHistoryEntryViaBackend({config, entry, accessToken});
    return;
  }

  if (!renderStatsStorageDisabled) {
    try {
      const existingRows = await supabaseAdminRequest({
        config,
        endpointPath: `/rest/v1/render_jobs?job_id=eq.${encodeURIComponent(entry.jobId)}&select=id,status&limit=1`,
      });

      const existing = Array.isArray(existingRows) ? existingRows[0] : null;
      const payload = {
        job_id: entry.jobId,
        user_id: entry.userId,
        mode: entry.mode,
        input_path: entry.inputPath || null,
        output_path: entry.outputPath || null,
        file_name: entry.fileName || null,
        status: entry.status,
        started_at: entry.startedAt || null,
        finished_at: entry.finishedAt || null,
        error: entry.error || null,
      };

      if (existing?.id) {
        await supabaseAdminRequest({
          config,
          endpointPath: `/rest/v1/render_jobs?id=eq.${encodeURIComponent(existing.id)}`,
          method: "PATCH",
          body: payload,
        });
      } else {
        await supabaseAdminRequest({
          config,
          endpointPath: "/rest/v1/render_jobs",
          method: "POST",
          prefer: "return=minimal",
          body: [payload],
        });
      }

      const shouldIncrementTotal = entry.status === "success" && existing?.status !== "success";
      if (shouldIncrementTotal) {
        await supabaseAdminRequest({
          config,
          endpointPath: "/rest/v1/rpc/increment_user_render_total",
          method: "POST",
          body: {
            p_user_id: entry.userId,
          },
        });
      }
    } catch (error) {
      if (shouldDisableRenderStats(error)) {
        disableRenderStatsStorage(error);
      } else {
        appendLog(`WARN: Gagal sinkron proyek ke DB: ${error instanceof Error ? error.message : String(error)}`);
      }
    }
  }

  await syncRenderSuccessAuditLog({config, entry});
};

const getCompletedProjectsTotalForUser = async ({config, userId, accessToken = ""}) => {
  if (!config || !userId) {
    return null;
  }

  const internalEnabled = hasInternalSubscriptionConfig(config);
  if (!internalEnabled) {
    return getCompletedProjectsTotalViaBackend({config, accessToken});
  }

  if (!renderStatsStorageDisabled) {
    try {
      const rows = await supabaseAdminRequest({
        config,
        endpointPath: `/rest/v1/user_render_stats?user_id=eq.${encodeURIComponent(userId)}&select=completed_projects_total&limit=1`,
      });

      const row = Array.isArray(rows) ? rows[0] : null;
      const total = Number(row?.completed_projects_total || 0);
      if (Number.isFinite(total)) {
        return total;
      }
    } catch (error) {
      if (shouldDisableRenderStats(error)) {
        disableRenderStatsStorage(error);
      } else {
        appendLog(`WARN: Gagal mengambil total proyek dari DB: ${error instanceof Error ? error.message : String(error)}`);
      }
    }
  }

  return getAuditLogCompletedProjectsTotalForUser({
    config,
    userId,
    accessToken,
  });
};

const openOutputFolder = () => {
  const targetPath = path.resolve(projectRoot, defaultOutputPath);
  fs.mkdirSync(targetPath, {recursive: true});

  if (process.platform === "win32") {
    const child = spawn("explorer", [targetPath], {
      detached: true,
      stdio: "ignore",
    });
    child.unref();
    return targetPath;
  }

  const command = process.platform === "darwin" ? "open" : "xdg-open";
  const child = spawn(command, [targetPath], {
    detached: true,
    stdio: "ignore",
  });
  child.unref();
  return targetPath;
};

const runBatch = ({
  mode,
  inputPath,
  composition,
  resolution,
  limit,
  actorUserId = null,
  statsConfig = null,
  statsAccessToken = "",
}) => {
  if (state.running) {
    throw new Error("A batch process is already running");
  }

  const {relative: inputRelative} = resolveInputPath(inputPath);
  const scriptPath = path.resolve(projectRoot, "scripts", "batch-render.mjs");
  const args = [
    scriptPath,
    "--input",
    inputRelative,
    "--out",
    defaultOutputPath,
  ];

  if (composition) {
    args.push("--composition", composition);
  }

  if (resolution) {
    args.push("--resolution", resolution);
  }

  const normalizedLimit = Number.isFinite(limit) && Number(limit) > 0
    ? Math.floor(Number(limit))
    : null;

  if (normalizedLimit !== null) {
    args.push("--limit", String(normalizedLimit));
  }

  if (mode === "test") {
    args.push("--frames", "0-60");

    if (normalizedLimit === null) {
      args.push("--limit", "1");
    }
  }

  state.running = true;
  state.stopRequested = false;
  state.exitCode = null;
  state.startedAt = new Date().toISOString();
  state.finishedAt = null;
  state.command = `${process.execPath} ${args.join(" ")}`;

  const runId = Date.now().toString(36);
  let currentJobId = null;

  const trackLine = (line, stream) => {
    const startMatch = line.match(/^\[(\d+)\/(\d+)\] Rendering (.+)$/);

    if (startMatch) {
      const previousJob = markJobDoneIfRunning(currentJobId, "success");
      if (previousJob) {
        void syncRenderHistoryEntry({config: statsConfig, entry: previousJob, accessToken: statsAccessToken});
      }

      const index = Number(startMatch[1]);
      const total = Number(startMatch[2]);
      const fileName = startMatch[3];
      currentJobId = `${runId}-${index}-${fileName}`;

      const historyEntry = {
        jobId: currentJobId,
        runId,
        userId: actorUserId,
        mode,
        inputPath: inputRelative,
        outputDir: defaultOutputPath,
        index,
        total,
        fileName,
        outputPath: path.join(defaultOutputPath, fileName),
        status: "running",
        startedAt: new Date().toISOString(),
        finishedAt: null,
        error: null,
      };

      pushHistory(historyEntry);
      void syncRenderHistoryEntry({config: statsConfig, entry: historyEntry, accessToken: statsAccessToken});

      return;
    }

    const failMatch = line.match(/^Failed: (.+)$/);

    if (failMatch) {
      const failedFile = failMatch[1];
      const target = [...state.history]
        .reverse()
        .find((entry) => entry.runId === runId && entry.fileName === failedFile);

      if (target) {
        updateHistory(target.jobId, {
          status: "failed",
          finishedAt: new Date().toISOString(),
          error: stream === "stderr" ? "Render command failed" : null,
        });
        void syncRenderHistoryEntry({config: statsConfig, entry: target, accessToken: statsAccessToken});
      }

      if (target?.jobId === currentJobId) {
        currentJobId = null;
      }
    }
  };

  appendLog(`Starting ${mode} run with ${inputRelative}`);

  const child = spawn(process.execPath, args, {
    cwd: projectRoot,
    stdio: ["ignore", "pipe", "pipe"],
  });
  state.child = child;

  child.stdout.on("data", (chunk) => {
    chunk
      .toString("utf8")
      .split(/\r?\n/)
      .filter(Boolean)
      .forEach((line) => {
        appendLog(line);
        trackLine(line, "stdout");
      });
  });

  child.stderr.on("data", (chunk) => {
    chunk
      .toString("utf8")
      .split(/\r?\n/)
      .filter(Boolean)
      .forEach((line) => {
        appendLog(`ERR: ${line}`);
        trackLine(line, "stderr");
      });
  });

  child.on("close", (code) => {
    state.running = false;
    state.child = null;
    state.exitCode = code;
    state.finishedAt = new Date().toISOString();
    const currentJob = markJobDoneIfRunning(
      currentJobId,
      state.stopRequested ? "stopped" : code === 0 ? "success" : "failed",
    );
    if (currentJob) {
      void syncRenderHistoryEntry({config: statsConfig, entry: currentJob, accessToken: statsAccessToken});
    }
    if (state.stopRequested) {
      appendLog("Process stopped by user");
    }
    appendLog(`Process finished with code ${code}`);
  });

  child.on("error", (error) => {
    state.running = false;
    state.child = null;
    state.exitCode = 1;
    state.finishedAt = new Date().toISOString();
    const currentJob = markJobDoneIfRunning(currentJobId, state.stopRequested ? "stopped" : "failed");
    if (currentJob) {
      void syncRenderHistoryEntry({config: statsConfig, entry: currentJob, accessToken: statsAccessToken});
    }
    appendLog(`ERR: ${error.message}`);
  });
};

const stopBatch = () => {
  if (!state.running || !state.child) {
    throw new Error("No batch process is currently running");
  }

  state.stopRequested = true;
  appendLog("Stop requested by user");

  const pid = state.child.pid;

  if (process.platform === "win32" && Number.isFinite(pid)) {
    const killer = spawn("taskkill", ["/PID", String(pid), "/T", "/F"], {
      stdio: "ignore",
      detached: true,
    });
    killer.unref();
    return;
  }

  state.child.kill("SIGTERM");
};

const htmlPath = path.resolve(projectRoot, "scripts", "batch-ui.html");
const subscriptionHtmlPath = path.resolve(projectRoot, "scripts", "subscription-ui.html");

const server = http.createServer(async (req, res) => {
  try {
    const url = new URL(req.url || "/", `http://${req.headers.host}`);

    if (req.method === "GET" && url.pathname === "/api/health") {
      sendJson(res, 200, {
        ok: true,
        running: state.running,
        port,
        host,
        now: new Date().toISOString(),
      });
      return;
    }

    if (req.method === "GET" && url.pathname === "/") {
      const config = getSubscriptionConfig();
      const accessToken = getCookieValue(req, "sb_access_token");

      if (!accessToken) {
        sendRedirect(res, "/subscription?reason=login");
        return;
      }

      try {
        const {user} = await authenticateUserFromToken(accessToken, config);
        const activeMembership = await hasActiveMembership({
          config,
          userId: user.id,
          accessToken,
        });

        if (!activeMembership) {
          sendRedirect(res, "/subscription?reason=membership");
          return;
        }
      } catch {
        sendRedirect(res, "/subscription?reason=login");
        return;
      }

      const html = fs.readFileSync(htmlPath, "utf8");
      sendHtml(res, html);
      return;
    }

    if (req.method === "GET" && url.pathname === "/subscription") {
      const html = fs.readFileSync(subscriptionHtmlPath, "utf8");
      sendHtml(res, html);
      return;
    }

    if (req.method === "GET" && url.pathname === "/api/tasks") {
      await requireLoggedInSession(req);
      const filePath = url.searchParams.get("path") || defaultInputPath;
      const data = loadTaskFile(filePath);
      sendJson(res, 200, data);
      return;
    }

    if (req.method === "POST" && url.pathname === "/api/tasks") {
      await requireLoggedInSession(req);
      const body = JSON.parse(await readRequestBody(req));
      const data = saveTaskFile(body.path, body.content);
      appendLog(`Saved ${data.path}`);
      sendJson(res, 200, data);
      return;
    }

    if (req.method === "POST" && url.pathname === "/api/template-autofix-preview") {
      await requireLoggedInSession(req);
      const body = JSON.parse(await readRequestBody(req));
      const templateCode = typeof body.templateCode === "string" ? body.templateCode : "";
      const preview = autoFixResponsiveTemplate(templateCode);

      sendJson(res, 200, {
        autoFixed: preview.autoFixed,
        notes: preview.notes,
      });
      return;
    }

    if (req.method === "POST" && url.pathname === "/api/save-template") {
      await requireActiveMembershipSession(req);
      const body = JSON.parse(await readRequestBody(req));
      const tplName = body.templateName?.trim();
      const tplCode = body.templateCode || "";
      const rootCode = body.rootCode || "";
      const compositionId = body.compositionId || "";
      
      if (!tplName || !tplName.endsWith(".tsx")) {
        throw new Error("Template name must be a valid .tsx file name");
      }

      const tplPath = path.resolve(projectRoot, "src", tplName);
      const rootPath = path.resolve(projectRoot, "src", "Root.tsx");
      const fixedTemplate = autoFixResponsiveTemplate(tplCode);
      const normalizedRootCode = normalizeRootCode({
        rootCode,
        templateName: tplName,
        compositionId,
      });
      const rootWasNormalized = String(rootCode).trim().length > 0
        && normalizedRootCode.trim() !== String(rootCode).trim();

      const missingTemplateImports = findMissingRelativeImports(fixedTemplate.code, tplPath);
      if (missingTemplateImports.length > 0) {
        throw new Error(`Template references missing relative imports: ${missingTemplateImports.join(", ")}`);
      }

      const missingRootImports = findMissingRelativeImports(
        normalizedRootCode,
        rootPath,
        new Set([tplPath]),
      );
      if (missingRootImports.length > 0) {
        throw new Error(`Root.tsx references missing imports: ${missingRootImports.join(", ")}`);
      }
      
      fs.writeFileSync(tplPath, fixedTemplate.code, "utf8");
      fs.writeFileSync(rootPath, normalizedRootCode, "utf8");
      
      appendLog(`Injected template ${tplName} and updated Root.tsx`);

      if (fixedTemplate.autoFixed) {
        fixedTemplate.notes.forEach((note) => appendLog(`Auto-fix: ${note}`));
      }

      if (rootWasNormalized) {
        appendLog("Auto-fix: Normalized Root.tsx import paths from ./compositions/... to ./...");
      }

      sendJson(res, 200, {
        success: true,
        autoFixed: fixedTemplate.autoFixed,
        notes: fixedTemplate.notes,
        rootNormalized: rootWasNormalized,
      });
      return;
    }

    if (req.method === "POST" && url.pathname === "/api/run") {
      const {config: statsConfig, token, user} = await requireActiveMembershipSession(req);
      const body = JSON.parse(await readRequestBody(req));
      const mode = body.mode === "render" ? "render" : "test";
      const resolution = body.resolution === "2k" || body.resolution === "4k" || body.resolution === "1080p"
        ? body.resolution
        : "1080p";
      const limit = Number.isFinite(Number(body.limit)) && Number(body.limit) > 0
        ? Math.floor(Number(body.limit))
        : null;

      runBatch({
        mode,
        inputPath: body.path,
        composition: body.composition,
        resolution,
        limit,
        actorUserId: user.id,
        statsConfig,
        statsAccessToken: token,
      });
      sendJson(res, 200, {running: true, mode});
      return;
    }

    if (req.method === "POST" && url.pathname === "/api/stop") {
      await requireActiveMembershipSession(req);
      stopBatch();
      sendJson(res, 200, {stopping: true});
      return;
    }

    if (req.method === "POST" && url.pathname === "/api/open-output") {
      const openedPath = openOutputFolder();
      appendLog(`Opened output folder: ${openedPath}`);
      sendJson(res, 200, {opened: true, path: openedPath});
      return;
    }

    if (req.method === "GET" && url.pathname === "/api/status") {
      const sessionCompletedCount = state.history.filter((entry) => entry.status === "success").length;
      let completedProjectsTotal = sessionCompletedCount;
      let completedProjectsSource = "session";

      try {
        const config = getSubscriptionConfig();
        const accessToken = getCookieValue(req, "sb_access_token");
        if (accessToken) {
          const {user} = await authenticateUserFromToken(accessToken, config);
          const dbTotal = await getCompletedProjectsTotalForUser({
            config,
            userId: user.id,
            accessToken,
          });

          if (Number.isFinite(dbTotal)) {
            completedProjectsTotal = dbTotal;
            completedProjectsSource = hasInternalSubscriptionConfig(config) ? "database" : "backend";
          }
        }
      } catch {
        // Keep session fallback when profile context is unavailable.
      }

      sendJson(res, 200, {
        running: state.running,
        stopRequested: state.stopRequested,
        exitCode: state.exitCode,
        startedAt: state.startedAt,
        finishedAt: state.finishedAt,
        command: state.command,
        logs: state.logs,
        outputDir: defaultOutputPath,
        history: state.history,
        completedProjectsTotal,
        completedProjectsSource,
      });
      return;
    }

    if (req.method === "GET" && url.pathname === "/api/subscription/config") {
      const config = getSubscriptionConfig();
      sendJson(res, 200, {
        supabaseUrl: config.supabaseUrl,
        supabaseAnonKey: config.supabaseAnonKey,
        midtransMode: config.isMidtransProduction ? "production" : "sandbox",
        midtransClientKey: config.midtransClientKey,
        publicMode: !hasInternalSubscriptionConfig(config),
        backendConfigured: Boolean(config.backendBaseUrl),
      });
      return;
    }

    if (req.method === "GET" && url.pathname === "/api/subscription/env-check") {
      const rawResolvedUrl =
        process.env.SUPABASE_URL?.trim()
        || process.env.VITE_SUPABASE_URL?.trim()
        || process.env.NEXT_PUBLIC_SUPABASE_URL?.trim()
        || "";
      const supabaseApiKey = resolveSupabaseApiKey();
      const resolvedUrl = isPlaceholderLike(rawResolvedUrl) ? "" : rawResolvedUrl;
      const resolvedAnon = supabaseApiKey.value;
      const missing = [];
      if (!resolvedUrl) missing.push("SUPABASE_URL");
      if (!resolvedAnon) missing.push("SUPABASE_ANON_KEY");

      sendJson(res, 200, {
        ready: missing.length === 0,
        missing,
        loadedFiles: envLoadDiagnostics.loadedFiles,
        checkedFiles: envLoadDiagnostics.checkedFiles,
        keyAliases: {
          supabaseUrl: resolvedUrl ? "resolved" : "missing",
          supabaseAnonKey: resolvedAnon ? "resolved" : "missing",
        },
        supabaseApiKeySource: supabaseApiKey.source || "missing",
        supabaseApiKeyKind: supabaseApiKey.kind,
        supabaseApiKeyCandidates: supabaseApiKey.candidates.map((entry) => ({
          name: entry.name,
          kind: entry.kind,
          hasValue: entry.hasValue,
          placeholderLike: entry.placeholderLike,
        })),
      });
      return;
    }

    if (req.method === "GET" && url.pathname === "/api/subscription/summary") {
      const config = getSubscriptionConfig();
      const accessToken = getCookieValue(req, "sb_access_token");

      if (!accessToken) {
        sendJson(res, 200, {
          loggedIn: false,
          user: null,
          membership: null,
        });
        return;
      }

      try {
        const {user} = await authenticateUserFromToken(accessToken, config);

        const membershipParams = new URLSearchParams({
          select: "id,status,starts_at,ends_at,grace_ends_at,updated_at,plan:plans(id,code,name,tier,billing_cycle_months,price_idr)",
          user_id: `eq.${user.id}`,
          order: "updated_at.desc",
          limit: "1",
        });

        const membershipRows = await supabaseUserRequest({
          config,
          accessToken,
          endpointPath: `/rest/v1/memberships?${membershipParams.toString()}`,
        });

        sendJson(res, 200, {
          loggedIn: true,
          user: {
            id: user.id,
            email: user.email || null,
            fullName: user.user_metadata?.full_name || null,
          },
          membership: Array.isArray(membershipRows) ? membershipRows[0] || null : null,
        });
      } catch {
        sendJson(res, 200, {
          loggedIn: false,
          user: null,
          membership: null,
        });
      }

      return;
    }

    if (req.method === "POST" && url.pathname === "/api/subscription/session") {
      const config = getSubscriptionConfig();

      let body;
      try {
        body = JSON.parse(await readRequestBody(req));
      } catch {
        throw new HttpError(400, "Invalid JSON payload");
      }

      const accessToken = typeof body?.accessToken === "string" ? body.accessToken.trim() : "";
      if (!accessToken) {
        throw new HttpError(400, "accessToken is required");
      }

      const {user} = await authenticateUserFromToken(accessToken, config);

      sendJson(
        res,
        200,
        {
          ok: true,
          user: {
            id: user.id,
            email: user.email,
          },
        },
        {
          "Set-Cookie": `sb_access_token=${encodeURIComponent(accessToken)}; Path=/; HttpOnly; SameSite=Lax`,
        },
      );
      return;
    }

    if (req.method === "DELETE" && url.pathname === "/api/subscription/session") {
      sendJson(
        res,
        200,
        {ok: true},
        {
          "Set-Cookie": "sb_access_token=; Path=/; HttpOnly; SameSite=Lax; Max-Age=0",
        },
      );
      return;
    }

    if (req.method === "GET" && url.pathname === "/api/subscription/plans") {
      const config = getSubscriptionConfig();
      const accessToken = getBearerTokenOptional(req) || getCookieValue(req, "sb_access_token");

      if (!accessToken) {
        sendJson(res, 200, {
          plans: getPublicFallbackPlans(),
          source: "public-fallback",
        });
        return;
      }

      const params = new URLSearchParams({
        select: "id,code,name,tier,billing_cycle_months,price_idr,is_active,metadata",
        is_active: "eq.true",
        order: "price_idr.asc",
      });

      const plans = await supabaseUserRequest({
        config,
        accessToken,
        endpointPath: `/rest/v1/plans?${params.toString()}`,
      });

      sendJson(res, 200, {
        plans: Array.isArray(plans) ? plans : [],
        source: "supabase",
      });
      return;
    }

    if (req.method === "POST" && url.pathname === "/api/subscription/register") {
      throw new HttpError(
        501,
        "Registrasi local server dinonaktifkan untuk build publik. Gunakan Supabase Auth signUp langsung dari client.",
      );
      return;
    }

    if (req.method === "GET" && url.pathname === "/api/subscription/status") {
      const config = getSubscriptionConfig();
      const {token, user} = await authenticateUserFromRequest(req, config);

      const membershipParams = new URLSearchParams({
        select: "id,status,starts_at,ends_at,grace_ends_at,canceled_at,updated_at,plan:plans(id,code,name,tier,billing_cycle_months,price_idr)",
        user_id: `eq.${user.id}`,
        order: "updated_at.desc",
        limit: "1",
      });

      const invoicesParams = new URLSearchParams({
        select: "id,external_order_id,amount_idr,currency,status,paid_at,created_at,updated_at,raw_payload",
        user_id: `eq.${user.id}`,
        order: "created_at.desc",
        limit: "10",
      });

      const paymentsParams = new URLSearchParams({
        select: "id,status,payment_method,payment_channel,external_transaction_id,transaction_time,settlement_time,created_at",
        user_id: `eq.${user.id}`,
        order: "created_at.desc",
        limit: "5",
      });

      const [memberships, invoices, payments] = await Promise.all([
        supabaseUserRequest({
          config,
          accessToken: token,
          endpointPath: `/rest/v1/memberships?${membershipParams.toString()}`,
        }),
        supabaseUserRequest({
          config,
          accessToken: token,
          endpointPath: `/rest/v1/invoices?${invoicesParams.toString()}`,
        }),
        supabaseUserRequest({
          config,
          accessToken: token,
          endpointPath: `/rest/v1/payments?${paymentsParams.toString()}`,
        }),
      ]);

      sendJson(res, 200, {
        user: {
          id: user.id,
          email: user.email,
        },
        membership: Array.isArray(memberships) ? memberships[0] || null : null,
        invoices: Array.isArray(invoices) ? invoices : [],
        payments: Array.isArray(payments) ? payments : [],
      });
      return;
    }

    if (
      req.method === "POST"
      && [
        "/api/subscription/voucher/validate",
        "/api/subscription/voucher/check",
        "/api/subscription/voucher/claim",
      ].includes(url.pathname)
    ) {
      const config = getSubscriptionConfig();
      const internalEnabled = hasInternalSubscriptionConfig(config);

      if (!internalEnabled && config.backendBaseUrl) {
        const body = JSON.parse(await readRequestBody(req));
        const result = await forwardSubscriptionRequest({
          config,
          req,
          endpointPath: "/voucher/validate",
          body,
        });
        sendJson(res, 200, result);
        return;
      }

      const internalConfig = requireInternalSubscriptionConfig(config);
      const {user} = await authenticateUserFromRequest(req, internalConfig);

      let body;
      try {
        body = JSON.parse(await readRequestBody(req));
      } catch {
        throw new HttpError(400, "Invalid JSON payload");
      }

      const planId = typeof body?.planId === "string" ? body.planId.trim() : "";
      const voucherCode = typeof body?.voucherCode === "string" ? body.voucherCode : "";

      if (!planId) {
        throw new HttpError(400, "planId is required");
      }

      const plan = await fetchActivePlanById({
        config: internalConfig,
        planId,
      });

      const checkoutVoucher = await resolveVoucherForCheckout({
        config: internalConfig,
        userId: user.id,
        plan,
        rawVoucherCode: voucherCode,
      });

      if (!checkoutVoucher) {
        throw new HttpError(400, "voucherCode is required");
      }

      sendJson(res, 200, {
        valid: true,
        voucher: {
          id: checkoutVoucher.voucher.id,
          code: checkoutVoucher.voucher.code,
          name: checkoutVoucher.voucher.name,
          description: checkoutVoucher.voucher.description || null,
          discountType: checkoutVoucher.voucher.discount_type,
          discountValue: Number(checkoutVoucher.voucher.discount_value || 0),
          maxDiscountIdr: Number(checkoutVoucher.voucher.max_discount_idr || 0),
          minPurchaseIdr: Number(checkoutVoucher.voucher.min_purchase_idr || 0),
          planAmountIdr: checkoutVoucher.planAmountIdr,
          discountIdr: checkoutVoucher.discountIdr,
          finalAmountIdr: checkoutVoucher.finalAmountIdr,
        },
      });
      return;
    }

    if (req.method === "POST" && url.pathname === "/api/subscription/checkout") {
      const config = getSubscriptionConfig();
      const internalEnabled = hasInternalSubscriptionConfig(config);

      let body;
      try {
        body = JSON.parse(await readRequestBody(req));
      } catch {
        throw new HttpError(400, "Invalid JSON payload");
      }

      if (!internalEnabled) {
        if (config.backendBaseUrl) {
          const result = await forwardSubscriptionRequest({
            config,
            req,
            endpointPath: "/checkout",
            body,
          });
          sendJson(res, 200, result);
          return;
        }

        throw new HttpError(
          503,
          "Checkout lokal dinonaktifkan untuk build publik. Set SUBSCRIPTION_BACKEND_URL untuk memproses pembayaran di backend.",
        );
      }

      const internalConfig = requireInternalSubscriptionConfig(config);
      const {user} = await authenticateUserFromRequest(req, internalConfig);

      const planId = typeof body?.planId === "string" ? body.planId.trim() : "";
      const voucherCode = typeof body?.voucherCode === "string" ? body.voucherCode : "";
      if (!planId) {
        throw new HttpError(400, "planId is required");
      }

      const plan = await fetchActivePlanById({
        config: internalConfig,
        planId,
      });
      const planAmount = resolvePlanAmountIdr(plan);

      const checkoutVoucher = await resolveVoucherForCheckout({
        config: internalConfig,
        userId: user.id,
        plan,
        rawVoucherCode: voucherCode,
      });

      const payableAmount = checkoutVoucher?.finalAmountIdr ?? planAmount;

      const upsertMembershipPayload = [
        {
          user_id: user.id,
          plan_id: plan.id,
          status: "pending_payment",
          source: "midtrans",
        },
      ];

      const membershipRows = await supabaseAdminRequest({
        config: internalConfig,
        endpointPath: "/rest/v1/memberships?on_conflict=user_id",
        method: "POST",
        prefer: "resolution=merge-duplicates,return=representation",
        body: upsertMembershipPayload,
      });

      const membership = Array.isArray(membershipRows) ? membershipRows[0] : null;
      if (!membership?.id) {
        throw new HttpError(502, "Unable to upsert membership");
      }

      const orderId = createCheckoutOrderId();
      const invoiceRows = await supabaseAdminRequest({
        config: internalConfig,
        endpointPath: "/rest/v1/invoices",
        method: "POST",
        prefer: "return=representation",
        body: [
          {
            user_id: user.id,
            membership_id: membership.id,
            provider: "midtrans",
            external_order_id: orderId,
            currency: "IDR",
            amount_idr: payableAmount,
            status: "open",
            raw_payload: {
              source: "subscription-ui",
              plan_id: plan.id,
              plan_code: plan.code,
              voucher: checkoutVoucher
                ? {
                  id: checkoutVoucher.voucher.id,
                  code: checkoutVoucher.voucherCode,
                  discount_type: checkoutVoucher.voucher.discount_type,
                  discount_value: Number(checkoutVoucher.voucher.discount_value || 0),
                  discount_idr: checkoutVoucher.discountIdr,
                  base_amount_idr: planAmount,
                  final_amount_idr: checkoutVoucher.finalAmountIdr,
                }
                : null,
            },
          },
        ],
      });

      const invoice = Array.isArray(invoiceRows) ? invoiceRows[0] : null;
      if (!invoice?.id) {
        throw new HttpError(502, "Unable to create invoice");
      }

      if (checkoutVoucher) {
        try {
          await reserveVoucherRedemption({
            config: internalConfig,
            checkoutVoucher,
            userId: user.id,
            invoiceId: invoice.id,
            orderId,
          });
        } catch (error) {
          await supabaseAdminRequest({
            config: internalConfig,
            endpointPath: `/rest/v1/invoices?id=eq.${encodeURIComponent(invoice.id)}`,
            method: "PATCH",
            body: {
              raw_payload: {
                source: "subscription-ui",
                voucher_reservation_error: error instanceof Error ? error.message : String(error),
              },
            },
          });

          throw new HttpError(502, "Gagal mengunci voucher. Silakan ulangi checkout.");
        }
      }

      const displayName =
        user.user_metadata?.full_name ||
        user.email?.split("@")[0] ||
        "Customer";

      let midtransResponse;
      try {
        midtransResponse = await createMidtransTransaction({
          config: internalConfig,
          payload: {
            transaction_details: {
              order_id: orderId,
              gross_amount: payableAmount,
            },
            customer_details: {
              first_name: displayName,
              email: user.email,
            },
            item_details: [
              {
                id: checkoutVoucher ? `${plan.code}-discounted` : plan.code,
                name: checkoutVoucher ? `${plan.name} + Voucher` : plan.name,
                price: payableAmount,
                quantity: 1,
              },
            ],
            custom_expiry: {
              expiry_duration: 60,
              unit: "minute",
            },
          },
        });
      } catch (error) {
        await supabaseAdminRequest({
          config: internalConfig,
          endpointPath: `/rest/v1/invoices?id=eq.${encodeURIComponent(invoice.id)}`,
          method: "PATCH",
          body: {
            raw_payload: {
              source: "subscription-ui",
              midtrans_error: error instanceof Error ? error.message : String(error),
            },
          },
        });
        throw error;
      }

      await supabaseAdminRequest({
        config: internalConfig,
        endpointPath: `/rest/v1/invoices?id=eq.${encodeURIComponent(invoice.id)}`,
        method: "PATCH",
        body: {
          raw_payload: {
            source: "subscription-ui",
            plan_id: plan.id,
            plan_code: plan.code,
            voucher: checkoutVoucher
              ? {
                id: checkoutVoucher.voucher.id,
                code: checkoutVoucher.voucherCode,
                discount_type: checkoutVoucher.voucher.discount_type,
                discount_value: Number(checkoutVoucher.voucher.discount_value || 0),
                discount_idr: checkoutVoucher.discountIdr,
                base_amount_idr: planAmount,
                final_amount_idr: checkoutVoucher.finalAmountIdr,
              }
              : null,
            midtrans: midtransResponse,
          },
        },
      });

      sendJson(res, 200, {
        orderId,
        invoiceId: invoice.id,
        membershipId: membership.id,
        token: midtransResponse.token,
        redirectUrl: midtransResponse.redirect_url,
        voucher: checkoutVoucher
          ? {
            code: checkoutVoucher.voucherCode,
            discountIdr: checkoutVoucher.discountIdr,
            baseAmountIdr: planAmount,
            finalAmountIdr: checkoutVoucher.finalAmountIdr,
          }
          : null,
      });
      return;
    }

    if (req.method === "POST" && url.pathname === "/api/subscription/webhook") {
      const config = getSubscriptionConfig();
      const internalEnabled = hasInternalSubscriptionConfig(config);

      if (!internalEnabled && config.backendBaseUrl) {
        const payload = JSON.parse(await readRequestBody(req));
        const result = await forwardSubscriptionRequest({
          config,
          req,
          endpointPath: "/webhook",
          body: payload,
        });
        sendJson(res, 200, result);
        return;
      }

      const internalConfig = requireInternalSubscriptionConfig(config);
      let payload;
      try {
        payload = JSON.parse(await readRequestBody(req));
      } catch {
        throw new HttpError(400, "Invalid JSON payload");
      }

      console.log(`[Webhook] Midtrans notification for ${payload.order_id}`);
      const result = await processMidtransNotification({config: internalConfig, notification: payload});
      sendJson(res, 200, result);
      return;
    }

    if (req.method === "POST" && url.pathname === "/api/subscription/verify-payment") {
      const config = getSubscriptionConfig();
      const internalEnabled = hasInternalSubscriptionConfig(config);

      let payload;
      try {
        payload = JSON.parse(await readRequestBody(req));
      } catch {
        throw new HttpError(400, "Invalid JSON payload");
      }

      if (!internalEnabled) {
        if (config.backendBaseUrl) {
          const result = await forwardSubscriptionRequest({
            config,
            req,
            endpointPath: "/verify-payment",
            body: payload,
          });
          sendJson(res, 200, result);
          return;
        }

        throw new HttpError(
          503,
          "Verifikasi payment lokal dinonaktifkan untuk build publik. Set SUBSCRIPTION_BACKEND_URL.",
        );
      }

      const internalConfig = requireInternalSubscriptionConfig(config);
      await authenticateUserFromRequest(req, internalConfig); // Ensure caller is authenticated
      
      const directNotification = payload?.notification;
      if (directNotification && typeof directNotification === "object" && directNotification.order_id) {
        const result = await processMidtransNotification({
          config: internalConfig,
          notification: directNotification,
        });
        sendJson(res, 200, {
          ...result,
          source: "snap-callback",
        });
        return;
      }

      if (!payload.order_id) {
        throw new HttpError(400, "order_id is required");
      }

      console.log(`[Verify] Manual verification requested for ${payload.order_id}`);
      const verification = await verifyMidtransPayment({config: internalConfig, orderId: payload.order_id});
      if (!verification?.data) {
        throw new HttpError(
          404,
          "Transaction not found in Midtrans status API (cek MIDTRANS_IS_PRODUCTION dan server key).",
        );
      }
      
      const result = await processMidtransNotification({config: internalConfig, notification: verification.data});
      sendJson(res, 200, {
        ...result,
        source: verification.source,
      });
      return;
    }

    sendJson(res, 404, {error: "Not found"});
  } catch (error) {
    const statusCode =
      error instanceof HttpError && Number.isFinite(error.statusCode)
        ? error.statusCode
        : 500;
    sendJson(res, statusCode, {error: error instanceof Error ? error.message : String(error)});
  }
});

server.listen(port, host, () => {
  const displayHost = host === "127.0.0.1" ? "localhost" : host;
  console.log(`Batch UI running at http://${displayHost}:${port}`);
  console.log("Press Ctrl+C to stop.");
});
