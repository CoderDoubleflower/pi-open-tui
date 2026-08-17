# ClaudeCodeRev 底部 Spinner 显示逻辑整理

> 基于 `CoderDoubleflower/ClaudeCodeRev` 当前 `master` 源码整理。<br>
> 本文仅整理主 Agent / 普通 CLI Spinner 相关逻辑，不包含 teammate / subagent 相关显示与状态。

## 1. 总览

Claude Code 的底部 Spinner 并不是一个简单的“动画图标 + Thinking...”组件，而是由以下几部分共同组成：

```text
[Spinner Glyph] [主消息…] [(metadata)]
```

典型示例：

```text
✻ Working…
✻ Working… (thinking)
✻ Working… (thinking with high effort)
✻ Working… (12s · ↓ 1.2k tokens)
✻ Working… (12s · ↓ 1.2k tokens · thought for 4s)
```

其中：

- Spinner Glyph：动态字符动画；
- 主消息：随机 spinner verb、Todo 文案或 override message；
- metadata：`spinnerSuffix`、计时、token、thinking/thought 状态；
- 下方还可能独立显示 `Next:`、`Tip:`、`Target:`。

---

## 2. 主消息的来源和优先级

主消息的选择优先级为：

```text
overrideMessage
    ↓
currentTodo.activeForm
    ↓
currentTodo.subject
    ↓
random spinner verb
```

可以表达为：

```ts
const verb =
  overrideMessage ??
  currentTodo?.activeForm ??
  currentTodo?.subject ??
  randomVerb

const message = verb + '…'
```

因此默认随机文案并不是唯一来源。

例如当前 Todo 为：

```text
subject: Fix authentication bug
activeForm: Fixing authentication bug
```

则 Spinner 会显示：

```text
✻ Fixing authentication bug…
```

而不是随机的：

```text
✻ Pondering…
```

### 2.1 随机 verb 的生命周期

随机 verb 使用 React state initializer 只在 Spinner 组件挂载时抽取一次：

```ts
useState(() => sample(getSpinnerVerbs()))
```

因此同一轮处理中不会每个动画帧随机切换 verb。

---

## 3. 内置 Spinner Verbs

ClaudeCodeRev 当前内置 **187 个** Spinner Verbs。

完整列表：

```text
Accomplishing
Actioning
Actualizing
Architecting
Baking
Beaming
Beboppin'
Befuddling
Billowing
Blanching
Bloviating
Boogieing
Boondoggling
Booping
Bootstrapping
Brewing
Bunning
Burrowing
Calculating
Canoodling
Caramelizing
Cascading
Catapulting
Cerebrating
Channeling
Channelling
Choreographing
Churning
Clauding
Coalescing
Cogitating
Combobulating
Composing
Computing
Concocting
Considering
Contemplating
Cooking
Crafting
Creating
Crunching
Crystallizing
Cultivating
Deciphering
Deliberating
Determining
Dilly-dallying
Discombobulating
Doing
Doodling
Drizzling
Ebbing
Effecting
Elucidating
Embellishing
Enchanting
Envisioning
Evaporating
Fermenting
Fiddle-faddling
Finagling
Flambéing
Flibbertigibbeting
Flowing
Flummoxing
Fluttering
Forging
Forming
Frolicking
Frosting
Gallivanting
Galloping
Garnishing
Generating
Gesticulating
Germinating
Gitifying
Grooving
Gusting
Harmonizing
Hashing
Hatching
Herding
Honking
Hullaballooing
Hyperspacing
Ideating
Imagining
Improvising
Incubating
Inferring
Infusing
Ionizing
Jitterbugging
Julienning
Kneading
Leavening
Levitating
Lollygagging
Manifesting
Marinating
Meandering
Metamorphosing
Misting
Moonwalking
Moseying
Mulling
Mustering
Musing
Nebulizing
Nesting
Newspapering
Noodling
Nucleating
Orbiting
Orchestrating
Osmosing
Perambulating
Percolating
Perusing
Philosophising
Photosynthesizing
Pollinating
Pondering
Pontificating
Pouncing
Precipitating
Prestidigitating
Processing
Proofing
Propagating
Puttering
Puzzling
Quantumizing
Razzle-dazzling
Razzmatazzing
Recombobulating
Reticulating
Roosting
Ruminating
Sautéing
Scampering
Schlepping
Scurrying
Seasoning
Shenaniganing
Shimmying
Simmering
Skedaddling
Sketching
Slithering
Smooshing
Sock-hopping
Spelunking
Spinning
Sprouting
Stewing
Sublimating
Swirling
Swooping
Symbioting
Synthesizing
Tempering
Thinking
Thundering
Tinkering
Tomfoolering
Topsy-turvying
Transfiguring
Transmuting
Twisting
Undulating
Unfurling
Unravelling
Vibing
Waddling
Wandering
Warping
Whatchamacalliting
Whirlpooling
Whirring
Whisking
Wibbling
Working
Wrangling
Zesting
Zigzagging
```

