import HTML from "./preview.html";

export const PREVIEW_PATH = "/v1.4.0-lab-6f2c9e7a4b1d";
export const PREVIEW_VERSION = "1.4.0-ui-lab.1";

const SECURITY_HEADERS = Object.freeze({
  "Cache-Control": "no-store, max-age=0",
  "Content-Security-Policy": [
    "default-src 'none'",
    "script-src 'unsafe-inline' https://telegram.org",
    "style-src 'unsafe-inline'",
    "img-src data:",
    "connect-src 'none'",
    "base-uri 'none'",
    "form-action 'none'",
    "object-src 'none'",
    "frame-ancestors https://web.telegram.org https://*.telegram.org",
  ].join("; "),
  "Cross-Origin-Resource-Policy": "cross-origin",
  "Permissions-Policy": "camera=(), microphone=(), geolocation=(), payment=()",
  "Referrer-Policy": "no-referrer",
  "X-Content-Type-Options": "nosniff",
  "X-Robots-Tag": "noindex, nofollow, noarchive",
});

function reply(body, status, contentType) {
  return new Response(body, {
    status,
    headers: {
      ...SECURITY_HEADERS,
      "Content-Type": contentType,
    },
  });
}

export default {
  async fetch(request) {
    let url;
    try {
      url = new URL(request.url);
    } catch {
      return reply("Not found", 404, "text/plain; charset=utf-8");
    }

    if (request.method !== "GET" && request.method !== "HEAD") {
      return reply("Method not allowed", 405, "text/plain; charset=utf-8");
    }

    if (url.pathname === "/health") {
      const payload = JSON.stringify({
        status: "ok",
        service: "re-program-cabinet-preview",
        version: PREVIEW_VERSION,
        isolated: true,
        productionData: false,
      });
      return reply(
        request.method === "HEAD" ? null : payload,
        200,
        "application/json; charset=utf-8",
      );
    }

    if (url.pathname !== PREVIEW_PATH) {
      return reply("Not found", 404, "text/plain; charset=utf-8");
    }

    return reply(
      request.method === "HEAD" ? null : HTML,
      200,
      "text/html; charset=utf-8",
    );
  },
};
