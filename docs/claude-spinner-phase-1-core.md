# Claude-like Spinner Phase 1: 核心状态与渲染

## 1. 阶段定位

本阶段建立 Claude-like spinner 的稳定内核，包括自定义 TUI 组件、运行状态机、基础动画、Thinking 生命周期、timer/token metadata、宽度降级、stall 检测和完整清理逻辑。

本阶段完成后，启用配置时应得到如下核心体验：

```text
✻ Working…
✻ Working… (thinking with high effort)
✻ Working… (31s · ↑ 18.4k tokens · ↓ 1.2k tokens)
✻ Working… (42s · ↑ 24.8k tokens · ↓ 3.2k tokens · thought for 4s)
```

阶段状态：待实施。

前置依赖：无。

后续依赖：Phase 2 和 Phase 3 都依赖本阶段定义的状态模型、事件分类和渲染接口。

## 2. 成功标准

本阶段不是只替换 `setWorkingIndicator()` 的字符帧。完成标准是：

1. 使用公开 pi API 接管正常 streaming working row。
2. 不修改、导入或 monkey-patch pi 内部实现。
3. 正确区分 `requesting`、`thinking`、`responding`、`tool-input`、`tool-use`。
4. Thinking 状态满足最短展示和完成态保留时序。
5. timer/token metadata 按 30 秒和 verbose 规则出现。
6. metadata 根据终端宽度逐级降级，不发生无控制换行。
7. stall 检测在并行工具执行期间不会误报。
8. retry、compaction 和 branch summary loader 继续由 pi 核心显示。
9. 插件禁用、reload、session replacement 和 shutdown 后不残留 timer、widget 或隐藏状态。
10. 所有时间、随机和终端判断都可注入，单元测试不依赖真实等待。

## 3. 范围

### 3.1 本阶段包含

- 自定义 spinner widget。
- 内置 working row 的隐藏和恢复。
- 单轮稳定的随机默认 verb。
- Unicode 省略号 `…`。
- 平台相关 glyph 集和 ping-pong 动画。
- `requesting`、`thinking`、`responding`、`tool-input`、`tool-use` mode。
- Thinking 状态机。
- effective thinking level 文案。
- elapsed timer。
- 仅基于公开 provider usage 的 token 统计。
- 普通 response delta 不触发 token 更新，避免高频 working-message 重绘。
- `↑ input` / `↓ output` 分离显示。
- metadata 顺序和 separator。
- Progressive Width Gating。
- stall 检测和基础颜色状态。
- reduced-motion 渲染能力。
- 最小持久化配置，用于安全启用和回退。
- 单元测试、组件测试和生命周期测试。

### 3.2 本阶段不包含

- 187 个完整 verbs 以及 append/replace 配置。
- Todo `activeForm`、`subject` 和 `Next:`。
- 外部 override message 协议。
- footer working timer 去重。
- 设置界面的 Spinner tab。
- 主文案 glimmer。
- thinking shimmer。
- tool-use flash。
- `Tip:` 和 `Target:`。
- Brief 模式。
- reconnect/disconnected 和 background task 计数。
- 对 pi retry/compaction loader 的定制。

这些项目分别进入 Phase 2 或 Phase 3。

## 4. 核心设计决策

### 4.1 使用自定义 widget，不拼接内置 working message

安装时使用：

```ts
ctx.ui.setWorkingVisible(false);
ctx.ui.setWidget(
  "open-tui-spinner",
  (tui, theme) => new OpenTuiSpinnerComponent(tui, theme, controller),
  { placement: "aboveEditor" },
);
```

原因：

- `setWorkingIndicator()` 只能配置 glyph frames。
- 反复调用 `setWorkingIndicator()` 会重置内置动画帧。
- `setWorkingMessage()` 没有承诺 ANSI、多行和完整布局控制。
- widget 的 `render(width)` 能获得准确可用宽度。
- widget 能返回额外行，为 Phase 2/3 的 `Next:`、`Tip:`、`Target:` 留出空间。
- `setWorkingVisible(false)` 只隐藏 normal working row，不会隐藏 retry 和 compaction loader。

### 4.2 Controller 与 Component 分离

