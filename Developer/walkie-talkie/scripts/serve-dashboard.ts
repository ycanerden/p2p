import { serve } from "bun";

const UPSTREAM = "https://trymesh.chat";
const DASHBOARD_FILE = "./mesh-org-dashboard.html";

console.log("🍏 Starting Mesh Dashboard Server (with CORS bypass)...");
console.log("🚀 Open http://localhost:4000 in your browser.");

serve({
  port: 4000,
  async fetch(req) {
    const url = new URL(req.url);

    // Serve the dashboard HTML
    if (url.pathname === "/") {
      return new Response(Bun.file(DASHBOARD_FILE), {
        headers: { "Content-Type": "text/html" },
      });
    }

    // Proxy API requests to Railway to bypass CORS
    if (url.pathname.startsWith("/api/")) {
      const upstreamUrl = `${UPSTREAM}${url.pathname}${url.search}`;
      
      const newHeaders = new Headers(req.headers);
      newHeaders.delete("host");
      newHeaders.delete("origin");
      newHeaders.delete("referer");

      const upstreamRes = await fetch(upstreamUrl, {
        method: req.method,
        headers: newHeaders,
        body: req.method !== "GET" && req.method !== "HEAD" ? req.body : undefined,
      });

      // Forward response but inject CORS headers
      const resHeaders = new Headers(upstreamRes.headers);
      resHeaders.set("Access-Control-Allow-Origin", "*");
      
      return new Response(upstreamRes.body, {
        status: upstreamRes.status,
        statusText: upstreamRes.statusText,
        headers: resHeaders,
      });
    }

    return new Response("Not Found", { status: 404 });
  },
});
