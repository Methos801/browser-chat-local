# Browser Chat

Connect a desktop chat workspace to a model server you choose, keep working conversations on your computer, and reopen them for the next shift. A packing list needs only a model; document tools and MCP connectors are available for tasks that need them.

[Illustrated walkthrough](https://methos801.github.io/browser-chat-local/)

## Try a conversation

1. Start a compatible server (for example Ollama or LM Studio) with a model loaded. Install Node.js 24 LTS. Download and extract this source, then open a terminal in the folder containing `package.json`.
2. Run `npm ci` and `npm start`. The first command downloads dependencies. No model weights or desktop installer are included.
3. Open **Connections → + add**, choose a preset or enter your server URL, and connect. On macOS the app can detect a running local oMLX server.
4. Start a chat and ask: “Make a packing checklist for 12 notebooks, 8 pencils and 4 folders. What is the total?” Rename it **Supply handoff** and reopen it from History.

## Where your data goes

Chat history is stored on your computer; Browser Chat does not encrypt the history database. The model server you select receives conversation context, including attachment content used in the request. Web tools and connectors can contact other services. Credentials use the operating system’s encryption when available; otherwise they stay in memory for the session.

## Development

`npm run verify` checks types and backend behavior. One filesystem test creates a symbolic link and requires an environment that permits it.

[MIT license](LICENSE) · [Reuse notes](docs/REUSE-AND-LICENSES.md) · [Dependency notices](THIRD_PARTY_NOTICES.txt)
