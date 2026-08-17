# Claude-like Spinner Phase 2: 原生配置、Verbs 与任务协议

## 1. 阶段定位

本阶段在 Phase 1 的原生 working row 实现上补齐产品配置和公开扩展协议。核心原则：

> 优先使用 Pi agent 公开接口；公开接口无法稳定实现的功能直接删除，不通过 widget、内部容器或布局模拟补回。

Spinner 呈现继续只使用：

```ts
ctx.ui.setWorkingIndicator(...)
ctx.ui.setWorkingMessage(...)
pi.events.on(...)
```

不得重新引入 `setWidget()`，不得隐藏原生 working row，不得访问 Pi 的 `statusContainer`、Loader 或其他内部对象。

本阶段完成后的主文案优先级：

```text
overrideMessage
    > currentTask.activeForm
    > currentTask.subject
    > randomVerb
```

典型输出仍是 Pi 原生单条 working message：

```text
✻ Fixing authentication bug… (thinking with high effort)
```

阶段状态：实现完成，自动验证通过；真实 TUI 和 provider 示例手工验收待执行。

前置依赖：Phase 1 原生 working row、状态机、配置和生命周期测试全部通过。

## 2. 原生 API 决策

### 2.1 Pi 负责

- working row 的真实位置、缩进和上下间距。
- normal working、retry、compaction、branch summary 的切换。
- indicator frame 动画和 request render。
- working message 的统一主题颜色、换行和最终布局。
- session/reload 时 extension UI 的核心清理。

### 2.2 open-tui 负责

- verbs 配置和单轮稳定抽取。
- mode、Thinking、timer、token 和 stall 状态。
- working message 的纯文本内容。
- indicator frames、reduced motion 和离散 stall 颜色。
- `pi.events` 上的 override/task 协议。
- 设置 UI 和 footer timer 去重。

### 2.3 不再承诺

- 不保证 working message 在窄终端严格单行。
- 不按真实组件 width 做 Progressive Width Gating。
- 不对 timer、tokens、thinking 分段着色。
- 不在 working row 中增加第二行或辅助区域。
- 不通过 ANSI 注入绕过 Pi 的原生 message color。

## 3. 成功标准

1. `/open-tui` 可以启用和配置原生 Spinner 的主要行为。
2. 完整默认 verbs 可用，单个 agent run 内 verb 保持稳定。
3. custom verbs 支持 `append` 和 `replace`，非法配置逐项回退。
4. 主文案严格遵循 override、task active form、task subject、random verb 优先级。
5. task 集成只接受 `pi.events` 上的完整结构化 snapshot，不解析工具输出或猜测 Todo 工具结构。
6. provider 不存在、snapshot 非法或 task 完成时回退到本轮 random verb。
7. spinner timer 与内置 footer working timer 可以按配置去重，done duration 仍可保留。
8. enable、disable、reload 和 session replacement 正确恢复 Pi 默认 working message/indicator。
9. 所有配置对旧版 `open-tui.json` 向后兼容。
10. Phase 1 状态、原生呈现和生命周期测试继续通过。

## 4. 范围

### 4.1 本阶段包含

- 完整默认 spinner verb 集。
- custom verbs 的 `append` / `replace` 策略。
- Spinner 设置 tab。
- thinking、timer、tokens、stall 等原生 message segment 开关。
- effective effort 显示开关。
- `pi.events` 主消息 override v1 协议。
- `pi.events` task snapshot v1 协议。
- `currentTask.activeForm` / `subject` 主文案。
- footer timer segment 配置和 working timer 抑制。
- README 配置、原生 API ownership 和事件协议文档。

### 4.2 明确删除

- `Next:` 独立行。
- Todo dependency/blockedBy 选择和 Next task 计算。
- Todo tool heuristic adapter。
- 解析 Todo MCP 或其他工具的 args/result/content。
- CJK/ANSI 的 width-aware 截断承诺。
- working row 多行输出。
- custom message 分段颜色。
- 自定义 widget/component。

删除理由：Pi 没有公开的 width-aware working component API，也没有标准 Todo provider API。`setWorkingMessage()` 适合单条原生 loader message，不应被当作自定义布局容器。

### 4.3 延后到 Phase 3

