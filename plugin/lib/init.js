// `alr init` / `alr uninstall`.
// One question, then: copy the app to a stable place (npx caches get wiped), install the
// Claude Code plugin from there, and wrap the status line. settings.json is backed up first.
import { loadPro } from "./pro-loader.js";
import fs from "node:fs";
import path from "node:path";
import readline from "node:readline/promises";
import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import { claudeDir, config, file, home, readJSON, writeJSON } from "./paths.js";
import * as zcode from "./zcode.js";
import * as codexlib from "./codex.js";
import { t } from "./i18n.js";

const NAME = "agent-limit-retry";
const pkgRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../..");
const appDir = () => path.join(home(), "app");
const statuslineScript = () => path.join(appDir(), "plugin", "scripts", "statusline.js");
const settingsPath = () => path.join(claudeDir(), "settings.json");
const isOurs = (cmd) => typeof cmd === "string" && cmd.includes("statusline.js") &&
  (cmd.includes(statuslineScript()) || cmd.includes(NAME));

async function confirm(q, yes) {
  if (yes) return true;
  if (!process.stdin.isTTY) { console.log(t(`${q}\nNo terminal to confirm on; pass --yes to run without asking`, `${q}\n没有终端可以确认；要直接执行请加 --yes`)); return false; }
  const rl = readline.createInterface({ input: process.stdin, output: process.stdout });
  const a = (await rl.question(`${q} [Y/n] `)).trim().toLowerCase();
  rl.close();
  return a === "" || a === "y" || a === "yes";
}

const claudeCmd = (args) => {
  const r = spawnSync("claude", args, { encoding: "utf8" });
  return { ok: r.status === 0, out: `${r.stdout || ""}${r.stderr || ""}`.trim() };
};

function claudeVersion() {
  const m = /(\d+)\.(\d+)\.(\d+)/.exec(claudeCmd(["--version"]).out);
  if (!m) return null;
  const [a, b, c] = m.slice(1).map(Number);
  return { text: m[0], ok: a > 2 || (a === 2 && (b > 1 || (b === 1 && c >= 234))) };
}

function copyApp() {
  const dst = appDir();
  if (path.resolve(pkgRoot) === path.resolve(dst)) return;         // running from the copy already
  fs.rmSync(dst, { recursive: true, force: true });
  for (const part of ["plugin", ".claude-plugin", "bin", "package.json"]) {
    fs.cpSync(path.join(pkgRoot, part), path.join(dst, part), { recursive: true });
  }
}

export const installed = () => isOurs(readJSON(settingsPath(), {}).statusLine?.command) || zcode.installed(path.join(appDir(), "plugin"));

