// When to ask the agent for a handoff, and what to say.
import fs from "node:fs";
import path from "node:path";
import { config, file, readJSON, writeJSON } from "./paths.js";

export const MARKER = "<!-- agent-limit-retry handoff -->";
const FRESH_SECONDS = 15 * 60;   // ignore quota snapshots older than this

export const handoffPath = (cwd) => path.join(cwd, config().handoffFile || "HANDOFF.md");

const LABEL = { five_hour: "5 小时", seven_day: "每周", spend_limit: "花费上限" };
const clock = (t) => new Date(t * 1000).toLocaleString("zh-CN", { month: "numeric", day: "numeric", hour: "2-digit", minute: "2-digit" });

/** The most-used window in a status-line snapshot, if it's fresh: { kind, pct, resetsAt }. */
export function hottestWindow(snap, now = Math.floor(Date.now() / 1000)) {
  if (!snap || now - (snap.updatedAt || 0) > FRESH_SECONDS) return null;
  let best = null;
  for (const kind of ["five_hour", "seven_day", "spend_limit"]) {
    const w = snap.rateLimits?.[kind];
    if (!w || typeof w.used_percentage !== "number") continue;
    if (w.resets_at && w.resets_at <= now) continue;     // window already rolled over
    if (!best || w.used_percentage > best.pct) best = { kind, pct: w.used_percentage, resetsAt: w.resets_at };
  }
  return best;
}

export function handoffRequest(win, cwd) {
  return [
    `[agent-limit-retry] ${LABEL[win.kind] || win.kind}额度已用 ${Math.round(win.pct)}%` +
      (win.resetsAt ? `，${clock(win.resetsAt)} 重置` : "") + "，很快会被打断。",
    "做完手上这一步就停下，不要开始新的子任务。然后把交接信息写进 " +
      `${handoffPath(cwd)}（覆盖旧内容），第一行必须是 ${MARKER}，接着写：`,
    "1. 目标：原始任务是什么  2. 已完成：改了哪些文件、做到哪一步  3. 进行中：没做完的部分，包括正在跑的子代理和它们的任务",
    "4. 下一步：按顺序列出，另一个 Agent 照着就能接着做  5. 注意：坑、未验证的假设、不要重复做的事",
    "写完再结束这一轮。",
  ].join("\n");
}

export const STOP_REMINDER = (cwd) =>
  `[agent-limit-retry] 额度快用完了，结束前还没写交接文件。请按之前的要求把交接信息写进 ${handoffPath(cwd)}，第一行是 ${MARKER}。`;

export const RESUME_PROMPT = (cwd) =>
  `你之前的任务因为额度用完被中断了，现在额度已经恢复。如果 ${handoffPath(cwd)} 存在，先读它；` +
  "然后从中断的地方继续完成原任务，不要重复已经完成的部分。";

export const SESSION_START_NOTE = (p) =>
  `[agent-limit-retry] ${p} 里有上一个会话因为额度中断留下的交接信息。如果用户要继续那个任务，先读它再动手。`;

/** Is there a handoff written by an agent at/after `since` (unix s)? */
export function handoffWritten(cwd, since = 0) {
  const p = handoffPath(cwd);
  try {
    const st = fs.statSync(p);
    return st.mtimeMs / 1000 >= since && fs.readFileSync(p, "utf8").includes(MARKER);
  } catch { return false; }
}

// Per-session memory: have we already asked this session for a handoff in this window?
const sessionFile = (id) => file(path.join("sessions", `${id}.json`));
export const sessionState = (id) => readJSON(sessionFile(id), {});
export const saveSessionState = (id, s) => writeJSON(sessionFile(id), s);
