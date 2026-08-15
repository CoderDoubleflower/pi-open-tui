# pi-open-tui

A polished TUI for [Pi](https://pi.dev) coding agent. Combines the best of pi-haiku, pi-claude-code-tui, and pi-zentui into one cohesive package.

![Preview](https://raw.githubusercontent.com/OldSuns/pi-open-tui/main/assets/preview_dashboard_1.png)

## What's in it

- **Animated Pi logo header** — 16-frame color-changing logo animation + "Let's build something great" tagline
- **Starship-style footer** — 2 lines showing cwd, git branch/status, runtime version, context bar, model, token counts, and cost
- **Full-width prompt editor** — horizontal borders with a fixed `❯` prompt and aligned continuation lines
- **60+ runtime detection** — Node, Rust, Go, Python, Ruby, Java, Swift, Kotlin, C/C++, Deno, Bun, and many more
- **Git status** — branch, ahead/behind, modified/untracked/staged/stashed, detached HEAD commit hash + tag
- **Working timer** — live elapsed time while the agent is working, done duration when finished
- **Turn telemetry** — generation speed, TTFT, stalls, tokens, and list-price rate after each complete agent run
- **Zero prototype patches** — uses public Pi APIs (setHeader/setFooter/setEditorComponent), safe across Pi updates
- **Interactive settings UI** — `/open-tui` opens a tabbed settings dialog (General / Icons / Footer / Telemetry)
- **Claude-inspired theme** — optional dark theme with a `#d78787` accent and terminal-friendly backgrounds

## Install

```bash
pi install npm:pi-open-tui
```

Or try it for one run:

```bash
pi -e npm:pi-open-tui
```

## Theme

The package includes the optional `claude-theme` dark theme. After installing the package, open `/settings` and select `claude-theme` from the theme list. The package does not change your active theme automatically.

## Configuration

Run `/open-tui` to open the interactive settings UI. Configuration is stored at `~/.pi/agent/open-tui.json`:

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
    "extensionStatuses": true
  },
  "telemetry": {
    "enabled": true,
    "tps": true,
    "ttft": true,
    "duration": true,
    "tokens": true,
    "stalls": true,
    "cost": true
  }
}
```

- `settingsLanguage`: language for the `/open-tui` settings UI only; `en` or `zh`
- `editor.dynamicBorderColor`: when `false` (default), editor borders use RGB `(103,103,103)`; when `true`, only the horizontal borders follow Pi's bash/thinking color
- `editor.autocompleteDirection`: completion menu placement; `up` (default) opens above the editor and `down` opens below it
- `icons.mode`: `auto` (detect Nerd Font), `nerd` (force Nerd Font glyphs), or `ascii` (plain fallbacks)
- `footerSegments.sessionName`: shows the current session name next to cwd (off by default); hidden when the session has no name
- `footerSegments.gitCommit`: shows short hash + tag on detached HEAD (off by default)
- `footerSegments.extensionStatuses`: shows statuses published by extensions through Pi's `setStatus()` API (on by default); turn it off to hide the whole status line, including MCP

## Custom Footer script

Set `footerScript` to the absolute path of an executable file to replace the built-in Footer. The file must have execute permission and a valid shebang. It is launched directly in the current project directory; no shell command interpolation is used.

See [`examples/open-tui-footer.sh`](examples/open-tui-footer.sh) for a complete executable demo with ANSI colors, cache hit rate, extension statuses, and commented mappings for every protocol field.

```json
{
  "footerScript": "/home/me/.pi/agent/footer.sh"
}
```

The script receives one UTF-8 JSON object on stdin. Protocol `version: 1` provides:

- `terminal.width` and `time.{nowMs,nowIso}`
- `session.{cwd,name,startedAtMs}`
- `model.{id,name,provider,reasoning,thinkingLevel,contextWindow}`
- `context.{tokens,contextWindow,percent}`
- `usage.{input,output,cacheRead,cacheWrite,cost,latestCacheHitRate}`
- complete `git` status and optional `runtime`
- `timer.{working,workingSinceMs,workingElapsedMs,lastDoneInMs}`
- `extensionStatuses`, sorted by extension id

Missing values are JSON `null`. Raw messages, credentials, and environment variables are never included. A minimal script:

```sh
#!/bin/sh
payload=$(cat)
printf 'custom footer\n'
```

Stdout becomes the Footer and may contain multiple lines and ANSI SGR colors. Other terminal control sequences are removed, and each line is clipped to the terminal width. Empty stdout hides the Footer.

Execution is asynchronous and cached. State changes or terminal width changes trigger a refresh; while the agent is working, refreshes are limited to once per second. The timeout is 1000 ms. On failure, the most recent successful output remains visible; before the first success, open-tui falls back to the built-in Footer and emits one warning per failure streak. `footerScript` always takes precedence over every `footerSegments` menu setting.

## Turn telemetry

After each complete agent run, open-tui shows one transient notification. Tool-call turns are aggregated into that single result:

```text
> TPS 42.5 tok/s | ~ TTFT 1.2s | + 29.7s | ↑ 567 | ↓ 1.2k | ! stall 1x / 4.3s | $ $3.60/M
```

The notification uses the footer's icon mode and semantic theme colors. Configure its master switch and individual TPS, TTFT, duration, token, stall, and cost segments from the **Telemetry** tab in `/open-tui`.

TPS is the complete generation throughput for the agent run: all provider-reported assistant output tokens divided by the summed generation time of every LLM turn, measured from `turn_start` through the assistant `message_end`. This includes time-to-first-token, hidden reasoning, buffering, and stalls so the token count and timing cover the same interval. Tool execution between turns is excluded. A run with no output tokens or no measurable generation time is shown as `TPS —`. The `stall` segment shows occurrence count followed by accumulated duration. The optional `$ / M` value uses the model's list-price `usage.cost.total`; it is not the session's cumulative cost shown in the footer.

## Local development

```bash
pi -e .
```

## License

MIT

## Acknowledgements

This project builds on the work of several Pi community packages:

- **[pi-haiku](https://github.com/nnocte/pi-haiku)** — the 2-line footer structure (location+model · timer+context) and working-timer pattern
- **[pi-claude-code-tui](https://github.com/Phoobobo/pi-claude-code-tui)** — the 16-frame animated Pi logo and rounded editor border technique
- **[pi-zentui](https://github.com/lmilojevicc/pi-zentui)** — the Starship-style footer segments (git status icons, runtime detection, context gauge), generation-based session lifecycle, and interactive settings UI pattern
- **[pi-tps](https://github.com/monotykamary/pi-tps)** — the turn timing, stall detection, and conservative TPS measurement approach

The animated logo frames are derived from `pi-claude-code-tui`, which in turn derive from Pi's official install script (`pi.dev/install.sh`). The runtime detection list and git porcelain parsing borrow structure from `pi-zentui`.

Special thanks to the **[LINUX DO](https://linux.do)** community for their support.
