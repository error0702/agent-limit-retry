// Where agent-limit-retry keeps its own state, and where the agents keep theirs.
import os from "node:os";
import path from "node:path";
import fs from "node:fs";

export const home = () => process.env.ALR_HOME || path.join(os.homedir(), ".agent-limit-retry");
export const claudeDir = () => process.env.CLAUDE_CONFIG_DIR || path.join(os.homedir(), ".claude");
export const codexDir = () => process.env.CODEX_HOME || path.join(os.homedir(), ".codex");

export const file = (name) => path.join(home(), name);

export function readJSON(p, fallback = null) {
  try { return JSON.parse(fs.readFileSync(p, "utf8")); } catch { return fallback; }
}

export function writeJSON(p, data) {
  fs.mkdirSync(path.dirname(p), { recursive: true });
  const tmp = `${p}.${process.pid}.tmp`;           // write-then-rename: hooks run concurrently
  fs.writeFileSync(tmp, JSON.stringify(data, null, 2));
  fs.renameSync(tmp, p);
}

export function appendEvent(event) {
  const p = file("events.jsonl");
  fs.mkdirSync(path.dirname(p), { recursive: true });
  fs.appendFileSync(p, JSON.stringify({ at: Math.floor(Date.now() / 1000), ...event }) + "\n");
}

export const config = () => ({ threshold: 90, maxResumes: 5, notify: true, ...readJSON(file("config.json"), {}) });

/** How to start Claude Code on this machine. On Windows the npm install leaves a `claude.cmd`
 *  shim, which child_process can't start without a shell; run its cli.js with node instead.
 *  Returns { cmd, args } to prepend to the real arguments. */
export function claudeLauncher() {
  const override = process.env.ALR_CLAUDE_BIN;
  if (override) return { cmd: override, args: [] };
  if (process.platform !== "win32") return { cmd: "claude", args: [] };
  const dirs = (process.env.PATH || "").split(path.delimiter).filter(Boolean);
  for (const d of dirs) {
    for (const ext of [".exe", ".com"]) { const p = path.join(d, `claude${ext}`); if (fs.existsSync(p)) return { cmd: p, args: [] }; }
    const cmd = path.join(d, "claude.cmd");
    if (fs.existsSync(cmd)) {
      const cli = path.join(d, "node_modules", "@anthropic-ai", "claude-code", "cli.js");
      if (fs.existsSync(cli)) return { cmd: process.execPath, args: [cli] };
      return { cmd, args: [], shell: true };
    }
  }
  return { cmd: "claude", args: [] };
}
