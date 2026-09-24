#!/usr/bin/env node
// Single entry point for all agent-limit-retry hooks. The runtime (Claude Code, ZCode, Codex)
// passes the event as JSON on stdin. Must never break the user's session: any error -> exit 0.
//
// The open core owns the state machine: when a limit hit, when the reset is over, when a resumed
// session needs a look, and the pre-limit handoff file. What to say about interrupted subagents
// comes from the Pro modules (plugin/pro/) when they are installed; without them the hooks are
// silent about subagents and everything else still works.
import fs from "node:fs";
import { fileURLToPath } from "node:url";
import path from "node:path";
import { t, zh } from "../lib/i18n.js";

const lib = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../lib");
const { config, appendEvent } = await import(path.join(lib, "paths.js"));
const claude = await import(path.join(lib, "claude.js"));
const h = await import(path.join(lib, "handoff.js"));
const { notify } = await import(path.join(lib, "notify.js"));
const zcode = await import(path.join(lib, "zcode.js"));
const codex = await import(path.join(lib, "codex.js"));
const { loadPro } = await import(path.join(lib, "pro-loader.js"));
const pro = (await loadPro())?.hooks || null;
// A subagent that stopped more than this long before the limit hit has nothing to do with it.
const WINDOW = 60 * 60;

const out = (obj) => process.stdout.write(JSON.stringify(obj));
const now = () => Math.floor(Date.now() / 1000);
const ctx = { h, appendEvent, WINDOW, lastVersion: (t) => lastVersion(t) };
/** Pro: what to tell the main agent about subagents an interruption cut off (null without Pro). */
const proResume = (runtime, ev, trigger) => { try { return pro?.resume(runtime, ev, trigger, ctx) || null; } catch (e) { if (process.env.ALR_DEBUG) process.stderr.write(`agent-limit-retry pro error: ${e.stack}\n`); return null; } };

function postToolUse(ev) {
  const win = h.hottestWindow(claude.quotaSnapshot());
  if (!win || win.pct < config().threshold) return;
  const st = h.sessionState(ev.session_id);
  if (st.requestedFor === win.resetsAt) return;            // already asked in this window
  h.saveSessionState(ev.session_id, { ...st, requestedFor: win.resetsAt, requestedAt: now(), cwd: ev.cwd });
  appendEvent({ type: "handoff_requested", session: ev.session_id, cwd: ev.cwd, window: win });
  out({ hookSpecificOutput: { hookEventName: "PostToolUse", additionalContext: h.handoffRequest(win, ev.cwd) } });
}

function stop(ev) {
  if (ev.stop_hook_active) return;                          // we already blocked once; let it end
  const st = h.sessionState(ev.session_id);
  if (!st.requestedAt || st.handoffDone) return;
  if (h.handoffWritten(ev.cwd, st.requestedAt)) {
    h.saveSessionState(ev.session_id, { ...st, handoffDone: now() });
    appendEvent({ type: "handoff_written", session: ev.session_id, cwd: ev.cwd });
    if (config().notify) notify(t("Handoff file written", "交接文件已写好"), t(`${path.basename(ev.cwd || "")}: quota nearly used up; progress saved to ${path.basename(h.handoffPath(ev.cwd))}`, `${path.basename(ev.cwd || "")}：额度快用完了，进度已保存到 ${path.basename(h.handoffPath(ev.cwd))}`));
    return;
  }
  out({ decision: "block", reason: h.STOP_REMINDER(ev.cwd) });
}

function stopFailure(ev) {
  // Interactive sessions send { error: "rate_limit", last_assistant_message }. (-p runs don't fire
  // this hook at all; `alr run` reads the result instead.)
  if (!/rate.?limit/i.test(`${ev.error || ""} ${ev.error_type || ""}`)) return;
  // The transcript entry may not be flushed yet when the hook runs; the message text has the reset.
  const hit = (ev.transcript_path && claude.lastLimitHit(ev.transcript_path)) || claude.hitFromText(ev.last_assistant_message);
  const st = h.sessionState(ev.session_id);
  h.saveSessionState(ev.session_id, { ...st, limitHitAt: now(), resetsAt: hit?.resetsAt, resumeNoted: false, cwd: ev.cwd });
  appendEvent({ type: "limit_hit", session: ev.session_id, cwd: ev.cwd, kind: hit?.kind, resetsAt: hit?.resetsAt });
  if (config().notify) {
    const when = hit?.resetsAt ? new Date(hit.resetsAt * 1000).toLocaleTimeString(zh ? "zh-CN" : "en-US", { hour: "2-digit", minute: "2-digit" }) : t("unknown time", "未知时间");
    const done = h.handoffWritten(ev.cwd, now() - 6 * 3600) ? t("handoff file written", "交接文件已写好") : t("no handoff file", "没有交接文件");
    notify(t("Claude Code hit its usage limit", "Claude Code 额度用完了"), t(`${path.basename(ev.cwd || "")}: resets ${when}, ${done}`, `${path.basename(ev.cwd || "")}：${when} 重置，${done}`));
  }
}

