// `alr status`: where each agent stands against its limits.
import { quotaSnapshot, recentLimitHits } from "./claude.js";
import { latestRateLimits } from "./codex.js";
import { config } from "./paths.js";

const fmt = (t) => t ? new Date(t * 1000).toLocaleString("zh-CN", { month: "numeric", day: "numeric", hour: "2-digit", minute: "2-digit" }) : "?";
const ago = (t) => { const m = Math.round((Date.now() / 1000 - t) / 60); return m < 60 ? `${m} 分钟前` : m < 1440 ? `${Math.round(m / 60)} 小时前` : `${Math.round(m / 1440)} 天前`; };
const bar = (p) => { const n = Math.round(Math.min(100, p) / 10); return "█".repeat(n) + "░".repeat(10 - n); };
const LABEL = { five_hour: "5 小时", seven_day: "每周", spend_limit: "花费上限", model: "单模型" };

export function status() {
  const lines = [];
  const snap = quotaSnapshot();
  lines.push("Claude Code");
  if (snap?.rateLimits) {
    for (const [k, w] of Object.entries(snap.rateLimits)) {
      if (typeof w?.used_percentage !== "number") continue;
      lines.push(`  ${(LABEL[k] || k).padEnd(6)} ${bar(w.used_percentage)} ${Math.round(w.used_percentage)}%  ${fmt(w.resets_at)} 重置`);
    }
    lines.push(`  （数据来自状态栏，${ago(snap.updatedAt)}更新；到 ${config().threshold}% 会让 Agent 先写交接文件）`);
  } else {
    lines.push("  还没有额度数据：运行 alr init 接上状态栏，再打开一次 Claude Code。");
  }
  const hits = recentLimitHits(8, 20).filter((h) => !h.transcript.includes("alr-selftest")).slice(0, 3);
  if (hits.length) {
    lines.push("  最近撞限额：");
    for (const h of hits) lines.push(`    ${fmt(h.at)}  ${LABEL[h.kind] || h.kind}限额，${fmt(h.resetsAt)} 重置`);
  }
  const cx = latestRateLimits();
  lines.push("", "Codex");
  if (cx) {
    for (const [name, w] of [["主窗口", cx.primary], ["副窗口", cx.secondary]]) {
      if (!w) continue;
      // Codex writes snake_case; older alr snapshots were camelCase
      const mins = w.window_minutes ?? w.windowMinutes, pct = w.used_percent ?? w.usedPercent, at = w.resets_at ?? w.resetsAt;
      if (typeof pct !== "number") continue;
      const span = mins >= 1440 ? `${Math.round(mins / 1440)} 天` : `${Math.round(mins / 60)} 小时`;
      lines.push(`  ${span.padEnd(6)} ${bar(pct)} ${Math.round(pct)}%  ${fmt(at)} 重置`);
    }
    lines.push(`  （套餐 ${cx.plan_type || cx.plan || "?"}，数据来自 ${ago(cx.at)}的会话日志）`);
  } else {
    lines.push("  没找到 Codex 会话日志。");
  }
  return lines.join("\n");
}