- 可选单行 suffix provider。
- 原生 API 写入去重和长期稳定性验收。
- 与其他 working-row extension 的 ownership 文档和手工验证。

## 5. Phase 1 接口边界

Phase 2 基于当前原生 Phase 1 接口：

```text
SpinnerController.initialize()
SpinnerController.agentStart()
SpinnerController.agentEnd()
SpinnerController.turnStart()
SpinnerController.messageUpdate()
SpinnerController.messageEnd()
SpinnerController.toolExecutionStart()
SpinnerController.toolExecutionEnd()
SpinnerController.thinkingLevelSelect()
SpinnerController.tick()
SpinnerController.beforeCompact()
SpinnerController.dispose()

renderNativeSpinnerMessage(state, config, now)
createNativeSpinnerIndicator(platform, reducedMotion, stalledIntensity, theme)
```

Phase 2 不把事件协议校验和 task store 塞入 `SpinnerStateMachine`。controller 只消费规范化后的 content state。

建议新增：

```ts
export interface SpinnerContentState {
  overrideMessage: string | null;
  currentTask: SpinnerTask | null;
}
```

## 6. 文件级改动

### 6.1 新增文件

```text
extensions/open-tui/spinner-events.ts
extensions/open-tui/spinner-content.ts
tests/spinner-config.test.ts
tests/spinner-events.test.ts
tests/spinner-content.test.ts
```

| 文件 | 职责 |
|---|---|
| `spinner-events.ts` | 公开 event channel、payload type、运行时校验和 unsubscribe |
| `spinner-content.ts` | override/task store、主文案优先级和 sanitize |
| `spinner-config.test.ts` | verbs、enum、配置迁移和 round trip |
| `spinner-events.test.ts` | override/task snapshot 协议和生命周期 |
| `spinner-content.test.ts` | current task 和主文案选择 |

### 6.2 修改文件

```text
extensions/open-tui/config.ts
extensions/open-tui/index.ts
extensions/open-tui/spinner.ts
extensions/open-tui/spinner-render.ts
extensions/open-tui/spinner-verbs.ts
extensions/open-tui/footer.ts
extensions/open-tui/settings-command.ts
tests/settings-command.test.ts
tests/footer.test.ts
tests/spinner-state.test.ts
tests/spinner-render.test.ts
tests/spinner-lifecycle.test.ts
package.json
README.md
```

## 7. 配置设计

```ts
export type SpinnerVerbMode = "append" | "replace";
export type SpinnerEffortDisplay = "effective" | "off";
export type SpinnerTaskIntegration = "events" | "off";

export interface SpinnerConfig {
  enabled: boolean;
  verbose: boolean;
  reducedMotion: boolean;

  showThinking: boolean;
  showTimer: boolean;
  showTokens: boolean;
  showStall: boolean;

  effortDisplay: SpinnerEffortDisplay;
  taskIntegration: SpinnerTaskIntegration;
  suppressFooterWorkingTimer: boolean;

  verbs: {
    mode: SpinnerVerbMode;
    values: string[];
  };
}
```

建议默认值：

