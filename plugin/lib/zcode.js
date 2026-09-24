// ZCode (Z.ai's desktop coding agent) adapter.
//
// ZCode runs Claude-Code-style plugins, but its hooks differ in two ways that matter here:
//   * `transcript_path` is a throwaway temp file, not the session - the real history is a SQLite
//     database (~/.zcode/cli/db/db.sqlite), so we read that with the `sqlite3` CLI that macOS ships.
//   * nothing fires on a usage-limit error, so the limit hit is discovered from the database at
//     the next prompt.
// Subagents are child sessions (task_type 'subagent_child', id sess_subagent_<agentId>) plus a
// metadata.json under ~/.zcode/cli/agents/<parent>/<agentId>/. In the same ZCode process a failed
// subagent can be woken with SendMessage {to: agentId}; after a restart that registry is gone and
// the fallback is ReadSessionContext(strategy: "handoff") on its child session + a new Agent.
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { spawnSync } from "node:child_process";
import { parseResetText } from "./claude.js";

export const isZCode = (ev = {}) =>
  process.env.ALR_AGENT === "zcode" || !!process.env.ZCODE_SESSION_ID || !!process.env.ZCODE_PLUGIN_ROOT ||
  (process.env.ALR_AGENT !== "claude" && typeof ev.sessionId === "string" && !ev.prompt_id && !!ev.hook_event_name && !ev.transcript_path?.includes("/.claude/"));

export const storageDir = () => process.env.ZCODE_STORAGE_DIR || path.join(os.homedir(), ".zcode");
export const configPath = () => path.join(storageDir(), "cli", "config.json");
export const dbPath = () => process.env.ZCODE_SESSION_DB_PATH || process.env.ZCODE_SESSION_DB || path.join(os.homedir(), ".zcode", "cli", "db", "db.sqlite");
export const agentsDir = () => path.join(storageDir(), "cli", "agents");

export const q = (s) => `'${String(s).replace(/'/g, "''")}'`;

/** Run one read-only query; rows as objects. Empty on any failure (missing db, locked, no sqlite3). */
export function query(sql, db = dbPath()) {
  if (!fs.existsSync(db)) return [];
  const r = spawnSync("sqlite3", ["-readonly", "-json", "-bail", db, sql], { encoding: "utf8", timeout: 8000 });
  if (r.status !== 0 || !r.stdout.trim()) return [];
  try { return JSON.parse(r.stdout); } catch { return []; }
}

const LIMIT_CODES = new Set(["1308", "1310", "1304", "1313", "insufficient_quota"]);
const LIMIT_TEXT = /使用上限|usage limit|quota|rate.?limit|hit your .*limit/i;

export function parseData(row) { try { return JSON.parse(row.data); } catch { return null; } }

/** The last assistant message of a session, decoded. */
export function lastAssistant(sessionId, db) {
  const rows = query(`select id, time_created, data from message where session_id=${q(sessionId)}
    order by sequence is null, sequence desc, time_created desc, rowid desc limit 30`, db);
  for (const r of rows) {
    const d = parseData(r);
    if (d?.role === "assistant") return { ...d, id: r.id, timeCreated: r.time_created };
  }
  return null;
}

export function limitError(d) {
  const e = d?.error?.data || d?.error;
  if (!e) return null;
  const attribution = d.error?.data?.attribution || {};
  const code = String(attribution.providerErrorCode || e.code || "");
  const text = String(e.message || d.error?.name || "");
  const isLimit = attribution.reason === "rate_limited" || LIMIT_CODES.has(code) || LIMIT_TEXT.test(text);
  return isLimit ? { code, text } : null;
}

/** Most recent usage-limit failure of a session: { at (unix s), resetsAt, code, text } or null. */
export function lastLimitHit(sessionId, db) {
  const rows = query(`select id, time_created, data from message where session_id=${q(sessionId)}
    order by sequence is null, sequence desc, time_created desc, rowid desc limit 60`, db);
  for (const r of rows) {
    const d = parseData(r);
    if (d?.role !== "assistant") continue;
    const err = limitError(d);
    if (!err) continue;
    const at = Math.floor((d.time?.completed || d.time?.created || r.time_created) / 1000);
    return { at, resetsAt: parseResetText(err.text, at), code: err.code, text: err.text.slice(0, 200), messageId: r.id };
  }
  return null;
}

function readJSON(p) { try { return JSON.parse(fs.readFileSync(p, "utf8")); } catch { return null; } }
export { readJSON };

// ---- install: register the plugin dir in ~/.zcode/cli/config.json (plugins.dirs) ----

export const installed = (pluginDir) => (readJSON(configPath())?.plugins?.dirs || []).includes(pluginDir);

export function register(pluginDir) {
  const p = configPath();
  const cfg = readJSON(p) || {};
  const dirs = new Set(cfg.plugins?.dirs || []);
  if (dirs.has(pluginDir)) return { changed: false, backup: null };
  const backup = fs.existsSync(p) ? `${p}.agent-limit-retry-backup-${Date.now()}` : null;
  if (backup) fs.copyFileSync(p, backup);
  fs.mkdirSync(path.dirname(p), { recursive: true });
  cfg.plugins = { ...(cfg.plugins || {}), dirs: [...dirs, pluginDir] };
  fs.writeFileSync(p, JSON.stringify(cfg, null, 2) + "\n");
  return { changed: true, backup };
}

export function unregister(pluginDir) {
  const p = configPath();
  const cfg = readJSON(p);
  if (!cfg?.plugins?.dirs?.includes(pluginDir)) return false;
  fs.copyFileSync(p, `${p}.agent-limit-retry-backup-${Date.now()}`);
  cfg.plugins.dirs = cfg.plugins.dirs.filter((d) => d !== pluginDir);
  fs.writeFileSync(p, JSON.stringify(cfg, null, 2) + "\n");
  return true;
}

export const present = () => fs.existsSync(path.join(storageDir(), "cli")) || fs.existsSync("/Applications/ZCode.app");
