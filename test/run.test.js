import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { spawnSync } from "node:child_process";
import { ROOT, sandbox } from "./helpers.js";

// A fake `claude`: first call hits a usage limit (writing a transcript like the real one does),
// later calls succeed. Every call is logged so the test can check the resume arguments.
const FAKE = `#!/usr/bin/env node
const fs=require("fs"),path=require("path");
const log=process.env.FAKE_LOG; const args=process.argv.slice(2);
fs.appendFileSync(log, JSON.stringify(args)+"\\n");
const n=fs.readFileSync(log,"utf8").trim().split("\\n").length, sid="sess-1";
if (n===1) {
  const dir=path.join(process.env.CLAUDE_CONFIG_DIR,"projects","-tmp-p"); fs.mkdirSync(dir,{recursive:true});
  fs.writeFileSync(path.join(dir,sid+".jsonl"), JSON.stringify({type:"assistant",error:"rate_limit",isApiErrorMessage:true,
    timestamp:new Date().toISOString(), message:{content:[{type:"text",text:"You've hit your session limit"}]},
    quotaLimits:{status:"rejected",resetsAt:Math.floor(Date.now()/1000)+2,rateLimitType:"five_hour"}})+"\\n");
  console.log(JSON.stringify({type:"result",is_error:true,result:"You've hit your session limit",session_id:sid})); process.exit(1);
}
console.log(JSON.stringify({type:"result",is_error:false,result:"all done",session_id:sid}));`;

test("alr run: waits for the reset, then resumes the same session", () => {
  const s = sandbox();
  const bin = path.join(s.dir, "fake-claude"); fs.writeFileSync(bin, FAKE, { mode: 0o755 });
  fs.writeFileSync(path.join(s.env.ALR_HOME, "config.json"), JSON.stringify({ resumeDelaySeconds: 0, notify: false }));
  const log = path.join(s.dir, "calls.log");
  const t0 = Date.now();
  const r = spawnSync("node", [path.join(ROOT, "bin/alr.js"), "run", "build the thing", "--", "--permission-mode", "acceptEdits"],
    { cwd: s.project, env: { ...s.env, ALR_CLAUDE_BIN: bin, FAKE_LOG: log }, encoding: "utf8", timeout: 20000 });
  assert.equal(r.status, 0, r.stderr);
  assert.match(r.stdout, /all done/);
  assert.ok(Date.now() - t0 >= 1500, "should have waited for the reset");
  const calls = fs.readFileSync(log, "utf8").trim().split("\n").map(JSON.parse);
  assert.equal(calls.length, 2);
  assert.deepEqual(calls[0].slice(0, 2), ["-p", "build the thing"]);
  assert.deepEqual(calls[1].slice(0, 3), ["-p", "--resume", "sess-1"]);
  assert.ok(calls[1].includes("--permission-mode"), "extra args carried over");
  assert.match(fs.readFileSync(path.join(s.env.ALR_HOME, "events.jsonl"), "utf8"), /run_waiting[\s\S]*run_finished/);
});

test("alr run: gives up after max resumes", () => {
  const s = sandbox();
  const always = FAKE.replace("if (n===1)", "if (true)");
  const bin = path.join(s.dir, "fake-claude"); fs.writeFileSync(bin, always, { mode: 0o755 });
  fs.writeFileSync(path.join(s.env.ALR_HOME, "config.json"), JSON.stringify({ resumeDelaySeconds: 0, notify: false }));
  const r = spawnSync("node", [path.join(ROOT, "bin/alr.js"), "run", "x", "--max-resumes", "1"],
    { cwd: s.project, env: { ...s.env, ALR_CLAUDE_BIN: bin, FAKE_LOG: path.join(s.dir, "calls.log") }, encoding: "utf8", timeout: 20000 });
  assert.equal(r.status, 3);
});