真实显示时统一追加 Unicode 省略号 `…`：

```text
Working…
Pondering…
Clauding…
```

### 3.1 用户可自定义 Spinner Verbs

`settings.spinnerVerbs` 支持两种策略。

#### replace

```text
mode = replace
```

如果配置的 `verbs` 非空，则完全替换内置列表。

#### append

其他模式会将用户 verbs 追加到默认 187 个 verb 后面：

```text
[...SPINNER_VERBS, ...config.verbs]
```

因此从程序能力上看，主消息并不是一个封闭的 187 项集合。

---

## 4. Spinner metadata 的整体结构

主消息后方可能出现 metadata：

```text
Working… (12s · ↓ 1.2k tokens · thinking with high effort)
```

metadata 的生成顺序固定为：

```text
spinnerSuffix
→ elapsed time
→ tokens
→ thinking/thought
```

各字段之间使用：

```text
" · "
```

即：

```text
空格 + · + 空格
```

示例：

```text
Working… (<suffix> · 12s · ↓ 450 tokens · thinking)
```

---

## 5. Thinking 状态机

Thinking 不是简单地根据当前 `mode` 即时显示/隐藏。

源码维护：

```ts
thinkingStatus: 'thinking' | number | null
```

对应三个阶段：

```text
null
  ↓
thinking
  ↓
duration(ms)
  ↓
null
```

---

## 6. Thinking 开始时

当：

```text
mode === 'thinking'
```

首次进入时记录：

```text
thinkingStart = Date.now()
thinkingStatus = 'thinking'
```

此时显示：

```text
thinking
```

如果当前显式 effort 存在，则显示：

```text
thinking with <level> effort
```

可能的完整文本为：

```text
thinking
thinking with low effort
thinking with medium effort
thinking with high effort
thinking with max effort
```

示例：

```text
✻ Working… (thinking)
```

或：

```text
✻ Working… (thinking with high effort)
```

---

## 7. Effort 文案规则

Effort level 集合：

```text
low
medium
high
max
```

Spinner 中的 suffix 模板固定为：

```text
 with <level> effort
```

例如：

```text
 with low effort
 with medium effort
 with high effort
 with max effort
```

但源码有一个重要条件：

> 只有存在显式 `effortValue` 时，`getEffortSuffix()` 才会返回文案。

如果：

```text
effortValue === undefined
```

则：

```text
effortSuffix = ''
```

即 Spinner 只显示：

```text
thinking
```

而不是自动显示默认 high/medium。

另外，`max` 如果应用到不支持 max effort 的模型，解析阶段会降级到 `high`。

---

## 8. Thinking 最短展示时间

Thinking 状态有 UI 防抖逻辑。

目标是：

> `thinking` 至少可见约 2 秒，避免极短 thinking 导致 UI 一闪而过。

流程：

```text
进入 thinking
    ↓
记录开始时间
    ↓
离开 thinking
    ↓
计算真实 thinking duration
    ↓
如果 thinking 不足 2s
    ↓
继续保持 thinking 到满 2s
    ↓
显示 thought for Ns
```

