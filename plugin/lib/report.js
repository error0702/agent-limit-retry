// `alr report`: a feedback file a tester can send back after hitting a limit.
// It answers one question - after a usage limit cut subagents off, did the main agent resume them
// by id or re-dispatch them? - without shipping anyone's code or conversation:
//   * no message text, no tool inputs, no file contents
//   * project paths and task descriptions are hashed (same task => same hash, so a re-dispatch
//     of the same work is still visible)
import crypto from "node:crypto";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { spawnSync } from "node:child_process";
import { claudeDir, config, file, readJSON } from "./paths.js";
import { findTranscript, recentLimitHits } from "./claude.js";
import { loadPro } from "./pro-loader.js";
import { t } from "./i18n.js";

const hash = (s) => (s ? crypto.createHash("sha1").update(String(s)).digest("hex").slice(0, 8) : null);
const ts = (d) => (d?.timestamp ? Math.floor(Date.parse(d.timestamp) / 1000) : null);

function readLines(p) {
  try { return fs.readFileSync(p, "utf8").split("\n").filter(Boolean).map((l) => { try { return JSON.parse(l); } catch { return null; } }).filter(Boolean); }
  catch { return []; }
}

/** Redacted timeline of a main session between `from` and `to` (unix s). */
function timeline(transcript, from, to) {
  const out = [];
  for (const d of readLines(transcript)) {
    const t = ts(d);
    if (!t || t < from || t > to) continue;
    const c = d.message?.content;
    const e = { t, type: d.type };
    if (d.error) e.error = d.error;
    if (d.quotaLimits) e.quota = { type: d.quotaLimits.rateLimitType, resetsAt: d.quotaLimits.resetsAt };
    if (d.type === "user" && typeof c === "string") {
      if (c.includes("<task-notification>")) {
        e.notice = {
          status: (/<status>([^<]+)</.exec(c) || [])[1],
          ids: [...c.matchAll(/<task-id>([^<]+)</g)].map((m) => m[1]),
          kind: /didn't finish before the previous session ended/.test(c) ? "unfinished_after_quit"
            : /hit your|limit/i.test(c) ? "failed_on_limit" : /finished|completed/i.test(c) ? "finished" : "other",
        };
      } else {
        e.prompt = { chars: c.length, isContinue: /^(continue|继续|接着)/i.test(c.trim()) || /continue from where you left off/i.test(c) };
      }
    }
    if (Array.isArray(c)) {
      const tools = c.filter((b) => b?.type === "tool_use").map((b) => {
        const x = { name: b.name };
        if (b.name === "SendMessage") x.to = String(b.input?.to || "").replace(/^agent-/, "");
        if (b.name === "Agent" || b.name === "Task") x.task = hash(b.input?.description);
        return x;
      });
      if (tools.length) e.tools = tools;
    }
    if (d.type === "attachment") {
      const a = d.attachment || {};
      const ours = JSON.stringify(a).includes("agent-limit-retry");
      if (!ours && !a.hookEvent) continue;
      const m = ours ? JSON.stringify(a).match(/有 (\d+) 个子 Agent|(\d+) subagent\(s\) were cut off/) : null;
      e.hook = { event: a.hookEvent || null, ours, agents: m ? m[1] || m[2] : null };
    }
    out.push(e);
  }
  return out;
}

/** Only the subagents that matter for the question: the ones a limit killed, and the ones
 *  started after the first hit (a re-dispatch shows up there with the same task hash). */
function subagents(pro, transcript, from, to, firstHit) {
  if (!pro) return [];
  const { inspect, subagentDir } = pro.subagents;
  const dir = subagentDir(transcript);
  let names = [];
  try { names = fs.readdirSync(dir).filter((n) => n.endsWith(".jsonl")); } catch { return []; }
  const out = [];
  for (const n of names) {
    const p = path.join(dir, n);
    const mt = fs.statSync(p).mtimeMs / 1000;
    if (mt < from) continue;
    const meta = readJSON(p.replace(/\.jsonl$/, ".meta.json"), {});
    const lines = readLines(p);
    const s = inspect(p, meta);
    const limitErrors = lines.filter((d) => d.error === "rate_limit").map(ts);
    const firstAt = ts(lines[0]);
    if (!limitErrors.length && !(firstHit && firstAt >= firstHit && firstAt <= to)) continue;
    out.push({
      id: n.replace(/^agent-|\.jsonl$/g, ""), task: hash(meta.description), type: meta.agentType || null,
      entries: lines.length, firstAt: ts(lines[0]), lastAt: ts(lines[lines.length - 1]),
      limitErrorsAt: limitErrors, finished: !s, cause: s?.cause || null,
      activityAfterLastLimit: limitErrors.length ? lines.filter((d) => ts(d) > limitErrors[limitErrors.length - 1]).length : null,
    });
  }
  return out.sort((a, b) => (a.firstAt || 0) - (b.firstAt || 0));
}

