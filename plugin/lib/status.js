// `alr status`: where each agent stands against its limits.
import { quotaSnapshot, recentLimitHits } from "./claude.js";
import { latestRateLimits } from "./codex.js";
import { config } from "./paths.js";
import { t, zh } from "./i18n.js";

const fmt = (at) => at ? new Date(at * 1000).toLocaleString(zh ? "zh-CN" : "en-US", { month: "numeric", day: "numeric", hour: "2-digit", minute: "2-digit" }) : "?";
const ago = (at) => {
  const m = Math.round((Date.now() / 1000 - at) / 60);
  return m < 60 ? t(`${m} min ago`, `${m} 分钟前`) : m < 1440 ? t(`${Math.round(m / 60)} h ago`, `${Math.round(m / 60)} 小时前`) : t(`${Math.round(m / 1440)} d ago`, `${Math.round(m / 1440)} 天前`);
};
const bar = (p) => { const n = Math.round(Math.min(100, p) / 10); return "█".repeat(n) + "░".repeat(10 - n); };
const LABEL = { five_hour: t("5-hour", "5 小时"), seven_day: t("weekly", "每周"), spend_limit: t("spend cap", "花费上限"), model: t("per-model", "单模型") };
const PAD = zh ? 6 : 9;

export function status() {
  const lines = [];
  const snap = quotaSnapshot();
  lines.push("Claude Code");
  if (snap?.rateLimits) {
    for (const [k, w] of Object.entries(snap.rateLimits)) {
      if (typeof w?.used_percentage !== "number") continue;
      lines.push(t(`  ${(LABEL[k] || k).padEnd(PAD)} ${bar(w.used_percentage)} ${Math.round(w.used_percentage)}%  resets ${fmt(w.resets_at)}`,
        `  ${(LABEL[k] || k).padEnd(PAD)} ${bar(w.used_percentage)} ${Math.round(w.used_percentage)}%  ${fmt(w.resets_at)} 重置`));
    }
    lines.push(t(`  (from the status line, updated ${ago(snap.updatedAt)}; at ${config().threshold}% the agent is asked to write a handoff file first)`,
      `  （数据来自状态栏，${ago(snap.updatedAt)}更新；到 ${config().threshold}% 会让 Agent 先写交接文件）`));
  } else {
    lines.push(t("  No quota data yet: run alr init to connect the status line, then open Claude Code once.", "  还没有额度数据：运行 alr init 接上状态栏，再打开一次 Claude Code。"));
  }
  const hits = recentLimitHits(8, 20).filter((h) => !h.transcript.includes("alr-selftest")).slice(0, 3);
  if (hits.length) {
    lines.push(t("  Recent limit hits:", "  最近撞限额："));
    for (const h of hits) lines.push(t(`    ${fmt(h.at)}  ${LABEL[h.kind] || h.kind} limit, resets ${fmt(h.resetsAt)}`, `    ${fmt(h.at)}  ${LABEL[h.kind] || h.kind}限额，${fmt(h.resetsAt)} 重置`));
  }
  const cx = latestRateLimits();
  lines.push("", "Codex");
  if (cx) {
    for (const [name, w] of [[t("primary", "主窗口"), cx.primary], [t("secondary", "副窗口"), cx.secondary]]) {
      if (!w) continue;
      // Codex writes snake_case; older alr snapshots were camelCase
      const mins = w.window_minutes ?? w.windowMinutes, pct = w.used_percent ?? w.usedPercent, at = w.resets_at ?? w.resetsAt;
      if (typeof pct !== "number") continue;
      const span = mins >= 1440 ? t(`${Math.round(mins / 1440)}-day`, `${Math.round(mins / 1440)} 天`) : t(`${Math.round(mins / 60)}-hour`, `${Math.round(mins / 60)} 小时`);
      lines.push(t(`  ${span.padEnd(PAD)} ${bar(pct)} ${Math.round(pct)}%  resets ${fmt(at)}`, `  ${span.padEnd(PAD)} ${bar(pct)} ${Math.round(pct)}%  ${fmt(at)} 重置`));
    }
    lines.push(t(`  (plan ${cx.plan_type || cx.plan || "?"}, from a session log written ${ago(cx.at)})`, `  （套餐 ${cx.plan_type || cx.plan || "?"}，数据来自 ${ago(cx.at)}的会话日志）`));
  } else {
    lines.push(t("  No Codex session logs found.", "  没找到 Codex 会话日志。"));
  }
  return lines.join("\n");
}
