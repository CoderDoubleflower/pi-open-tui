# Claude-style tool rendering

`pi-open-tui` renders Pi built-in tools, MCP tools, `shell_command`, `apply_patch`, and common OpenAI-style web/task/context tools with a shared Claude-style presentation.

## Included behavior

- Adjacent and concurrent tool calls are grouped under one compact status row.
- `edit`, `write`, and `apply_patch` show call-phase diff previews once their arguments are complete.
- Diffs select unified or split layout from the terminal width, include add/remove and hunk statistics, emphasize changed words, and use Shiki syntax highlighting when available.
- Running Bash calls show a live tail preview.
- Read, search, Bash, MCP, and OpenAI-style results each support hidden, summary, or preview output modes.
- `Ctrl+O` continues to control Pi's normal collapsed/expanded tool state.

The renderer only changes presentation. It does not replace tool schemas or execution functions.

## Configuration

Settings are stored in `~/.pi/agent/open-tui.json` under `toolRendering`:

```json
{
  "toolRendering": {
    "enabled": true,
    "groupToolCalls": true,
    "readOutputMode": "summary",
    "searchOutputMode": "summary",
    "bashOutputMode": "preview",
    "mcpOutputMode": "preview",
    "openAiOutputMode": "preview",
    "previewLines": 8,
    "expandedPreviewMaxLines": 4000,
    "livePreview": true,
    "livePreviewLines": 5,
    "diffCollapsedLines": 24,
    "diffLayout": "auto",
    "diffTheme": "github-dark"
  }
}
```

Output modes are `hidden`, `summary`, and `preview`. Diff layouts are `auto`, `unified`, and `split`.

## Settings panel

Run `/open-tui`, then choose **General → Tool rendering**. The nested panel exposes every `toolRendering` setting:

- Enable or disable Claude-style rendering and adjacent/concurrent tool grouping.
- Choose `hidden`, `summary`, or `preview` independently for Read, Search, Bash, MCP, and OpenAI-style results.
- Set collapsed preview lines from `1–50` and the expanded preview cap from `100–20000`.
- Enable or disable the running-tool live preview and set its line count from `1–20`.
- Set collapsed Diff lines from `4–200`, choose `auto`, `unified`, or `split`, and enter a Shiki theme name up to 80 characters.

Press `Enter` or `Space` to toggle booleans and cycle enums. Numeric and theme settings open an inline input with validation. Every accepted change is written to `open-tui.json` immediately. Press `Esc` or `←` to return to the main settings panel.

The legacy `/open-tui-tools` command is no longer registered. Changing grouping off immediately restores currently grouped tool components to the normal Pi message tree. Unknown or unsupported tools always fall back to Pi's original renderer.
