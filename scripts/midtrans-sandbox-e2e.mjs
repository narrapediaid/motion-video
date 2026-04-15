import { createHash, randomUUID } from "node:crypto";
import { readFileSync, existsSync } from "node:fs";
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
    if (!process.env[key]) {
      process.env[key] = value;
    }
  }
};

const required = (name) => {
  const value = process.env[name];
  if (!value) {
    throw new Error(`Missing required env: ${name}`);
  }
  return value;
};

const signature = ({ orderId, statusCode, grossAmount, serverKey }) => {
  const raw = `${orderId}${statusCode}${grossAmount}${serverKey}`;
  return createHash("sha512").update(raw).digest("hex");
};

const requestJson = async ({ url, method = "GET", headers = {}, body }) => {
  const res = await fetch(url, {
    method,
    headers: {
      "Content-Type": "application/json",
      ...headers,
    },
    body: body ? JSON.stringify(body) : undefined,
  });

  const text = await res.text();
  let json = null;
  try {
    json = text ? JSON.parse(text) : null;
  } catch {
    json = { raw: text };
  }

  return { status: res.status, data: json };
};

const assert = (condition, message) => {
  if (!condition) throw new Error(message);
};

const cleanupFaultModeRaw = process.env.E2E_FAULT_INJECT_CLEANUP ?? "";
const cleanupFaultMode = cleanupFaultModeRaw.trim().toLowerCase();
const cleanupFaultFromCli = process.argv.slice(2).includes("--fault-cleanup");
const cleanupFaultInjected =
  cleanupFaultFromCli ||
  cleanupFaultMode === "1" ||
  cleanupFaultMode === "true" ||
  cleanupFaultMode === "force-issue";

loadEnv();

const SUPABASE_URL = required("SUPABASE_URL");
const SUPABASE_ANON_KEY = required("SUPABASE_ANON_KEY");
const SUPABASE_SERVICE_ROLE_KEY = required("SUPABASE_SERVICE_ROLE_KEY");
const MIDTRANS_SERVER_KEY = required("MIDTRANS_SERVER_KEY");

const functionHeaders = {
  apikey: SUPABASE_ANON_KEY,
  Authorization: `Bearer ${SUPABASE_ANON_KEY}`,
};

const serviceHeaders = {
  apikey: SUPABASE_SERVICE_ROLE_KEY,
  Authorization: `Bearer ${SUPABASE_SERVICE_ROLE_KEY}`,
  Prefer: "return=representation",
};

const testId = `E2E-${Date.now()}-${Math.floor(Math.random() * 1000)}`;
const email = `e2e-midtrans-${Date.now()}@example.com`;
const password = `Test${Math.floor(Math.random() * 100000)}!A`;
const orderId = `ORDER-${testId}`;
const transactionId = `TX-${testId}`;
const grossAmount = "10000.00";
const planCode = `PLAN-${testId}`;

const state = {
  userId: null,
  planId: null,
  membershipId: null,
  invoiceId: null,
};

const cleanup = async () => {
  const issues = [];
  const h = {
    apikey: SUPABASE_SERVICE_ROLE_KEY,
    Authorization: `Bearer ${SUPABASE_SERVICE_ROLE_KEY}`,
  };

  const deleteRest = async (label, path) => {
    try {
      const res = await fetch(`${SUPABASE_URL}${path}`, {
        method: "DELETE",
        headers: h,
      });
      if (res.status !== 200 && res.status !== 204) {
        const body = await res.text();
        issues.push(`${label}: delete failed with status ${res.status}, body=${body}`);
      }
    } catch (error) {
      issues.push(`${label}: delete request error: ${error instanceof Error ? error.message : String(error)}`);
    }
  };

  const verifyNone = async (label, path) => {
    try {
      const check = await requestJson({
        url: `${SUPABASE_URL}${path}`,
        method: "GET",
        headers: h,
      });
      if (check.status !== 200) {
        issues.push(`${label}: verify failed with status ${check.status}`);
        return;
      }
      if (!Array.isArray(check.data)) {
        issues.push(`${label}: verify expected array response`);
        return;
      }
      if (check.data.length > 0) {
        issues.push(`${label}: ${check.data.length} record(s) still exist`);
      }
    } catch (error) {
      issues.push(`${label}: verify request error: ${error instanceof Error ? error.message : String(error)}`);
    }
  };

  await deleteRest("payment_events", `/rest/v1/payment_events?external_order_id=eq.${orderId}`);

  if (state.invoiceId) {
    await deleteRest("audit_logs", `/rest/v1/audit_logs?entity_id=eq.${state.invoiceId}`);
    await deleteRest("payments", `/rest/v1/payments?invoice_id=eq.${state.invoiceId}`);
    await deleteRest("invoices", `/rest/v1/invoices?id=eq.${state.invoiceId}`);
  }

  if (state.membershipId) {
    await deleteRest("memberships", `/rest/v1/memberships?id=eq.${state.membershipId}`);
  }

  if (state.planId) {
    await deleteRest("plans", `/rest/v1/plans?id=eq.${state.planId}`);
  }

  if (state.userId) {
    await deleteRest("profiles", `/rest/v1/profiles?id=eq.${state.userId}`);
    try {
      const authDelete = await fetch(`${SUPABASE_URL}/auth/v1/admin/users/${state.userId}`, {
        method: "DELETE",
        headers: h,
      });
      if (authDelete.status !== 200) {
        const body = await authDelete.text();
        issues.push(`auth.users: delete failed with status ${authDelete.status}, body=${body}`);
      }
    } catch (error) {
      issues.push(`auth.users: delete request error: ${error instanceof Error ? error.message : String(error)}`);
    }
  }

  await verifyNone("payment_events", `/rest/v1/payment_events?external_order_id=eq.${orderId}&select=id`);
  await verifyNone("invoices", `/rest/v1/invoices?external_order_id=eq.${orderId}&select=id`);

  if (state.membershipId) {
    await verifyNone("memberships", `/rest/v1/memberships?id=eq.${state.membershipId}&select=id`);
  }

  await verifyNone("plans", `/rest/v1/plans?code=eq.${planCode}&select=id`);

  if (state.userId) {
    await verifyNone("profiles", `/rest/v1/profiles?id=eq.${state.userId}&select=id`);
    try {
      const authCheck = await requestJson({
        url: `${SUPABASE_URL}/auth/v1/admin/users/${state.userId}`,
        method: "GET",
        headers: h,
      });
      if (authCheck.status !== 404) {
        issues.push(`auth.users: expected 404 after cleanup but got ${authCheck.status}`);
      }
    } catch (error) {
      issues.push(`auth.users: verify request error: ${error instanceof Error ? error.message : String(error)}`);
    }
  }

  if (cleanupFaultInjected) {
    issues.push("fault injection active: simulated cleanup assertion failure");
  }

  return issues;
};