`SpinnerController` 负责事件和时间状态；`OpenTuiSpinnerComponent` 只负责将状态渲染成字符串数组。

禁止在 `render()` 内产生业务状态变更。这样可以保证：

- 重复 render 是幂等的。
- 宽度变化不会改变运行状态。
- 测试可直接输入 state 和 width。
- Phase 3 可以替换颜色动画而不改变事件状态机。

### 4.3 使用单个动画调度器

运行期间只允许一个 interval。基础 tick 建议为 50ms，以兼容 token 追赶逻辑；仅当可见输出或动画相位变化时调用 `tui.requestRender()`。

停止条件：

- `agent_end`
- `session_before_compact`
- `session_shutdown`
- 插件禁用
- widget dispose

不得为 glyph、token、thinking 分别创建独立 interval。

### 4.4 时间与随机必须注入

定义：

```ts
export interface SpinnerClock {
  now(): number;
}

export interface SpinnerRandom {
  pick<T>(items: readonly T[]): T;
}
```

生产环境使用 monotonic clock，例如 `performance.now()`。测试使用 fake clock，不使用真实 `setTimeout()` 等待状态转换。

## 5. 文件级改动

### 5.1 新增文件

```text
extensions/open-tui/spinner.ts
extensions/open-tui/spinner-state.ts
extensions/open-tui/spinner-render.ts
extensions/open-tui/spinner-verbs.ts
tests/spinner-state.test.ts
tests/spinner-render.test.ts
tests/spinner-lifecycle.test.ts
```

职责建议：

| 文件 | 职责 |
|---|---|
| `spinner.ts` | 安装/卸载、controller、TUI component、timer 生命周期 |
| `spinner-state.ts` | 类型、事件 reducer、Thinking/stall/token 状态机 |
| `spinner-render.ts` | 纯渲染、宽度预算、metadata 拼装、glyph 选择 |
| `spinner-verbs.ts` | Phase 1 的小型默认 verb 集和稳定抽取函数 |
| `spinner-state.test.ts` | fake clock 驱动的状态机测试 |
| `spinner-render.test.ts` | 不同宽度和 mode 的纯渲染测试 |
| `spinner-lifecycle.test.ts` | pi UI mock、安装、事件接线和清理测试 |

### 5.2 修改文件

```text
extensions/open-tui/config.ts
extensions/open-tui/index.ts
package.json
README.md
```

修改说明：

- `config.ts`：加入最小 spinner 配置和运行时校验。
- `index.ts`：安装 spinner，并向 controller 转发生命周期事件。
- `package.json`：将三个新测试加入 `npm test`。
- `README.md`：记录实验性配置、行为边界和回退方式。

## 6. 配置设计

Phase 1 只增加运行所需的最小配置：

```ts
export interface SpinnerConfig {
  enabled: boolean;
  verbose: boolean;
  reducedMotion: boolean;
}

export interface OpenTuiConfig {
  // existing fields...
  spinner: SpinnerConfig;
}
```

建议默认值：

```json
{
  "spinner": {
    "enabled": false,
    "verbose": false,
    "reducedMotion": false
  }
}
```

默认关闭的原因：Phase 1 尚未提供设置界面，先避免升级后无提示接管用户现有 working row。实现和验收时通过 `~/.pi/agent/open-tui.json` 手动启用。Phase 2 提供交互设置后，再单独决定是否调整新安装的默认值。

`loadConfig()` 必须逐项校验 boolean。旧配置缺少 `spinner` 时由现有 `deepMerge()` 补齐，不能报错或覆盖其他配置。

## 7. 状态模型

### 7.1 Mode

```ts
export type SpinnerMode =
  | "requesting"
  | "thinking"
  | "responding"
  | "tool-input"
  | "tool-use";
```

默认 mode：`requesting`。

事件映射：

| 事件 | Mode 变化 |
|---|---|
| `agent_start` | 初始化为 `requesting` |
| `turn_start` | `requesting` |
| `thinking_start` / `thinking_delta` | `thinking` |
| `text_start` / `text_delta` | `responding` |
| `toolcall_start` / `toolcall_delta` | `tool-input` |
| 第一个 `tool_execution_start` | `tool-use` |
| 最后一个 `tool_execution_end` | 保持 `tool-use`，直到下一次 `turn_start` |

