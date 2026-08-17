# Claude-like Spinner Phase 3: 原生扩展协议与稳定性收尾

## 1. 阶段定位

Phase 3 不再建设自定义动画和多行布局系统。本阶段只补充 Pi 公开 API 能稳定承载的单行 suffix provider，并完成性能、ownership、reload 和长期运行验收。

核心原则：

> 使用 Pi agent 公开接口完成原生 working row 增强；公开接口没有提供的颜色、布局、宽度或运行状态能力直接删除。

继续允许的呈现接口只有：

```ts
ctx.ui.setWorkingIndicator(...)
ctx.ui.setWorkingMessage(...)
```

继续允许的跨扩展接口只有：

```ts
pi.events.on(...)
```

目标输出仍是 Pi 原生单行 working message：

```text
✻ Implementing authentication… (workspace · 42s · ↑ 24.8k tokens · ↓ 3.2k tokens · thinking with high effort)
```

其中 `workspace` 是可选 suffix provider 数据。Pi 仍拥有 row 的位置、颜色、换行和 loader 生命周期。

阶段状态：实现完成，自动验证通过；真实 TUI、core loader 和长期运行手工验收待执行。

前置依赖：Phase 1 原生内核和 Phase 2 配置/事件协议完成清单全部通过。

## 2. 原生 API 约束

### 2.1 必须遵守

- 不导入 `@earendil-works/pi-coding-agent/dist/...`。
- 不读取或修改 `InteractiveMode.statusContainer`。
- 不 monkey-patch Pi working Loader。
- 不使用 `setWidget()` 模拟 working row。
- 不调用 `setWorkingVisible(false)`。
- 不向 working message 注入多行布局。
- 不假设 `setWorkingMessage()` 支持分段 ANSI contract。
- 不新增 Spinner interval；状态推进继续复用现有 250ms working timer。
- indicator 动画只由 Pi 原生 Loader 的 `frames` / `intervalMs` 驱动。

### 2.2 Pi 继续负责

- working row 的准确位置和尺寸。
- working message 的主题色和自动换行。
- indicator frame 动画。
- retry、compaction、branch summary loader。
- regular/fullscreen 的布局差异。

### 2.3 open-tui 继续负责

- 纯状态和纯文本 message 内容。
- indicator frame 集与离散 accent/warning/error 颜色。
- reduced motion 静态 indicator。
- 可选 suffix event store。
- dirty write 去重。
- cleanup 时恢复默认 working message/indicator。

## 3. 成功标准

1. suffix 只通过版本化 `pi.events` 协议接入。
2. suffix 不存在或非法时，Phase 1/2 message 完全不变。
3. suffix、timer、tokens、thinking 使用固定 metadata 顺序。
4. 相同 working message 不重复调用 `setWorkingMessage()`。
5. 相同 indicator options 不重复调用 `setWorkingIndicator()`。
6. Spinner 不拥有新 interval，继续复用已有 250ms working timer。
7. reduced motion 只使用静态 `●`，不创建 pulse timer。
8. disable/reload/session replacement 后 provider、message 和 indicator 无残留。
9. retry、compaction 和 branch summary 继续完全由 Pi core 显示。
10. README 明确 wrap、theme 和 last-writer-wins 限制。

## 4. 范围

### 4.1 本阶段包含

- 可选单行 suffix v1 provider。
- suffix source/scope/sequence 规则。
- suffix sanitize、限长和 cleanup。
- `showSuffix` 配置和设置项。
- 原生 message metadata 顺序扩展。
- working message/indicator dirty write 测试。
- 250ms 状态推进和原生 Loader 动画频率验证。
- reload/session replacement/disable ownership 测试。
- regular/fullscreen、SSH、窄终端和长期运行手工验收。
- README 最终能力边界和跨扩展协议。

### 4.2 明确删除

- 主消息 glimmer。
- requesting/normal 逐字符速度和方向差异。
- thinking shimmer。
- tool-use flash。
- 连续 RGB stall 渐变。
- grapheme 扫描动画。
- fixed override color 和动画颜色优先级。
- `Tip:`。
- `Target:` token budget、percentage 和 ETA。
- `Next:` 辅助行。
- Brief 模式和点动画。
- Brief idle placeholder。
- 右对齐 background task count。
- reconnecting/disconnected UI。
- background task provider。
- 自定义 idle row。
- 多行 auxiliary layout。
- 50ms animation scheduler。
- RGB/ANSI 插值基础设施。

### 4.3 删除理由