/** What to tell the main agent after an interruption at `cutAt`: the Pro subagent advice (if any)
 *  plus a pointer to a handoff file written shortly before. */
function resumeContext(ev, cutAt, mode) {
  const parts = [];
  const sub = proResume("claude", ev, { mode, cutAt });
  if (sub) parts.push(sub);
  if (h.handoffWritten(ev.cwd, cutAt - 6 * 3600)) parts.push(h.SESSION_START_NOTE(h.handoffPath(ev.cwd)));
  return parts.join("\n\n");
}
const say = (event, text) => out({ hookSpecificOutput: { hookEventName: event, additionalContext: text } });

// The first prompt after a reset (Claude Code's own auto-continue sends one) or after a resume.
function userPromptSubmit(ev) {
  const st = h.sessionState(ev.session_id);
  // 1. a usage limit hit in this session, now reset
  if (st.limitHitAt && !st.resumeNoted) {
    if (st.resetsAt && now() < st.resetsAt - 60) return;        // still limited: waking agents now just fails again
    h.saveSessionState(ev.session_id, { ...st, resumeNoted: now() });
    const text = resumeContext(ev, st.limitHitAt, "limit");
    if (text) say("UserPromptSubmit", text);
    return;
  }
  // 2. a resumed session we're still deciding about (see sessionStart)
  if (st.pending && !st.pending.done) {
    if (st.pending.mode === "limit" && st.pending.resetsAt && now() < st.pending.resetsAt - 60) return;
    h.saveSessionState(ev.session_id, { ...st, pending: { ...st.pending, done: now() } });
    const text = resumeContext(ev, st.pending.cutAt, st.pending.mode);
    if (text) say("UserPromptSubmit", text);
  }
}

function sessionStart(ev) {
  if (ev.source === "resume") {
    const cutAt = lastEntryTime(ev.transcript_path);
    const st = h.sessionState(ev.session_id);
    if (cutAt && st.pending?.cutAt !== cutAt) {
      const hit = claude.lastLimitHit(ev.transcript_path);
      const limited = hit && hit.at >= cutAt - WINDOW;
      const pending = { cutAt, mode: limited ? "limit" : "quit", resetsAt: limited ? hit.resetsAt : null };
      h.saveSessionState(ev.session_id, { ...st, pending });
      // After a quit, newer Claude Code reports unfinished agents itself at the first prompt; we
      // wait for that and only fill the gaps. Old Claude Code never does: say it right now.
      if (!limited && pro?.claudeQuitAdviceAtStart(ev.transcript_path, ctx)) {
        h.saveSessionState(ev.session_id, { ...h.sessionState(ev.session_id), pending: { ...pending, done: now() } });
        const text = resumeContext(ev, cutAt, "quit");
        if (text) return say("SessionStart", text);
      }
    }
  }
  if (!["startup", "resume"].includes(ev.source)) return;
  if (!h.handoffWritten(ev.cwd, now() - 7 * 86400)) return;
  say("SessionStart", h.SESSION_START_NOTE(h.handoffPath(ev.cwd)));
}

// Transcripts can be ~100 MB and often end with hundreds of untimestamped metadata lines
// (titles, modes, agent names). Read backwards in growing chunks until what we need shows up.
function tailEntries(transcript, want) {
  let fd;
  try { fd = fs.openSync(transcript, "r"); } catch { return null; }
  try {
    const size = fs.fstatSync(fd).size;
    for (let chunk = 256 * 1024; ; chunk *= 4) {
      const start = Math.max(0, size - chunk);
      const buf = Buffer.alloc(size - start);
      fs.readSync(fd, buf, 0, buf.length, start);
      const lines = buf.toString("utf8").split("\n");
      if (start > 0) lines.shift();                     // first line is probably cut in half
      for (let i = lines.length - 1; i >= 0; i--) {
        let d; try { d = JSON.parse(lines[i]); } catch { continue; }
        const v = want(d);
        if (v) return v;
      }
      if (start === 0) return null;
    }
  } finally { fs.closeSync(fd); }
}
const lastEntryTime = (t) => tailEntries(t, (d) => d.timestamp && Math.floor(Date.parse(d.timestamp) / 1000)) || 0;
const lastVersion = (t) => tailEntries(t, (d) => d.version) || null;

