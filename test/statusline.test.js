import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { spawnSync } from "node:child_process";
import { ROOT, sandbox } from "./helpers.js";

const input = { session_id: "s1", rate_limits: { five_hour: { used_percentage: 62.4, resets_at: 1790000000 }, seven_day: { used_percentage: 41, resets_at: 1790500000 } } };
const run = (env, data) => spawnSync("node", [path.join(ROOT, "plugin/scripts/statusline.js")], { input: JSON.stringify(data), env, encoding: "utf8" });

test("saves the snapshot and prints a compact default", () => {
  const s = sandbox();
  const r = run(s.env, input);
  assert.equal(r.stdout, "⏳ 5h 62% · 7d 41%");
  const snap = JSON.parse(fs.readFileSync(path.join(s.env.ALR_HOME, "claude-quota.json"), "utf8"));
  assert.equal(snap.rateLimits.five_hour.used_percentage, 62.4);
});

test("passes stdin through to the user's original status line", () => {
  const s = sandbox();
  fs.writeFileSync(path.join(s.env.ALR_HOME, "config.json"), JSON.stringify({ wrappedStatusLine: { type: "command", command: "node -e \"let s='';process.stdin.on('data',d=>s+=d).on('end',()=>process.stdout.write('mine:'+JSON.parse(s).session_id))\"" } }));
  assert.equal(run(s.env, input).stdout, "mine:s1");
});

test("no rate limits (API key users): prints nothing, writes nothing", () => {
  const s = sandbox();
  assert.equal(run(s.env, { session_id: "s1" }).stdout, "");
  assert.equal(fs.existsSync(path.join(s.env.ALR_HOME, "claude-quota.json")), false);
});
