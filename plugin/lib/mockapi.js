// A fake Anthropic API: the first /v1/messages call answers "5-hour limit reached, resets in
// `resetIn` seconds" with the same rate-limit headers the real API sends; after the reset every
// call gets a short normal reply. Used by `alr selftest` so users can watch a limit hit and a
// resume happen without spending any quota. Requests never leave this machine; headers
// (including auth) are neither logged nor stored.
import http from "node:http";

export function startMockApi({ resetIn = 10, util5h = "0.05", reply = "selftest ok" } = {}) {
  let resetAt = 0;
  const calls = [];
  const now = () => Math.floor(Date.now() / 1000);
  const server = http.createServer((req, res) => {
    let body = "";
    req.on("data", (d) => { body += d; });
    req.on("end", () => {
      const path = req.url.split("?")[0];
      if (req.method !== "POST" || !path.startsWith("/v1/messages") || path.includes("count_tokens")) {
        res.writeHead(404, { "content-type": "application/json" });
        return res.end(JSON.stringify({ type: "error", error: { type: "not_found_error", message: "mock" } }));
      }
      let j = {}; try { j = JSON.parse(body); } catch { /* defaults */ }
      if (!calls.length) resetAt = now() + resetIn;
      const limited = now() < resetAt;
      calls.push({ at: now(), status: limited ? 429 : 200 });
      if (limited) {
        res.writeHead(429, {
          "content-type": "application/json",
          "anthropic-ratelimit-unified-status": "rejected",
          "anthropic-ratelimit-unified-reset": String(resetAt),
          "anthropic-ratelimit-unified-representative-claim": "five_hour",
          "anthropic-ratelimit-unified-5h-utilization": "1.0",
          "anthropic-ratelimit-unified-5h-reset": String(resetAt),
          "anthropic-ratelimit-unified-overage-status": "rejected",
          "anthropic-ratelimit-unified-overage-disabled-reason": "org_level_disabled",
          "anthropic-ratelimit-unified-fallback": "not_available",
          "retry-after": String(Math.max(1, resetAt - now())),
        });
        return res.end(JSON.stringify({ type: "error", error: { type: "rate_limit_error", message: "Rate limited" } }));
      }
      const headers = {
        "anthropic-ratelimit-unified-status": "allowed",
        "anthropic-ratelimit-unified-reset": String(now() + 5 * 3600),
        "anthropic-ratelimit-unified-5h-utilization": util5h,
        "anthropic-ratelimit-unified-5h-reset": String(now() + 5 * 3600),
        "anthropic-ratelimit-unified-7d-utilization": "0.30",
        "anthropic-ratelimit-unified-7d-reset": String(now() + 3 * 86400),
      };
      const usage = { input_tokens: 10, output_tokens: 12, cache_read_input_tokens: 0, cache_creation_input_tokens: 0 };
      const msg = { id: `msg_mock_${calls.length}`, type: "message", role: "assistant", model: j.model || "claude-mock",
        content: [{ type: "text", text: reply }], stop_reason: "end_turn", stop_sequence: null, usage };
      if (!j.stream) { res.writeHead(200, { "content-type": "application/json", ...headers }); return res.end(JSON.stringify(msg)); }
      res.writeHead(200, { "content-type": "text/event-stream", ...headers });
      const ev = (type, data) => res.write(`event: ${type}\ndata: ${JSON.stringify({ type, ...data })}\n\n`);
      ev("message_start", { message: { ...msg, content: [], stop_reason: null, usage: { ...usage, output_tokens: 1 } } });
      ev("content_block_start", { index: 0, content_block: { type: "text", text: "" } });
      ev("content_block_delta", { index: 0, delta: { type: "text_delta", text: reply } });
      ev("content_block_stop", { index: 0 });
      ev("message_delta", { delta: { stop_reason: "end_turn", stop_sequence: null }, usage: { output_tokens: 12 } });
      ev("message_stop", {});
      res.end();
    });
  });
  return new Promise((resolve) => server.listen(0, "127.0.0.1", () => resolve({
    url: `http://127.0.0.1:${server.address().port}`, calls, close: () => server.close(),
  })));
}