| 能力 | 删除原因 |
|---|---|
| glimmer/shimmer/flash | 原生 message 只有统一 message color，没有逐 grapheme render API |
| 连续 stall RGB | Theme 不公开 RGB，native indicator 只适合离散 semantic color frames |
| Tip/Target/Next | 原生 working API 不提供 width-aware 多行 component |
| Brief/right align | `setWorkingMessage()` 不提供布局、对齐和 idle row ownership |
| connection/background | Pi 没有公开稳定状态来源，不能伪造 |
| 自定义 idle 状态 | native working row 只在 Pi streaming 生命周期中显示 |
| 精确宽度降级 | working message API 不提供实际 render width |

不得通过 `process.stdout.columns`、隐藏 widget、内部 status container 或 ANSI 光标控制来伪装这些能力仍然存在。

## 5. 架构

```text
Pi events / provider events
          ↓
Spinner state + content store
          ↓
renderNativeSpinnerMessage()
          ↓
ctx.ui.setWorkingMessage()

platform/config/stall state
          ↓
createNativeSpinnerIndicator()
          ↓
ctx.ui.setWorkingIndicator()
```

### 5.1 调度

不增加 scheduler：

```text
Pi native Loader:       120ms indicator frame，由 Pi 管理
open-tui working timer: 250ms state tick，Phase 1 已存在
```

每个 250ms tick 可以计算新 state/message/indicator，但只有序列化结果变化时调用 UI API。

### 5.2 Dirty key

```ts
lastWorkingMessage: string | undefined
lastIndicatorSignature: string
```

message 比较最终 plain text。indicator signature 至少包含：

```text
platform frames
intervalMs
reducedMotion
stall semantic color
theme-rendered frame strings
```

主题颜色变化导致 frame string 变化时允许重发 indicator，不需要访问 Theme 内部 RGB。

## 6. 文件级改动

### 6.1 新增文件

```text
extensions/open-tui/spinner-suffix.ts
tests/spinner-suffix.test.ts
tests/spinner-native-performance.test.ts
```

| 文件 | 职责 |
|---|---|
| `spinner-suffix.ts` | suffix channel、payload 校验、source store 和 cleanup |
| `spinner-suffix.test.ts` | source/scope/sanitize/message 顺序 |
| `spinner-native-performance.test.ts` | fake clock 下 UI API 写入次数和无额外 timer 约束 |

### 6.2 修改文件

```text
extensions/open-tui/config.ts
extensions/open-tui/index.ts
extensions/open-tui/spinner.ts
extensions/open-tui/spinner-render.ts
extensions/open-tui/spinner-events.ts
extensions/open-tui/settings-command.ts
tests/settings-command.test.ts
tests/spinner-render.test.ts
tests/spinner-lifecycle.test.ts
package.json
README.md
```

不新增 `spinner-animation.ts`、`spinner-colors.ts`、`spinner-brief.ts` 或任何 widget component。

## 7. 配置扩展

Phase 3 只增加一个开关：

```ts
export interface SpinnerConfig {
  // Phase 2 fields...
  showSuffix: boolean;
}
```

默认：

```json
{
  "spinner": {
    "showSuffix": true
  }
}
```

校验规则：

- 只接受 boolean。
- 旧配置缺失时补默认值。
- 设置切换后下一次 publish 立即生效。
- 关闭只隐藏 suffix，不删除 provider store；重新开启可恢复当前有效 suffix。

不增加 animations、tips、target、style、brief、connection 或 background 配置。

## 8. Suffix Provider

### 8.1 Channel

```ts
export const SPINNER_SUFFIX_EVENT = "open-tui:spinner:suffix:v1";
```

### 8.2 Payload

```ts
export interface SpinnerSuffixEventV1 {
  version: 1;
  source: string;
  suffix: string | null;
  scope?: "agent" | "session";
}
```

### 8.3 语义

- string 设置 source suffix。
- `null` 只清除同 source。
- 默认 scope 为 `agent`。
- agent scope 在 `agent_end` 清除。
- session scope 保留到显式清除或 `session_shutdown`。
- 多 source 使用最后一次有效写入。
- 清除当前 source 后回退到前一个有效 source。
- source 必须是非空单行 string，并限制长度。
- suffix 必须 sanitize 为单行 plain text。
- suffix 最多 64 个 code points。
- 空白、换行、C0/C1 control sequence 和 terminal escape payload 无效。

store 使用 source map 和递增 sequence，不需要 revision，因为每个 payload 都是完整 source value。

### 8.4 不支持的字段

payload 不包含：

```text
tip
target
connection
backgroundTasks
colorMode
allowStallColor
```

这些字段没有稳定的原生呈现或 Pi 状态来源。

## 9. Message 组合

metadata 最终顺序：

```text
suffix · timer · input tokens · output tokens · thinking
```

示例：

```text
Working… (workspace · 31s · ↑ 18.4k tokens · ↓ 1.2k tokens · thinking with high effort)
```

