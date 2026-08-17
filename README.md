# pi-open-tui

一个为 [Pi](https://pi.dev) coding agent 打造的精致终端界面扩展。项目综合了 `pi-haiku`、`pi-claude-code-tui`、`pi-zentui` 等社区项目中优秀的交互思路，并尽量只使用 Pi 的公开扩展 API，降低升级 Pi 时的维护成本。

![预览](assets/preview_dashboard_1.png)

## 功能概览

- **动态 Pi Logo Header**：16 帧颜色动画，并显示简洁的启动标语。
- **Starship 风格 Footer**：两行展示当前目录、Git 分支与状态、运行时、上下文占用、模型、Token 和费用等信息。
- **全宽输入框**：固定 `❯` 提示符、水平边框、多行输入对齐，并支持补全菜单向上或向下弹出。
- **60+ 运行时识别**：覆盖 Node、Rust、Go、Python、Ruby、Java、Swift、Kotlin、C/C++、Deno、Bun 等常见环境。
- **Git 状态展示**：支持分支、ahead/behind、modified、untracked、staged、stashed，以及 detached HEAD 的 commit hash/tag。
- **工作计时器**：Agent 工作时显示实时耗时，结束后显示本次完成耗时。
- **Claude 风格 Spinner**：使用 Pi 自定义 Widget 实现动画、任务/覆盖/后缀事件、Thinking 生命周期、耗时、Token 和 stall 状态。
- **Turn Telemetry**：每次完整 Agent 运行结束后展示 TPS、TTFT、stall、Token、耗时和模型标价速率。
- **公开 API 实现**：主要基于 `setHeader`、`setFooter`、`setEditorComponent`、`setWidget` 等 Pi 公共 API，不依赖 prototype patch。
- **交互式设置界面**：执行 `/open-tui`，可直接配置 General / Icons / Spinner / Footer / Telemetry。
- **Claude 风格主题**：附带可选的 `claude-theme` 深色主题，默认强调色为 `#d78787`。

## 安装

安装到 Pi：

```bash
pi install npm:pi-open-tui
```

只临时体验一次：

```bash
pi -e npm:pi-open-tui
```

## 主题

项目附带可选的 `claude-theme` 深色主题。安装完成后，打开 `/settings`，在主题列表中选择 `claude-theme` 即可。

扩展不会自动修改你当前正在使用的主题。

## 配置

执行 `/open-tui` 可打开交互式设置界面。配置文件默认保存在：

```text
~/.pi/agent/open-tui.json
```

默认配置结构如下：

```json
{
  "enabled": true,
  "settingsLanguage": "en",
  "footerScript": null,
  "editor": {
    "dynamicBorderColor": false,
    "autocompleteDirection": "up"
  },
  "icons": {
    "mode": "auto"
  },
  "footerSegments": {
    "cwd": true,
    "sessionName": false,
    "gitBranch": true,
    "gitStatus": true,
    "gitCommit": false,
    "runtime": true,
    "context": true,
    "tokens": true,
    "cost": true,
    "extensionStatuses": true,
    "timer": true
  },
  "telemetry": {
    "enabled": true,
    "tps": true,
    "ttft": true,
    "duration": true,
    "tokens": true,
    "stalls": true,
    "cost": true
  },
  "spinner": {
    "enabled": false,
    "verbose": false,
    "reducedMotion": false,
    "showThinking": true,
    "showTimer": true,
    "showTokens": true,
    "showStall": true,
    "showSuffix": true,
    "effortDisplay": "effective",
    "taskIntegration": "events",
    "suppressFooterWorkingTimer": true,
    "verbs": {
      "mode": "append",
      "values": []
    }
  }
}
```

常用配置项说明：

- `settingsLanguage`：`/open-tui` 设置界面的语言，可选 `en` 或 `zh`。
- `editor.dynamicBorderColor`：为 `false` 时输入框边框使用固定灰色；为 `true` 时水平边框会跟随 Pi 的 bash/thinking 状态颜色。
- `editor.autocompleteDirection`：补全菜单方向，`up` 表示在输入框上方弹出，`down` 表示在下方弹出。
- `icons.mode`：`auto` 自动探测 Nerd Font，`nerd` 强制 Nerd Font 图标，`ascii` 使用纯文本回退字符。
- `footerSegments.sessionName`：在 cwd 旁显示当前 session 名称；默认关闭，没有名称时自动隐藏。
- `footerSegments.gitCommit`：detached HEAD 时显示短 hash 和 tag；默认关闭。
- `footerSegments.extensionStatuses`：显示通过 Pi `setStatus()` API 发布的扩展状态，包括 MCP；关闭后整行扩展状态都不会显示。
- `footerSegments.timer`：控制内置 Footer 的工作计时和完成耗时；自定义 Footer Script 仍会收到完整 timer 数据。

## Claude 风格 Spinner

Spinner 默认关闭，可以在 `/open-tui` 的 **Spinner** 标签页中开启，也可以直接修改 `open-tui.json`。

开启后，open-tui 会隐藏 Pi 默认的普通 Working 状态行，并通过公开的 `setWidget()` API 在编辑器上方挂载一个自定义 Spinner Widget。`SpinnerController` 继续负责状态机、任务事件、Thinking、Token、计时和 stall 检测，而 Widget 只负责最终渲染和动画。

当前架构可以概括为：

```text
SpinnerStateMachine
        ↓
SpinnerController
  - requesting / thinking / responding
  - tool input / tool execution
  - task / override / suffix
  - timer / tokens / stall
        ↓
Spinner Widget Snapshot
        ↓
Pi Custom Widget
  - render(width)
  - 120ms 动画
  - stall 颜色
  - reduced motion
  - 宽度裁剪
```

普通 Agent 工作 Spinner 被 Widget 替代，但 Pi 自己的 retry、compaction 和 branch-summary 状态仍由 Pi Core 的独立 Status Indicator 显示，不会被一起隐藏。

每次 Agent run 会固定抽取一个动词，请求、Thinking、回复、流式工具参数和工具执行阶段都沿用这个动词。内置动词表目前包含 187 个词。

默认情况下，运行超过 30 秒后才开始显示耗时和 Token；设置 `verbose: true` 后会立即显示。

相关选项：

- `showTimer`：显示运行耗时。
- `showTokens`：显示 provider 上报的 input/output Token。
- `showThinking`：显示 Thinking 状态和完成耗时。
- `showSuffix`：显示外部 provider 提供的后缀信息。
- `effortDisplay: "effective"`：显示 Pi 当前实际生效的 Thinking level。
- `showStall`：长时间没有新的响应数据时，Spinner 从 accent 逐步切换到 warning/error。
- `reducedMotion: true`：停止动画，改为静态 `●`。

当以下三个条件同时成立时：

```text
spinner.enabled = true
spinner.showTimer = true
spinner.suppressFooterWorkingTimer = true
```

Footer 会隐藏重复的 working timer，但 Agent 结束后仍然会保留完成耗时。如果希望 Footer 完全不显示 timer，可以将 `footerSegments.timer` 设为 `false`。

### 自定义 Spinner 动词

`verbs.mode` 支持两种模式：

- `append`：在内置动词后追加自定义动词。
- `replace`：使用自定义动词替换内置动词。

示例：

```json
{
  "spinner": {
    "verbs": {
      "mode": "append",
      "values": ["Inspecting", "Testing"]
    }
  }
}
```

自定义值会被 trim 和去重；单项最多 64 个 Unicode code point，总数最多 256 项。包含终端控制字符或换行的值会被拒绝。`replace` 为空时自动回退到内置动词表。

一个 Agent run 内只抽样一次动词，切换 provider 不会重新抽样。

### Spinner Provider Events

其他扩展可以通过 Pi 共享 Event Bus 修改 Spinner 主消息。

#### Override

```ts
pi.events.emit("open-tui:spinner:override:v1", {
  version: 1,
  source: "my-extension",
  message: "Reviewing security",
  scope: "agent",
});

pi.events.emit("open-tui:spinner:override:v1", {
  version: 1,
  source: "my-extension",
  message: null,
});
```

`scope` 默认为 `agent`：

- `agent`：在 `agent_end` 时自动清除。
- `session`：一直保留到该 source 主动清除，或者当前 session 结束。

多个 source 同时存在时，使用最近一次写入的有效值；清除某个 source 后，会自动回退到之前仍然有效的 source。

#### Task Snapshot

任务 Provider 应发布完整 snapshot：

```ts
pi.events.emit("open-tui:spinner:tasks:v1", {
  version: 1,
  source: "my-task-provider",
  revision: 4,
  tasks: [
    {
      id: 1,
      subject: "Fix authentication",
      activeForm: "Fixing authentication",
      status: "in_progress"
    }
  ]
});
```

每个 source 的 `revision` 必须递增。Spinner 会选择第一个 `in_progress` 任务，优先显示 `activeForm`，没有时回退到 `subject`。

`pending`、`completed` 和 `deleted` 状态不会显示。设置 `taskIntegration: "off"` 可完全忽略任务 snapshot。

open-tui 不会通过分析工具参数或工具结果来猜 Todo 状态，也没有内置 Todo-tool heuristic。完整示例见 [`examples/spinner-provider.ts`](examples/spinner-provider.ts)。

Spinner 主消息优先级如下：

```text
override
→ 当前任务 activeForm
→ 当前任务 subject
→ 当前 Agent run 的随机动词
```

#### Suffix

Suffix Provider 可以追加一段纯文本 metadata，同时不改变主消息优先级：

```ts
pi.events.emit("open-tui:spinner:suffix:v1", {
  version: 1,
  source: "my-workspace-provider",
  suffix: "workspace",
  scope: "agent"
});
```

最终可能显示为：

```text
✢ Fixing authentication… (workspace · 31s · ↑ 18.4k tokens · ↓ 1.2k tokens · thinking with high effort)
```

Suffix 的 scope、source 回退规则与 override 相同。使用 `suffix: null` 只会清除当前 source。

Suffix 必须是单行纯文本，不允许终端控制字符，最大 64 个 Unicode code point。`showSuffix: false` 只隐藏当前值，并不会删除它；重新打开后会恢复最新的有效 suffix。

metadata 顺序固定为：

```text
suffix → timer → input tokens → output tokens → thinking
```

### Token 与刷新策略

Spinner 只使用 Pi/provider 实际上报的：

```text
message.usage.input
message.usage.output
```

Input 和 Output 会分别累计整个 Agent run 中所有 LLM turn。Cache read/write 继续由 Footer 单独统计，不会混进 Spinner 的 input Token。

Spinner 不会通过流式字符数量估算 Token。有些 provider 只会在最后一个 stream chunk 返回 usage，因此 Token 可能在 message 完成时一次性跳变，这是 provider 数据可用性的限制。

外层状态、计时和 stall 检测继续复用现有的 250ms working timer。Widget 自己只维护 120ms 的动画帧计时。

Controller 会对可见状态进行去重：普通 `text_delta`、`thinking_delta` 或 `toolcall_delta` 如果没有造成消息、Token、Thinking 状态、timer 或 stall 颜色变化，就不会额外触发 UI 重绘。

Widget 的 `render(width)` 会按当前终端宽度裁剪长消息，因此窄终端下不会依赖 Pi 原生 working-message 的自动换行行为。

运行时关闭 Spinner 或将 `spinner.enabled` 设置为 `false` 后，Widget 会被卸载，并恢复 Pi 默认的普通 Working 状态行。

## 自定义 Footer Script

将 `footerScript` 设置为一个可执行文件的绝对路径，可以完全替换内置 Footer。

脚本必须：

- 具有执行权限；
- 包含有效 shebang；
- 可以直接执行。

脚本会在当前项目目录下直接启动，不经过 shell command interpolation。

完整示例见 [`examples/open-tui-footer.sh`](examples/open-tui-footer.sh)。

```json
{
  "footerScript": "/home/me/.pi/agent/footer.sh"
}
```

脚本会从 stdin 收到一个 UTF-8 JSON 对象。协议 `version: 1` 包含：

- `terminal.width` 和 `time.{nowMs,nowIso}`
- `session.{cwd,name,startedAtMs}`
- `model.{id,name,provider,reasoning,thinkingLevel,contextWindow}`
- `context.{tokens,contextWindow,percent}`
- `usage.{input,output,cacheRead,cacheWrite,cost,latestCacheHitRate}`
- 完整的 `git` 状态和可选的 `runtime`
- `timer.{working,workingSinceMs,workingElapsedMs,lastDoneInMs}`
- 按扩展 id 排序后的 `extensionStatuses`

缺失值统一使用 JSON `null`。原始聊天消息、凭据和环境变量不会传给脚本。

最小脚本示例：

```sh
#!/bin/sh
payload=$(cat)
printf 'custom footer\n'
```

脚本 stdout 会直接成为 Footer，可以输出多行以及 ANSI SGR 颜色。其他终端控制序列会被移除，每一行都会按终端宽度裁剪。stdout 为空时会隐藏 Footer。

Footer Script 异步执行并带缓存。状态或终端宽度发生变化时会触发刷新；Agent 工作期间最多每秒刷新一次。脚本超时为 1000ms。

如果执行失败：

- 已经有成功结果时，继续保留最近一次成功输出；
- 从未成功时，回退到内置 Footer；
- 每个连续失败阶段只发送一次 warning。

只要 `footerScript` 不为 `null`，它的优先级始终高于所有 `footerSegments` 设置。

## Turn Telemetry

每个完整 Agent run 结束后，open-tui 会显示一条临时统计通知。包含多个 tool-call turn 的 Agent run 会聚合成一条最终结果，例如：

```text
> TPS 42.5 tok/s | ~ TTFT 1.2s | + 29.7s | ↑ 567 | ↓ 1.2k | ! stall 1x / 4.3s | $ $3.60/M
```

通知会复用 Footer 的图标模式和主题语义颜色。可以在 `/open-tui` 的 **Telemetry** 标签页分别控制：

- TPS
- TTFT
- duration
- tokens
- stalls
- cost

TPS 表示整个 Agent run 的完整生成吞吐：所有 provider 上报的 assistant output Token，除以所有 LLM turn 的生成时间总和。

计时区间从 `turn_start` 到对应 assistant `message_end`，因此会包含 TTFT、隐藏 Thinking、provider buffering 和响应 stall，使 Token 数量和计时覆盖同一个生成区间。工具执行时间不包含在 TPS 分母中。

如果没有 output Token，或者没有可测量的生成时间，则显示：

```text
TPS —
```

`stall` 段显示 stall 次数和累计 stall 时长。可选的 `$ / M` 使用模型 `usage.cost.total` 推导当前 Agent run 的标价速率，不等于 Footer 中显示的整个 session 累计费用。

## 本地开发

在仓库根目录直接加载当前扩展：

```bash
pi -e .
```

类型检查：

```bash
npm run typecheck
```

运行测试：

```bash
npm test
```

## License

MIT

## 致谢

本项目参考并吸收了多个 Pi 社区项目的设计：

- **[pi-haiku](https://github.com/nnocte/pi-haiku)**：两行 Footer 结构，以及 working timer 的交互模式。
- **[pi-claude-code-tui](https://github.com/Phoobobo/pi-claude-code-tui)**：16 帧 Pi Logo 动画和圆角输入框设计思路。
- **[pi-zentui](https://github.com/lmilojevicc/pi-zentui)**：Starship 风格 Footer、Git 状态、运行时识别、上下文 gauge、基于 generation 的 session 生命周期和交互式设置界面。
- **[pi-tps](https://github.com/monotykamary/pi-tps)**：turn timing、stall 检测以及偏保守的 TPS 计算方式。

动态 Logo 帧来自 `pi-claude-code-tui` 的实现思路，而它又源自 Pi 官方安装脚本中的 Logo。运行时识别列表和 Git porcelain 解析结构参考了 `pi-zentui`。

特别感谢 **[LINUX DO](https://linux.do)** 社区的支持。