export async function init({ yes = false } = {}) {
  const v = claudeVersion();
  const pro = await loadPro();                 // Codex / ZCode support ships with Pro only
  const hasZCode = !!pro && zcode.present();
  const hasCodex = !!pro && codexPresent();
  if (!v && !hasZCode && !hasCodex) { console.log(t("Claude Code, Codex or ZCode not found. Install one of them first.", "没找到 Claude Code、Codex 或 ZCode。先装好其中一个。")); return 1; }
  if (!v) { const a = hasZCode ? await initZCode({ yes }) : 0; const b = hasCodex ? await initCodex({ yes }) : 0; return a || b; }
  const settings = readJSON(settingsPath(), {});
  const current = settings.statusLine;
  const slNote = current && !isOurs(current.command)
    ? t(" (your existing status line is kept as is)", "（你现有的状态栏会原样保留）")
    : t(" (shows ⏳ 5h xx% · 7d xx%)", "（会显示 ⏳ 5h xx% · 7d xx%）");
  console.log(t(`agent-limit-retry will do three things (Claude Code ${v.text}):
  1. Install a Claude Code plugin: after a limit hit, wake the interrupted subagents by their original IDs once the limit resets; when quota is nearly used up, ask for a handoff file first
  2. Take over the status line to read the quota percentage${slNote}
  3. Back up ~/.claude/settings.json before changing it; alr uninstall restores it any time`, `agent-limit-retry 会做三件事（Claude Code ${v.text}）：
  1. 安装一个 Claude Code 插件：撞额度后，等重置了再按原 ID 叫醒被打断的子 Agent；额度快用完时先写交接文件
  2. 接管状态栏来读取额度百分比${slNote}
  3. 修改前备份 ~/.claude/settings.json，随时可以 alr uninstall 还原`));
  if (!v.ok) console.log(t("  Note: your Claude Code is older than 2.1.234; upgrading first is recommended.", "  注意：你的 Claude Code 版本低于 2.1.234，建议先升级。"));
  if (!(await confirm(t("Install now?", "开始安装？"), yes))) return 1;

  copyApp();
  let r = claudeCmd(["plugin", "marketplace", "add", appDir()]);
  if (!r.ok && /already/i.test(r.out)) r = claudeCmd(["plugin", "marketplace", "update", NAME]);
  if (!r.ok) { console.log(t(`Failed to add the plugin marketplace: ${r.out}`, `插件市场添加失败：${r.out}`)); return 1; }
  r = claudeCmd(["plugin", "install", `${NAME}@${NAME}`]);
  if (!r.ok && !/already/i.test(r.out)) { console.log(t(`Plugin install failed: ${r.out}`, `插件安装失败：${r.out}`)); return 1; }
  claudeCmd(["plugin", "update", `${NAME}@${NAME}`]);   // already installed: pull the new version
  claudeCmd(["plugin", "enable", `${NAME}@${NAME}`]);   // a reinstall can leave it disabled
  console.log(t("  ✓ Plugin installed", "  ✓ 插件已安装"));

  // `claude plugin install` just rewrote settings.json (enabledPlugins, marketplaces):
  // re-read it, or we'd write back the stale copy and silently disable the plugin.
  const fresh = readJSON(settingsPath(), {});
  if (!isOurs(current?.command)) {
    const p = settingsPath();
    if (fs.existsSync(p)) fs.copyFileSync(p, `${p}.${NAME}-backup-${Date.now()}`);
    const cfg = readJSON(file("config.json"), {});
    if (current) cfg.wrappedStatusLine = current;
    writeJSON(file("config.json"), cfg);
    fresh.statusLine = { type: "command", command: `node "${statuslineScript()}"`, ...(current?.padding != null && { padding: current.padding }) };
    writeJSON(p, fresh);
  } else if (!current.command.includes(statuslineScript())) {
    fresh.statusLine = { ...current, command: `node "${statuslineScript()}"` };   // app moved; repoint
    writeJSON(settingsPath(), fresh);
  }
  console.log(t("  ✓ Status line connected", "  ✓ 状态栏已接上"));
  const cfgNow = readJSON(file("config.json"), {});
  if (!cfgNow.installedAt) writeJSON(file("config.json"), { ...cfgNow, installedAt: Math.floor(Date.now() / 1000) });
  if (hasZCode) { console.log(""); await initZCode({ yes, quiet: true }); }
  if (hasCodex) { console.log(""); await initCodex({ yes, quiet: true }); }
  console.log(t(`\nDone. Restart Claude Code to activate it; nothing else to do.
  To confirm it works: alr selftest (simulates a limit hit, spends no quota)
  Quota:               alr status
  Settings:            ${file("config.json")} (the handoff file is written at ${config().threshold}% quota)`, `\n装好了。重启 Claude Code 生效，之后不用管它。
  想确认能用：alr selftest（模拟一次撞限额，不花额度）
  看额度：    alr status
  调整设置：  ${file("config.json")}（额度用到 ${config().threshold}% 时写交接文件）`));
  return 0;
}

/** ZCode: the plugin folder is listed in ~/.zcode/cli/config.json `plugins.dirs`, which ZCode loads
 *  as an always-enabled inline plugin (hooks included, no trust step). */
export async function initZCode({ yes = false, quiet = false } = {}) {
  const pluginDir = path.join(appDir(), "plugin");
  if (!quiet) console.log(t(`ZCode detected. agent-limit-retry will register the plugin directory in ${zcode.configPath()} (backed up first),
  so that after a limit hit, your next message tells the main agent which subagents were interrupted.`, `检测到 ZCode。agent-limit-retry 会把插件目录登记到 ${zcode.configPath()}（改前备份），
  撞额度后在你下一句话时，把被打断的子 Agent 告诉主 Agent。`));
  if (zcode.installed(pluginDir)) { console.log(t("  ✓ ZCode plugin registered", "  ✓ ZCode 插件已登记")); return 0; }
  if (!(await confirm(t("Register with ZCode?", "登记到 ZCode？"), yes))) return 1;
  copyApp();
  const r = zcode.register(pluginDir);
  const backup = r.backup ? t(` (backup: ${r.backup})`, `（备份：${r.backup}）`) : "";
  console.log(t(`  ✓ ZCode plugin registered${backup}`, `  ✓ ZCode 插件已登记${backup}`));
  if (!quiet) console.log(t(`\nRestart ZCode to activate it. To confirm your data can be read: alr zcode-check`, `\n重启 ZCode 生效。确认能读到你的数据：alr zcode-check`));
  return 0;
}