```json
{
  "spinner": {
    "enabled": false,
    "verbose": false,
    "reducedMotion": false,
    "showThinking": true,
    "showTimer": true,
    "showTokens": true,
    "showStall": true,
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

只显示 Pi 当前 effective thinking level。不得提供 Claude level 映射，因为映射会改变显示语义但没有对应的 Pi 状态来源。

### 7.1 配置校验

`loadConfig()` 必须：

- 逐项校验 boolean。
- 校验 enum，非法值回退默认值。
- 只接受 string array 作为 verbs values。
- trim 每个 verb，丢弃空字符串、换行和控制字符。
- 精确文本去重，保持首次出现顺序。
- 单个 verb 最多 64 个 code points。
- custom verbs 最多 256 项。
- 只规范化内存值，不自动改写用户配置文件。

## 8. 完整 Verbs

默认列表放入 `spinner-verbs.ts`：

```ts
export const DEFAULT_SPINNER_VERBS = [
  // 核对后的完整列表
] as const;
```

解析规则：

```ts
export function resolveSpinnerVerbs(config: SpinnerConfig): readonly string[] {
  const custom = normalizeCustomVerbs(config.verbs.values);
  if (config.verbs.mode === "replace" && custom.length > 0) return custom;
  return unique([...DEFAULT_SPINNER_VERBS, ...custom]);
}
```

要求：

- 默认 verb 不带 `…`，省略号由 message renderer 追加。
- `replace` 空列表回退默认 verbs，不能调用 `random.pick([])`。
- append 最终去重，避免隐式改变抽样权重。
- 单轮只在 `agentStart()` 抽取一次。
- override/task 清除后恢复本轮原 random verb，不重新抽取。

## 9. 主文案解析

```ts
export function resolveSpinnerMessage(input: {
  overrideMessage: string | null;
  currentTask: SpinnerTask | null;
  randomVerb: string;
}): string {
  return sanitizeMessage(input.overrideMessage)
    ?? sanitizeMessage(input.currentTask?.activeForm)
    ?? sanitizeMessage(input.currentTask?.subject)
    ?? input.randomVerb;
}
```

要求：

- renderer 最终统一追加一个 Unicode `…`。
- 输入末尾已有 `...` 或 `…` 时先移除。
- override/task 变化后立即调用 `setWorkingMessage()` 更新原生 row。
- 空白、换行和 terminal control sequence 视为无值。
- sanitize 只负责安全和长度，不假装拥有准确 terminal width。
- message 过长时允许 Pi 原生 `Text` 换行；README 明确该限制。

## 10. 公开事件协议

使用 Pi 公开共享事件总线 `pi.events`。

### 10.1 Channel

```ts
export const SPINNER_OVERRIDE_EVENT = "open-tui:spinner:override:v1";
export const SPINNER_TASKS_EVENT = "open-tui:spinner:tasks:v1";
```

### 10.2 Override payload

```ts
export interface SpinnerOverrideEventV1 {
  version: 1;
  source: string;
  message: string | null;
  scope?: "agent" | "session";
}
```

规则：

- string 设置 override，`null` 只清除同 source。
- 默认 scope 为 `agent`，在 `agent_end` 清理。
- session scope 保留到显式清除或 `session_shutdown`。
- 多 source 使用最后一次有效写入，清除后回退到前一个有效 source。
- source、scope、message 和 version 必须运行时校验。

直接调用 `ctx.ui.setWorkingMessage()` 的其他扩展无法被观察或合并。多个扩展同时写 working message 时遵循 Pi 的 last-writer-wins 行为。

### 10.3 Task snapshot payload

```ts
export type SpinnerTaskStatus =
  | "pending"
  | "in_progress"
  | "completed"
  | "deleted";

export interface SpinnerTaskV1 {
  id: string | number;
  subject: string;
  activeForm?: string;
  status: SpinnerTaskStatus;
}

export interface SpinnerTasksEventV1 {
  version: 1;
  source: string;
  revision: number;
  tasks: SpinnerTaskV1[];
}
```

规则：

- payload 必须是完整 snapshot，不接受 patch。
- revision 对同 source 单调递增，旧 revision 忽略。
- 默认使用最后更新的合法 source。
- current task 是数组中第一个 `in_progress`。
- 没有 `in_progress` 时 current 为 null，主文案回退。
- completed/deleted/pending 不进入主文案。
- session start/shutdown 清空 snapshot 和 revision。
- 不计算 dependency，不生成 Next task。

### 10.4 订阅清理

保存 `pi.events.on()` 返回的 unsubscribe，并在统一 cleanup 中释放。reload/session replacement 后旧 runtime 不得继续收事件。

## 11. 删除 Todo Tool Adapter

Phase 2 不再监听具体 todo tool 名称，也不解析：

```text
tool_execution_start.args
tool_execution_end.result
content[].text
MCP 私有 details
```

理由：Pi 当前没有标准 Todo API。工具 allowlist 和 shape heuristic 虽然能实现，但不是稳定的 Pi agent 合约，会增加大量兼容分支。需要 task 文案的扩展应发布 `SPINNER_TASKS_EVENT` 完整 snapshot。

## 12. Spinner 设置界面

新增 Spinner tab，建议顺序：

```text
General → Icons → Spinner → Footer → Telemetry
```

至少包含：

```text
Enabled
Verbose metadata
Reduced motion
Thinking status
Elapsed timer
Input/output tokens
Stall indication
Effort display
Task event integration
Hide duplicate footer timer
Custom verb mode
```

设置 UI 不编辑 verbs array，只显示 `N configured`；用户在 JSON 中维护 values。

Live update：

- message segment 和 verbose 改动在下一次 controller publish/tick 生效。
- reduced motion 和 stall 开关通过 `setWorkingIndicator()` 重新发布原生 frames。
- enabled 切换沿用 overlay close 后安装/卸载，避免焦点问题。
- 禁用时调用无参数 `setWorkingMessage()` / `setWorkingIndicator()` 恢复 Pi 默认值。

## 13. Footer Timer 去重

在 `FooterSegments` 增加：

```ts
timer: boolean;
```

默认 `true`。

规则：

```text
footerSegments.timer = false
  → working 和 done 都隐藏