规则：

- suffix 只在 `showSuffix=true` 且存在合法 provider value 时加入。
- suffix 不影响主文案 override/task/random 优先级。
- suffix 不参与 stall 和 effort 状态。
- suffix 清除后立即回到无 suffix message。
- 不根据 terminal width 删除或截断某个 metadata segment。
- Pi 原生 `Text` 可以在窄终端自动换行，这是明确接受的行为。
- 不向 suffix 或 message 注入 ANSI。

## 10. Indicator 行为冻结

Phase 3 不增加新 indicator 动画，只冻结 Phase 1 行为：

```text
normal stall=0        → theme accent frames
warning 0<intensity<1 → theme warning frames
error intensity=1     → theme error frames
reducedMotion=true     → 单帧静态 ●
```

正常模式继续使用 platform ping-pong frames 和 `intervalMs=120`。离散 stall bucket 变化时重发 indicator，bucket 内 intensity 连续变化不重发。

不实现：

- message 颜色变化。
- metadata 颜色变化。
- indicator alpha/RGB 插值。
- tool-use flash。
- reduced motion pulse。

## 11. Settings UI

Spinner tab 只新增：

```text
External suffix
```

不显示已删除能力的占位设置。特别是不得出现：

```text
Glimmer
Thinking shimmer
Tool-use flash
Tips
Target
Brief
Connection status
Background count
```

设置页中英文 copy、选择保持和窄宽度行为沿用 Phase 2。

## 12. Lifecycle 与 Ownership

### 12.1 安装

- spinner enabled 时配置 native indicator。
- 不安装 widget。
- 不修改 working visibility。
- 订阅 suffix event 并保存 unsubscribe。

### 12.2 Agent end

- 清理 agent-scoped override 和 suffix；task snapshot 保留到新 revision 或 session cleanup。
- 保留 session-scoped provider 数据。
- controller runtime state 回到 inactive。
- 不主动显示 idle placeholder。

### 12.3 Disable / shutdown / reload

统一 cleanup：

1. unsubscribe event handlers。
2. 清空 provider stores。
3. dispose controller。
4. 调用无参数 `setWorkingMessage()`。
5. 调用无参数 `setWorkingIndicator()`。

不调用 `setWorkingVisible()`，因为原生方案从未修改 visibility。

### 12.4 多扩展冲突

Pi working message/indicator API 是 last-writer-wins，没有公开 owner getter 或 compare-and-restore API。因此：

- README 明确 Spinner enabled 时 open-tui 会写这两个 API。
- 不尝试检测其他扩展。
- 不访问内部 active status indicator。
- cleanup 恢复 Pi 默认值，最终结果受 extension cleanup 顺序影响。
- 手工测试至少与官方 `working-indicator.ts` 示例同时加载一次。

## 13. 测试方案

### 13.1 Suffix Store

`tests/spinner-suffix.test.ts`：

- 合法 agent/session suffix。
- agent end 只清 agent scope。
- session shutdown 全清。
- 多 source last-write-wins。
- source-specific clear 和 fallback。
- 非法 version/source/scope/suffix 忽略。
- 空白、换行、escape、控制字符被拒绝。
- code point 长度限制。
- unsubscribe 后无更新。

### 13.2 Native Message

扩展 `tests/spinner-render.test.ts`：

- suffix 第一，随后 timer、tokens、thinking。
- showSuffix=false 隐藏 suffix。
- 无 provider 时 Phase 2 message 不变。
- suffix 清除后 message 恢复。
- CJK/emoji suffix 保持 plain text。
- 不做 visible width 或多行 snapshot 断言。

### 13.3 Native Performance

`tests/spinner-native-performance.test.ts` 使用 fake clock 和 UI mock：

- 60 秒虚拟时间内 controller 不创建 interval。
- 静态 message 不重复调用 `setWorkingMessage()`。
- timer 只在显示文本变化时写入。
- token smoothing 只在近似 token 文本变化时写入。
- stall warning/error bucket 各重发一次 indicator。
- bucket 内 intensity 变化不重发。
- reduced motion 只发布单帧 indicator。
- theme frame string 不变时不重发。
- dispose 后 tick/event 不写 UI。
- 100 次 install/dispose 不累计 listener。

自动测试不使用真实 `setTimeout()`、`process.cpuUsage()` 或终端截图阈值。

### 13.4 Lifecycle

扩展 `tests/spinner-lifecycle.test.ts`：

- install 不调用 widget/visibility API。
- suffix event 更新 active native message。
- compaction 不覆盖 core loader。
- disable/reload/session replacement unsubscribe 并恢复默认 API。
- session-scoped suffix 不泄漏到 replacement session。
- 多次 cleanup 幂等。

