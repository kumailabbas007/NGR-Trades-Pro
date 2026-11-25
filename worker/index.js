const ALLOWED_ORIGIN = "https://kumailabbas007.github.io";
const PRICE_URL = "https://xaus.com/api/v1/spot?compact=1";
const MAX_PRICE_AGE_SECONDS = 180;
const ALLOWED_EXPIRY = new Set(["Until deleted", "24 hours", "7 days"]);

function corsHeaders() {
  return {
    "Access-Control-Allow-Origin": ALLOWED_ORIGIN,
    "Access-Control-Allow-Headers": "Content-Type, Authorization",
    "Access-Control-Allow-Methods": "GET, POST, DELETE, OPTIONS",
    "Access-Control-Max-Age": "86400",
    "Vary": "Origin"
  };
}

function json(data, status = 200) {
  return new Response(JSON.stringify(data), {
    status,
    headers: { "Content-Type": "application/json; charset=utf-8", ...corsHeaders() }
  });
}

function authorized(request, env) {
  return typeof env.APP_TOKEN === "string" &&
    env.APP_TOKEN.length >= 24 &&
    request.headers.get("Authorization") === `Bearer ${env.APP_TOKEN}`;
}

function expiryTimestamp(expiry, now) {
  if (expiry === "24 hours" || expiry === "Today") return now + 24 * 60 * 60 * 1000;
  if (expiry === "7 days") return now + 7 * 24 * 60 * 60 * 1000;
  return null;
}

export default {
  async fetch(request, env) {
    const url = new URL(request.url);
    const origin = request.headers.get("Origin") || "";

    if (request.method === "OPTIONS") {
      if (origin !== ALLOWED_ORIGIN) return new Response(null, { status: 403 });
      return new Response(null, { status: 204, headers: corsHeaders() });
    }

    if (url.pathname === "/health" && request.method === "GET") {
      return json({
        status: "online",
        service: "NGR Gold Alerts",
        kvConfigured: Boolean(env.ALERTS_KV),
        authConfigured: typeof env.APP_TOKEN === "string" && env.APP_TOKEN.length >= 24,
        notificationConfigured: typeof env.NTFY_TOPIC === "string" && env.NTFY_TOPIC.length > 0
      });
    }

    if (origin !== ALLOWED_ORIGIN) return json({ error: "Origin not allowed" }, 403);
    if (!authorized(request, env)) return json({ error: "Unauthorized" }, 401);
    if (!env.ALERTS_KV) return json({ error: "Alert storage is not configured" }, 503);

    if (url.pathname === "/alerts" && request.method === "GET") {
      const alerts = [];
      let cursor;
      do {
        const page = await env.ALERTS_KV.list({ prefix: "alert:", cursor, limit: 1000 });
        for (const key of page.keys) {
          const value = await env.ALERTS_KV.get(key.name, "json");
          if (value) alerts.push(value);
        }
        cursor = page.list_complete ? undefined : page.cursor;
      } while (cursor);
      alerts.sort((a, b) => (b.createdAt || 0) - (a.createdAt || 0));
      return json({ alerts });
    }

    if (url.pathname === "/alerts" && request.method === "POST") {
      const contentType = request.headers.get("Content-Type") || "";
      if (!contentType.toLowerCase().includes("application/json")) {
        return json({ error: "Content-Type must be application/json" }, 415);
      }
      const raw = await request.text();
      if (raw.length > 4096) return json({ error: "Request body is too large" }, 413);
      let body;
      try { body = JSON.parse(raw); } catch { return json({ error: "Invalid JSON" }, 400); }

      const level = Number(body?.level);
      const condition = body?.condition;
      const expiry = ALLOWED_EXPIRY.has(body?.expiry) ? body.expiry : "Until deleted";
      if (!Number.isFinite(level) || level <= 0 || level > 1000000 ||
          !["above", "below"].includes(condition)) {
        return json({ error: "Enter a valid positive target and condition" }, 400);
      }

      const now = Date.now();
      const expiresAt = expiryTimestamp(expiry, now);
      const id = crypto.randomUUID();
      const alert = {
        id,
        symbol: "XAUUSD",
        condition,
        level,
        createdAt: now,
        expiry,
        expiresAt
      };
      const options = expiresAt
        ? { expirationTtl: Math.max(60, Math.ceil((expiresAt - now) / 1000)) }
        : undefined;
      await env.ALERTS_KV.put(`alert:${id}`, JSON.stringify(alert), options);
      return json({ success: true, alert }, 201);
    }

    if (url.pathname === "/alerts" && request.method === "DELETE") {
      const id = url.searchParams.get("id");
      if (!id || !/^[a-f0-9-]{36}$/i.test(id)) return json({ error: "Invalid alert ID" }, 400);
      await env.ALERTS_KV.delete(`alert:${id}`);
      return json({ success: true });
    }

    return json({ error: "Not found" }, 404);
  },

  async scheduled(controller, env, ctx) {
    ctx.waitUntil(checkAlerts(env));
  }
};

