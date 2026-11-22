/*
 * Deterministic headless smoke test for the connect-only wire logic.
 *
 * Spins up a mock OpenAI-compatible server (plus a mock HTML page and a mock
 * MCP stdio server), then drives the REAL compiled ConnectionManager +
 * protocol adapter + ToolsRegistry + internal tools + McpManager through:
 *
 *   - auto-detection, model listing, streaming
 *   - the bounded tool loop with registry-routed tool calls
 *   - full JSON-schema advertisement (req.tools, tool_choice: "auto")
 *   - internal tools: document_parse (MD / XLSX / PDF / DOCX), web_search
 *     (no-key note), web_extract, scratch_read / scratch_list
 *   - local MCP: a real stdio server wrapped as mcp__<server>__<tool>
 *
 * Usage: node scripts/smoke.cjs   (after npm run build:electron)
 */

const http = require("node:http");
const { writeFileSync, mkdtempSync } = require("node:fs");
const { tmpdir } = require("node:os");
const { join, resolve, basename } = require("node:path");
const { ConnectionManager } = require("../dist/store/connection.js");
const { ToolsRegistry } = require("../dist/agent/registry.js");
const { buildInternalTools } = require("../dist/agent/internalTools.js");
const { McpManager } = require("../dist/agent/mcp.js");
const { ScratchPad } = require("../dist/services/scratchPad.js");
const { Workbook } = require("exceljs");
const JSZip = require("jszip");

// web_search's no-key path must be deterministic in this test.
delete process.env.TAVILY_API_KEY;

let passed = 0;
let failed = 0;
function check(name, cond, extra = "") {
  if (cond) {
    passed++;
    console.log(`  ✓ ${name}`);
  } else {
    failed++;
    console.log(`  ✗ ${name}${extra ? ` -- ${extra}` : ""}`);
  }
}

/* --- mock OpenAI-compatible server ------------------------------------ */
/*
 * Shared mutable `state` lets each scenario script the first turn:
 *   state.firstCall — () => ({ name, args }) emitted on a turn with no prior
 *                      tool activity (null → answer with plain text instead)
 *   state.finalText — text answer once tool results are in history
 *   state.bodies    — every captured request body (for schema assertions)
 *
 * Non-streaming requests (the connect() dialect probe) get a plain JSON
 * OpenAI-shaped reply so detectAdapter locks "openai" properly.
 */
const HTML_PAGE = `<html><head><title>Smoke Page</title>
<style>body{color:red}</style><script>var leak = "SCRIPT_MARKER";</script></head>
<body><h1>Heading One</h1><p>EXTRACT_MARKER_99 lives in the body.</p></body></html>`;

function startMockServer() {
  const state = { firstCall: null, finalText: "Done.", bodies: [] };
  const server = http.createServer((req, res) => {
    const url = new URL(req.url, "http://localhost");
    if (req.method === "GET" && url.pathname === "/v1/models") {
      return sendJson(res, 200, { data: [{ id: "mock-9b", name: "Mock 9B" }] });
    }
    if (req.method === "GET" && url.pathname === "/page") {
      res.writeHead(200, { "content-type": "text/html" });
      return res.end(HTML_PAGE);
    }
    if (req.method === "POST" && url.pathname === "/v1/chat/completions") {
      let body = "";
      req.on("data", (c) => (body += c));
      req.on("end", () => {
        const json = safeParse(body);
        state.bodies.push(json);
        if (json && json.stream === false) {
          return sendJson(res, 200, {
            choices: [{ message: { role: "assistant", content: "pong" } }],
          });
        }
        const history = json?.messages ?? [];
        const answered = history.some(
          (m) => m.role === "tool" || (m.role === "assistant" && m.tool_calls),
        );
        res.writeHead(200, { "content-type": "text/event-stream" });
        const call = answered ? null : state.firstCall ? state.firstCall() : null;
        if (call) writeSse(res, toolCallDelta(call.name, call.args));
        else writeSse(res, textDelta(state.finalText));
        writeSse(res, { choices: [{ delta: {} }] });
        writeSse(res, { choices: [{ finish_reason: "stop" }] }, true);
      });
      return;
    }
    sendJson(res, 404, { error: { message: "not found" } });
  });
  return new Promise((resolveP) =>
    server.listen(0, "127.0.0.1", () => resolveP({ server, state, port: server.address().port })),
  );
}

function toolCallDelta(toolName, args) {
  return {
    choices: [
      {
        delta: {
          tool_calls: [
            { id: "call_1", index: 0, type: "function", function: { name: toolName, arguments: JSON.stringify(args) } },
          ],
        },
      },
    ],
  };
}

function textDelta(content) {
  return { choices: [{ delta: { content } }] };
}

