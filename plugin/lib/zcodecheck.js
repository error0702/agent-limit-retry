// `alr zcode-check`: can this machine's ZCode data be read, and what's in it. Nothing is sent anywhere.
import { loadPro } from "./pro-loader.js";
import fs from "node:fs";
import path from "node:path";
import { spawnSync } from "node:child_process";
import * as zcode from "./zcode.js";
import { home } from "./paths.js";
import { t, zh } from "./i18n.js";

const fmt = (at) => new Date(at * 1000).toLocaleString(zh ? "zh-CN" : "en-US", { month: "numeric", day: "numeric", hour: "2-digit", minute: "2-digit" });

export async function zcodeCheck() {
  if (!(await loadPro())) { console.log(t("ZCode support is part of Pro: https://retry.autorun.fun", "ZCode 支持属于 Pro 版：https://retry.autorun.fun")); return 2; }
  let failed = false;
  const ok = (m) => console.log(`  ✓ ${m}`), bad = (m) => { console.log(`  ✗ ${m}`); failed = true; };
  console.log(t("ZCode check (reads local data only, no network)", "ZCode 自检（只读本机数据，不联网）"));
  const sq = spawnSync("sqlite3", ["-version"], { encoding: "utf8" });
  sq.status === 0 ? ok(t(`sqlite3 available (${sq.stdout.trim().split(" ")[0]})`, `sqlite3 可用（${sq.stdout.trim().split(" ")[0]}）`)) : bad(t("sqlite3 command not found (ships with macOS; install it on Linux)", "没有 sqlite3 命令（macOS 自带，Linux 需要安装）"));
  const db = zcode.dbPath();
  fs.existsSync(db) ? ok(t(`Found the session database ${db}`, `找到会话数据库 ${db}`)) : bad(t(`Session database ${db} not found (has ZCode been used yet?)`, `没找到会话数据库 ${db}（ZCode 还没用过？）`));
  const n = zcode.query("select count(*) as n from session where task_type='interactive'")[0]?.n;
  n != null ? ok(t(`Readable: ${n} sessions`, `能读取：${n} 个会话`)) : bad(t("Cannot read the database (locked, or a different schema)", "数据库读不出来（被锁住或结构不同）"));
  const kids = zcode.query("select count(*) as n from session where task_type='subagent_child'")[0]?.n ?? 0;
  console.log(t(`  · Subagent sessions: ${kids}`, `  · 子 Agent 会话：${kids} 个`));
  const hits = zcode.query(`select session_id, max(time_created) as t from message
    where data like '%rate_limited%' or data like '%使用上限%' or data like '%1308%' group by session_id order by t desc limit 5`);
  console.log(t(`  · Recent limit-hit sessions: ${hits.length}`, `  · 最近撞额度的会话：${hits.length} 个`) + (hits.length ? t(": ", "：") + hits.map((h) => fmt(h.t / 1000)).join(t(", ", "、")) : ""));
  const pluginDir = path.join(home(), "app", "plugin");
  zcode.installed(pluginDir) ? ok(t("Plugin registered in the ZCode config", "插件已登记到 ZCode 配置")) : bad(t("Plugin not registered yet; run alr init", "插件还没登记，运行 alr init"));
  const node = spawnSync("node", ["--version"], { encoding: "utf8" });
  node.status === 0 ? ok(t(`node available (${node.stdout.trim()})`, `node 可用（${node.stdout.trim()}）`)) : bad(t("hooks need node, but it was not found", "hooks 需要 node，但找不到"));
  console.log(failed ? t("\nSomething is off; send the output above to the author.", "\n有问题，把上面的输出发给作者。") : t("\nAll good. Restart ZCode and the plugin works in the background.", "\n都正常。重启 ZCode 后插件就在后台起作用了。"));
  return failed ? 1 : 0;
}