不根据 tool 名称判断 mode。

### 7.2 Runtime state

建议最小状态：

```ts
export interface SpinnerRuntimeState {
  active: boolean;
  mode: SpinnerMode;
  agentStartedAtMs: number | null;
  turnStartedAtMs: number | null;

  randomVerb: string;

  inputTokens: number;
  outputTokens: number;
  completedInputTokens: number;
  completedOutputTokens: number;
  currentInputTokens: number;
  currentOutputTokens: number;
  lastResponseAtMs: number | null;

  activeToolIds: Set<string>;

  thinkingStartedAtMs: number | null;
  thinkingEndedAtMs: number | null;
  thinkingActualDurationMs: number | null;
  thinkingPhase: "none" | "thinking" | "holding-thinking" | "thought";
  thinkingPhaseUntilMs: number | null;

  effectiveEffort: string | null;
  stalledIntensity: number;
}
```

`Set` 不可直接 JSON 序列化，但它只属于内存运行态，不进入配置或 session。

### 7.3 单轮稳定 verb

Phase 1 使用小型中性集合，例如：

```ts
export const CORE_SPINNER_VERBS = [
  "Working",
  "Thinking",
  "Processing",
  "Building",
  "Checking",
] as const;
```

只在 `agent_start` 抽取一次。同一 agent run 内的 mode、tool turn 和动画帧变化都不得重新抽取。

Phase 2 会替换为完整 verbs 和 append/replace 策略，因此 Phase 1 的 controller 应通过 `getVerbs()` 依赖获取列表，不要直接 import 常量后写死。

## 8. Thinking 状态机

常量：

```ts
const MIN_THINKING_VISIBLE_MS = 2000;
const THOUGHT_VISIBLE_MS = 2000;
```

### 8.1 开始

收到 `thinking_start`：

1. 记录 `thinkingStartedAtMs = now`。
2. `thinkingPhase = "thinking"`。
3. 清除上一次 `thinkingEndedAtMs` 和 duration。
4. mode 设为 `thinking`。

如果 provider 不发送 `thinking_start`，第一次非空 `thinking_delta` 必须执行同样的初始化。

### 8.2 结束

收到 `thinking_end`：

1. 记录真实结束时间。
2. 计算真实 duration，不包含后续 UI hold 时间。
3. 如果真实 duration 小于 2 秒，进入 `holding-thinking`，直到 `thinkingStartedAtMs + 2000`。
4. 达到最短展示时间后进入 `thought`。
5. `thought` 保留 2 秒后进入 `none`。

文案：

```text
thinking
thinking with <level> effort
thought for <N>s
```

秒数：

```ts
Math.max(1, Math.round(actualDurationMs / 1000))
```

### 8.3 优先级和边界

- 新的 `thinking_start` 始终覆盖旧的 `thought` 状态。
- mode 已切换到 responding 时，`holding-thinking` metadata 仍可继续显示。
- `agent_end` 优先于最短展示规则，必须立即隐藏 spinner，避免任务结束后残留工作状态。
- aborted/error message 也通过 `agent_end` 清理。
- Phase 1 使用 pi 当前 effective thinking level。`off`、空值或 non-reasoning model 不显示 effort。
- pi 的 `minimal`、`xhigh` 等值先按原值显示，不在本阶段伪装成 Claude 的四档；Phase 2 再决定显示映射策略。

## 9. Timer 与 token

### 9.1 Elapsed time

```ts
elapsedMs = max(0, now - agentStartedAtMs)
```

Phase 1 不实现 pause 扣除，因为 pi 没有公开 pause 生命周期。

沿用现有 `formatDuration()`，但确认 60 秒边界输出符合预期：

```text
5s
31s
1m 5s
```

### 9.2 出现条件

timer 和 tokens 只有在以下任一条件成立时参与渲染：

```ts
config.verbose || elapsedMs > 30_000
```

严格测试 30,000ms 边界：

- `30_000` 不显示。
- `30_001` 显示。

### 9.3 Input token

只读取 assistant `message.usage.input`，与 Footer 的 `↑` 口径一致。cache read/write 继续由 Footer 的独立字段展示，不折叠进 Spinner input。同一 agent run 包含多个 tool turn 时，每次完成或流中已报告的 LLM input 都参与累计。

