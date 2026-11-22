# Reuse and license record

2026-10-18. Browser Chat reuses maintained libraries instead of implementing replacement protocols, parsers and document containers. Production package license texts are generated into THIRD_PARTY_NOTICES.txt for the packaged app; original dependency package notices are retained. The lockfile records exact versions.

| Reuse | Purpose | Declared license |
|---|---|---|
| @modelcontextprotocol/sdk | MCP clients, transports, OAuth/PKCE | MIT |
| React, react-markdown, remark-gfm | UI and safe Markdown/GFM rendering | MIT |
| Lucide React | Consistent interface icons | ISC |
| yaml | Agent Skills frontmatter | ISC |
| sql.js | SQLite without native ABI coupling | MIT |
| JSZip | DOCX container assembly | MIT alternative selected from MIT OR GPL-3.0-or-later |
| ExcelJS | XLSX reading/writing | MIT |
| Mammoth | DOCX extraction | BSD-2-Clause |
| pdfjs-dist | PDF extraction | Apache-2.0 |
| npm | Bundled, unmodified local MCP package runner | Artistic-2.0 |

The generated notice file also preserves transitive dependencies' notices. Electron and packaging components retain their distributed notices. External MCP packages are fetched only when the user configures them and retain their own notices. This inventory is an engineering record, not a claim that every future third-party server is approved.

Sources checked: [Agent Skills format](https://github.com/agentskills/agentskills/blob/main/docs/specification.mdx), [official filesystem server](https://github.com/modelcontextprotocol/servers/blob/main/src/filesystem/README.md), [Tavily MCP](https://github.com/tavily-ai/tavily-mcp), [GitHub MCP](https://github.com/github/github-mcp-server), and installed SDK types/examples. These inform compatible formats and setup recipes. Interaction patterns were independently implemented; no third-party skill bodies were imported. Starter skill text is authored for this app. Larger orchestration/model-management systems were deliberately excluded from this milestone.

### Hosted connector references checked for 0.2.1

- [Tavily](https://docs.tavily.com/documentation/mcp): hosted URL, browser OAuth and bearer/API-key link options.
- [Exa](https://exa.ai/mcp) and [official source](https://github.com/exa-labs/exa-mcp-server): anonymous hosted endpoint, OAuth and token options.
- [GitHub host integration](https://github.com/github/github-mcp-server/blob/main/docs/host-integration.md): no dynamic client registration; token setup remains guided.
- [Notion connection guide](https://developers.notion.com/guides/mcp/get-started-with-mcp), [Linear MCP](https://linear.app/docs/mcp), [Context7 clients](https://context7.com/docs/resources/all-clients): official hosted endpoints and supported authentication.

No provider SDKs or connector source code were copied. The maintained MCP SDK handles transport and OAuth; catalog recipes and interface are app code.