const codexCmd = (args) => {
  const r = spawnSync("codex", args, { encoding: "utf8", timeout: 60000 });
  return { ok: r.status === 0, out: `${r.stdout || ""}${r.stderr || ""}`.trim() };
};
export const codexPresent = () => fs.existsSync(codexlib.sessionsDir()) || spawnSync("codex", ["--version"], { encoding: "utf8" }).status === 0;

/** Codex: register the app copy as a local marketplace and install the plugin from it.
 *  Codex copies the plugin into ~/.codex/plugins/cache. Its hooks stay OFF until the user trusts
 *  them once in Codex ("Hooks need review" -> "Trust all and continue"); nothing here can do
 *  that for them. */
export async function initCodex({ yes = false, quiet = false } = {}) {
  if (!quiet) console.log(t(`Codex detected. agent-limit-retry will install the plugin with the codex plugin command (Codex copies it to ~/.codex/plugins/cache).
  After a limit hit, your next message tells the main agent which subagents were interrupted; alr run --agent codex resumes unattended.`, `检测到 Codex。agent-limit-retry 会用 codex plugin 命令安装插件（Codex 会把它复制到 ~/.codex/plugins/cache）。
  撞额度后，在你下一句话时把被打断的子 Agent 告诉主 Agent；alr run --agent codex 可以无人值守续跑。`));
  if (!(await confirm(t("Install into Codex?", "安装到 Codex？"), yes))) return 1;
  copyApp();
  let r = codexCmd(["plugin", "marketplace", "add", appDir()]);
  if (!r.ok && !/already|exists/i.test(r.out)) { console.log(t(`  Failed to add the Codex plugin marketplace: ${r.out.slice(0, 300)}`, `  Codex 插件市场添加失败：${r.out.slice(0, 300)}`)); return 1; }
  r = codexCmd(["plugin", "add", `${NAME}@${NAME}`]);
  if (!r.ok && !/already|installed/i.test(r.out)) { console.log(t(`  Codex plugin install failed: ${r.out.slice(0, 300)}`, `  Codex 插件安装失败：${r.out.slice(0, 300)}`)); return 1; }
  console.log(t("  ✓ Codex plugin installed", "  ✓ Codex 插件已安装"));
  console.log(t(`  ! One step left: Codex hooks must be trusted by you once. Next time you open Codex and see "Hooks need review", choose "Trust all and continue"
    (in the CLI you can also type /hooks to check). If the desktop app never shows that prompt, run codex once in a terminal, then go back to the desktop app.`, `  ！还差一步：Codex 的 hooks 要你亲自信任一次。下次打开 Codex 看到 “Hooks need review” 时选 “Trust all and continue”
    （命令行里也可以输入 /hooks 查看）。桌面版如果没有这个提示，先在终端跑一次 codex 再回到桌面版。`));
  if (!quiet) console.log(t(`
To confirm your data can be read: alr codex-check`, `
确认能读到你的数据：alr codex-check`));
  return 0;
}

export async function uninstall({ yes = false } = {}) {
  if (!(await confirm(t("Uninstall agent-limit-retry and restore your original status line?", "卸载 agent-limit-retry，并恢复原来的状态栏？"), yes))) return 1;
  const settings = readJSON(settingsPath(), {});
  const cfg = readJSON(file("config.json"), {});
  if (isOurs(settings.statusLine?.command)) {
    const p = settingsPath();
    fs.copyFileSync(p, `${p}.${NAME}-backup-${Date.now()}`);
    if (cfg.wrappedStatusLine) settings.statusLine = cfg.wrappedStatusLine; else delete settings.statusLine;
    writeJSON(p, settings);
  }
  claudeCmd(["plugin", "uninstall", `${NAME}@${NAME}`]);
  claudeCmd(["plugin", "marketplace", "remove", NAME]);
  if (zcode.unregister(path.join(appDir(), "plugin"))) console.log(t("  ZCode plugin removed", "  ZCode 插件已移除"));
  if (codexPresent()) { codexCmd(["plugin", "remove", `${NAME}@${NAME}`]); codexCmd(["plugin", "marketplace", "remove", NAME]); console.log(t("  Codex plugin removed", "  Codex 插件已移除")); }
  console.log(t("Uninstalled. Your status line is restored; data stays in " + home() + " (safe to delete).", "已卸载。你的状态栏已恢复，数据留在 " + home() + "（可以直接删掉）。"));
  return 0;
}
