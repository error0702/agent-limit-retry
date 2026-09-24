// `alr codex-check`: can Codex's data be read on this machine, and is the plugin installed + trusted.
import { loadPro } from "./pro-loader.js";
import fs from "node:fs";
import path from "node:path";
import { spawnSync } from "node:child_process";
import * as codex from "./codex.js";
import { codexDir } from "./paths.js";

const fmt = (t) => new Date(t * 1000).toLocaleString("zh-CN", { month: "numeric", day: "numeric", hour: "2-digit", minute: "2-digit" });

export async function codexCheck() {
  if (!(await loadPro())) { console.log("Codex 支持属于 Pro 版：https://retry.autorun.fun"); return 2; }
  let failed = false;
  const ok = (m) => console.log(`  ✓ ${m}`), bad = (m) => { console.log(`  ✗ ${m}`); failed = true; };
  console.log("Codex 自检（只读本机数据，不联网）");
  const v = spawnSync("codex", ["--version"], { encoding: "utf8" });
  v.status === 0 ? ok(`codex 命令可用（${v.stdout.trim()}）`) : bad("找不到 codex 命令（桌面版用户：把 Codex 的 CLI 加到 PATH，或只用桌面版也行）");
  fs.existsSync(codex.sessionsDir()) ? ok(`找到会话记录 ${codex.sessionsDir()}`) : bad(`没找到会话记录 ${codex.sessionsDir()}`);
  const rl = codex.latestRateLimits();
  if (rl) {
    for (const [name, w] of [["主窗口", rl.primary], ["副窗口", rl.secondary]]) if (w) console.log(`  · ${name}：${Math.round(w.usedPercent ?? w.used_percent)}% 已用，${fmt(w.resetsAt ?? w.resets_at)} 重置（${Math.round((w.windowMinutes ?? w.window_minutes) / 60)} 小时窗口）`);
  } else console.log("  · 还没有额度记录");
  const cache = path.join(codexDir(), "plugins", "cache", "agent-limit-retry");
  fs.existsSync(cache) ? ok("插件已安装到 Codex") : bad("插件还没安装，运行 alr init");
  let cfg = ""; try { cfg = fs.readFileSync(path.join(codexDir(), "config.toml"), "utf8"); } catch { /* none */ }
  /agent-limit-retry[^\n]*trusted_hash|trusted_hash[^\n]*agent-limit-retry/s.test(cfg) || /\[hooks\.state\.[^\]]*agent-limit-retry/.test(cfg)
    ? ok("hooks 已被信任") : console.log("  ！hooks 还没被信任：打开 Codex，看到 “Hooks need review” 时选 “Trust all and continue”");
  const node = spawnSync("node", ["--version"], { encoding: "utf8" });
  node.status === 0 ? ok(`node 可用（${node.stdout.trim()}）`) : bad("hooks 需要 node，但找不到");
  console.log(failed ? "\n有问题，把上面的输出发给作者。" : "\n基本正常。");
  return failed ? 1 : 0;
}
