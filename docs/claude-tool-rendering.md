# Claude-style tool rendering

`pi-open-tui` renders Pi built-in tools, MCP tools, `shell_command`, `apply_patch`, common OpenAI-style web/task/context tools, and Codex-style multi-agent tools with a shared Claude-style presentation.

## Included behavior

- Adjacent and concurrent tool calls are grouped under one compact status row.
- `edit`, `write`, and `apply_patch` show call-phase diff previews once their arguments are complete.
- Diffs select unified or split layout from the terminal width, include add/remove and hunk statistics, emphasize changed words, and use Shiki syntax highlighting when available.
- Running Bash calls show a live tail preview.
- Read, search, Bash, MCP, and OpenAI-style results each support hidden, summary, or preview output modes.
- Codex-style `spawn_agent`, `send_input`, `wait_agent`, `close_agent`, and `list_agents` calls render as Claude Code-style agent status rows or trees. Standard Codex JSON results work without private metadata; optional structurally compatible progress snapshots add live activity, usage, elapsed time, prompt, response, and error details.
- `Ctrl+O` continues to control Pi's normal collapsed/expanded tool state.

The renderer only changes presentation. It does not replace tool schemas or execution functions. Codex subagent detection is convention-based: exact tool names plus compatible argument/result shapes. It does not import, identify, or depend on any particular subagent package, and it does not require a package-name marker in tool results.

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
    "diffTheme": "github-dark",
    "subagents": {
      "enabled": true,
      "collapsedActivityItems": 3,
      "expandedActivityItems": 200,
      "showToolActivity": true,
      "showUsage": true,
      "showElapsed": true,
      "showExpandHint": true
    }
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
- Configure Codex-style Subagent rendering, collapsed activities from `0–20`, expanded activity retention from `1–5000`, and the tool activity, token usage, elapsed time, and expand-hint fields.

Press `Enter` or `Space` to toggle booleans and cycle enums. Numeric and theme settings open an inline input with validation. Every accepted change is written to `open-tui.json` immediately. Press `Esc` or `←` to return to the main settings panel.

The legacy `/open-tui-tools` command is no longer registered. Changing grouping off immediately restores currently grouped tool components to the normal Pi message tree. Unknown or unsupported tools always fall back to Pi's original renderer.


## Codex-style Subagent matching

The adapter recognizes the public multi-agent convention rather than a package identity:

- tool names: `spawn_agent`, `send_input`, `wait_agent`, `close_agent`, `list_agents`;
- call fields such as `task_name`, `message`, `agent_type`, `target`, `ids`, `timeout_ms`, and `interrupt`;
- standard outputs such as `{ "agent_id": ..., "nickname": ... }`, `{ "submission_id": ... }`, `{ "status": ..., "timed_out": ... }`, `{ "previous_status": ... }`, and `{ "agents": [...] }`;
- Codex status values including `pending_init`, `running`, `interrupted`, `shutdown`, `not_found`, `{ "completed": ... }`, and `{ "errored": ... }`.

A Pi tool may optionally place richer, presentation-neutral snapshots in `result.details`. They are accepted only by structural validation and are never used as a package identity signal. Malformed or unrelated data falls back to Pi's original renderer.
