# Spinner 手工验收

## 1. 启动

从仓库根目录启动，只加载 open-tui 和验收 provider，避免其他已安装扩展干扰：

```bash
pi --no-extensions \
  -e ./extensions/open-tui/index.ts \
  -e ./examples/spinner-provider.ts \
  --approve
```

运行 `/open-tui`，在 Spinner tab 设置：

```text
Enabled: On
Verbose metadata: On
Reduced motion: Off
Thinking status: On
Elapsed timer: On
Input/output tokens: On
Stall indication: On
External suffix: On
Effort display: Effective
Task event integration: Events
Hide duplicate footer timer: On
```

## 2. 基础与随机 Verb

```text
/spinner-provider reset
```

然后发送：

```text
请用 8 句话说明这个仓库的用途，不要调用工具。
```

观察：

- 原生 working row 位置不变。
- 每轮随机 verb 固定，不随动画帧变化。
- verbose 模式立即显示 timer；`↑ input` / `↓ output` 只在 provider usage 大于 0 时出现。
- 普通 text/thinking/tool-call delta 不应触发 token message 重写或造成 TUI 卡顿。
- provider 若只在最终 chunk 返回 usage，token 会在 message 完成时一次跳到真实值；不能用字符数伪造中间值。
- reasoning model 会显示 `thinking with <level> effort` 和 `thought for Ns`。

## 3. Task 与 Suffix

```text
/spinner-provider combo
```

发送任意正常问题。预期主文案类似：

```text
Validating spinner provider… (workspace · 1s · ↑ 18.4k tokens · thinking with high effort)
```

输出开始后 metadata 顺序应为：

```text
workspace · timer · input tokens · output tokens · thinking
```

完成 task：

```text
/spinner-provider complete
```

下一轮应回到随机 verb。

## 4. Override 优先级

```text
/spinner-provider task
/spinner-provider Reviewing security
```

下一轮必须显示 `Reviewing security…`，而不是 task 文案。清除 override：

```text
/spinner-provider clear
```

下一轮应回退到 `Validating spinner provider…`。

## 5. Session Scope

```text
/spinner-provider reset
/spinner-provider session Indexing workspace
/spinner-provider suffix-session repository
```

连续发送两轮问题，两轮都应显示：

```text
Indexing workspace… (repository · ...)
```

分别清除：

```text
/spinner-provider clear
/spinner-provider suffix-clear
```

## 6. Suffix 开关保留数据

先设置 session suffix：

```text
/spinner-provider suffix-session repository
```

在 `/open-tui` 关闭 External suffix，发送一轮问题，`repository` 不应显示。重新开启后再发送一轮，`repository` 应恢复。

## 7. Stall 颜色

```text
/spinner-provider reset
/spinner-provider stall
```

马上发送：

```text
只回复 OK。
```

验收 provider 会把下一次 provider 请求延迟 6 秒。预期 indicator：

```text
0-3s   accent
3-5s   warning
5-6s   error
响应后  accent
```

延迟只作用一次，不修改 provider payload。

## 8. Tool-use 与 Stall 抑制

发送：

```text
必须调用 bash 工具执行 sleep 6，然后只回复 done。
```

工具执行期间 Spinner 应保持 tool-use 状态，不应因为 6 秒无模型输出变成 warning/error。

## 9. Reduced Motion

在 `/open-tui` 开启 Reduced motion，再发送一轮问题。预期 indicator 是静态 `●`，没有 glyph 动画；timer 和 tokens 仍更新。验证后恢复 Off。

## 10. Footer Timer 去重

保持 Spinner 的 Elapsed timer 和 Hide duplicate footer timer 为 On，发送问题时 Footer 不应再显示 `working Ns`，结束后仍显示 `done Ns`。

关闭 Hide duplicate footer timer 后再发送一轮，Spinner 和 Footer 应同时显示 working timer。

关闭 Footer tab 的 Timer 后，Footer 的 working/done 都应隐藏，但 Spinner timer 不受影响。

## 11. Core Loader

执行：

```text
/compact
```

压缩期间必须显示 Pi 原生 compaction 动画和取消提示。Spinner 不应覆盖它。retry 和 branch summary 同样由 Pi core 管理。

## 12. Cleanup

依次验证：

```text
/reload
/new
/resume
```

以及在 `/open-tui` 关闭 Spinner。每次都不应留下旧 suffix、message、indicator 或重复 listener；关闭 Spinner 后恢复 Pi 默认 working row。

## 13. 终端矩阵

分别启动：

```bash
pi --no-extensions -e ./extensions/open-tui/index.ts -e ./examples/spinner-provider.ts --approve --tui-mode regular
pi --no-extensions -e ./extensions/open-tui/index.ts -e ./examples/spinner-provider.ts --approve --tui-mode fullscreen
```

将终端调整到约 120、80、40 列。窄终端允许 Pi 原生换行，但不能出现控制字符、错位、重叠或 stale message。

## 14. Ownership

额外加载官方 working indicator 示例：

```bash
pi --no-extensions \
  -e ./extensions/open-tui/index.ts \
  -e ./examples/spinner-provider.ts \
  -e ./node_modules/@earendil-works/pi-coding-agent/examples/extensions/working-indicator.ts \
  --approve
```

两个扩展同时写 working indicator 时应表现为 Pi 的 last-writer-wins；退出或 reload 结果受扩展 cleanup 顺序影响，不能出现崩溃。