因此，即使模型只 thinking 了几百毫秒，也不会立刻切换成完成态。

---

## 9. Thinking 结束后的 `thought for Ns`

Thinking 结束后：

```text
thinkingStatus = duration(ms)
```

显示：

```text
thought for <N>s
```

秒数计算：

```ts
Math.max(1, Math.round(duration / 1000))
```

因此最小为：

```text
thought for 1s
```

可能出现：

```text
thought for 1s
thought for 2s
thought for 3s
thought for 10s
...
```

示例：

```text
✻ Working… (thought for 4s)
```

### 9.1 完成态保留时间

`thought for Ns` 会继续显示约：

```text
2 秒
```

随后：

```text
thinkingStatus = null
```

Thinking metadata 才完全消失。

完整时序：

```text
thinking
    ↓
至少显示到约 2s
    ↓
thought for Ns
    ↓
约 2s
    ↓
消失
```

---

## 10. Thinking shimmer

正在 thinking 时，`thinking...` metadata 自身还带独立 shimmer。

常量：

```text
THINKING_DELAY_MS = 3000
THINKING_GLOW_PERIOD_S = 2
```

也就是说：

- thinking 开始后的前 3 秒不做 glow；
- 3 秒后开始周期性 shimmer；
- glow 周期约 2 秒。

颜色在：

```text
RGB(153,153,153)
```

与：

```text
RGB(185,185,185)
```

之间正弦插值。

当 `reducedMotion = true` 时，不使用动态 thinking shimmer。

---

## 11. elapsed time 计时

计时来源是 wall-clock elapsed time：

```text
Date.now()
- loadingStartTime
- totalPausedMs
```

如果当前处于 pause，则以：

```text
pauseStartTime
```

作为当前时间，从而冻结 elapsed time。

格式通过：

```text
formatDuration(...)
```

生成，例如：

```text
5s
12s
1m 5s
...
```

---

## 12. timer 和 token 的出现条件

普通主 Spinner 下：

```text
verbose === true
```

或者：

```text
elapsed > 30_000 ms
```

才会尝试显示：

```text
timer
tokens
```

即：

### 非 verbose

前 30 秒通常：

```text
✻ Working…
```

超过约 30 秒后：

```text
✻ Working… (31s · ↓ 1.2k tokens)
```

### verbose

从任务开始就允许显示：

```text
✻ Working… (1s · ↓ 50 tokens)
```

实际是否显示仍受终端宽度限制。

---

## 13. Token 数并不是 API 的精确 token usage

这是实现中非常重要的一点。

源码先维护：

```text
responseLengthRef
```

然后计算：

```ts
const leaderTokens =
  Math.round(displayedResponseLength / 4)
```

也就是说：

> Spinner 中显示的 token 数，本质上是用 response length 除以 4 得到的近似值。

并不是直接读取模型 API 的精确 output token usage。

---

## 14. Token counter 使用平滑追赶动画

为了避免 token 数突然大跳，显示值不会立即跳到最新 `responseLength`。

每约 50ms 更新一次。

当 gap：

### 小于 70

```text
increment = 3
```

### 小于 200

```text
increment = max(8, ceil(gap * 0.15))
```

### 大于等于 200

```text
increment = 50
```

因此视觉上 token counter 会逐步追上真实的 response length，而不是瞬间跳变。

如果 `reducedMotion = true`，则直接同步到当前值，不做平滑追赶。

---

## 15. Token 方向箭头

Token metadata 根据当前 Spinner mode 加方向箭头。

### 下行 `↓`

以下模式：

```text
tool-input
tool-use
responding
thinking
```

显示：

```text
↓ <N> tokens
```

例如：

```text
↓ 1.2k tokens
```

### 上行 `↑`

`requesting` 模式显示：

```text
↑ <N> tokens
```

例如：

```text
↑ 850 tokens
```

---

## 16. metadata 的完整可能组合

