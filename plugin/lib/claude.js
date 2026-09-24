// Claude Code: quota snapshots (from our status line tap) and usage-limit hits (from transcripts).
import fs from "node:fs";
import path from "node:path";
import { claudeDir, file, readJSON } from "./paths.js";

const LIMIT_TEXT = /hit your (session|weekly|[\w .-]+?) limit|usage limit reached|reached your [\w .-]+ limit|requires usage credits|已达到.{0,10}使用上限/i;

/** ~/.claude/projects/<encoded cwd>/<session>.jsonl — search instead of re-deriving the encoding. */
export function findTranscript(sessionId) {
  const root = path.join(claudeDir(), "projects");
  let dirs = [];
  try { dirs = fs.readdirSync(root); } catch { return null; }
  for (const d of dirs) {
    const p = path.join(root, d, `${sessionId}.jsonl`);
    if (fs.existsSync(p)) return p;
  }
  return null;
}

/** Most recent usage-limit hit recorded in a transcript, or null.
 *  Claude Code writes an assistant entry with error:"rate_limit" and (since ~2.1.23x) a
 *  quotaLimits object with the exact reset time. Neither is documented, so the visible
 *  "resets 8pm (Asia/Shanghai)" text is parsed as a fallback. */
export function lastLimitHit(transcriptPath) {
  let lines;
  try { lines = fs.readFileSync(transcriptPath, "utf8").split("\n"); } catch { return null; }
  for (let i = lines.length - 1; i >= 0; i--) {
    const line = lines[i];
    if (!line.includes("rate_limit") && !LIMIT_TEXT.test(line)) continue;
    let d;
    try { d = JSON.parse(line); } catch { continue; }
    const text = entryText(d);
    // Only Claude Code's own API-error entries count - conversations *about* limits
    // (like the one this tool was built in) must not trigger it.
    if (d.type !== "assistant") continue;
    if (d.error !== "rate_limit" && !(d.isApiErrorMessage && LIMIT_TEXT.test(text))) continue;
    const at = d.timestamp ? Math.floor(Date.parse(d.timestamp) / 1000) : Math.floor(Date.now() / 1000);
    const q = d.quotaLimits || {};
    return {
      kind: q.rateLimitType || kindFromText(text),
      resetsAt: q.resetsAt || parseResetText(text, at),
      text,
      at,
      sidechain: !!d.isSidechain,
    };
  }
  return null;
}

/** Limit hit from the visible message alone (hook payloads, -p results). */
export function hitFromText(text, at = Math.floor(Date.now() / 1000)) {
  if (!text || !(LIMIT_TEXT.test(text) || /限额|使用上限/.test(text))) return null;
  return { kind: kindFromText(text), resetsAt: parseResetText(text, at), text, at };
}

function entryText(d) {
  const c = d.message?.content;
  if (typeof c === "string") return c;
  if (Array.isArray(c)) return c.map((b) => b?.text || "").join(" ");
  return "";
}

function kindFromText(t) {
  if (/weekly|每周|每月/i.test(t)) return "seven_day";
  if (/session|5 ?小时/i.test(t)) return "five_hour";
  return "model";   // e.g. "You've reached your Opus limit"
}

