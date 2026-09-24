// The Pro modules live in plugin/pro/ and are only present in Pro builds. Everything else must
// work without them.
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const proDir = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..", "pro");
let cached;

export async function loadPro() {
  if (cached !== undefined) return cached;
  if (process.env.ALR_NO_PRO || !fs.existsSync(path.join(proDir, "index.js"))) return (cached = null);
  try { cached = await import(path.join(proDir, "index.js")); } catch { cached = null; }
  return cached;
}