仅有 thinking：

```text
Working… (thinking)
```

带 effort：

```text
Working… (thinking with high effort)
```

只有 timer：

```text
Working… (12s)
```

timer + tokens：

```text
Working… (12s · ↓ 450 tokens)
```

timer + tokens + thinking：

```text
Working… (12s · ↓ 450 tokens · thinking)
```

timer + tokens + thinking + effort：

```text
Working… (12s · ↓ 450 tokens · thinking with high effort)
```

Thinking 完成后：

```text
Working… (12s · ↓ 450 tokens · thought for 3s)
```

有 suffix：

```text
Working… (<suffix>)
```

完整组合：

```text
Working… (<suffix> · 12s · ↓ 450 tokens · thinking)
```

---

## 17. 一个特殊的 `thinkingOnly` 显示形式

如果当前：

```text
showThinking = true
thinkingStatus = thinking
spinnerSuffix 不存在
timer 不显示
tokens 不显示
```

则进入：

```text
thinkingOnly
```

这时 `(thinking)` 自身由 thinking text 负责包含括号，而不是外围统一包括号。

视觉结果仍是：

```text
Working… (thinking)
```

但内部组件结构不同。

---

## 18. 终端宽度不足时的 Progressive Width Gating

Claude Code 不会简单地把整个 metadata 一刀截断。

它会根据剩余宽度决定哪些字段显示。

可用空间近似：

```text
columns
- 主消息宽度
- 固定布局开销
```

然后逐项判断。

### 18.1 Thinking 优先判断

首先尝试显示完整：

```text
thinking with high effort
```

如果完整 effort 文案放不下，但裸：

```text
thinking
```

放得下，则自动降级为：

```text
thinking
```

也就是说：

```text
thinking with high effort
        ↓ 宽度不足
thinking
```

如果连 `thinking` 都放不下，则 thinking metadata 完全隐藏。

### 18.2 Timer

在 thinking 占用空间之后，再判断 timer 是否能放下。

### 18.3 Tokens

最后判断 token 是否还能放下。

因此字段的空间预算逻辑是：

```text
thinking
→ timer
→ tokens
```

而最终实际输出字段顺序仍为：

```text
suffix
→ timer
→ tokens
→ thinking
```

这是两个不同概念：

- **空间分配优先级**：thinking → timer → tokens；
- **最终排列顺序**：suffix → timer → tokens → thinking。

### 18.4 示例

宽终端：

```text
✻ Implementing authentication… (42s · ↓ 3.2k tokens · thinking with high effort)
```

变窄后可能成为：

```text
✻ Implementing authentication… (42s · thinking with high effort)
```

再窄：

```text
✻ Implementing authentication… (thinking)
```

再窄：

```text
✻ Implementing authentication…
```

因此 Spinner metadata 是 responsive UI，而不是固定字符串。

---

## 19. Spinner Glyph 动画

默认基础字符由平台决定。

### macOS

```text
·
✢
✳
✶
✻
✽
```

### Ghostty

```text
·
✢
✳
✶
✻
*
```

Ghostty 用 `*` 替代最后的 `✽`，源码注释原因是 `✽` 在 Ghostty 中存在轻微垂直偏移。

### 其他平台

```text
·
✢
*
✶
✻
✽
```

---

## 20. Spinner Glyph 实际动画帧

动画不是只顺序播放 6 个字符，而是：

```ts
[
  ...DEFAULT_CHARACTERS,
  ...DEFAULT_CHARACTERS.reverse()
]
```

即正序 + 倒序。

因此 macOS 的一个完整周期为：

```text
·
✢
✳
✶
✻
✽
✽
✻
✶
✳
✢
·
```

共：

```text
12 frame
```

Spinner frame 计算：

```ts
Math.floor(time / 120)
```

即大约：

```text
120ms / frame
```

---

## 21. Reduced Motion

启用：

```text
prefersReducedMotion
```

后，不再播放字符序列。

改为固定：

```text
●
```

这个圆点以：

```text
2 秒
```

