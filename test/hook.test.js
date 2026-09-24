import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { hook, sandbox, writeQuota } from "./helpers.js";

const ev = (name, s, extra = {}) => ({ hook_event_name: name, session_id: "s1", cwd: s.project, transcript_path: "/nope", ...extra });
const writeHandoff = (s, body = "<!-- agent-limit-retry handoff -->\n## 目标\n...") => fs.writeFileSync(path.join(s.project, "HANDOFF.md"), body);

test("below threshold: stays silent", () => {
  const s = sandbox(); writeQuota(s.env, 70);
  assert.equal(hook(s.env, ev("PostToolUse", s)).out, null);
});

test("over threshold: asks for a handoff once per window, then Stop enforces it", () => {
  const s = sandbox(); writeQuota(s.env, 93);
  const first = hook(s.env, ev("PostToolUse", s));
  assert.match(first.out.hookSpecificOutput.additionalContext, /已用 93%.*HANDOFF\.md/s);
  assert.equal(hook(s.env, ev("PostToolUse", s)).out, null, "asked twice in the same window");

  const blocked = hook(s.env, ev("Stop", s, { stop_hook_active: false }));
  assert.equal(blocked.out.decision, "block");
  assert.equal(hook(s.env, ev("Stop", s, { stop_hook_active: true })).out, null, "must not loop");

  writeHandoff(s);
  assert.equal(hook(s.env, ev("Stop", s, { stop_hook_active: false })).out, null, "handoff written -> let it stop");
  const events = fs.readFileSync(path.join(s.env.ALR_HOME, "events.jsonl"), "utf8");
  assert.match(events, /handoff_requested/);
  assert.match(events, /handoff_written/);
});

test("a HANDOFF.md without our marker doesn't count", () => {
  const s = sandbox(); writeQuota(s.env, 95);
  hook(s.env, ev("PostToolUse", s));
  writeHandoff(s, "# my own notes");
  assert.equal(hook(s.env, ev("Stop", s)).out.decision, "block");
});

test("stale quota snapshot is ignored", () => {
  const s = sandbox(); writeQuota(s.env, 99, { updatedAgo: 3600 });
  assert.equal(hook(s.env, ev("PostToolUse", s)).out, null);
});

test("a window that already reset is ignored", () => {
  const s = sandbox(); writeQuota(s.env, 99, { resetsIn: -10 });
  assert.equal(hook(s.env, ev("PostToolUse", s)).out, null);
});

test("threshold is configurable", () => {
  const s = sandbox(); writeQuota(s.env, 75);
  fs.writeFileSync(path.join(s.env.ALR_HOME, "config.json"), JSON.stringify({ threshold: 70 }));
  assert.ok(hook(s.env, ev("PostToolUse", s)).out);
});

test("new session in a project with a handoff gets pointed at it", () => {
  const s = sandbox(); writeHandoff(s);
  const r = hook(s.env, ev("SessionStart", s, { source: "startup" }));
  assert.match(r.out.hookSpecificOutput.additionalContext, /HANDOFF\.md/);
  assert.equal(hook(s.env, ev("SessionStart", s, { source: "compact" })).out, null);
});

test("garbage input never breaks the session", () => {
  const s = sandbox();
  const r = hook(s.env, "not json at all");
  assert.equal(r.code, 0);
});

test("usage-limit failure is recorded with its reset time", () => {
  const s = sandbox();
  const t = path.join(s.dir, "t.jsonl");
  fs.writeFileSync(t, JSON.stringify({ type: "assistant", error: "rate_limit", isApiErrorMessage: true, timestamp: new Date().toISOString(),
    message: { content: [{ type: "text", text: "You've hit your session limit" }] },
    quotaLimits: { resetsAt: 1790000000, rateLimitType: "five_hour" } }) + "\n");
  hook(s.env, ev("StopFailure", s, { error_type: "rate_limit", transcript_path: t }));
  const events = fs.readFileSync(path.join(s.env.ALR_HOME, "events.jsonl"), "utf8");
  assert.match(events, /"type":"limit_hit".*"resetsAt":1790000000/);
});

test("other API failures are ignored", () => {
  const s = sandbox();
  hook(s.env, ev("StopFailure", s, { error_type: "overloaded" }));
  assert.equal(fs.existsSync(path.join(s.env.ALR_HOME, "events.jsonl")), false);
});
