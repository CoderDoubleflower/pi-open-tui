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

## Runtime command

Use `/open-tui-tools status` to inspect the active configuration. Other commands persist immediately:

```text
/open-tui-tools enabled on|off|toggle
/open-tui-tools group on|off|toggle
/open-tui-tools read|search|bash|mcp|openai hidden|summary|preview
/open-tui-tools preview <1-50>
/open-tui-tools expanded <100-20000>
/open-tui-tools live on|off|toggle
/open-tui-tools live-lines <1-20>
/open-tui-tools diff-lines <4-200>
/open-tui-tools diff-layout auto|unified|split
/open-tui-tools diff-theme <shiki-theme>
```

Changing grouping off immediately restores currently grouped tool components to the normal Pi message tree. Unknown or unsupported tools always fall back to Pi's original renderer.