### 9.4 Output token

只读取 assistant `message.usage.output`。不根据 `text_delta`、`thinking_delta` 或 `toolcall_delta` 的字符数构造 token。provider 如果在流式过程中更新 usage，Spinner 随 usage 变化；如果只在最终 chunk 返回，output 在 message 完成时一次更新。

### 9.5 双向显示

input 与 output 是独立累计值，不再由当前 mode 决定同一个数字的箭头：

```text
↑ <input> tokens · ↓ <output> tokens
```

值为 0 的方向不渲染。具体出现和刷新时机由 provider usage 的上报时机决定。

## 10. Stall 检测

常量：

```ts
const STALL_DELAY_MS = 3000;
const STALL_RAMP_MS = 2000;
```

### 10.1 活动时间

- `agent_start` 和 `turn_start` 初始化 `lastResponseAtMs`。
- 每个非空 text/thinking/toolcall delta 重置 `lastResponseAtMs`。
- `tool_execution_start` 将 tool id 加入 `activeToolIds` 并将 stall intensity 清零。
- 工具执行期间持续关闭 stall。
- 最后一个工具结束时将 `lastResponseAtMs` 重置为当前时间，避免工具刚结束就立即进入 stall。

### 10.2 强度

```ts
if (!active || activeToolIds.size > 0 || lastResponseAtMs === null) {
  intensity = 0;
} else {
  intensity = clamp((now - lastResponseAtMs - 3000) / 2000, 0, 1);
}
```

Phase 1 只需要提供可见的三档或连续颜色过渡接口：

- `0`：主题 accent/muted。
- `(0, 1)`：向 warning/error 过渡。
- `1`：error。

精确 RGB 插值和 stall 时停止 glimmer 在 Phase 3 完成。

## 11. Glyph 与 reduced motion

### 11.1 平台识别

终端识别函数必须可注入环境对象并单独测试：

```ts
detectSpinnerPlatform({ platform, env }): "macos" | "ghostty" | "other"
```

建议优先判断 Ghostty，再判断 macOS：

```ts
env.TERM_PROGRAM?.toLowerCase() === "ghostty" ||
env.GHOSTTY_RESOURCES_DIR !== undefined
```

字符集：

```ts
macos:   ["·", "✢", "✳", "✶", "✻", "✽"]
ghostty: ["·", "✢", "✳", "✶", "✻", "*"]
other:   ["·", "✢", "*", "✶", "✻", "✽"]
```

### 11.2 Ping-pong frames

保持端点重复：

```ts
const frames = [...base, ...base.toReversed()];
```

frame index：

```ts
Math.floor(elapsedMs / 120) % frames.length
```

不得使用会修改原数组的 `reverse()`。

### 11.3 Reduced motion

Phase 1 采用固定 `●`，每秒在 normal/dim 间切换：

```ts
Math.floor(elapsedMs / 1000) % 2
```

Token 统计与 reduced motion 无关，只随 provider usage 变化。

## 12. Metadata 与宽度降级

最终字段顺序固定：

```text
timer · tokens · thinking
```

Phase 1 尚无 suffix。

空间预算优先级：

```text
thinking with effort
→ thinking without effort
→ timer
→ tokens
```

最终输出顺序与预算顺序不同，必须分两步完成：

1. 根据 width 决定保留哪些字段。
2. 按 timer、tokens、thinking 顺序拼接。

主行结构：

```text
<glyph> <verb>… (<metadata>)
```

渲染要求：

- 使用 `visibleWidth()` 计算 ANSI 和 Unicode 可见宽度。
- 使用 `truncateToWidth()` 作为最后防线。
- 优先保留 glyph 和主消息。
- 主消息本身过长时先截断主消息，再判断 metadata。
- 不允许 Text 组件自动把 metadata 换到下一行。
- width 小于最小结构时，依次退化为主消息、glyph、空行。
- 每个返回行的 `visibleWidth(line)` 必须小于等于 `width`。

建议测试宽度：`1`、`2`、`8`、`16`、`24`、`40`、`60`、`80`、`120`。

## 13. 生命周期接入

### 13.1 安装

