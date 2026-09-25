# agent-limit-retry

**让 Claude Code 扛过额度限制。** 撞限额时拿到精确的重置时间；快用完时先写交接文件；无人值守任务撞了限额自己睡到重置再接着跑。

[English](README.md) · Pro 版：<https://retry.autorun.fun>

```bash
npx agent-limit-retry    # 回答一个问题，装好插件并接上状态栏
alr selftest                      # 本地假接口模拟一次撞限额 + 自动续跑，不花额度
alr status                        # 5 小时 / 每周窗口、重置时间、最近撞限额记录
```

![alr selftest and alr status](docs/assets/alr.png)

装完重启一次 Claude Code。全部在本机运行：不走代理、不需要账号、没有遥测、不检查更新。

## 为什么

Pro/Max 套餐有 5 小时窗口和每周窗口，撞上的时候从来不挑时候。Claude Code 自带的 auto-continue 能覆盖的比看上去少：
只续跑**主对话**、只在**交互式**会话里、只在重置**不到 24 小时**时。无人值守的 `claude -p`、周限额、撞限额那一刻正在做的事，它都不管。

agent-limit-retry 只读 Claude Code 本来就写下的东西（传给状态栏的 `rate_limits`、transcript 里的 `quotaLimits.resetsAt`），把这些缺口补上。

| | Claude Code 自带 | agent-limit-retry |
|---|---|---|
| 5 小时重置后续跑主对话（交互式） | ✅ | – |
| 撞限额的精确重置时间 + 桌面通知 | ❌ | ✅ |
| 限额到之前（窗口用到 90%）先写交接文件 | ❌ | ✅ |
| 无人值守的 `claude -p`：睡到重置，续跑同一个会话 | ❌ | ✅ `alr run` |
| 周限额 | ❌ | ✅ |
| 被限额杀掉的子 Agent 按 ID 叫醒，不重新派发 | ❌ | [Pro](https://retry.autorun.fun) |

## 原理

一个 Claude Code 插件里的四个 hook，加一个状态栏转接。你和 API 之间没有任何中间层。

1. **状态栏转接**：Claude Code 会把套餐的 `rate_limits`（5 小时/7 天的百分比和重置时间）传给状态栏。alr 存下来，再原样输出你自己的状态栏；没有的话显示 `⏳ 5h 62% · 7d 41%`。
2. **提前交接**（`PostToolUse`）：某个窗口过了阈值，让 Agent 做完当前一步就写 `HANDOFF.md`：目标、已完成、进行中、下一步、坑。每个窗口只提醒一次。
3. **收尾保护**（`Stop`）：Agent 想在没写交接文件的情况下结束，提醒一次；绝不拦第二次。
4. **接着干**（`SessionStart`）：这个项目里新开或恢复的会话会被指向交接文件。
5. **撞限额**（`StopFailure`）：记下精确重置时间，发桌面通知（macOS / Linux / Windows）。

### 无人值守

```bash
alr run "把测试迁移到 vitest" -- --permission-mode acceptEdits
```

跑的是 `claude -p`。撞限额后 `alr run` 从 transcript 里读出精确的重置时间，睡到那个点（笔记本合盖睡过去也没事，醒来接着算），再用 `--resume` 续跑同一个会话，并让 Agent 先读交接文件。周限额同样处理。放在 tmux 或 `nohup` 里跑。`--max-resumes` 限制次数（默认 5）。

## Pro：子 Agent 断点续跑

限额撞上的时候主 Agent 正开着几个并行子 Agent，它们会一起失败。每个子 Agent 的完整上下文都还在磁盘上，可以按 ID 叫醒。但重置后主 Agent 几乎从不这么做：要么把同样的任务从头再派一遍（额度再花一次），要么直接忘了；还经常在重置**之前**就去叫，于是再失败一次。

**Pro** 找出被限额（或崩溃）打断的子 Agent，读出各自做到哪一步（任务、改过的文件、最后几步），等限额真的重置之后告诉主 Agent 按 ID 续跑。Claude Code 自己已经处理的情况，它一句话不说。**Codex**（CLI + 桌面版，macOS/Windows，另加一个自动续跑 watcher，因为 Codex 没有 auto-continue）和 **ZCode**（GLM 编程套餐）同样支持。

→ **<https://retry.autorun.fun>** · 一次性付费，完整源码，直接装在这个包上面。

## 配置

`~/.agent-limit-retry/config.json`

| 键 | 默认 | |
|---|---|---|
| `threshold` | `90` | 窗口用到多少 % 触发交接 |
| `handoffFile` | `HANDOFF.md` | 写在项目根目录（可以加进 `.gitignore`） |
| `maxResumes` | `5` | `alr run` 最多续跑几次 |
| `resumeDelaySeconds` | `90` | 重置时间之后再多等几秒 |
| `notify` | `true` | 撞限额 / 写好交接文件时发桌面通知 |

## 常见问题

**要我的 API key 或账号吗？** 不要。只读 Claude Code 写在本机的文件（`~/.claude/projects/**/*.jsonl`）和它喂给状态栏的 JSON。

**会改我的设置吗？** `alr init` 改 `~/.claude/settings.json` 之前先备份，已有的状态栏保留并原样传入。`alr uninstall` 全部还原。

**要求。** Node.js 18+，Claude Code ≥ 2.1.234，Pro 或 Max 套餐。API key 用户没有额度窗口，什么都不会发生。

**有东西离开我的机器吗？** 没有。`alr report` 在桌面上生成一个 JSON，只有时间戳、事件类型、工具名（没有对话内容、没有代码，项目路径做过哈希），报 bug 时你手动发。

**能提高额度或者轮换账号吗？** 不能，也永远不会做。它只帮你用好已经付了钱的套餐。

## 更新记录

- **0.4.3** — `alr run` / `alr selftest` 失败时会打印 Claude Code 的原话（比如"未登录"），不再只给一个退出码；自检说明只覆盖 Claude Code。
- **0.4.2** — Windows：`alr selftest` / `alr report` 拼出的路径是 `/C:/...`，自检启动不了带插件的 Claude Code；`alr run` / `alr init` 现在也能正确启动 npm 装的 `claude.cmd`。
- **0.4.1** — 默认英文界面（中文 locale 或 `ALR_LANG=zh` 时显示中文）；README 加截图。
- **0.4.0** — 首个公开版本：开源核心与 Pro 拆分，发布到 npm（包名 `agent-limit-retry`）。

## 开发

```bash
npm test                                    # node:test，零依赖
claude -p "..." --plugin-dir ./plugin       # 不安装直接试 hooks
ALR_HOME=/tmp/x ALR_DEBUG=1 alr ...         # 隔离状态 + hook 调试事件
```

欢迎 issue 和 PR。某次撞限额没处理好的话，附上 `alr report` 的输出。

MIT © autorun
