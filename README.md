# opencode-plugins

A Bun/TypeScript workspace for the small OpenCode plugins that used to live in dotfiles.

## Plugins

| Package | Plugin id | Description |
| --- | --- | --- |
| packages/artifacts | artifacts | Publish, edit and delete HTML or Markdown artifacts served from a local preview server and at.stjhn.xyz; Mermaid fences render as inline SVG via Ondine. |
| packages/ntfy-notify | ntfy-notify | Send ntfy notifications for pending permissions, questions and session completions. |
| packages/openai-context-limit | openai-context-limit | Restore models.dev context limits for OpenAI models clamped by ChatGPT OAuth. |
| packages/quick-quote | quick-quote | TUI plugin that inserts random literary quotes as blockquotes. |
| packages/codemode-only | codemode-only | Move direct tools into Code Mode while keeping question and todowrite direct. |
| packages/pdf-ocr | pdf-ocr | Wrap the read tool to prepend OCR text for PDF files. |
| packages/todos | opencode-todos | Reminds the agent to carry on when it stops with built-in todos still open, on top of OpenCode's native todowrite tool and sidebar. |

## Larger plugins

The larger OpenCode plugins live in their own repositories:

- [opencode-agents](https://github.com/StevenJPx2/opencode-agents)
- [opencode-history](https://github.com/StevenJPx2/opencode-history)
- [opencode-antigravity](https://github.com/StevenJPx2/opencode-antigravity) (paused)

## Development

```sh
bun install
bun test
bun run typecheck
```

Notes:

- `@opencode/plugin` is pinned to 2.0.12.
- Plugins are consumed from this checkout via explicit paths and are not published to npm.
- Licensed MIT.
