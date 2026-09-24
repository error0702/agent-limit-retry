// `alr codex-check`: can Codex's data be read on this machine, and is the plugin installed + trusted.
import { loadPro } from "./pro-loader.js";
import fs from "node:fs";
import path from "node:path";
import { spawnSync } from "node:child_process";
import * as codex from "./codex.js";
import { codexDir } from "./paths.js";
import { t, zh } from "./i18n.js";

const fmt = (at) => new Date(at * 1000).toLocaleString(zh ? "zh-CN" : "en-US", { month: "numeric", day: "numeric", hour: "2-digit", minute: "2-digit" });

export async function codexCheck() {
  if (!(await loadPro())) { console.log(t("Codex support is part of Pro: https://retry.autorun.fun", "Codex 支持属于 Pro 版：https://retry.autorun.fun")); return 2; }
  let failed = false;
  const ok = (m) => console.log(`  ✓ ${m}`), bad = (m) => { console.log(`  ✗ ${m}`); failed = true; };
  console.log(t("Codex check (reads local data only, no network)", "Codex 自检（只读本机数据，不联网）"));
  const v = spawnSync("codex", ["--version"], { encoding: "utf8" });
  v.status === 0 ? ok(t(`codex command available (${v.stdout.trim()})`, `codex 命令可用（${v.stdout.trim()}）`)) : bad(t("codex command not found (desktop app users: add the Codex CLI to PATH, or just keep using the desktop app)", "找不到 codex 命令（桌面版用户：把 Codex 的 CLI 加到 PATH，或只用桌面版也行）"));
  fs.existsSync(codex.sessionsDir()) ? ok(t(`Found session logs at ${codex.sessionsDir()}`, `找到会话记录 ${codex.sessionsDir()}`)) : bad(t(`No session logs at ${codex.sessionsDir()}`, `没找到会话记录 ${codex.sessionsDir()}`));
  const rl = codex.latestRateLimits();
  if (rl) {
    for (const [name, w] of [[t("primary window", "主窗口"), rl.primary], [t("secondary window", "副窗口"), rl.secondary]]) if (w) console.log(t(`  · ${name}: ${Math.round(w.usedPercent ?? w.used_percent)}% used, resets ${fmt(w.resetsAt ?? w.resets_at)} (${Math.round((w.windowMinutes ?? w.window_minutes) / 60)}-hour window)`, `  · ${name}：${Math.round(w.usedPercent ?? w.used_percent)}% 已用，${fmt(w.resetsAt ?? w.resets_at)} 重置（${Math.round((w.windowMinutes ?? w.window_minutes) / 60)} 小时窗口）`));
  } else console.log(t("  · No quota records yet", "  · 还没有额度记录"));
  const cache = path.join(codexDir(), "plugins", "cache", "agent-limit-retry");
  fs.existsSync(cache) ? ok(t("Plugin installed in Codex", "插件已安装到 Codex")) : bad(t("Plugin not installed yet; run alr init", "插件还没安装，运行 alr init"));
  let cfg = ""; try { cfg = fs.readFileSync(path.join(codexDir(), "config.toml"), "utf8"); } catch { /* none */ }
  /agent-limit-retry[^\n]*trusted_hash|trusted_hash[^\n]*agent-limit-retry/s.test(cfg) || /\[hooks\.state\.[^\]]*agent-limit-retry/.test(cfg)
    ? ok(t("hooks trusted", "hooks 已被信任")) : console.log(t('  ! hooks not trusted yet: open Codex and choose "Trust all and continue" when you see "Hooks need review"', "  ！hooks 还没被信任：打开 Codex，看到 “Hooks need review” 时选 “Trust all and continue”"));
  const node = spawnSync("node", ["--version"], { encoding: "utf8" });
  node.status === 0 ? ok(t(`node available (${node.stdout.trim()})`, `node 可用（${node.stdout.trim()}）`)) : bad(t("hooks need node, but it was not found", "hooks 需要 node，但找不到"));
  console.log(failed ? t("\nSomething is off; send the output above to the author.", "\n有问题，把上面的输出发给作者。") : t("\nLooks fine.", "\n基本正常。"));
  return failed ? 1 : 0;
}