export async function report(outDir) {
  const pro = await loadPro();
  const pkg = readJSON(new URL("../../package.json", import.meta.url).pathname, {});
  const events = readLines(file("events.jsonl")).map((e) => ({ ...e, cwd: e.cwd ? `proj-${hash(e.cwd)}` : undefined }));
  const sessionIds = [...new Set(events.filter((e) => e.session && /limit_hit|resume_noted|run_/.test(e.type)).map((e) => e.session))];
  // Sessions that hit a limit since the plugin was installed (even if it never fired - that's a
  // finding too), plus the 3 most recent from before as a baseline.
  const since = config().installedAt || 0;
  const hits = recentLimitHits(30, 200).filter((h) => h.session && !h.sidechain && !h.transcript.includes("alr-selftest"));
  const after = [...new Set(hits.filter((h) => h.at >= since).map((h) => h.session))];
  const before = [...new Set(hits.filter((h) => h.at < since).map((h) => h.session))].slice(0, 3);
  for (const id of [...after, ...before]) if (!sessionIds.includes(id)) sessionIds.push(id);

  const sessions = [];
  for (const id of sessionIds.slice(0, 15)) {
    const t = findTranscript(id);
    if (!t) continue;
    const lines = readLines(t);
    const hits = lines.filter((d) => d.type === "assistant" && d.error === "rate_limit").map(ts).filter(Boolean);
    if (!hits.length && !events.some((e) => e.session === id)) continue;
    const from = (hits[0] || ts(lines[0]) || 0) - 3600;
    const to = (hits[0] || from) + 6 * 3600;
    sessions.push({
      afterInstall: hits.length ? hits[hits.length - 1] >= since : null,
      session: id, project: `proj-${hash(path.dirname(t))}`, claudeVersion: [...lines].reverse().find((d) => d.version)?.version || null,
      limitHitsAt: hits, timeline: timeline(t, from, to).slice(0, 4000), subagents: subagents(pro, t, from, to, hits[0]).slice(0, 400),
      pluginState: readJSON(file(path.join("sessions", `${id}.json`)), null),
    });
  }
  const settings = readJSON(path.join(claudeDir(), "settings.json"), {});
  const data = {
    about: t("agent-limit-retry feedback. Contains only timestamps, event types, tool names and subagent IDs/status; no conversation content, code or file contents. Project paths and task descriptions are hashed.",
      "agent-limit-retry 测试反馈。只有时间、事件类型、工具名、子 Agent ID/状态；不含对话内容、代码、文件内容。项目路径和任务描述已做哈希。"),
    createdAt: Math.floor(Date.now() / 1000),
    versions: {
      alr: pkg.version, claude: (spawnSync("claude", ["--version"], { encoding: "utf8" }).stdout || "").trim(),
      node: process.version, os: `${os.platform()} ${os.release()}`,
    },
    install: {
      pluginEnabled: /agent-limit-retry[\s\S]{0,200}enabled/.test(spawnSync("claude", ["plugin", "list"], { encoding: "utf8" }).stdout || ""),
      statusLineTapped: /statusline\.js/.test(settings.statusLine?.command || ""),
      quotaSnapshotAgeSec: (() => { const q = readJSON(file("claude-quota.json")); return q ? Math.floor(Date.now() / 1000) - q.updatedAt : null; })(),
      config: config(),
    },
    events, sessions,
  };
  const dir = outDir || (fs.existsSync(path.join(os.homedir(), "Desktop")) ? path.join(os.homedir(), "Desktop") : process.cwd());
  const out = path.join(dir, `alr-report-${new Date().toISOString().slice(0, 16).replace(/[-:T]/g, "")}.json`);
  fs.writeFileSync(out, JSON.stringify(data, null, 1));
  const subs = sessions.reduce((n, s) => n + s.subagents.length, 0);
  console.log(t(`Feedback file: ${out}
  Contains ${sessions.length} sessions that hit a limit, the status of ${subs} subagents, and ${events.length} plugin events.
  No conversation content or code; feel free to open it before sending. Just send this file to the author.`, `反馈文件：${out}
  包含 ${sessions.length} 个撞过额度的会话、${subs} 个子 Agent 的状态、${events.length} 条插件事件。
  不含对话内容和代码，发之前可以打开看一眼。把这个文件发给作者就行。`));
  return 0;
}