try {
  if (cleanupFaultInjected) {
    console.log("[E2E] Fault injection enabled: cleanup failure will be simulated.");
  }

  console.log("[E2E] Create auth user...");
  const createdUser = await requestJson({
    url: `${SUPABASE_URL}/auth/v1/admin/users`,
    method: "POST",
    headers: {
      apikey: SUPABASE_SERVICE_ROLE_KEY,
      Authorization: `Bearer ${SUPABASE_SERVICE_ROLE_KEY}`,
    },
    body: {
      email,
      password,
      email_confirm: true,
      user_metadata: {
        full_name: "Midtrans E2E User",
      },
    },
  });

  assert(createdUser.status === 200 || createdUser.status === 201, `Create user failed: ${JSON.stringify(createdUser)}`);
  state.userId = createdUser.data.id;

  console.log("[E2E] Ensure profile exists...");
  const profileUpsert = await requestJson({
    url: `${SUPABASE_URL}/rest/v1/profiles`,
    method: "POST",
    headers: {
      ...serviceHeaders,
      Prefer: "resolution=merge-duplicates,return=representation",
    },
    body: [
      {
        id: state.userId,
        email,
        full_name: "Midtrans E2E User",
        app_role: "user",
      },
    ],
  });
  assert(profileUpsert.status === 201 || profileUpsert.status === 200, `Upsert profile failed: ${JSON.stringify(profileUpsert)}`);

  console.log("[E2E] Create plan...");
  const planResp = await requestJson({
    url: `${SUPABASE_URL}/rest/v1/plans`,
    method: "POST",
    headers: serviceHeaders,
    body: [
      {
        code: planCode,
        name: `Plan ${testId}`,
        tier: "monthly",
        billing_cycle_months: 1,
        price_idr: 10000,
        is_active: true,
        metadata: { source: "midtrans-e2e" },
      },
    ],
  });
  assert(planResp.status === 201, `Create plan failed: ${JSON.stringify(planResp)}`);
  state.planId = planResp.data[0].id;

  console.log("[E2E] Create membership...");
  const membershipResp = await requestJson({
    url: `${SUPABASE_URL}/rest/v1/memberships`,
    method: "POST",
    headers: serviceHeaders,
    body: [
      {
        user_id: state.userId,
        plan_id: state.planId,
        status: "pending_payment",
        source: "midtrans",
      },
    ],
  });
  assert(membershipResp.status === 201, `Create membership failed: ${JSON.stringify(membershipResp)}`);
  state.membershipId = membershipResp.data[0].id;

  console.log("[E2E] Create invoice...");
  const invoiceResp = await requestJson({
    url: `${SUPABASE_URL}/rest/v1/invoices`,
    method: "POST",
    headers: serviceHeaders,
    body: [
      {
        user_id: state.userId,
        membership_id: state.membershipId,
        provider: "midtrans",
        external_order_id: orderId,
        currency: "IDR",
        amount_idr: 10000,
        status: "open",
        raw_payload: { source: "midtrans-e2e" },
      },
    ],
  });
  assert(invoiceResp.status === 201, `Create invoice failed: ${JSON.stringify(invoiceResp)}`);
  state.invoiceId = invoiceResp.data[0].id;

  const basePayload = {
    order_id: orderId,
    transaction_id: transactionId,
    status_code: "200",
    gross_amount: grossAmount,
    transaction_status: "settlement",
    fraud_status: "accept",
    transaction_time: new Date().toISOString(),
    settlement_time: new Date().toISOString(),
    payment_type: "bank_transfer",
    store: "bca",
  };

  const validPayload = {
    ...basePayload,
    signature_key: signature({
      orderId: basePayload.order_id,
      statusCode: basePayload.status_code,
      grossAmount: basePayload.gross_amount,
      serverKey: MIDTRANS_SERVER_KEY,
    }),
  };

  console.log("[E2E] Call webhook (valid signature)...");
  const firstCall = await requestJson({
    url: `${SUPABASE_URL}/functions/v1/midtrans-webhook`,
    method: "POST",
    headers: functionHeaders,
    body: validPayload,
  });
  assert(firstCall.status === 200, `Valid webhook call failed: ${JSON.stringify(firstCall)}`);
  assert(firstCall.data?.result?.status === "applied", `Expected applied, got: ${JSON.stringify(firstCall.data)}`);

  console.log("[E2E] Call webhook duplicate payload...");
  const secondCall = await requestJson({
    url: `${SUPABASE_URL}/functions/v1/midtrans-webhook`,
    method: "POST",
    headers: functionHeaders,
    body: validPayload,
  });
  assert(secondCall.status === 200, `Duplicate webhook call failed: ${JSON.stringify(secondCall)}`);
  assert(secondCall.data?.result?.status === "duplicate", `Expected duplicate, got: ${JSON.stringify(secondCall.data)}`);

  console.log("[E2E] Call webhook invalid signature...");
  const invalidCall = await requestJson({
    url: `${SUPABASE_URL}/functions/v1/midtrans-webhook`,
    method: "POST",
    headers: functionHeaders,
    body: {
      ...basePayload,
      signature_key: randomUUID().replaceAll("-", ""),
    },
  });
  assert(invalidCall.status === 401, `Expected 401 invalid signature, got: ${JSON.stringify(invalidCall)}`);

  console.log("[E2E] Verify invoice status paid...");
  const invoiceCheck = await requestJson({
    url: `${SUPABASE_URL}/rest/v1/invoices?id=eq.${state.invoiceId}&select=id,status,paid_at`,
    method: "GET",
    headers: {
      apikey: SUPABASE_SERVICE_ROLE_KEY,
      Authorization: `Bearer ${SUPABASE_SERVICE_ROLE_KEY}`,
    },
  });
  assert(invoiceCheck.status === 200, `Invoice check failed: ${JSON.stringify(invoiceCheck)}`);
  assert(invoiceCheck.data?.[0]?.status === "paid", `Invoice status expected paid: ${JSON.stringify(invoiceCheck.data)}`);

  console.log("[E2E] Verify membership status active...");
  const membershipCheck = await requestJson({
    url: `${SUPABASE_URL}/rest/v1/memberships?id=eq.${state.membershipId}&select=id,status,version`,
    method: "GET",
    headers: {
      apikey: SUPABASE_SERVICE_ROLE_KEY,
      Authorization: `Bearer ${SUPABASE_SERVICE_ROLE_KEY}`,
    },
  });
  assert(membershipCheck.status === 200, `Membership check failed: ${JSON.stringify(membershipCheck)}`);
  assert(membershipCheck.data?.[0]?.status === "active", `Membership status expected active: ${JSON.stringify(membershipCheck.data)}`);

  console.log("[E2E] Verify payment event ledger exists...");
  const eventCheck = await requestJson({
    url: `${SUPABASE_URL}/rest/v1/payment_events?external_order_id=eq.${orderId}&select=id,process_result,received_at&order=received_at.asc`,
    method: "GET",
    headers: {
      apikey: SUPABASE_SERVICE_ROLE_KEY,
      Authorization: `Bearer ${SUPABASE_SERVICE_ROLE_KEY}`,
    },
  });
  assert(eventCheck.status === 200, `Payment events check failed: ${JSON.stringify(eventCheck)}`);
  assert(Array.isArray(eventCheck.data) && eventCheck.data.length >= 1, "Payment events are missing.");

  console.log("[E2E] PASS");
} catch (err) {
  console.error("[E2E] FAIL", err.message);
  process.exitCode = 1;
} finally {
  const cleanupIssues = await cleanup();
  if (cleanupIssues.length > 0) {
    console.error("[E2E] CLEANUP FAIL");
    for (const issue of cleanupIssues) {
      console.error(`[E2E] CLEANUP ISSUE: ${issue}`);
    }
    process.exitCode = 1;
  } else {
    console.log("[E2E] Cleanup done and verified.");
  }
}