spinner.enabled && spinner.showTimer && spinner.suppressFooterWorkingTimer
  → footer working 隐藏，done 保留

其他情况
  → 保持当前 footer working/done 行为
```

去重只影响内置 footer render，不修改磁盘配置。`footerScript` 的 timer 输入保持不变，由脚本自行决定布局。

## 14. 原生呈现规则

Phase 2 仍只发布一个 plain-text working message：

```text
<resolved message>… (<timer> · <input tokens> · <output tokens> · <thinking>)
```

要求：

- 不向 message 注入 ANSI 分段色。
- 不发送换行来构造辅助行。
- input/output 只读取公开 assistant `message.usage.input/output`，口径与 Footer 箭头一致。
- 不根据 text/thinking/tool-call delta 的字符数估算 token，也不因此重写 working message。
- provider 只在最终 chunk 返回 usage 时，token 在 message 完成时一次更新。
- token 跨同一 agent run 的多个 tool turn 累加，始终分别显示 `↑` 和 `↓`，不再根据 mode 改写同一个数字的方向。
- 不调用 `setWidget()`。
- 不调用 `setWorkingVisible(false)`。
- message 相同则不重复调用 `setWorkingMessage()`。
- indicator options 相同则不重复调用 `setWorkingIndicator()`。
- retry/compaction/branch summary 由 Pi core 的 status indicator 接管。

## 15. 测试方案

### 15.1 Verbs 与配置

`tests/spinner-config.test.ts`：

- 默认 verbs 基准数量和唯一性。
- 默认 verbs 不带省略号。
- append、replace、去重和空 replace fallback。
- 非 string、空白、换行和控制字符被丢弃。
- 单项和总项数限制。
- enum/boolean 非法值逐项回退。
- 旧配置迁移和 save/load round trip。

### 15.2 Content Priority

`tests/spinner-content.test.ts`：

- override > activeForm > subject > random verb。
- 空 override 回退 task。
- task 完成后回退本轮 random verb。
- override 清除后不重新抽 verb。
- 已有 `...` / `…` 最终只显示一个 Unicode 省略号。
- CJK、emoji、引号和 apostrophe 保持完整文本。
- 不做 width 截断断言。

### 15.3 Event Bus

`tests/spinner-events.test.ts`：

- override agent/session scope。
- 多 source last-write-wins 和 source-specific clear。
- 非法 version/source/message 忽略。
- task 完整 snapshot 和 revision 单调性。
- 多个 in_progress 稳定选择第一个。
- completed/deleted/pending 不作为 current。
- unsubscribe 后不再更新。
- reload/session shutdown 清空。
- 没有 tool heuristic 或 text parser。

### 15.4 Settings

扩展 `tests/settings-command.test.ts`：

- tab 顺序和中英文 copy。
- boolean 和 enum 切换。
- overlay 关闭前不安装/卸载 UI。
- custom verb count。
- 设置页自身在窄宽度不溢出。

### 15.5 Footer

扩展 `tests/footer.test.ts`：

- spinner disabled 时 footer timer 保持。
- showTimer=false 时不抑制 footer working timer。
- suppress=false 时允许重复显示。
- suppress=true 时 working 隐藏、done 保留。
- footerSegments.timer=false 时 working/done 都隐藏。
- footerScript timer payload 不变。

### 15.6 Native Lifecycle

扩展 `tests/spinner-lifecycle.test.ts`：

- enabled 只配置 working indicator，不安装 widget。
- event/content 更新调用 working message。
- 相同 message/indicator 不重复写。
- disable/dispose 恢复 Pi 默认 message/indicator。
- 全程不调用 working visibility API。
- retry/compaction 前停止自定义状态但不修改 core loader。

## 16. 手工 TUI 验证

1. `/open-tui` 中切换 Spinner 设置。
2. append/replace verbs 后 `/reload`。
3. override provider 设置和清除文案。
4. task provider 发布完整 snapshot，并完成 current task。
5. footer working timer 去重和 done duration。
6. regular/fullscreen 下确认 row 始终处于 Pi 原生位置。
7. 40 列下观察 Pi 原生 wrap，确认不出现控制字符或 stale message。
8. retry、manual/auto compaction、branch summary。
9. reload、new、resume 和 disable cleanup。
10. 与另一个 working-message extension 同时加载，记录实际 last-writer 行为。

## 17. 协议示例

可增加非发布入口示例：

```text
examples/spinner-provider.ts
```

只演示：

- 发布/清除 agent-scoped override。
- 发布 task 完整 snapshot。
- revision 更新和 current task 完成。

不得依赖具体 Todo MCP。

## 18. 验证命令

```bash
node --test tests/spinner-config.test.ts
node --test tests/spinner-content.test.ts
node --test tests/spinner-events.test.ts
node --test tests/settings-command.test.ts
node --test tests/footer.test.ts
node --test tests/spinner-lifecycle.test.ts
npm run typecheck
npm test
```

本地 TUI：

```bash
pi -e .
```

## 19. 风险与边界

| 风险 | 影响 | 处理 |
|---|---|---|
| working message 没有 width 参数 | 窄终端自动换行 | 接受 Pi 原生布局；sanitize 和限长；不声明严格单行 |
| 多扩展写 working API | message/indicator 互相覆盖 | README 明确 last-writer-wins；不尝试读取内部 owner |
| task provider 不存在 | 无 task 文案 | 回退本轮 random verb |
| provider 发布 stale snapshot | 文案回退错误 | source + revision 规则；session cleanup |
| custom verb 含控制字符 | TUI 注入 | 单行 sanitize、长度和数量限制 |
| footer 抑制改写配置 | 用户配置被暗改 | 仅 render 时判断，不持久化副作用 |
| 原生 frames 为 verbatim ANSI | theme 切换后颜色可能暂时旧 | controller tick 比较新 frames；变化时重发 indicator |
| cleanup 覆盖其他扩展 | ownership 冲突 | 只恢复自己明确修改的 message/indicator；记录加载顺序限制 |

## 20. 回滚方案

完整关闭：

```json
{
  "spinner": {
    "enabled": false
  }
}
```

只关闭 task integration：

```json
{
  "spinner": {
    "taskIntegration": "off"
  }
}
```

恢复 footer working timer：

```json
{
  "spinner": {
    "suppressFooterWorkingTimer": false
  }
}
```

## 21. 完成清单

- [x] 完整默认 verbs 已核对并测试。
- [x] append/replace 和输入规范化完成。
- [x] override/task/random 主文案优先级完成。
- [x] override v1 事件协议完成并文档化。
- [x] task snapshot v1 协议完成并文档化。
- [x] current task 选择完成；未实现 Next task。
- [x] 不存在 Todo tool heuristic 或文本解析器。
- [x] Spinner 设置 tab 完成中英文 copy。
- [x] 基础设置可 live update。
- [x] footer timer segment 和 working 抑制完成。
- [x] footer script 协议保持兼容。
- [x] 原生 working row 未被隐藏或替换为 widget。
- [x] disable/reload/session replacement 恢复默认 working API。
- [x] config/content/events/settings/footer 定向测试通过。
- [x] Phase 1 全部测试继续通过。
- [x] `npm run typecheck` 通过。
- [x] `npm test` 通过（132/132）。
- [ ] provider 示例手工验证通过。
- [x] README 记录配置、协议、wrap 和 ownership 限制。

完成以上清单后进入 Phase 3。Phase 3 不再恢复被删除的自定义布局和高级逐字符动画。
