# Claude Code improvements

Plugins and setup tips for Claude Code, shared from my own setup.

## Plugins

### agent-sidebar

Keeps track of the subagents in a session and makes it obvious which agent you are talking to.

- **Agents pane on the right.** Lists every subagent of the session as a tree: an agent started by another agent is indented under it. It opens by itself when the first subagent starts, or with `/agents-sidebar`. Click a row to switch to that agent, or "Main agent" to switch back. A totals line at the top counts running, done and failed agents. Each row shows:
  - the agent type, what it is doing (testing, building, editing, reading, browsing, git, shell, thinking, ...), how long it has run (or took) and its model
  - its status and task
  - the folder or worktree it works in, when that is not the session's own folder
  - its latest tool call, such as `now: Bash: dotnet test`
  - the files it changed, such as `files: Lease.cs, LeaseTests.cs (+2)`
  - `⚠ same file as Explore: Lease.cs` in red when another running agent (or the main agent) edited the same file, with a pop-up when it first happens
  - its last test result, such as `tests: ✓ 412 passed` or `tests: ✗ 3 failed of 415` (read from the `dotnet test` summary)
  - once finished, the first line of its answer, such as `→ 3 blockers found in the review`
  - the skills it used, such as `skills: code-review ×2, precommit`
  - `⚠ quiet 3m` in orange when a running agent has made no tool call or model reply for 3 minutes
  - `⚠ still open 6m` when it finished or went idle but was never closed
- **Background commands.** A "Background" section lists the commands and monitors running in the background, from the main agent or any subagent, with what they do (testing, building, watching, ...), how long they have run and which agent started them. A server started in the background shows its port, such as `server :8123`, until it stops. A finished command stays for 2 minutes with ✓ or ✗, and a test run with its result.
- **Memory warning.** `⚠ 3 builds/tests at once (limit 3): memory risk` in orange at the top when 3 or more `dotnet build`, `dotnet test`, `dotnet run` or `gd-test` commands run at once across all agents, in the foreground or the background.
- **Yellow warning banner.** While a subagent's transcript is in view, a yellow banner above the prompt says so, because your next message then goes to that subagent and not to the main agent. It has a "Back to main" button.
- **Finish notices.** A short pop-up when a subagent finishes or fails.
- **Reminders to close finished subagents.** When a subagent has been finished or idle for 5 minutes but is still open, the main agent's next tool result carries a note (which you do not see) naming it and asking it to stop the agent with TaskStop unless it still needs it. The note repeats at most every 10 minutes per agent.

The pane docks on the right in fullscreen mode (`"tui": "fullscreen"` in settings) when the terminal is at least 110 columns wide; otherwise it shows above the prompt.

Install, at the prompt of a terminal session:

```
/plugin install agent-sidebar --marketplace KRSogaard/claude
```

Answer `y` to add the marketplace, then pick the user scope. From a shell:

```
claude plugin install agent-sidebar --marketplace KRSogaard/claude
```

In the desktop app: click + next to the prompt box, then Plugins, Add marketplace with `KRSogaard/claude`, then Add plugin.

## Setup tips

### Show the full account email in claude-hud

[claude-hud](https://github.com/jarrodwatts/claude-hud) can show who you are signed in as (`showAuthUser`), but only the part of the email before the @. To show the full email instead, use its `--extra-cmd` option with [`scripts/claude-hud-account`](scripts/claude-hud-account), which prints the email from `~/.claude.json`:

1. Copy the script to `~/.local/bin/claude-hud-account` and make it executable (`chmod +x`). It needs Node.js.
2. In the `statusLine` command in `~/.claude/settings.json`, put `CLAUDE_HUD_ALLOW_EXTRA_CMD=1` in front of the `node .../dist/index.js` call and `--extra-cmd ~/.local/bin/claude-hud-account` after it:

   ```
   CLAUDE_HUD_ALLOW_EXTRA_CMD=1 exec node "${plugin_dir}dist/index.js" --extra-cmd ~/.local/bin/claude-hud-account
   ```

3. Leave `showAuthUser` off in `~/.claude/plugins/claude-hud/config.json`, so the name does not show twice.

## Developing

Each plugin is a folder under `plugins/`. Check one with:

```
claude plugin validate plugins/agent-sidebar
claude plugin test plugins/agent-sidebar
```