const HANDLERS = { PostToolUse: postToolUse, Stop: stop, StopFailure: stopFailure, SessionStart: sessionStart, UserPromptSubmit: userPromptSubmit };

// ---- ZCode / Codex ---------------------------------------------------------------------------
// Neither fires a hook on a limit hit nor writes a notice after a restart, so both are read from
// the runtime's own records: the limit at the next prompt, the restart at SessionStart(resume).
// `k` is a per-runtime key prefix in the session state (z*/c*) so one id can't mix the two.
function otherSessionStart(runtime, ev, cutAt, lastHit) {
  if (ev.source !== "resume") return;
  const k = runtime[0];
  const st = h.sessionState(ev.session_id);
  h.saveSessionState(ev.session_id, { ...st, [`${k}ResumedAt`]: now() });
  if (!cutAt || st[`${k}ResumedFrom`] === cutAt) return;
  h.saveSessionState(ev.session_id, { ...h.sessionState(ev.session_id), [`${k}ResumedFrom`]: cutAt });
  const hit = lastHit();
  if (hit && hit.at >= cutAt - WINDOW) return;             // a limit: handled at the first prompt after the reset
  const text = proResume(runtime, ev, { mode: "quit", cutAt, sameProcess: false });
  if (text) say("SessionStart", text);
}

function otherUserPromptSubmit(runtime, ev, hit) {
  if (!hit) return;
  const k = runtime[0], id = hit.messageId ?? hit.at;
  const st = h.sessionState(ev.session_id);
  if (st[`${k}NotedHit`] === id) return;
  if (hit.resetsAt && now() < hit.resetsAt - 60) {
    if (st[`${k}LimitSeen`] !== id) {
      h.saveSessionState(ev.session_id, { ...st, [`${k}LimitSeen`]: id });
      appendEvent({ type: "limit_hit", agent: runtime, session: ev.session_id, cwd: ev.cwd, kind: hit.code ?? hit.kind, resetsAt: hit.resetsAt });
    }
    return;                                                 // still limited: waking anything now just fails again
  }
  h.saveSessionState(ev.session_id, { ...st, [`${k}NotedHit`]: id });
  const resumedAt = st[`${k}ResumedAt`];
  const text = proResume(runtime, ev, { mode: "limit", cutAt: hit.at, sameProcess: !(resumedAt && resumedAt > hit.at) });
  if (text) say("UserPromptSubmit", text);
}

const Z_HANDLERS = {
  SessionStart: (ev) => {
    const last = zcode.query(`select max(time_updated) as t from message where session_id='${ev.session_id.replace(/'/g, "''")}'`)[0]?.t;
    otherSessionStart("zcode", ev, last ? Math.floor(last / 1000) : 0, () => zcode.lastLimitHit(ev.session_id));
  },
  UserPromptSubmit: (ev) => otherUserPromptSubmit("zcode", ev, zcode.lastLimitHit(ev.session_id)),
};
const C_HANDLERS = {
  SessionStart: (ev) => otherSessionStart("codex", ev, codex.lastEntryTime(ev.transcript_path), () => codex.lastLimitHit(ev.transcript_path)),
  UserPromptSubmit: (ev) => {
    // Nothing tells us when the limit hits, so a per-thread watcher (Pro) does the waiting and
    // the `codex queue` continue; idempotent on every prompt.
    pro?.codexWatch(ev, ctx);
    otherUserPromptSubmit("codex", ev, codex.lastLimitHit(ev.transcript_path));
  },
};

try {
  const ev = JSON.parse(fs.readFileSync(0, "utf8") || "{}");
  if (process.env.ALR_DEBUG) appendEvent({ type: "debug_hook", event: ev.hook_event_name, keys: Object.keys(ev) });
  (codex.isCodex(ev) ? C_HANDLERS : zcode.isZCode(ev) ? Z_HANDLERS : HANDLERS)[ev.hook_event_name]?.(ev);
} catch (e) {
  if (process.env.ALR_DEBUG) process.stderr.write(`agent-limit-retry hook error: ${e.stack}\n`);
}
process.exit(0);
