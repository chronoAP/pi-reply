# Pi Reply

Browser quote/reply pane for [Pi](https://pi.dev) chats.

## Features

- Open with `/reply`.
- Select text in the browser chat view and click **Add quote**.
- Draft multiple `LLM:` / `User:` quote replies.
- Send with **Reply** or `Ctrl+Enter`.
- Sends as steering while the agent is busy, or as a normal user message when idle.
- Live browser updates via SSE.
- Tool results are quoteable and collapsed by default.

## Install

```sh
pi install npm:pi-reply
```

For local development:

```sh
pi install /path/to/pi-reply
```

## Usage

```text
/reply
```

Highlight chat text, click **Add quote**, type your reply, then press `Ctrl+Enter` or click **Reply**.

## Security

Pi extensions run with local system access. Review extension source before installing third-party packages.

## License

MIT
