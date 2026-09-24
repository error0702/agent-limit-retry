// `alr selftest`: prove the whole loop works on this machine without spending quota.
// A local fake API makes a real Claude Code hit a "5-hour limit" that resets in a few
// seconds; we check the limit is detected, we wait for the reset, and the same session resumes.
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { startMockApi } from "./mockapi.js";
import { claudeDir, readJSON } from "./paths.js";

const pluginDir = path.resolve(path.dirname(new URL(import.meta.url).pathname), "..");

export async function selftest() {
  const ok = (m) => console.log(`  ✓ ${m}`);
  const bad = (m) => { console.log(`  ✗ ${m}`); failed = true; };
  let failed = false;
  console.log("自检：模拟一次“5 小时额度用完、10 秒后重置”（本地假接口，不消耗额度）…");

  const api = await startMockApi({ resetIn: 10 });
  const home = fs.mkdtempSync(path.join(os.tmpdir(), "alr-selftest-"));
  const project = path.join(home, "project");
  fs.mkdirSync(project);
  fs.writeFileSync(path.join(home, "config.json"), JSON.stringify({ resumeDelaySeconds: 1, notify: false }));
  // Only for the child Claude Code: its own state stays out of the real ~/.agent-limit-retry.
  Object.assign(process.env, { ALR_HOME: home, ALR_DEBUG: "1", ANTHROPIC_BASE_URL: api.url });
  delete process.env.CLAUDE_CODE_CHILD_SESSION;

  const { run } = await import("./run.js");
  const cwd = process.cwd();
  process.chdir(project);
  const quietLog = [];
  const t0 = Date.now();
  const code = await run({ prompt: "selftest", extraArgs: ["--plugin-dir", pluginDir], maxResumes: 1, cwd: project, log: (m) => quietLog.push(m), quiet: true });
  process.chdir(cwd);
  api.close();

  const events = fs.existsSync(path.join(home, "events.jsonl"))
    ? fs.readFileSync(path.join(home, "events.jsonl"), "utf8").trim().split("\n").map(JSON.parse) : [];
  const waited = events.find((e) => e.type === "run_waiting");
  if (api.calls.length) ok("Claude Code 启动正常"); else bad("Claude Code 没发出请求（是否已登录？运行 claude 检查一下）");
  if (events.some((e) => e.type === "debug_hook")) ok("插件 hooks 加载正常"); else bad("插件 hooks 没有运行");
  if (waited) ok(`识别到额度用完，拿到重置时间 ${new Date(waited.resetsAt * 1000).toLocaleTimeString("zh-CN")}`); else bad("没识别到额度用完");
  if (code === 0 && api.calls.some((c) => c.status === 200)) ok(`到点自动续跑同一个会话，任务完成（用时 ${Math.round((Date.now() - t0) / 1000)} 秒）`);
  else bad(`续跑失败（退出码 ${code}）\n    ${quietLog.join("\n    ")}`);

  const st = readJSON(path.join(claudeDir(), "settings.json"), {}).statusLine?.command || "";
  if (st.includes("statusline.js") && st.includes("agent-limit-retry")) ok("状态栏已接上（能提前看到额度百分比）");
  else console.log("  - 状态栏还没接上：运行 alr init 后，额度快用完时才会提前写交接文件");

  fs.rmSync(home, { recursive: true, force: true });
  console.log(failed ? "\n自检没通过，把上面的输出发给作者。" : "\n全部正常。之后撞限额时它会自动处理，不用管它。");
  return failed ? 1 : 0;
}