async function getFreshGoldPrice() {
  const response = await fetch(PRICE_URL, {
    headers: { Accept: "application/json" },
    signal: AbortSignal.timeout(10000)
  });
  if (!response.ok) throw new Error(`Price source returned HTTP ${response.status}`);
  const data = await response.json();
  const price = Number(data?.spot_usd_oz);
  const state = data?.data_state;
  const age = Number(state?.age_seconds);
  const generatedAt = Date.parse(data?.updated_at || "");
  const generatedAge = (Date.now() - generatedAt) / 1000;

  if (!Number.isFinite(price) || price <= 0 ||
      state?.status !== "fresh" ||
      !Number.isFinite(age) || age < 0 || age > MAX_PRICE_AGE_SECONDS ||
      !Number.isFinite(generatedAt) || generatedAge < -30 ||
      generatedAge > MAX_PRICE_AGE_SECONDS) {
    throw new Error("Gold price is stale, unavailable, or missing a valid timestamp");
  }
  return { price, updatedAt: data.updated_at };
}

async function checkAlerts(env) {
  if (!env.ALERTS_KV || !env.NTFY_TOPIC) {
    console.log("Alert check skipped: KV or notification topic is not configured.");
    return;
  }

  let market;
  try {
    market = await getFreshGoldPrice();
  } catch (error) {
    console.log(`Alert check skipped: ${error.message}`);
    return;
  }

  let cursor;
  do {
    const page = await env.ALERTS_KV.list({ prefix: "alert:", cursor, limit: 1000 });
    for (const key of page.keys) {
      const alert = await env.ALERTS_KV.get(key.name, "json");
      if (!alert) continue;

      if (alert.expiresAt && Date.now() >= alert.expiresAt) {
        await env.ALERTS_KV.delete(key.name);
        continue;
      }

      const triggered = alert.condition === "above"
        ? market.price >= alert.level
        : market.price <= alert.level;
      if (!triggered) continue;

      const message = [
        "NGR TRADES PRO | XAU/USD",
        `Target ${alert.condition}: $${Number(alert.level).toFixed(2)}`,
        `Observed spot price: $${market.price.toFixed(2)}`,
        `Price timestamp: ${market.updatedAt}`,
        "Source: XAUS indicative spot. Verify the quote on your broker's MT5 before acting."
      ].join("\\n");

      try {
        const sent = await fetch(`https://ntfy.sh/${encodeURIComponent(env.NTFY_TOPIC)}`, {
          method: "POST",
          headers: {
            "Title": "NGR Gold Price Alert",
            "Priority": "high",
            "Tags": "chart_with_upwards_trend"
          },
          body: message,
          signal: AbortSignal.timeout(10000)
        });
        if (sent.ok) {
          await env.ALERTS_KV.delete(key.name);
        } else {
          console.log(`Notification failed with HTTP ${sent.status}; alert retained.`);
        }
      } catch (error) {
        console.log(`Notification request failed; alert retained: ${error.message}`);
      }
    }
    cursor = page.list_complete ? undefined : page.cursor;
  } while (cursor);
}
