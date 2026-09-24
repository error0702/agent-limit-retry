#!/usr/bin/env node
// Status line tap: Claude Code hands the status line its rate-limit percentages (documented
// `rate_limits` field). We save them for the hooks, then print either the user's original
// status line (if `alr init` wrapped one) or a compact default.
import fs from "node:fs";
import path from "node:path";
import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";

const lib = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../lib");
const { config, file, writeJSON } = await import(path.join(lib, "paths.js"));

const raw = fs.readFileSync(0, "utf8");
let data = {};
try { data = JSON.parse(raw); } catch { /* keep going: still show something */ }

if (data.rate_limits) {
  try {
    writeJSON(file("claude-quota.json"), {
      rateLimits: data.rate_limits, session: data.session_id, updatedAt: Math.floor(Date.now() / 1000),
    });
  } catch { /* never break the status line */ }
}

const wrapped = config().wrappedStatusLine;
if (wrapped?.command) {
  const r = spawnSync(wrapped.command, { input: raw, shell: true, encoding: "utf8", timeout: 5000 });
  process.stdout.write(r.stdout || "");
} else {
  const rl = data.rate_limits || {};
  const seg = [["5h", rl.five_hour], ["7d", rl.seven_day]]
    .filter(([, w]) => typeof w?.used_percentage === "number")
    .map(([k, w]) => `${k} ${Math.round(w.used_percentage)}%`);
  process.stdout.write(seg.length ? `⏳ ${seg.join(" · ")}` : "");
}