为完整周期：

```text
1 秒正常
1 秒 dim
```

循环。

也就是：

```text
●
● (dim)
●
● (dim)
...
```

Reduced Motion 同时会关闭多种平滑/动态效果：

- glyph 字符序列；
- glimmer；
- thinking shimmer；
- token counter 平滑追赶。

---

## 22. 主消息 Glimmer 动画

Spinner 主消息还有扫光效果。

例如：

```text
Working…
```

并不是纯静态文字。

Glimmer 的方向和速度取决于 mode。

### requesting

```text
glimmerSpeed = 50ms
```

并使用一个方向扫描。

### 其他模式

```text
glimmerSpeed = 200ms
```

扫描方向与 requesting 相反。

因此 `requesting` 在视觉上会明显更快。

---

## 23. tool-use 模式额外 Flash

当：

```text
mode === 'tool-use'
```

时，还会计算：

```ts
(Math.sin((time / 1000) * Math.PI) + 1) / 2
```

作为 flash opacity。

也就是说工具使用状态下，主消息会多一个周期性明暗效果。

---

## 24. Stall 检测

Spinner 还会检测“模型是否长时间没有继续输出”。

核心条件：

```text
连续超过 3 秒没有新增 response
AND
当前没有 active tool
```

则：

```text
isStalled = true
```

### 24.1 新 token 到达时

只要：

```text
currentResponseLength > lastResponseLength
```

就会：

```text
重置 lastTokenTime
重置 stalledIntensity
```

Spinner 恢复正常状态。

### 24.2 工具执行期间

如果：

```text
hasActiveTools === true
```

stall timer 会持续归零。

因此：

> 工具正在执行时，即使模型暂时没有输出 token，也不会误判为 stall。

---

## 25. Stall 渐红动画

超过 3 秒后并不是立即变成纯红。

强度：

```ts
(timeSinceLastToken - 3000) / 2000
```

最大为：

```text
1
```

因此：

```text
0～3s      正常
3～5s      逐渐变红
5s+        达到最大目标强度
```

目标错误红：

```text
RGB(171, 43, 63)
```

Spinner 会从主题本来的 message color 平滑插值到该颜色。

同时，stall 状态会停止主消息的 glimmer。

文本本身不会改变。

例如：

```text
✻ Working…
```

仍然是：

```text
✻ Working…
```

只是颜色发生变化。

如果当前显式设置了 `overrideColor`，则 stall intensity 不应用到 Spinner 行。

---

## 26. 下方 `Next:` 文本

如果存在 pending task，会寻找下一个可执行任务。

优先选择：

```text
没有被 unresolved task 阻塞的 pending task
```

如果找不到，则 fallback 到第一个 pending task。

显示：

```text
Next: <task.subject>
```

例如：

```text
Next: Run integration tests
```

`Next:` 的优先级高于普通 `Tip:`。

---

## 27. `Tip:` 文本

Spinner 可以接收：

```text
spinnerTip
```

并显示：

```text
Tip: <spinnerTip>
```

此外源码中还有时间触发的 override tip。

### 27.1 超过 30 秒

如果：

```text
tipsEnabled
elapsed > 30s
尚未使用过 /btw
没有 nextTask
```

显示：

```text
Tip: Use /btw to ask a quick side question without interrupting Claude's current work
```

### 27.2 超过 30 分钟

如果：

```text
tipsEnabled
elapsed > 30min
没有 nextTask
```

显示：

```text
Tip: Use /clear to start fresh when switching topics and free up context
```

30 分钟 `/clear` tip 的优先级高于 `/btw` tip。

总体优先关系近似为：

```text
Next task
    ↓
/clear time tip
    ↓
/btw time tip
    ↓
spinnerTip
```

---

## 28. Token Budget `Target:` 文本

该功能受：

```text
feature('TOKEN_BUDGET')
```

控制。

### 尚未达到 budget

显示：

```text
Target: <tokens> / <budget> (<pct>%)
```

例如：

