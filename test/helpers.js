import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { spawnSync } from "node:child_process";

export const ROOT = path.resolve(path.dirname(new URL(import.meta.url).pathname), "..");

/** Fresh ALR_HOME + CLAUDE_CONFIG_DIR + project dir for one test. */
export function sandbox() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "relay-test-"));
  const env = { ...process.env, ALR_HOME: path.join(dir, "relay"), CLAUDE_CONFIG_DIR: path.join(dir, "claude"), CODEX_HOME: path.join(dir, "codex"), ALR_NO_WATCH: "1" };
  const project = path.join(dir, "project");
  fs.mkdirSync(project, { recursive: true });
  fs.mkdirSync(env.ALR_HOME, { recursive: true });
  return { dir, env, project };
}

export function writeQuota(env, pct, { resetsIn = 3600, updatedAgo = 0 } = {}) {
  const now = Math.floor(Date.now() / 1000);
  fs.writeFileSync(path.join(env.ALR_HOME, "claude-quota.json"), JSON.stringify({
    rateLimits: { five_hour: { used_percentage: pct, resets_at: now + resetsIn } }, updatedAt: now - updatedAgo,
  }));
}

export function hook(env, event) {
  const r = spawnSync("node", [path.join(ROOT, "plugin/scripts/hook.js")], { input: JSON.stringify(event), env: { ...env, ALR_NO_NOTIFY: "1" }, encoding: "utf8" });
  return { code: r.status, out: r.stdout ? JSON.parse(r.stdout) : null, err: r.stderr };
}