function sendJson(res, status, obj) {
  res.writeHead(status, { "content-type": "application/json" });
  res.end(JSON.stringify(obj));
}
function writeSse(res, obj, done = false) {
  res.write(`data: ${JSON.stringify(obj)}\n\n`);
  if (done) res.end();
}
function safeParse(s) {
  try {
    return JSON.parse(s);
  } catch {
    return {};
  }
}

/** Run one chat turn; returns { events, finalMsg, toolResult }. */
async function runTurn(mgr, { message, toolNames, connectionId = "mock", modelId = "mock-9b" }) {
  const events = [];
  const req = { connectionId, modelId, messages: [{ role: "user", content: message }] };
  if (toolNames) req.toolNames = toolNames;
  const finalMsg = await mgr.streamChat(req, (e) => events.push(e));
  return { events, finalMsg, toolResult: events.find((e) => e.type === "tool_result")?.result ?? "" };
}

/* --- binary fixtures --------------------------------------------------- */

/** Hand-rolled minimal one-page PDF with a Helvetica text layer. */
function makePdf(text) {
  const stream = `BT /F1 18 Tf 72 720 Td (${text.replace(/[\\()]/g, (m) => "\\" + m)}) Tj ET`;
  const objs = [
    "<</Type /Catalog /Pages 2 0 R>>",
    "<</Type /Pages /Kids [3 0 R] /Count 1>>",
    "<</Type /Page /Parent 2 0 R /MediaBox [0 0 612 792] /Resources <</Font <</F1 5 0 R>>>> /Contents 4 0 R>>",
    `<</Length ${stream.length}>>\nstream\n${stream}\nendstream`,
    "<</Type /Font /Subtype /Type1 /BaseFont /Helvetica>>",
  ];
  let out = "%PDF-1.4\n";
  const offsets = [];
  for (let i = 0; i < objs.length; i++) {
    offsets.push(out.length);
    out += `${i + 1} 0 obj\n${objs[i]}\nendobj\n`;
  }
  const xrefPos = out.length;
  out += `xref\n0 ${objs.length + 1}\n0000000000 65535 f \n`;
  for (let i = 1; i <= objs.length; i++) out += String(offsets[i - 1]).padStart(10, "0") + " 00000 n \n";
  out += `trailer\n<</Size ${objs.length + 1} /Root 1 0 R>>\nstartxref\n${xrefPos}\n%%EOF`;
  return Buffer.from(out, "latin1");
}

/** Minimal OPC DOCX (content types + rels + one paragraph). */
async function makeDocx(text) {
  const zip = new JSZip();
  zip.file(
    "[Content_Types].xml",
    `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types">
<Default Extension="rels" ContentType="application/vnd.openxmlformats-package.relationships+xml"/>
<Default Extension="xml" ContentType="application/xml"/>
<Override PartName="/word/document.xml" ContentType="application/vnd.openxmlformats-officedocument.wordprocessingml.document.main+xml"/>
</Types>`,
  );
  zip.file(
    "_rels/.rels",
    `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships">
<Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/officeDocument" Target="word/document.xml"/>
</Relationships>`,
  );
  zip.file(
    "word/document.xml",
    `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<w:document xmlns:w="http://schemas.openxmlformats.org/wordprocessingml/2006/main">
<w:body><w:p><w:r><w:t xml:space="preserve">${text}</w:t></w:r></w:p></w:body>
</w:document>`,
  );
  return zip.generateAsync({ type: "nodebuffer" });
}

/* --- test ---------------------------------------------------------------- */

