# Claude Code improvements

Plugins and setup tips for Claude Code, shared from my own setup.

## Plugins

### agent-sidebar

Keeps track of the subagents in a session and makes it obvious which agent you are talking to.

- **Agents pane on the right.** Lists every subagent of the session with its type, task and status (running, done, failed). It opens by itself when the first subagent starts. Click a row to switch to that agent, or "Main agent" to switch back. Open it at any time with `/agents-sidebar`.
- **Yellow warning banner.** While a subagent's transcript is in view, a yellow banner above the prompt says so, because your next message then goes to that subagent and not to the main agent. It has a "Back to main" button.

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

### Show the account name in claude-hud

[claude-hud](https://github.com/jarrodwatts/claude-hud) can show who you are signed in as, but it is off by default. Create `~/.claude/plugins/claude-hud/config.json`:

```json
{
  "display": {
    "showAuthUser": true,
    "authUserLength": 0
  }
}
```

`authUserLength: 0` shows the full name instead of cutting it at 8 characters.

## Developing

Each plugin is a folder under `plugins/`. Check one with:

```
claude plugin validate plugins/agent-sidebar
claude plugin test plugins/agent-sidebar
```
