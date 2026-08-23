# pi-notify-telegram

A threaded Telegram remote interface for [Pi](https://github.com/earendil-works/pi).

Each Pi session gets its own topic in the bot's private chat. Telegram replies are injected as real Pi user messages, and assistant text is streamed with Telegram's native `sendMessageDraft` API before being persisted as a normal message.

## Features

- One private Telegram topic per Pi session
- Native streaming assistant responses
- Notification replies become `pi.sendUserMessage()` input
- Multiple concurrent Pi processes share one localhost broker and one `getUpdates` poller
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
  "port": 43871
}
```

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

Reply delivery uses ACKs. A reply stays in durable state until the target Pi process confirms that `sendUserMessage()` accepted it.

## Streaming

Assistant text is observed through Pi's `message_start`, `message_update`, and `message_end` lifecycle events.

- `sendMessageDraft` updates are throttled to avoid one HTTP request per token.
- Drafts use the session's private topic.
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
