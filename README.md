# pi-open-tui

A polished TUI for [Pi](https://pi.dev) coding agent. Combines the best of pi-haiku, pi-claude-code-tui, and pi-zentui into one cohesive package.

![Preview](https://raw.githubusercontent.com/OldSuns/pi-open-tui/main/assets/preview_dashboard_1.png)

## What's in it

- **Animated Pi logo header** — 16-frame color-changing logo animation + "Let's build something great" tagline
- **Starship-style footer** — 2 lines showing cwd, git branch/status, runtime version, context bar, model, token counts, and cost
- **Rounded editor** — accent rail + borderMuted rounded corners, clean visual frame
- **60+ runtime detection** — Node, Rust, Go, Python, Ruby, Java, Swift, Kotlin, C/C++, Deno, Bun, and many more
- **Git status** — branch, ahead/behind, modified/untracked/staged/stashed, detached HEAD commit hash + tag
- **Working timer** — live elapsed time while the agent is working, done duration when finished
- **Turn telemetry** — generation speed, TTFT, stalls, tokens, and list-price rate after each complete agent run
- **Zero prototype patches** — uses public Pi APIs (setHeader/setFooter/setEditorComponent), safe across Pi updates
- **Interactive settings UI** — `/open-tui` opens a tabbed settings dialog (Features / Icons / Segments / Telemetry)

## Install

```bash
pi install npm:pi-open-tui
```

Or try it for one run:

```bash
pi -e npm:pi-open-tui
```

## Configuration

Run `/open-tui` to open the interactive settings UI. Configuration is stored at `~/.pi/agent/open-tui.json`:

```json
{
  "enabled": true,
  "icons": {
    "mode": "auto"
  },
  "footerSegments": {
    "cwd": true,
    "gitBranch": true,
    "gitStatus": true,
    "gitCommit": false,
    "runtime": true,
    "context": true,
    "tokens": true,
    "cost": true
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

- `icons.mode`: `auto` (detect Nerd Font), `nerd` (force Nerd Font glyphs), or `ascii` (plain fallbacks)
- `footerSegments.gitCommit`: shows short hash + tag on detached HEAD (off by default)

## Turn telemetry

After each complete agent run, open-tui shows one transient notification. Tool-call turns are aggregated into that single result:

```text
> TPS 42.5 tok/s | ~ TTFT 1.2s | + 29.7s | ↑ 567 | ↓ 1.2k | ! stall 1x / 4.3s | $ $3.60/M
```

The notification uses the footer's icon mode and semantic theme colors. Configure its master switch and individual TPS, TTFT, duration, token, stall, and cost segments from the **Telemetry** tab in `/open-tui`.

TPS excludes time-to-first-token, detected stalls, and tool execution between messages. In a multi-turn agent run, it is weighted from the turns with measurable streaming spans; an unmeasurable tool turn no longer hides a measurable final response. A rate that cannot be identified reliably is shown as `TPS —`. The `stall` segment shows occurrence count followed by accumulated duration. The optional `$ / M` value uses the model's list-price `usage.cost.total`; it is not the session's cumulative cost shown in the footer.

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