```text
Target: 4.2k / 10k (42%)
```

### ETA

当：

```text
elapsed > 5s
tokens >= 2000
```

才计算生成速率。

如果能够计算 ETA，则：

```text
Target: 4.2k / 10k (42%) · ~35s
```

### 达到 budget

当：

```text
tokens >= budget
```

显示：

```text
Target: <tokens> used (<budget> min ✓)
```

视觉示例：

```text
Target: 10.5k used (10k min ✓)
```

---

# 29. Brief / Assistant 模式

ClaudeCodeRev 当前还有一套完全不同的 `BriefSpinner`。

它不是：

```text
✻ Working…
```

而是单行文字 + 点动画：

```text
Working.
Working..
Working...
```

点动画：

```text
.
..
...
```

循环。

每一帧占固定 3 列，避免右侧文本随着点数量变化而水平抖动。

---

## 30. Brief 模式主 verb

Brief 模式仍然：

```text
overrideMessage
    ↓
random spinner verb
```

随机 verb 仍来自同一套 `getSpinnerVerbs()`。

所以可能看到：

```text
Pondering.
Pondering..
Pondering...
```

或：

```text
Working.
Working..
Working...
```

---

## 31. Brief 模式点动画频率

源码：

```ts
const dotFrame = Math.floor(time / 300) % 3
```

因此大约：

```text
300ms
```

切换一次：

```text
.
..
...
```

Reduced Motion 下直接使用：

```text
…
```

不再播放点数量动画。

---

## 32. Brief 模式的连接异常文案

如果远程连接状态为：

```text
reconnecting
```

主 verb 被覆盖成：

```text
Reconnecting
```

动画：

```text
Reconnecting.
Reconnecting..
Reconnecting...
```

如果：

```text
disconnected
```

则：

```text
Disconnected.
Disconnected..
Disconnected...
```

连接异常状态不会播放正常的 working shimmer，因为 shimmer 会让异常状态看起来像“正在正常工作”。

Reduced Motion 下使用 Unicode 省略号：

```text
Reconnecting…
Disconnected…
```

---

## 33. Brief 模式后台任务计数

如果有 background task：

```text
<N> in background
```

会右对齐显示。

例如：

```text
Working...                                      2 in background
```

或：

```text
Reconnecting...                                 3 in background
```

---

## 34. Brief Idle Status

Brief 模式空闲状态使用一个单独的 placeholder，以保持 Spinner 出现/消失时输入框不发生垂直跳动。

连接重试时：

```text
Reconnecting…
```

断开时：

```text
Disconnected
```

注意：

> Idle Status 的 `Disconnected` 没有 Unicode `…`。

如果还有 background task，则右边仍可出现：

```text
2 in background
```

例如：

```text
Disconnected                                   2 in background
```

如果：

```text
无连接警告
AND
无 background task
```

则不显示文本，只保留固定高度。

---

# 35. 普通 Spinner 的最终状态机

去掉所有 teammate 相关逻辑后，可以将普通 Spinner 简化为：

```text
                         ┌─ overrideMessage
                         │
主消息来源 ──────────────┼─ currentTodo.activeForm
                         │
                         ├─ currentTodo.subject
                         │
                         └─ random spinner verb
                                  │
                                  └─ +"…"
```

metadata：

```text
spinnerSuffix
    ↓
timer
    ↓
token count
    ↓
thinking / thought
```

Thinking：

```text
mode = thinking
    ↓
thinking
    ↓
thinking with <effort>       // 显式 effort 时
    ↓
thinking 至少维持约 2s
    ↓
thought for Ns
    ↓
约 2s
    ↓
消失
```

timer / token：

```text
verbose
OR
elapsed > 30s
    ↓
允许显示 timer / token
```

宽度不足时：

```text
完整 thinking + effort
    ↓ 放不下
裸 thinking
    ↓ 放不下
隐藏 thinking

然后再按剩余空间决定 timer
然后再决定 tokens
```

stall：

