import { checkRateLimitPersistent, isExemptFromRateLimit, verifyAdmin, getRoomPasswordHash, verifyRoomPassword } from "../rooms.js";

export const VERSION = "2.9.0";
export const startTime = Date.now();
export const SSE_ENABLED = process.env.SSE_DISABLED !== "true";

// Track active SSE connections
export let activeConnections = { count: 0 };

export function checkRateLimit(key: string, max: number, windowMs: number, name?: string): boolean {
  if (name && isExemptFromRateLimit(name)) return true;
  return checkRateLimitPersistent(key, max, windowMs);
}

// ── Admin page protection (per-room) ─────────────────────────────────────────
export function isValidPasswordSession(room: string, val: string): boolean {
  if (!val.startsWith("pwdsess_")) return false;
  const hash = getRoomPasswordHash(room);
  if (!hash) return false;
  return val === `pwdsess_${hash}`;
}

export function hasRoomAccess(c: any, room: string): boolean {
  // 1. Check admin cookie from login
  const cookie = c.req.header("cookie") || "";
  const match = cookie.match(new RegExp(`mesh_admin_${room}=([^;]+)`));
  if (match) {
    const val = decodeURIComponent(match[1] || "");
    if (verifyAdmin(room, val) || isValidPasswordSession(room, val)) return true;
  }
  // 2. Check access_token param/header
  const hash = getRoomPasswordHash(room);
  const accessToken = c.req.query("access_token") || c.req.header("x-room-token");
  if (hash && accessToken && accessToken === `${room}.${hash}`) return true;
  // 3. Check password query param directly
  const password = c.req.query("password");
  if (hash && password && verifyRoomPassword(room, password)) return true;
  // 4. Check admin token param/header
  const token = c.req.query("token") || c.req.header("x-admin-token");
  if (token && verifyAdmin(room, token)) return true;
  // 5. No password = open room
  if (!hash) return true;
  return false;
}

// ── Duplicate message dedup ────────────────────────────────────────────────────
const recentMsgHashes = new Map<string, { hash: string; ts: number }[]>();
export function isDuplicateMessage(room: string, name: string, content: string): boolean {
  const key = `${room}:${name}`;
  const now = Date.now();
  const windowMs = 60_000;
  // simple hash: first 80 chars normalized
  const hash = content.trim().slice(0, 80).toLowerCase().replace(/\s+/g, ' ');
  const history = (recentMsgHashes.get(key) || []).filter(e => now - e.ts < windowMs);
  if (history.some(e => e.hash === hash)) return true;
  history.push({ hash, ts: now });
  recentMsgHashes.set(key, history.slice(-20)); // keep last 20 entries
  return false;
}

// Inject PostHog analytics if POSTHOG_KEY env var is set
const POSTHOG_KEY = process.env.POSTHOG_KEY || "";
const posthogSnippet = POSTHOG_KEY
  ? `<script>!function(t,e){var o,n,p,r;e.__SV||(window.posthog=e,e._i=[],e.init=function(i,s,a){function g(t,e){var o=e.split(".");2==o.length&&(t=t[o[0]],e=o[1]);t[e]=function(){t.push([e].concat(Array.prototype.slice.call(arguments,0)))}}(p=t.createElement("script")).type="text/javascript",p.async=!0,p.src=s.api_host+"/static/array.js",(r=t.getElementsByTagName("script")[0]).parentNode.insertBefore(p,r);var u=e;for(void 0!==a?u=e[a]=[]:a="posthog",u.people=u.people||[],u.toString=function(t){var e="posthog";return"posthog"!==a&&(e+="."+a),t||(e+=" (stub)"),e},u.people.toString=function(){return u.toString(1)+" (stub)"},o="capture identify alias people.set people.set_once set_config register register_once unregister opt_out_capturing has_opted_out_capturing opt_in_capturing reset isFeatureEnabled onFeatureFlags getFeatureFlag getFeatureFlagPayload reloadFeatureFlags group updateEarlyAccessFeatureEnrollment getEarlyAccessFeatures getActiveMatchingSurveys getSurveys".split(" "),n=0;n<o.length;n++)g(u,o[n]);e._i.push([i,s,a])},e.__SV=1)}(document,window.posthog||[]);posthog.init('${POSTHOG_KEY}',{api_host:'https://app.posthog.com'})</script>`
  : "";

export function injectAnalytics(html: string): string {
  if (!posthogSnippet) return html;
  return html.replace("</head>", `${posthogSnippet}\n</head>`);
}
