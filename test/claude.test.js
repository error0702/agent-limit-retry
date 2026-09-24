import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { sandbox } from "./helpers.js";

process.env.TZ = "UTC";
const { parseResetText, lastLimitHit } = await import("../plugin/lib/claude.js");
const iso = (t) => new Date(t * 1000).toISOString();
const at = Date.parse("2026-09-23T09:00:00Z") / 1000;    // 17:00 in Shanghai

test("reset text: later today, tomorrow, minutes, explicit date", () => {
  assert.equal(iso(parseResetText("You've hit your session limit · resets 8pm (Asia/Shanghai)", at)), "2026-09-23T12:00:00.000Z");
  assert.equal(iso(parseResetText("resets 10am (Asia/Shanghai)", at)), "2026-09-24T02:00:00.000Z");
  assert.equal(iso(parseResetText("resets 2:10am (Asia/Shanghai)", at)), "2026-09-23T18:10:00.000Z");
  assert.equal(iso(parseResetText("resets Sep 30, 10am (America/New_York)", at)), "2026-09-30T14:00:00.000Z");
  assert.equal(iso(parseResetText("resets 12am (Asia/Shanghai)", at)), "2026-09-23T16:00:00.000Z");
  assert.equal(iso(parseResetText("You've hit your weekly limit · resets Aug 4 at 10am (Asia/Shanghai)", Date.parse("2026-08-01T00:00:00Z") / 1000)), "2026-08-04T02:00:00.000Z");
  assert.equal(parseResetText("no reset info here", at), null);
});

test("reset text: a reset later in the same minute is today, not tomorrow", () => {
  const hitAt = Date.parse("2026-09-23T09:32:25Z") / 1000;
  assert.equal(iso(parseResetText("resets 5:32pm (Asia/Shanghai)", hitAt)), "2026-09-23T09:32:00.000Z");
});

test("reset text: GLM coding plan format (local time)", () => {
  // TZ=UTC in this test file
  assert.equal(iso(parseResetText("[1308][已达到 5 小时的使用上限。您的限额将在 2026-08-11 01:15:20 重置。]", at)), "2026-08-11T01:15:20.000Z");
});

function transcript(lines) {
  const { dir } = sandbox();
  const p = path.join(dir, "t.jsonl");
  fs.writeFileSync(p, lines.map((l) => JSON.stringify(l)).join("\n") + "\n");
  return p;
}

test("limit hit: quotaLimits gives the exact reset", () => {
  const p = transcript([
    { type: "user", message: { content: "do it" } },
    { type: "assistant", error: "rate_limit", isApiErrorMessage: true, timestamp: "2026-09-16T09:02:54Z",
      message: { content: [{ type: "text", text: "You've hit your session limit · resets 5pm (Asia/Shanghai)" }] },
      quotaLimits: { status: "rejected", resetsAt: 1789558800, rateLimitType: "five_hour" } },
  ]);
  const h = lastLimitHit(p);
  assert.equal(h.kind, "five_hour");
  assert.equal(h.resetsAt, 1789558800);
});

test("limit hit: falls back to the visible text when quotaLimits is missing", () => {
  const p = transcript([{ type: "assistant", isApiErrorMessage: true, timestamp: "2026-09-23T09:00:00Z",
    message: { content: [{ type: "text", text: "You've hit your weekly limit · resets Sep 30, 10am (Asia/Shanghai)" }] } }]);
  const h = lastLimitHit(p);
  assert.equal(h.kind, "seven_day");
  assert.equal(iso(h.resetsAt), "2026-09-30T02:00:00.000Z");
});

test("limit hit: talking about limits is not a limit hit", () => {
  const p = transcript([
    { type: "user", message: { content: "why do I keep seeing 'You've hit your weekly limit'?" } },
    { type: "assistant", message: { content: [{ type: "text", text: "When you've hit your session limit · resets 8pm ..." }] } },
  ]);
  assert.equal(lastLimitHit(p), null);
});
