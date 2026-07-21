# pi-open-tui

A polished TUI for [Pi](https://pi.dev) coding agent. Combines the best of pi-haiku, pi-claude-code-tui, and pi-zentui into one cohesive package.

## What's in it

- **Animated Pi logo header** — 16-frame color-changing logo animation + "Let's build something great" tagline
- **Starship-style footer** — 2 lines showing cwd, git branch/status, runtime version, context bar, model, token counts, and cost
- **Rounded editor** — accent rail + borderMuted rounded corners, clean visual frame
- **60+ runtime detection** — Node, Rust, Go, Python, Ruby, Java, Swift, Kotlin, C/C++, Deno, Bun, and many more
- **Git status** — branch, ahead/behind, modified/untracked/staged/stashed, detached HEAD commit hash + tag
- **Working timer** — live elapsed time while the agent is working, done duration when finished
- **Zero prototype patches** — uses only public Pi APIs (setHeader/setFooter/setEditorComponent), safe across Pi updates
- **Interactive settings UI** — `/open-tui` opens a tabbed settings dialog (Features / Icons / Segments)
- **Auto-collapse resources** — collapses pi's `[Context]`/`[Skills]`/`[Extensions]` startup sections on launch (toggle in settings; press `Ctrl+O` to expand manually)

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
  "autoCollapseResources": true,
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
  }
}
```

- `icons.mode`: `auto` (detect Nerd Font), `nerd` (force Nerd Font glyphs), or `ascii` (plain fallbacks)
- `footerSegments.gitCommit`: shows short hash + tag on detached HEAD (off by default)
- `autoCollapseResources`: collapses pi's `[Context]`/`[Skills]`/`[Extensions]` startup sections on launch (on by default; press `Ctrl+O` to toggle expansion)

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

The animated logo frames are derived from `pi-claude-code-tui`, which in turn derive from Pi's official install script (`pi.dev/install.sh`). The runtime detection list and git porcelain parsing borrow structure from `pi-zentui`.
