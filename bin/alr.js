#!/usr/bin/env node
// agent-limit-retry CLI. Run with no arguments: installs if needed, otherwise shows status.
const load = (m) => import(new URL(`../plugin/lib/${m}`, import.meta.url));

const HELP = `agent-limit-retry：让 Claude Code / Codex / ZCode 扛过额度限制

  npx @autorun/agent-limit-retry     一条命令装好（已装好时显示额度）

  alr selftest                       Claude Code：模拟一次撞限额和自动续跑，确认能用（不花额度）
  alr zcode-check                    ZCode：确认能读到本机的 ZCode 数据
  alr codex-check                    Codex：确认插件已装、hooks 已信任、能读到额度
  alr status                         看 Claude Code / Codex 的额度和最近的撞限额记录
  alr run "<任务>" [--agent codex] [-- <参数>]
                                     无人值守跑任务：撞限额后等重置自动续跑（周限额也行；Codex 也支持）
  alr report                         撞过额度后生成反馈文件（不含对话和代码），发给作者
  alr uninstall                      卸载并恢复原来的状态栏

设置：~/.agent-limit-retry/config.json
  threshold 90   额度用到多少 % 时让 Agent 先写交接文件
  handoffFile    交接文件名，默认 HANDOFF.md（项目根目录）
  maxResumes 5   alr run 最多续跑几次
  notify true    撞限额、写好交接文件时发桌面通知`;

const argv = process.argv.slice(2);
const yes = argv.includes("--yes") || argv.includes("-y");
const [cmd, ...rest] = argv[0] === "--yes" || argv[0] === "-y" ? [undefined, ...argv.slice(1)] : argv;
let code = 0;
switch (cmd) {
  case undefined: {
    const init = await load("init.js");
    code = init.installed() ? (console.log((await load("status.js")).status()), 0) : await init.init({ yes });
    break;
  }
  case "init": code = await (await load("init.js")).init({ yes }); break;
  case "uninstall": code = await (await load("init.js")).uninstall({ yes }); break;
  case "status": console.log((await load("status.js")).status()); break;
  case "selftest": case "test": code = await (await load("selftest.js")).selftest(); break;
  case "report": code = await (await load("report.js")).report(rest[0]); break;
  case "zcode-check": code = await (await load("zcodecheck.js")).zcodeCheck(); break;
  case "codex-check": code = await (await load("codexcheck.js")).codexCheck(); break;
  case "version": case "--version": case "-v": console.log((await import("node:fs")).readFileSync(new URL("../package.json", import.meta.url), "utf8").match(/"version": "([^"]+)"/)[1]); break;
  case "run": {
    const dd = rest.indexOf("--");
    const own = dd === -1 ? rest : rest.slice(0, dd);
    const extraArgs = dd === -1 ? [] : rest.slice(dd + 1);
    const opt = (name) => { const i = own.indexOf(name); return i === -1 ? undefined : own[i + 1]; };
    const maxResumes = opt("--max-resumes") ? Number(opt("--max-resumes")) : undefined;
    const agent = opt("--agent") || "claude";
    const skip = new Set(["--max-resumes", "--agent"].flatMap((n) => { const i = own.indexOf(n); return i === -1 ? [] : [i, i + 1]; }));
    const prompt = own.filter((a, i) => !skip.has(i))[0];
    if (!prompt) { console.error('用法：alr run "<任务>" [--agent claude|codex] [--max-resumes N] [-- <传给 claude/codex 的参数>]'); code = 2; break; }
    code = await (await load("run.js")).run({ prompt, extraArgs, maxResumes, agent });
    break;
  }
  default: console.log(HELP); code = ["help", "--help", "-h"].includes(cmd) ? 0 : 2;
}
process.exit(code);
