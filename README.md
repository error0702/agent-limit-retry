# agent-limit-retry

**Keep Claude Code working through usage limits: exact reset times, a handoff file before the limit hits, and unattended runs that resume themselves.**

Node.js 18+, Claude Code ≥ 2.1.234 on a Pro/Max plan. Everything runs locally: no proxy, no account, no telemetry.

```bash
npx @autorun/agent-limit-retry    # one question, installs the plugin and taps the status line
alr selftest                      # simulated limit hit + resume against a local fake API, no quota used
alr status                        # 5-hour / 7-day usage and the recent limit hits
```

Restart Claude Code after installing. `alr init` backs up `~/.claude/settings.json` before editing it; if you
already have a custom status line it keeps it and passes the same input through. `alr uninstall` undoes everything.

## What the free version does

| | Claude Code built-in | agent-limit-retry |
|---|---|---|
| Continue the main conversation after a 5-hour reset (interactive) | ✅ | – |
| Know the exact reset time of a limit hit, and get a desktop notification | ❌ | ✅ |
| Write a handoff before the limit hits (default: at 90 % of a window) | ❌ | ✅ |
| Headless `claude -p` runs that sleep through the reset and resume the same session | ❌ | ✅ `alr run` |
| Weekly limits | ❌ | ✅ |
| Feedback report without conversation content or code | – | ✅ `alr report` |

### How it works

1. **Status line tap.** Claude Code passes the status line your plan's `rate_limits` (5-hour and 7-day
   percentages and reset times). agent-limit-retry saves them, then prints your own status line or a compact
   `⏳ 5h 62% · 7d 41%`.
2. **Handoff before the limit** (`PostToolUse` hook). Once a window passes the threshold, the agent is told to
   finish its current step and write `HANDOFF.md`: goal, what's done, what's in flight, next steps, gotchas.
   Once per window.
3. **Stop guard** (`Stop` hook). If the agent tries to end the turn without writing the handoff, it gets one
   reminder and is never blocked twice.
4. **Pick up later** (`SessionStart` hook). A new or resumed session in that project is pointed at the handoff.
5. **Limit hit** (`StopFailure` hook). The hit is recorded with its exact reset time (from the `quotaLimits`
   field in the transcript, falling back to the visible "resets 8pm (Asia/Shanghai)" text) and you get a
   desktop notification.

### Unattended runs

```bash
alr run "migrate the test suite to vitest" -- --permission-mode acceptEdits
```

Runs `claude -p`. On a usage limit, `alr run` reads the exact reset time from the session transcript, sleeps
until then (a laptop that slept through the reset carries on once it wakes), and resumes the same session with
`--resume`, telling the agent to read the handoff first. Keep the process alive in tmux or with `nohup`.

## Pro: subagents that survive the limit

When a limit hits while subagents are running, Claude Code only reports them as "failed"; the main agent then
re-dispatches them from scratch (same quota again) or forgets them, and often tries before the reset so they fail
twice. A stopped subagent keeps its full context and can be woken by id.

**agent-limit-retry Pro** finds the subagents a limit (or a crash) cut off, reads what each was doing (task,
files changed, last steps), and once the limit has actually reset tells the main agent to resume them by id.
It does the same for **Codex** (CLI + Desktop, macOS/Windows; plus an auto-continue watcher, since Codex has
none) and **ZCode** (GLM Coding Plan).

→ <https://retry.autorun.fun> — one-time purchase, source included, installs on top of this package.

## Config

`~/.agent-limit-retry/config.json`

| key | default | |
|---|---|---|
| `threshold` | `90` | percent of a window that triggers the handoff |
| `handoffFile` | `HANDOFF.md` | written in the project root (add it to `.gitignore` if you like) |
| `maxResumes` | `5` | `alr run` gives up after this many resumes |
| `resumeDelaySeconds` | `90` | extra wait after the reset time |
| `notify` | `true` | desktop notification on a limit hit |

## Notes

- API-key users have no usage windows to track; nothing happens.
- `alr report` writes a JSON file to your desktop with timestamps, event types and tool names only: no
  conversation content, no code, project paths hashed. Nothing is ever sent automatically.
- agent-limit-retry never rotates accounts or proxies traffic. It only helps you use the plan you already have.

## Development

```bash
npm test                                    # node:test, no dependencies
claude -p "..." --plugin-dir ./plugin       # try the hooks without installing
ALR_HOME=/tmp/x ALR_DEBUG=1 ...             # isolated state and hook debug events
```

MIT © autorun