### 13.5 Settings

扩展 `tests/settings-command.test.ts`：

- External suffix 中英文 copy。
- toggle live update。
- 设置 tab 不出现所有已删除 Phase 3 项。

## 14. 手工 TUI 验证

### 14.1 终端矩阵

```text
regular:    40 / 80 / 120 columns
fullscreen: 40 / 80 / 120 columns
```

至少覆盖一个本地终端和一个 SSH/低刷新环境。

### 14.2 场景

1. 无 suffix provider 的完整 agent run。
2. agent-scoped suffix 设置、覆盖、清除。
3. session-scoped suffix 跨多个 agent run。
4. suffix + timer + tokens + thinking 同时出现。
5. 40 列下观察 Pi 原生 wrap。
6. stall warning/error indicator。
7. tool 执行期间 stall 关闭。
8. reduced motion 静态 `●`。
9. Esc abort、retry、manual/auto compaction 和 branch summary。
10. `/reload`、`/new`、`/resume`。
11. spinner disable 后 Pi 默认 working row 恢复。
12. 与另一个 working-indicator extension 同时加载。
13. 连续运行至少 10 分钟，观察 CPU、闪烁和 stale message。

不要求浏览器、canvas 或像素自动测试。字符 TUI 的自动验收以 API call、state 和 plain message 测试为准。

## 15. 验证命令

```bash
node --test tests/spinner-suffix.test.ts
node --test tests/spinner-native-performance.test.ts
node --test tests/spinner-render.test.ts
node --test tests/spinner-lifecycle.test.ts
node --test tests/settings-command.test.ts
npm run typecheck
npm test
```

本地 TUI：

```bash
pi -e .
```

## 16. 风险与边界

| 风险 | 影响 | 处理 |
|---|---|---|
| suffix 增加 message 长度 | 窄终端换行 | 接受 Pi 原生 wrap；suffix sanitize/限长；可关闭 showSuffix |
| 多 provider 写 suffix | 文案跳动 | source sequence 和 clear/fallback 规则 |
| provider 未 cleanup | replacement session 显示旧值 | unsubscribe + session store reset |
| working API last-writer-wins | 与其他扩展互相覆盖 | 文档化 ownership，不读取内部 owner |
| native indicator verbatim ANSI | 主题变化后旧 frame 短暂保留 | tick 重算 theme frame string并按 signature 重发 |
| 250ms 状态 tick | Thinking/stall 切换最多约 250ms 误差 | 接受；不恢复 50ms scheduler |
| Pi Text 自动换行 | 行高变化 | 接受原生行为，不使用 widget 修正 |
| restore default 覆盖其他扩展 | cleanup 顺序相关 | 文档化；不伪造 compare-and-restore |

## 17. 回滚方案

关闭 suffix：

```json
{
  "spinner": {
    "showSuffix": false
  }
}
```

启用 reduced motion：

```json
{
  "spinner": {
    "reducedMotion": true
  }
}
```

完整关闭：

```json
{
  "spinner": {
    "enabled": false
  }
}
```

删除 `spinner-suffix.ts` 和对应设置后，Phase 1/2 仍必须可独立编译和运行。

## 18. 完成清单

- [x] suffix v1 事件协议完成并文档化。
- [x] suffix source/scope/sequence/clear 规则完成。
- [x] suffix sanitize 和长度限制完成。
- [x] metadata 顺序固定为 suffix、timer、tokens、thinking。
- [x] showSuffix 配置和设置项完成。
- [x] controller 不创建新 interval。
- [x] working message dirty write 去重完成。
- [x] indicator signature dirty write 去重完成。
- [x] reduced motion 保持单帧静态 indicator。
- [x] 不存在 glimmer/shimmer/flash/RGB 动画代码或配置。
- [x] 不存在 Tip/Target/Next/Brief/connection/background UI。
- [x] 不存在 widget、working visibility 接管或内部 Pi import。
- [x] suffix/native performance/lifecycle/settings 定向测试通过。
- [x] Phase 1/2 全部测试继续通过。
- [x] `npm run typecheck` 通过。
- [x] `npm test` 通过（148/148）。
- [ ] regular/fullscreen 终端矩阵验证通过。
- [ ] retry/compaction/branch summary 原生 loader 验证通过。
- [ ] 10 分钟稳定性和 ownership 手工验证通过。
- [x] README 记录 suffix 协议、wrap、theme 和 last-writer 边界。

完成本清单后，Claude-like Spinner 三阶段结束。后续只有在 Pi 新增公开 width-aware working component、working owner 或连接/后台任务事件后，才重新评估已删除能力；不得基于 Pi 内部实现提前恢复。