async function main() {
  const { server, state, port } = await startMockServer();
  const url = `http://127.0.0.1:${port}/v1`;
  const pageUrl = `http://127.0.0.1:${port}/page`;

  /* 1 — tool loop plumbing via a custom registry tool ------------------- */
  console.log("\n[1] tool loop + registry");
  const fakeRegistry = new ToolsRegistry();
  const FAKE_DESC = "Fake search used by the smoke test";
  fakeRegistry.register({
    name: "web_search",
    description: FAKE_DESC,
    parameters: {
      type: "object",
      properties: { query: { type: "string", description: "Search query" } },
      required: ["query"],
    },
    handler: async (args) => `fake result for ${args.query}`,
  });

  const mgr = new ConnectionManager({ maxIterations: 6, registry: fakeRegistry });
  const status = await mgr.connect({ id: "mock", name: "Mock", url });
  check(
    "connect() auto-detects OpenAI backend",
    status.status === "connected" && status.connection.protocol === "openai",
    JSON.stringify(status),
  );
  check(
    "models listed from /v1/models",
    status.connection?.models?.length === 1 && status.connection.models[0].id === "mock-9b",
  );

  state.firstCall = () => ({ name: "web_search", args: { query: "latest MLX benchmarks" } });
  state.finalText = "The latest MLX benchmarks show strong throughput.";
  const turn1 = await runTurn(mgr, { message: "What are the latest MLX benchmarks?" }); // no toolNames → all registered

  const types = turn1.events.map((e) => e.type);
  check("streamed a status event", types.includes("status"));
  check("streamed a token event", types.includes("token"));
  check("streamed a tool_call event", types.includes("tool_call"));
  check("streamed a tool_result event", types.includes("tool_result"));
  check(
    "tool call parsed with name + args and routed to the handler",
    turn1.events.find((e) => e.type === "tool_call")?.call?.name === "web_search" &&
      /fake result for latest MLX benchmarks/.test(turn1.toolResult),
    turn1.toolResult,
  );
  check(
    "looped back and produced a final text answer",
    /benchmarks/.test(turn1.finalMsg.content ?? ""),
    turn1.finalMsg.content,
  );
  check("final message has no dangling tool calls", !turn1.finalMsg.toolCalls?.length);

  const chatBody = state.bodies.find((b) => b?.stream === true);
  const adv = chatBody?.tools?.find((t) => t.function?.name === "web_search"); // OpenAI-shaped
  check(
    "advertises full registry schemas (no toolNames → all tools)",
    Array.isArray(chatBody?.tools) && adv?.function?.description === FAKE_DESC &&
      adv?.function?.parameters?.properties?.query?.type === "string",
    JSON.stringify(chatBody?.tools?.map((t) => t.function?.name)),
  );
  check("sets tool_choice: auto", chatBody?.tool_choice === "auto");

  /* 2 — internal tools through the loop --------------------------------- */
  console.log("\n[2] internal tools");
  const tmp = mkdtempSync(join(tmpdir(), "browserchat-smoke-"));
  const scratch = new ScratchPad(tmp);
  const internalRegistry = new ToolsRegistry();
  for (const tool of buildInternalTools({ scratch })) internalRegistry.register(tool);
  check(
    "buildInternalTools registers the five internal tools",
    ["document_parse", "scratch_list", "scratch_read", "web_search", "web_extract"].every((n) =>
      internalRegistry.has(n),
    ),
  );

  const mdPath = join(tmp, "scratch", "notes.md");
  writeFileSync(mdPath, "# Title\n\nHello world from the parser.\n");

  const xlsxPath = join(tmp, "scratch", "sales.xlsx");
  {
    const wb = new Workbook();
    const ws = wb.addWorksheet("Sales");
    ws.getRow(1).getCell(1).value = "Item";
    ws.getRow(1).getCell(2).value = "Qty";
    ws.getRow(2).getCell(1).value = "Widget";
    ws.getRow(2).getCell(2).value = 42;
    await wb.xlsx.writeFile(xlsxPath);
  }

  const pdfPath = join(tmp, "scratch", "spec.pdf");
  writeFileSync(pdfPath, makePdf("PDF SMOKE MARKER 12345"));

  const docxPath = join(tmp, "scratch", "brief.docx");
  writeFileSync(docxPath, await makeDocx("DOCX SMOKE MARKER 67890"));

  const docMgr = new ConnectionManager({ maxIterations: 6, registry: internalRegistry });
  const docStatus = await docMgr.connect({ id: "docmock", name: "DocMock", url });
  check("internal tools: connect() succeeds", docStatus.status === "connected", JSON.stringify(docStatus));

  async function docTurn(path) {
    state.firstCall = () => ({ name: "document_parse", args: { path } });
    state.finalText = "Parsed document summary.";
    return runTurn(docMgr, { message: "Parse the file", toolNames: ["document_parse"], connectionId: "docmock" });
  }

  const md = await docTurn(mdPath);
  check(
    "document_parse: markdown extracted into tool result",
    /Hello world from the parser\./.test(md.toolResult) && /notes\.md/.test(md.toolResult),
    md.toolResult,
  );

  const xlsx = await docTurn(xlsxPath);
  check(
    "document_parse: XLSX rendered as a markdown table",
    /Widget/.test(xlsx.toolResult) && /\| 42 \|/.test(xlsx.toolResult),
    xlsx.toolResult,
  );

  const pdf = await docTurn(pdfPath);
  check(
    "document_parse: PDF text layer extracted",
    /PDF SMOKE MARKER 12345/.test(pdf.toolResult),
    pdf.toolResult,
  );

  const docx = await docTurn(docxPath);
  check(
    "document_parse: DOCX text extracted",
    /DOCX SMOKE MARKER 67890/.test(docx.toolResult),
    docx.toolResult,
  );

  state.firstCall = () => ({ name: "web_search", args: { query: "anything" } });
  state.finalText = "Searched.";
  const ws = await runTurn(docMgr, { message: "Search", toolNames: ["web_search"], connectionId: "docmock" });
  check(
    "web_search: without a connector returns guided setup (no crash)",
    /Tools & MCP/.test(ws.toolResult) && /Tavily or Exa/.test(ws.toolResult),
    ws.toolResult,
  );

  state.firstCall = () => ({ name: "web_extract", args: { url: pageUrl } });
  state.finalText = "Extracted.";
  const we = await runTurn(docMgr, { message: "Extract", toolNames: ["web_extract"], connectionId: "docmock" });
  check(
    "web_extract: HTML reduced to readable text (title + body)",
    /Smoke Page/.test(we.toolResult) && /EXTRACT_MARKER_99/.test(we.toolResult) &&
      /Heading One/.test(we.toolResult),
    we.toolResult,
  );
  check("web_extract: script content stripped", !/SCRIPT_MARKER/.test(we.toolResult));

  scratch.save("notes.txt", "text/plain", Buffer.from("SCRATCH_MARKER_77 hello"));
  state.firstCall = () => ({ name: "scratch_read", args: { name: "notes.txt" } });
  state.finalText = "Read.";
  const sr = await runTurn(docMgr, { message: "Read the scratch file", toolNames: ["scratch_read"], connectionId: "docmock" });
  check("scratch_read: returns file content", /SCRATCH_MARKER_77/.test(sr.toolResult), sr.toolResult);

  state.firstCall = () => ({ name: "scratch_list", args: {} });
  state.finalText = "Listed.";
  const sl = await runTurn(docMgr, { message: "List scratch files", toolNames: ["scratch_list"], connectionId: "docmock" });
  check("scratch_list: shows the stored file", /notes\.txt/.test(sl.toolResult), sl.toolResult);

  state.firstCall = () => ({ name: "no_such_tool", args: {} });
  state.finalText = "Recovered.";
  const bad = await runTurn(docMgr, { message: "Call something wrong", connectionId: "docmock" });
  check(
    "unknown tool: error fed back as a tool result, loop still completes",
    /unknown tool/.test(bad.toolResult) && /Recovered/.test(bad.finalMsg.content ?? ""),
    bad.toolResult,
  );

  /* 3 — local MCP over stdio --------------------------------------------- */
  console.log("\n[3] MCP (stdio)");
  const mcpConfigPath = join(tmp, "mcp.config.json");
  writeFileSync(
    mcpConfigPath,
    JSON.stringify(
      {
        servers: {
          mock: { transport: "stdio", command: process.execPath, args: [resolve(__dirname, "mock-mcp.cjs")] },
          disabled: { transport: "stdio", command: "node", args: ["nonexistent.js"], enabled: false },
        },
        default_timeout: 30,
      },
      null,
      2,
    ),
  );

  const mcp = new McpManager(mcpConfigPath);
  const mcpStatuses = [];
  const mcpTools = await mcp.connectAll((msg) => mcpStatuses.push(msg));
  check(
    "MCP: stdio server connected and tool wrapped as mcp__mock__mock_add",
    mcpTools.length === 1 && mcpTools[0].name === "mcp__mock__mock_add" &&
      /Add two numbers/.test(mcpTools[0].description),
    JSON.stringify(mcpTools.map((t) => t.name)),
  );
  check(
    "MCP: status lines report the connection and the skip",
    mcpStatuses.some((s) => /mock: connected — 1 tool/.test(s)) &&
      mcpStatuses.some((s) => /skip "disabled"/.test(s)),
    mcpStatuses.join(" | "),
  );

  const mcpRegistry = new ToolsRegistry();
  for (const t of mcpTools) mcpRegistry.register(t);
  const mcpMgr = new ConnectionManager({ maxIterations: 6, registry: mcpRegistry });
  const mcpStatus = await mcpMgr.connect({ id: "mock", name: "Mock", url });
  check("MCP: connect() succeeds", mcpStatus.status === "connected", JSON.stringify(mcpStatus));

  state.firstCall = () => ({ name: "mcp__mock__mock_add", args: { a: 2, b: 40 } });
  state.finalText = "The sum was computed.";
  const mt = await runTurn(mcpMgr, { message: "Add two and forty" });
  check(
    "MCP: tool call routed through the SDK client and result fed back",
    /sum is 42/.test(mt.toolResult) && /sum was computed/.test(mt.finalMsg.content ?? ""),
    mt.toolResult,
  );

  await mcp.close();
  check("MCP: close() resolves without throwing", true);

  server.close();
  console.log(`\n${passed} passed, ${failed} failed`);
  process.exit(failed ? 1 : 0);
}

main().catch((err) => {
  console.error("smoke test crashed:", err);
  process.exit(1);
});
