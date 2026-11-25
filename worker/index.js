const ALLOWED_ORIGIN = "https://kumailabbas007.github.io";
const PRICE_URL = "https://xaus.com/api/v1/spot?compact=1";

function json(data, status = 200, origin = ALLOWED_ORIGIN) {
  return new Response(JSON.stringify(data), {
    status,
    headers: {
      "Content-Type": "application/json",
      "Access-Control-Allow-Origin": origin,
      "Access-Control-Allow-Headers": "Content-Type, Authorization",
      "Access-Control-Allow-Methods": "GET, POST, DELETE, OPTIONS"
    }
  });
}
function authorized(request, env) {
  return request.headers.get("Authorization") === `Bearer ${env.APP_TOKEN}`;
}
export default {
  async fetch(request, env) {
    const origin = request.headers.get("Origin") || "";
    const url = new URL(request.url);
    if (request.method === "OPTIONS") {
      return new Response(null, { headers: {
        "Access-Control-Allow-Origin": ALLOWED_ORIGIN,
        "Access-Control-Allow-Headers": "Content-Type, Authorization",
        "Access-Control-Allow-Methods": "GET, POST, DELETE, OPTIONS"
      }});
    }
    if (url.pathname === "/health" && request.method === "GET") {
      return json({ status: "online", service: "NGR Gold Alerts" });
    }
    if (origin !== ALLOWED_ORIGIN) return json({ error: "Origin not allowed" }, 403, ALLOWED_ORIGIN);
    if (!authorized(request, env)) return json({ error: "Unauthorized" }, 401);
    if (url.pathname === "/alerts" && request.method === "GET") {
      const result = await env.ALERTS_KV.list({ prefix: "alert:" });
      const alerts = [];
      for (const key of result.keys) {
        const value = await env.ALERTS_KV.get(key.name, "json");
        if (value) alerts.push(value);
      }
      return json({ alerts });
    }
    if (url.pathname === "/alerts" && request.method === "POST") {
      let body;
      try { body = await request.json(); } catch { return json({ error: "Invalid JSON" }, 400); }
      const level = Number(body.level), condition = body.condition;
      if (!Number.isFinite(level) || level <= 0 || !["above", "below"].includes(condition)) return json({ error: "Invalid alert details" }, 400);
      const id = crypto.randomUUID();
      const alert = { id, symbol: "XAUUSD", condition, level, createdAt: Date.now(), expiry: body.expiry || "Until deleted" };
      await env.ALERTS_KV.put(`alert:${id}`, JSON.stringify(alert));
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
  async scheduled(controller, env, ctx) { ctx.waitUntil(checkAlerts(env)); }
};
async function checkAlerts(env) {
  try {
    const response = await fetch(PRICE_URL, { headers: { Accept: "application/json" } });
    if (!response.ok) throw new Error("Price source unavailable");
    const data = await response.json();
    const price = Number(data.spot_usd_oz), age = Number(data.data_state?.age_seconds);
    if (!Number.isFinite(price) || data.data_state?.status !== "fresh" || !Number.isFinite(age) || age > 180) {
      console.log("Price stale/unavailable; skip"); return;
    }
    const result = await env.ALERTS_KV.list({ prefix: "alert:" });
    for (const key of result.keys) {
      const alert = await env.ALERTS_KV.get(key.name, "json");
      if (!alert) continue;
      const elapsed = Date.now() - alert.createdAt;
      const expired = alert.expiry === "Today" ? elapsed > 86400000 : alert.expiry === "7 days" ? elapsed > 7 * 86400000 : false;
      if (expired) { await env.ALERTS_KV.delete(key.name); continue; }
      const triggered = alert.condition === "above" ? price >= alert.level : price <= alert.level;
      if (!triggered) continue;
      const message = `NGR TRADES PRO | XAU/USD\nTarget ${alert.condition}: $${alert.level}\nObserved spot price: $${price.toFixed(2)}\nSource: XAUS. Verify on Exness MT5 before acting.`;
      const sent = await fetch(`https://ntfy.sh/${encodeURIComponent(env.NTFY_TOPIC)}`, {
        method: "POST", headers: { Title: "NGR Gold Price Alert", Priority: "high", Tags: "chart_with_upwards_trend" }, body: message
      });
      if (sent.ok) await env.ALERTS_KV.delete(key.name);
      else console.log("Notification failed; alert retained.");
    }
  } catch (error) { console.log("Alert check failed:", error.message); }
}