在 `applyUi(ctx)` 中：

1. 仅当 `config.spinner.enabled` 时隐藏内置 working row。
2. 创建 controller。
3. 安装固定 key 的 above-editor widget。
4. 保存 cleanup 函数。

widget 可以在 idle 时返回空数组。不要每个 tick 反复调用 `setWidget()`。

### 13.2 事件转发

在现有 handler 内增加 controller 调用，保持 telemetry 和 spinner 相互独立：

```text
agent_start
agent_end
turn_start
message_update
message_end
tool_execution_start
tool_execution_end
thinking_level_select
session_before_compact
session_shutdown
```

`message_update` 必须转发 start/delta/end 全部事件，而不是只转发带 delta 的事件。

### 13.3 清理

cleanup 顺序：

1. controller dispose，停止 timer。
2. `ctx.ui.setWidget("open-tui-spinner", undefined)`。
3. `ctx.ui.setWorkingVisible(true)`。
4. 清空引用。

`uninstallUi()`、`session_shutdown` 和配置禁用必须走同一个幂等 cleanup。

不能无条件调用 `setWorkingIndicator()` 或 `setWorkingMessage()`，因为本阶段没有修改它们，恢复这些值可能覆盖其他扩展。

## 14. 测试方案

### 14.1 状态机单元测试

文件：`tests/spinner-state.test.ts`

必须覆盖：

- `agent_start` 初始化所有运行态。
- 随机 verb 每个 agent run 只抽取一次。
- 新 agent run 可以抽取新 verb。
- mode 按 stream start/delta 事件切换。
- provider 缺失 `thinking_start` 时，首个 `thinking_delta` 能补初始化。
- thinking 500ms 后结束，继续保持到 2 秒。
- 真实 duration 不包含 UI hold 时间。
- `thought for Ns` 最少为 1 秒。
- thought 状态保留 2 秒后清空。
- 新 thinking 覆盖旧 thought。
- agent end 立即清空所有 thinking 状态。
- 30 秒 gating 的三个边界：29,999、30,000、30,001ms。
- verbose 从第一秒允许 timer/token。
- 三档 token gap 追赶算法。
- reduced motion 直接同步 token。
- text/thinking/toolcall 空 delta 不累计。
- 并行两个工具开始/结束时 active set 正确。
- 工具执行期间 stall 始终为 0。
- 最后一个工具结束后 stall 计时重新开始。
- 3 秒前、3～5 秒、5 秒后的 stall intensity。
- abort、重复 end 和未知 tool id 不抛异常。

所有测试使用 fake clock 和固定 random，不调用真实 timer。

### 14.2 渲染单元测试

文件：`tests/spinner-render.test.ts`

必须覆盖：

- 五种 mode 的基础输出。
- effort 存在和不存在。
- thinking、holding-thinking、thought 三种文案。
- timer、tokens、thinking 的最终顺序。
- separator 严格为 ` · `。
- token 箭头方向。
- macOS、Ghostty、other glyph。
- ping-pong 周期和重复端点。
- reduced-motion normal/dim 周期。
- 宽度不足时 effort 先降级为裸 thinking。
- 进一步变窄时 tokens 先于 timer/ thinking 被移除。
- 超长 verb 和 CJK verb 不超宽。
- 每个测试宽度下所有行都满足 `visibleWidth <= width`。
- ANSI 颜色不影响宽度计算。

不要只依赖大段 snapshot。优先断言语义字段和可见宽度；少量 snapshot 用于确认最终排版。

### 14.3 生命周期测试

文件：`tests/spinner-lifecycle.test.ts`

构造最小 `ExtensionContext`/UI mock，记录：

- `setWorkingVisible()` 调用。
- `setWidget()` 安装和移除。
- component dispose。
- fake scheduler active timer 数量。
- requestRender 次数。

必须覆盖：

- spinner disabled 时不接管 working row。
- enabled 时只安装一个 widget。
- agent start 后 component 显示，agent end 后隐藏。
- session shutdown 清理 widget 和 timer。
- 配置启用/禁用往返不会产生重复 timer。
- reload/session replacement 的 cleanup 幂等。
- compaction 前隐藏自定义 spinner，core loader 不被禁用。
- 多次 dispose 不抛异常。