/** "resets 8pm (Asia/Shanghai)" / "resets 2:10am" -> next matching instant after `after` (unix s). */
export function parseResetText(text, after = Math.floor(Date.now() / 1000)) {
  // GLM coding plan (via Claude Code): "您的限额将在 2026-08-11 01:15:20 重置" (local time)
  const zh = /(\d{4})-(\d{2})-(\d{2})[ T](\d{2}):(\d{2})(?::(\d{2}))?\s*重置/.exec(text || "");
  if (zh) {
    const [, y, mo, d, h, mi, sec] = zh.map(Number);
    return zonedToUnix(Intl.DateTimeFormat().resolvedOptions().timeZone, y, mo, d, h, mi) + (sec || 0);
  }
  // Codex: "try again at Aug 11th, 2026 3:15 PM" (local time, no zone)
  const cx = /try again at\s+(\w{3,9})\s+(\d{1,2})(?:st|nd|rd|th)?,?\s+(\d{4})\s+(\d{1,2}):(\d{2})\s*(am|pm)/i.exec(text || "");
  if (cx) {
    const [, mon, day, year, hh, mm, ampm] = cx;
    const hour = Number(hh) % 12 + (ampm.toLowerCase() === "pm" ? 12 : 0);
    return zonedToUnix(Intl.DateTimeFormat().resolvedOptions().timeZone, Number(year), monthIndex(mon), Number(day), hour, Number(mm));
  }
  // "resets 8pm (Asia/Shanghai)", "resets Aug 4 at 10am", and Codex's same-day "Try again at 3:05 PM."
  const m = /(?:resets|try again at)\s+(?:(\w{3,9})\s+(\d{1,2}),?\s+(?:at\s+)?)?(\d{1,2})(?::(\d{2}))?\s*(am|pm)\s*(?:\(([^)]+)\))?/i.exec(text || "");
  if (!m) return null;
  const [, mon, day, h, mi, ampm, tz] = m;
  let hour = Number(h) % 12 + (ampm.toLowerCase() === "pm" ? 12 : 0);
  const minute = Number(mi || 0);
  const zone = tz || Intl.DateTimeFormat().resolvedOptions().timeZone;
  for (let d = 0; d <= 8; d++) {
    const local = partsIn(zone, (after + d * 86400) * 1000);
    if (mon && (monthIndex(mon) !== local.month || Number(day) !== local.day)) continue;
    const t = zonedToUnix(zone, local.year, local.month, local.day, hour, minute);
    // The message is rounded down to the minute, so a reset later in this same minute
    // prints as a time up to 59s in the past - that's still today, not tomorrow.
    if (t > after - 60) return t;
  }
  return null;
}

const MONTHS = ["jan", "feb", "mar", "apr", "may", "jun", "jul", "aug", "sep", "oct", "nov", "dec"];
const monthIndex = (s) => MONTHS.indexOf(s.slice(0, 3).toLowerCase()) + 1;

function partsIn(zone, ms) {
  const p = Object.fromEntries(new Intl.DateTimeFormat("en-US", {
    timeZone: zone, year: "numeric", month: "numeric", day: "numeric", hour: "numeric", minute: "numeric", hourCycle: "h23",
  }).formatToParts(new Date(ms)).map((x) => [x.type, Number(x.value)]));
  return { year: p.year, month: p.month, day: p.day, hour: p.hour, minute: p.minute };
}

function zonedToUnix(zone, y, mo, d, h, mi) {
  // Guess UTC, then correct by the zone's offset at that instant (twice, for DST edges).
  let t = Date.UTC(y, mo - 1, d, h, mi);
  for (let i = 0; i < 2; i++) {
    const p = partsIn(zone, t);
    const asUTC = Date.UTC(p.year, p.month - 1, p.day, p.hour, p.minute);
    t += Date.UTC(y, mo - 1, d, h, mi) - asUTC;
  }
  return Math.floor(t / 1000);
}

/** Latest percentages Claude Code handed to our status line (see plugin/scripts/statusline.js). */
export function quotaSnapshot() {
  return readJSON(file("claude-quota.json"));
}

/** Usage-limit hits across recent transcripts (newest first). */
export function recentLimitHits(days = 8, max = 20) {
  const root = path.join(claudeDir(), "projects");
  const since = Date.now() - days * 86400e3;
  const files = [];
  try {
    for (const d of fs.readdirSync(root)) {
      for (const f of fs.readdirSync(path.join(root, d))) {
        if (!f.endsWith(".jsonl")) continue;
        const p = path.join(root, d, f);
        const st = fs.statSync(p);
        if (st.mtimeMs >= since) files.push([st.mtimeMs, p]);
      }
    }
  } catch { /* no transcripts yet */ }
  files.sort((a, b) => b[0] - a[0]);
  const hits = [];
  for (const [, p] of files.slice(0, 200)) {
    const h = lastLimitHit(p);
    if (h) hits.push({ ...h, transcript: p, session: path.basename(p, ".jsonl") });
  }
  return hits.sort((a, b) => b.at - a.at).slice(0, max);
}
