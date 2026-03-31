import { Hono } from "hono";
import { compress } from "hono/compress";
import { cors } from "hono/cors";
import { checkRateLimitPersistent, isExemptFromRateLimit } from "./rooms.js";

// ── Known creators ──────────────────────────────────────────────────────────
export const CREATORS = new Set(
  (process.env.MESH_CREATORS || "Can Erden,Vincent").split(",").map(s => s.trim())
);

// ── Global rate limit: 200 requests/min per IP ─────────────────────────────
const ipHits = new Map<string, { count: number; reset: number }>();

export function applyMiddleware(app: Hono) {
  // IP rate limit
  app.use("*", async (c, next) => {
    const ip = c.req.header("x-forwarded-for") ?? "unknown";
    const now = Date.now();
    const entry = ipHits.get(ip);
    if (!entry || now > entry.reset) {
      ipHits.set(ip, { count: 1, reset: now + 60_000 });
    } else {
      entry.count++;
      if (entry.count > 200) {
        return c.json({ error: "rate_limit_exceeded", detail: "Max 200 requests/min" }, 429);
      }
    }
    if (Math.random() < 0.001) {
      for (const [k, v] of ipHits) { if (now > v.reset) ipHits.delete(k); }
    }
    await next();
  });

  // Compression
  app.use("*", compress());

  // CORS
  app.use("*", cors({
    origin: "*",
    allowMethods: ["GET", "POST", "PUT", "DELETE", "OPTIONS"],
    allowHeaders: ["Content-Type", "x-mesh-secret"],
    exposeHeaders: ["Content-Type"],
  }));

  // Optional secret token auth
  const SECRET = process.env.MESH_SECRET;
  if (SECRET) {
    app.use("*", async (c, next) => {
      if (c.req.path === "/health") return next();
      const token = c.req.query("secret") || c.req.header("x-mesh-secret");
      if (token !== SECRET) return c.json({ error: "unauthorized" }, 401);
      return next();
    });
  }
}

// ── Rate limiting helper ────────────────────────────────────────────────────
export function checkRateLimit(key: string, max: number, windowMs: number, name?: string): boolean {
  if (name && (CREATORS.has(name) || isExemptFromRateLimit(name))) return true;
  return checkRateLimitPersistent(key, max, windowMs);
}

// ── Duplicate message dedup ─────────────────────────────────────────────────
const recentMsgHashes = new Map<string, { hash: string; ts: number }[]>();
export function isDuplicateMessage(room: string, name: string, content: string): boolean {
  const key = `${room}:${name}`;
  const now = Date.now();
  const windowMs = 60_000;
  const maxDupes = 1;
  const hash = content.trim().slice(0, 80).toLowerCase().replace(/\s+/g, ' ');
  const history = (recentMsgHashes.get(key) || []).filter(e => now - e.ts < windowMs);
  const dupeCount = history.filter(e => e.hash === hash).length;
  history.push({ hash, ts: now });
  recentMsgHashes.set(key, history.slice(-20));
  return dupeCount >= maxDupes;
}

// ── PostHog analytics injection ─────────────────────────────────────────────
const POSTHOG_KEY = process.env.POSTHOG_KEY || "";
const posthogSnippet = POSTHOG_KEY
  ? `<script>!function(t,e){var o,n,p,r;e.__SV||(window.posthog=e,e._i=[],e.init=function(i,s,a){function g(t,e){var o=e.split(".");2==o.length&&(t=t[o[0]],e=o[1]);t[e]=function(){t.push([e].concat(Array.prototype.slice.call(arguments,0)))}}(p=t.createElement("script")).type="text/javascript",p.async=!0,p.src=s.api_host+"/static/array.js",(r=t.getElementsByTagName("script")[0]).parentNode.insertBefore(p,r);var u=e;for(void 0!==a?u=e[a]=[]:a="posthog",u.people=u.people||[],u.toString=function(t){var e="posthog";return"posthog"!==a&&(e+="."+a),t||(e+=" (stub)"),e},u.people.toString=function(){return u.toString(1)+" (stub)"},o="capture identify alias people.set people.set_once set_config register register_once unregister opt_out_capturing has_opted_out_capturing opt_in_capturing reset isFeatureEnabled onFeatureFlags getFeatureFlag getFeatureFlagPayload reloadFeatureFlags group updateEarlyAccessFeatureEnrollment getEarlyAccessFeatures getActiveMatchingSurveys getSurveys".split(" "),n=0;n<o.length;n++)g(u,o[n]);e._i.push([i,s,a])},e.__SV=1)}(document,window.posthog||[]);posthog.init('${POSTHOG_KEY}',{api_host:'https://app.posthog.com'})</script>`
  : "";

export function injectAnalytics(html: string): string {
  if (!posthogSnippet) return html;
  return html.replace("</head>", `${posthogSnippet}\n</head>`);
}
