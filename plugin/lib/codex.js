// Codex CLI / Codex Desktop (they share ~/.codex). Sessions ("threads") are rollout files:
//   ~/.codex/sessions/YYYY/MM/DD/rollout-<time>-<thread id>.jsonl
// Subagents are threads of their own whose session_meta.source.subagent.thread_spawn names the
// parent thread and the agent's path (e.g. /root/research). A usage limit ends a turn with an
// event_msg/task_complete whose error.codex_error_info is "usage_limit_exceeded"; every turn also
// logs a token_count event carrying rate_limits (used_percent, resets_at) for the plan's windows.
import fs from "node:fs";
import path from "node:path";
import { codexDir } from "./paths.js";
import { parseResetText } from "./claude.js";

export const sessionsDir = () => path.join(codexDir(), "sessions");

/** Codex hook payloads carry turn_id and a rollout path under CODEX_HOME/sessions. */
export const isCodex = (ev = {}) =>
  process.env.ALR_AGENT === "codex" ||
  (process.env.ALR_AGENT !== "claude" && process.env.ALR_AGENT !== "zcode" && typeof ev.transcript_path === "string" &&
    /[\\/]\.codex[\\/]sessions[\\/]|rollout-\d{4}-\d{2}-\d{2}T/.test(ev.transcript_path));

export function lastEntryTime(threadFile) {
  const lines = readLines(threadFile);
  for (let i = lines.length - 1; i >= 0; i--) if (lines[i].timestamp) return ts(lines[i]);
  return 0;
}

function walk(dir, out = []) {
  let ents = [];
  try { ents = fs.readdirSync(dir, { withFileTypes: true }); } catch { return out; }
  for (const e of ents) {
    const p = path.join(dir, e.name);
    if (e.isDirectory()) walk(p, out);
    else if (e.name.endsWith(".jsonl")) out.push(p);
  }
  return out;
}

const cache = { files: null, at: 0 };
export function files() {
  if (cache.files && Date.now() - cache.at < 5000) return cache.files;
  cache.files = walk(sessionsDir()).map((p) => [fs.statSync(p).mtimeMs, p]).sort((a, b) => b[0] - a[0]).map((x) => x[1]);
  cache.at = Date.now();
  return cache.files;
}

export function readLines(p) {
  try { return fs.readFileSync(p, "utf8").split("\n").filter(Boolean).map((l) => { try { return JSON.parse(l); } catch { return null; } }).filter(Boolean); }
  catch { return []; }
}

export function meta(p) {
  try {
    const first = fs.readFileSync(p, "utf8").split("\n", 1)[0];
    const d = JSON.parse(first);
    return d.type === "session_meta" ? d.payload : null;
  } catch { return null; }
}

/** Rollout file of a thread id (the file name ends with the id). */
export function findThread(threadId) {
  return files().find((p) => p.endsWith(`-${threadId}.jsonl`)) || null;
}

export const ts = (d) => (d?.timestamp ? Math.floor(Date.parse(d.timestamp) / 1000) : 0);

/** Most recent usage-limit failure in a thread: { at, resetsAt, text, window } or null.
 *  Codex writes a token_count (rate_limits parsed from the 429's headers) right before the
 *  task_complete that carries the error, so the structured reset time is a few lines up. */
export function lastLimitHit(threadFile) {
  const lines = readLines(threadFile);
  for (let i = lines.length - 1; i >= 0; i--) {
    const d = lines[i], pl = d.payload || {};
    if (pl.type !== "task_complete" || !pl.error) continue;
    const e = pl.error;
    const text = String(e.message || "");
    if (e.codex_error_info !== "usage_limit_exceeded" && !/usage limit/i.test(text)) continue;
    const at = ts(d);
    let resetsAt = null, window = null;
    for (let j = i - 1; j >= Math.max(0, i - 40); j--) {
      const rl = lines[j].payload?.type === "token_count" && lines[j].payload.rate_limits;
      if (!rl) continue;
      const pick = rl.rate_limit_reached_type && rl[rl.rate_limit_reached_type] ? rl[rl.rate_limit_reached_type]
        : [rl.primary, rl.secondary].filter((w) => w && w.used_percent >= 95).sort((a, b) => (b.used_percent - a.used_percent))[0];
      if (pick?.resets_at) { resetsAt = pick.resets_at; window = pick.window_minutes; }
      break;
    }
    return { at, resetsAt: resetsAt || parseResetText(text, at), text: text.slice(0, 200), kind: "usage_limit", window };
  }
  return null;
}

/** Latest rate-limit windows seen in a thread (or in the newest thread overall). */
export function latestRateLimits(threadFile = null) {
  for (const p of threadFile ? [threadFile] : files().slice(0, 30)) {
    const lines = readLines(p);
    for (let i = lines.length - 1; i >= 0; i--) {
      const pl = lines[i].payload || {};
      if (pl.type === "token_count" && pl.rate_limits) return { ...pl.rate_limits, at: ts(lines[i]) };
    }
  }
  return null;
}

/** How a thread ended: finished | usage_limit | error | interrupted (cut mid-turn). */
export function ending(lines) {
  for (let i = lines.length - 1; i >= 0; i--) {
    const pl = lines[i].payload || {};
    if (lines[i].type !== "event_msg") continue;
    if (pl.type === "task_complete") {
      if (!pl.error) return "finished";
      return pl.error.codex_error_info === "usage_limit_exceeded" || /usage limit/i.test(pl.error.message || "") ? "usage_limit" : "error";
    }
    if (pl.type === "turn_aborted") return "aborted";
    if (pl.type === "task_started") return "interrupted";       // a turn began and never completed
  }
  return "unknown";
}

