// `alr run`: a headless Claude Code task that survives usage limits.
// Claude Code's own auto-continue only covers interactive sessions and resets < 24h away;
// this covers `-p` runs, background jobs, and weekly limits.
import { spawn } from "node:child_process";
import { appendEvent, config, claudeLauncher } from "./paths.js";
import { findTranscript, lastLimitHit, parseResetText } from "./claude.js";
import { RESUME_PROMPT } from "./handoff.js";
import { notify } from "./notify.js";
import { loadPro } from "./pro-loader.js";
import { t, zh } from "./i18n.js";

const LIMIT_TEXT = /hit your .*limit|usage limit|reached your .*limit/i;
const now = () => Math.floor(Date.now() / 1000);
const fmt = (at) => new Date(at * 1000).toLocaleString(zh ? "zh-CN" : "en-US", { month: "numeric", day: "numeric", hour: "2-digit", minute: "2-digit" });

function runClaude(args, log) {
  const launcher = claudeLauncher();
  const bin = launcher.cmd;
  return new Promise((resolve) => {
    const child = spawn(bin, [...launcher.args, ...args], { stdio: ["ignore", "pipe", "inherit"], shell: !!launcher.shell, windowsHide: true });
    let out = "";
    child.stdout.on("data", (d) => { out += d; });
    child.on("error", (e) => { log(t(`Cannot start ${bin}: ${e.message}`, `无法启动 ${bin}: ${e.message}`)); resolve({ code: 127, result: null }); });
    child.on("close", (code) => {
      // --output-format json prints one JSON object; take the last parseable line.
      let result = null;
      for (const line of out.trim().split("\n").reverse()) {
        try { result = JSON.parse(line); break; } catch { /* not JSON */ }
      }
      resolve({ code, result, raw: out });
    });
  });
}

/** Did this run stop on a usage limit? Returns { kind, resetsAt } or null. */
export function detectLimit(res, startedAt) {
  const r = res.result || {};
  if (res.code === 0 && r.is_error === false) return null;   // a clean finish is never a limit hit
  const text = typeof r.result === "string" ? r.result : res.raw || "";
  // Transcript first: it carries the exact reset time. A resumed session's transcript still
  // holds the *previous* hit, so only count one recorded after this run started.
  if (r.session_id) {
    const t = findTranscript(r.session_id);
    const hit = t && lastLimitHit(t);
    if (hit && hit.at >= startedAt - 1) return { kind: hit.kind, resetsAt: hit.resetsAt };
  }
  if ((r.is_error || res.code !== 0) && LIMIT_TEXT.test(text)) {
    return { kind: /weekly/i.test(text) ? "seven_day" : "five_hour", resetsAt: parseResetText(text) };
  }
  return null;
}

/** Sleep until `t` (unix s). Checks the wall clock in short steps, so a laptop that slept
 *  through the reset wakes up and continues instead of waiting out the remaining timer. */
async function sleepUntil(t, onTick) {
  while (now() < t) {
    onTick?.(t - now());
    await new Promise((r) => setTimeout(r, Math.min(30, Math.max(1, t - now())) * 1000));
  }
}

export async function run({ prompt, extraArgs = [], maxResumes, cwd = process.cwd(), log = console.error, quiet = false, agent = "claude" }) {
  if (agent === "codex") {
    const pro = await loadPro();
    if (!pro) { log(t("Unattended Codex resume is part of Pro: https://retry.autorun.fun", "Codex 的无人值守续跑属于 Pro 版：https://retry.autorun.fun")); return 2; }
    return pro.codexrun.run({ prompt, extraArgs, maxResumes, cwd, log, quiet });
  }
  const cfg = config();
  maxResumes ??= cfg.maxResumes;
  const delay = cfg.resumeDelaySeconds ?? 90;          // reset times are approximate; don't race them
  let sessionId = null;
  let lastCutAt = 0;
  for (let attempt = 0; ; attempt++) {
    const startedAt = now();
    const pro = sessionId ? await loadPro() : null;
    const cutSubagents = pro ? pro.subagents.resumeInstructions(pro.subagents.interrupted(findTranscript(sessionId), lastCutAt - 30 * 60), cwd) : "";
    const args = sessionId
      ? ["-p", "--resume", sessionId, [RESUME_PROMPT(cwd), cutSubagents].filter(Boolean).join("\n\n"), "--output-format", "json", ...extraArgs]
      : ["-p", prompt, "--output-format", "json", ...extraArgs];
    const res = await runClaude(args, log);
    sessionId = res.result?.session_id || sessionId;
    const hit = detectLimit(res, startedAt);
    if (!hit) {
      appendEvent({ type: "run_finished", session: sessionId, cwd, attempts: attempt + 1, ok: res.code === 0 });
      if (res.result?.result && !quiet) process.stdout.write(res.result.result + "\n");
      return res.code ?? 1;
    }
    if (attempt >= maxResumes) {
      log(t(`[agent-limit-retry] Still hitting the limit after ${attempt} resumes; giving up. Session ${sessionId}`, `[agent-limit-retry] 已续跑 ${attempt} 次仍然撞限额，停止。会话 ${sessionId}`));
      return 3;
    }
    lastCutAt = now();
    const resetsAt = hit.resetsAt || now() + 5 * 3600;     // unknown reset: assume a 5-hour window
    const wakeAt = resetsAt + delay;
    appendEvent({ type: "run_waiting", session: sessionId, cwd, kind: hit.kind, resetsAt, wakeAt });
    log(t(`[agent-limit-retry] Usage limit hit (${hit.kind}); session ${sessionId} resumes automatically at ${fmt(wakeAt)}. `, `[agent-limit-retry] 额度用完（${hit.kind}），会话 ${sessionId} 将在 ${fmt(wakeAt)} 自动续跑。`) +
        t("Keep this process running (tmux / nohup is fine).", "保持这个进程运行（可以放在 tmux / nohup 里）。"));
    if (cfg.notify) notify(t("agent-limit-retry: task paused", "agent-limit-retry：任务暂停"), t(`Usage limit hit; resumes at ${fmt(wakeAt)}`, `额度用完，${fmt(wakeAt)} 自动续跑`));
    let lastMsg = 0;
    await sleepUntil(wakeAt, (left) => {
      if (now() - lastMsg >= 1800) { lastMsg = now(); log(t(`[agent-limit-retry] ${Math.ceil(left / 60)} more minutes to wait`, `[agent-limit-retry] 还要等 ${Math.ceil(left / 60)} 分钟`)); }
    });
    log(t(`[agent-limit-retry] Quota reset; resuming session ${sessionId} (attempt ${attempt + 1})`, `[agent-limit-retry] 额度已重置，续跑会话 ${sessionId}（第 ${attempt + 1} 次）`));
  }
}

