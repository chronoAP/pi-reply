# Pi Reply

Pi Reply adds a browser-based reply workspace for [Pi](https://pi.dev) chats, making it easier to respond to specific parts of long agent conversations.

Instead of typing a vague follow-up, you can highlight exact text from the chat, collect multiple quotes, write targeted replies for each one, and send them back to Pi as a structured response. This is especially useful for correcting mistakes, steering ongoing work, reviewing tool output, or replying to several points in one turn.

## Features

- Open with `/reply`
- Browser chat view with selectable text
- Floating **Add quote** button near your selection
- Multiple quote/reply pairs in one message
- Clear `LLM:` / `User:` formatting
- Sends as steering while the agent is working
- Quotes tool results, including edit diffs
- Collapsed user/tool messages by default
- Live chat updates via browser stream
- Tab title follows the current conversation
- `Ctrl+Enter` to send all replies

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