```text
无 active tool
AND
3s 无新输出
    ↓
进入 stalled
    ↓
约 2s 渐红
```

---

# 36. 对标实现时最重要的行为清单

如果目标是在其他 TUI 中复刻 Claude Code 的底部 Spinner，真正需要复刻的不是只有 187 个随机词，而是以下完整行为：

1. **主文案优先级**

   ```text
   overrideMessage
   > Todo activeForm
   > Todo subject
   > random verb
   ```

2. **随机 verb 一轮任务内保持稳定**

3. **统一追加 Unicode `…`**

4. **Thinking 独立状态机**

   ```text
   thinking
   → thought for Ns
   → null
   ```

5. **thinking 最少展示约 2 秒**

6. **thought for Ns 再保留约 2 秒**

7. **显式 effort 才追加**

   ```text
   with low/medium/high/max effort
   ```

8. **Thinking 3 秒后开始独立 shimmer**

9. **非 verbose 模式约 30 秒后才开放 timer/token**

10. **verbose 模式从一开始就允许 timer/token**

11. **Token 是 `responseLength / 4` 的近似值**

12. **Token counter 平滑追赶**

13. **requesting 用 `↑`，其他主要输出状态用 `↓`**

14. **metadata 最终排列**

    ```text
    suffix · timer · tokens · thinking
    ```

15. **metadata 使用 ` · ` 作为 separator**

16. **响应式宽度裁剪**

17. **effort 放不下时先降级成裸 `thinking`**

18. **Spinner Glyph 使用正序 + 倒序的 ping-pong 动画**

19. **不同终端平台 glyph 集不同**

20. **Reduced Motion 使用 `●` 明暗闪烁**

21. **requesting glimmer 更快且方向不同**

22. **tool-use 有额外 flash**

23. **3 秒无输出且无 active tool 时进入 stall**

24. **stall 在接下来约 2 秒逐渐变红**

25. **工具执行期间关闭 stall 检测**

26. **stall 时停止 glimmer**

27. **下方支持 `Next:`**

28. **30 秒后可自动出现 `/btw` Tip**

29. **30 分钟后可自动出现 `/clear` Tip**

30. **Token Budget 可显示 `Target:` / percentage / ETA**

31. **Brief 模式使用独立的 `Verb.` / `Verb..` / `Verb...` 动画**

32. **Brief 模式连接异常覆盖普通 verb**

---

# 37. 主要源码位置

本整理基于以下 ClaudeCodeRev `master` 源码：

```text
src/components/Spinner.tsx
src/components/Spinner/SpinnerAnimationRow.tsx
src/components/Spinner/SpinnerGlyph.tsx
src/components/Spinner/useStalledAnimation.ts
src/components/Spinner/utils.ts
src/constants/spinnerVerbs.ts
src/utils/effort.ts
```

其中最核心的三个文件：

```text
Spinner.tsx
```

负责：

- 主 verb 选择；
- Todo override；
- Thinking 状态机；
- effort suffix；
- Tip / Next / Target；
- BriefSpinner。

```text
Spinner/SpinnerAnimationRow.tsx
```

负责：

- 50ms 动画时钟；
- elapsed time；
- token 平滑计数；
- thinking 文案；
- width gating；
- metadata 拼接；
- glimmer / tool-use flash；
- mode 对应的 token 箭头。

```text
Spinner/SpinnerGlyph.tsx
```

负责：

- glyph 动画；
- reduced motion；
- stalled 渐红。

---

## 38. 一句话总结

Claude Code 的底部 Spinner 本质上是一套 **带响应式布局的实时状态展示系统**：

```text
动态 Glyph
+ 动态任务主文案
+ Thinking 状态机
+ Effort
+ Timer
+ Token 近似统计
+ Responsive metadata
+ Stall detection
+ Glimmer / Flash
+ Todo / Tip / Budget 辅助信息
+ Brief 模式
```

真正影响使用体验的是这些状态的**出现时机、保留时间、切换顺序和宽度降级策略**，而不是单独的动画字符或随机 verb。
