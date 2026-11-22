#!/usr/bin/env node
// Minimal MCP stdio server: JSON-RPC 2.0 over stdin/stdout.
let buf = "";
process.stdin.on("data", (chunk) => {
  buf += chunk.toString();
  let idx;
  while ((idx = buf.indexOf("\n")) !== -1) {
    const line = buf.slice(0, idx).trim();
    buf = buf.slice(idx + 1);
    if (!line) continue;
    let msg; try { msg = JSON.parse(line); } catch { continue; }
    handle(msg);
  }
});
function send(obj) { process.stdout.write(JSON.stringify(obj) + "\n"); }
function handle(msg) {
  const { id, method, params } = msg;
  if (id === undefined) return; // notification
  switch (method) {
    case "initialize":
      return send({ jsonrpc: "2.0", id, result: {
        protocolVersion: params.protocolVersion,
        capabilities: { tools: {} },
        serverInfo: { name: "mock-mcp", version: "0.0.1" },
      }});
    case "tools/list":
      return send({ jsonrpc: "2.0", id, result: { tools: [
        { name: "mock_add", description: "Add two numbers.", inputSchema: { type: "object", properties: { a: { type: "number" }, b: { type: "number" } }, required: ["a", "b"] } },
      ]}});
    case "tools/call": {
      const { name, arguments: args } = params;
      const text = name === "mock_add" ? `sum is ${args.a + args.b}` : `unknown tool ${name}`;
      return send({ jsonrpc: "2.0", id, result: { content: [{ type: "text", text }], isError: false }});
    }
    default:
      return send({ jsonrpc: "2.0", id, error: { code: -32601, message: `method not found: ${method}` }});
  }
}