### 14.4 配置测试

扩展现有配置测试：

- 旧 JSON 没有 `spinner` 时正确补默认值。
- 非 boolean 值回退默认值。
- spinner 字段不会覆盖 editor/footer/telemetry。
- save/load round trip 保留配置。

### 14.5 手工 TUI 验证

至少验证：

1. regular 模式，宽度 120、80、40。
2. fullscreen 模式，宽度 120、80、40。
3. reasoning model，产生 thinking 和 text。
4. non-reasoning model。
5. 单个工具和并行工具。
6. Esc 中断。
7. 自动 retry。
8. 手动 `/compact` 和自动 compaction。
9. `/reload`。
10. `/new` 或 `/resume`。
11. `/open-tui` 中禁用整个插件。
12. `reducedMotion=true`。

观察项：

- spinner 是否与 editor/footer 重叠。
- spinner 消失后是否留下多余行。
- retry/compaction loader 是否仍显示。
- 长文案是否换行或截断异常。
- 终端缩放是否立即重新布局。
- 运行 5 分钟后 CPU 使用和 timer 数量是否稳定。

## 15. 验证命令

阶段开发中先运行定向测试：

```bash
node --test tests/spinner-state.test.ts
node --test tests/spinner-render.test.ts
node --test tests/spinner-lifecycle.test.ts
```

阶段完成前必须运行：

```bash
npm run typecheck
npm test
```

本地 TUI：

```bash
pi -e .
```

## 16. 风险与缓解

| 风险 | 影响 | 缓解措施 |
|---|---|---|
| 50ms tick 导致高频重绘 | CPU 升高、SSH 闪烁 | 仅 dirty 时 requestRender；记录每秒重绘上限；必要时调到 80ms |
| spinner 与现有 footer timer 重复 | 信息冗余 | Phase 1 明确接受，Phase 2 增加抑制配置 |
| 其他扩展也接管 working row | last-writer-wins | spinner 默认关闭；README 说明 UI ownership；cleanup 不重置未修改 API |
| 并行工具误判 idle | stall 误报 | 使用 `Set<toolCallId>`，测试交错结束顺序 |
| provider 不发送 start/end | Thinking 状态卡住 | delta 补开始；message_end/agent_end 强制收敛 |
| ANSI 导致宽度错误 | 换行、布局抖动 | 所有预算使用 `visibleWidth`；最终 `truncateToWidth` |
| 终端宽度极小 | 组件抛错或负数 repeat | 所有宽度计算 clamp 到 0；覆盖 1～8 列测试 |
| session replacement 后旧 timer 运行 | stale ctx、内存泄漏 | cleanup 幂等；controller generation/disposed guard |
| pi API 版本差异 | 老版本缺少 API | 保持 peer `>=0.80`；不导入 `dist/` 内部路径 |
| exact effort 与 Claude 不同 | 文案不完全一致 | Phase 1 显示 effective value并记录差异，不伪造显式来源 |

## 17. 回滚方案

运行时回滚：

```json
{
  "spinner": {
    "enabled": false
  }
}
```

代码级回滚只需要移除 `installSpinner()` 接线，不应影响 footer、editor、header 和 telemetry。由于实现只使用 `setWorkingVisible` 和独立 widget key，不需要恢复 pi 内部对象。

## 18. 完成清单

- [ ] 最小 spinner 配置可加载、保存和校验。
- [ ] 自定义 widget 使用公开 API 安装。
- [ ] 内置 normal working row 可隐藏和恢复。
- [ ] 五种 mode 事件映射完成。
- [ ] Thinking 状态机完成。
- [ ] timer/token gating 和 smoothing 完成。
- [ ] Progressive Width Gating 完成。
- [ ] glyph、ping-pong、reduced motion 完成。
- [ ] stall 检测支持并行工具。
- [ ] cleanup 覆盖 disable/reload/shutdown/replacement。
- [ ] 三个新测试文件通过。
- [ ] 全量 `npm test` 通过。
- [ ] `npm run typecheck` 通过。
- [ ] regular/fullscreen 手工验证通过。
- [ ] README 记录配置、限制和回滚方式。

只有以上项目全部完成后，才能进入 Phase 2。
