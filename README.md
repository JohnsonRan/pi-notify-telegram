# pi-notify-telegram

A threaded Telegram remote interface for [Pi](https://github.com/earendil-works/pi).

Each Pi session gets its own topic in the bot's private chat. Telegram replies are injected as real Pi user messages, and assistant text is streamed with Telegram's native `sendMessageDraft` API before being persisted as a normal message.

## Features

- One private Telegram topic per top-level Pi session
- Subagent processes (`PI_SUBAGENT_CHILD=1`) stay inside their parent session and do not create topics
- Native streaming assistant responses
- Safe Markdown-to-Telegram-HTML rendering for headings, emphasis, code, links, quotes, spoilers, and lists
- Notification replies become `pi.sendUserMessage()` input
- Multiple concurrent Pi processes share one localhost broker and one `getUpdates` poller
- Optional always-on wake daemon resumes a stopped Pi session when its topic receives a message
- The unthreaded All Topics view provides explicit `/new`, `/sessions`, `/status`, and `/help` control commands
- Pi extension, prompt-template, and skill commands are synchronized into Telegram's bot command menu
- Cross-platform per-user services support Windows Scheduled Tasks, macOS LaunchAgents, and Linux systemd user units
- Replies route by `message_thread_id`, so agents cannot consume each other's messages
- Busy sessions receive Telegram input as `steer`; idle sessions start a normal turn
- Consumes `pi:semantic-hook:v1` notifications from `pi-notify` and other neutral producers
- Bot token stays in a dedicated plain secret file, separate from JSON configuration

## Requirements

- Pi 0.84.0 or newer
- Node.js 22.19.0 or newer
- A dedicated Telegram bot with **Threaded Mode** enabled

Enable Threaded Mode in `@BotFather`:

```text
Select bot -> Bot Settings -> Threaded Mode -> Enable
```

Threaded Mode must be enabled in the bot's private chat. A forum supergroup is not required.

## Install

```bash
pi install git:github.com/JohnsonRan/pi-notify-telegram
```

Restart Pi after installation.

## Configure

Run the interactive setup utility from the installed Git checkout:

```bash
node "$HOME/.pi/agent/git/github.com/JohnsonRan/pi-notify-telegram/setup.cjs"
```

If `PI_CODING_AGENT_DIR` points somewhere else, replace `$HOME/.pi/agent` with that directory. When developing from a clone, run `node setup.cjs` in the repository root. Stop all Pi sessions before rerunning setup so there is no competing Telegram `getUpdates` poller.

The setup process:

1. Reads the BotFather token without echoing it.
2. Verifies the bot with `getMe`.
3. Uses a one-time `/start <nonce>` message to identify the authorized Telegram account.
4. Creates a temporary private topic and calls `sendMessageDraft` to verify Threaded Mode.
5. Deletes the temporary validation topic.
6. Writes the configuration files under `$PI_CODING_AGENT_DIR` (normally `~/.pi/agent`).

Files:

| File | Purpose |
| --- | --- |
| `pi-notify-telegram.secret` | Telegram bot token only |
| `pi-notify-telegram.json` | Allowed chat/user, localhost broker secret, and port |
| `pi-notify-telegram.state.json` | Update offset, session/topic mappings, notification mappings, and pending replies |

Example non-secret configuration:

```json
{
  "chatId": 123456789,
  "allowedUserId": 123456789,
  "bridgeSecret": "generated-random-value",
  "port": 43871,
  "linkPreview": false,
  "wakeMode": true,
  "wakeDefaultCwd": "F:\\",
  "wakeAllowedRoots": ["F:\\"],
  "wakePiCommand": "pi",
  "wakePiCommandArgs": []
}
```

`linkPreview` defaults to `false`, which disables URL previews on notifications and persisted assistant messages. Set it to `true` to opt back in. Telegram's ephemeral `sendMessageDraft` method does not expose link preview options.

## Wake daemon

Set `wakeMode` to `true` to let Telegram start Pi when no interactive Pi process owns the target session. `wakeDefaultCwd` is used by `/new | <prompt>`, and every requested working directory must resolve inside one of the `wakeAllowedRoots`. Symbolic links and junctions are resolved before the allowlist check.

The wake process runs Pi with the existing session ID, full tools, and project approval:

```text
pi --session-id <id> --name <name> --print --approve <prompt>
```

Only the configured `allowedUserId` can issue wake requests. One background process may run per session; additional messages are delivered through the normal authenticated broker connection.

Install the per-user service from the installed checkout:

```bash
node "$HOME/.pi/agent/git/github.com/JohnsonRan/pi-notify-telegram/service.cjs" install
```

The command selects the native service manager for the current platform:

- Windows: per-user Scheduled Task
- macOS: `~/Library/LaunchAgents/com.johnsonran.pi-notify-telegram.plist`
- Linux: `~/.config/systemd/user/pi-notify-telegram.service`

Service lifecycle commands are `install`, `start`, `stop`, `status`, and `uninstall`. The daemon waits if an older embedded broker still owns the port, then takes ownership automatically after that Pi process exits.

All Topics is command-only:

```text
/new F:\\project | inspect this project
/new F:\\project
/new | use the configured default directory
/sessions
/status
/help
```

Messages in an existing session topic wake that exact session. Ordinary unthreaded text never falls back to a globally "latest" session.

## Pi command menu

For each connected session, the extension reads `pi.getCommands()` and synchronizes invokable extension commands, prompt templates, and skills into Telegram with `setMyCommands`. Names that Telegram cannot represent directly are converted to stable lowercase aliases, for example `/ctx-stats` becomes `/ctx_stats` and `/skill:frontend-design` becomes `/skill_frontend_design`.

Selecting an alias inside a session topic restores the original Pi command and dispatches it with `expandPromptTemplates: true`. The command mapping is stored with the topic, so it also works when that topic must wake a stopped session. The internal `/telegram-wake` command is never exposed.

Telegram permits at most 100 bot commands. Wake controls occupy four entries, and up to 96 discovered Pi commands are published. Built-in interactive-only TUI commands such as `/model`, `/settings`, and `/hotkeys` are intentionally excluded because Pi does not expose them through `getCommands()` and they cannot execute through a remote prompt. Commands that open custom terminal UI may still require an interactive Pi window; prompt templates, skills, and headless extension commands work normally.

Wake mode permits unattended model calls, file writes, and command execution. Keep the bot private and restrict `wakeAllowedRoots` to trusted directories.

## pi-notify integration

This extension listens directly to the neutral `pi:semantic-hook:v1` bus.

Recognized hooks:

- `agent-notify` with `TITLE` and `CONTENT`
- `user-ready` with `STOP_KIND` and `REASON`

It also listens directly for `ask_user_question` tool starts. `pi-notify` may remain installed for BEL/OSC notifications and for its optional `agent_notify` tool, but its Telegram command action should be removed to avoid duplicate pushes.

## Message routing

```text
Pi session A -> Telegram topic A -> reply -> Pi session A
Pi session B -> Telegram topic B -> reply -> Pi session B
```

A single localhost broker owns Telegram long polling. Every Pi process connects to it using a random secret. If the broker-owning Pi process exits, another connected process can become the broker after reconnecting.

Reply delivery uses ACKs. A reply stays in durable state until the target Pi process confirms that `sendUserMessage()` accepted it. Notification mappings and undelivered replies expire after 30 days and are pruned every six hours; topic mappings are retained so resumed Pi sessions continue using their existing Telegram topics.

## Streaming

Assistant text is observed through Pi's `message_start`, `message_update`, and `message_end` lifecycle events.

- `sendMessageDraft` updates are throttled to avoid one HTTP request per token.
- Drafts use the session's private topic.
- Pi Markdown is converted to Telegram's supported HTML subset on every draft update, so partial Markdown remains balanced and safe.
- Supported formatting includes headings, bold, italic, strikethrough, spoilers, inline/fenced code, links, blockquotes, and readable list markers.
- Raw HTML and unsafe link protocols are escaped rather than trusted.
- If Telegram rejects formatted entities, delivery retries once as plain text.
- The final response is persisted with `sendMessage`.
- Responses longer than Telegram's message limit are split at line boundaries when possible.
- Thinking blocks and tool-call payloads are not forwarded; only assistant text content is streamed.

## Security

- Use a dedicated bot.
- The configured `chatId` and `allowedUserId` must both match incoming messages.
- The broker binds only to `127.0.0.1`.
- Local broker frames require the generated `bridgeSecret`.
- Do not commit any files from `~/.pi/agent` to this repository.

## Development

```bash
npm install
npm run check
```

## License

MIT
