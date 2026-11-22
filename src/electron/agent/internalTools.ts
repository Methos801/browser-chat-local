/**
 * Internal tools: capabilities that ship with the app (no external server).
 *  - document_parse  — extract text from PDF / DOCX / XLSX / Markdown
 *  - scratch_list    — list files in the local scratch pad
 *  - scratch_read    — read a scratch-pad file as text
 *  - web_search      — built-in Tavily search (needs TAVILY_API_KEY)
 *  - web_extract     — fetch a URL and reduce it to readable text
 *
 * Each returns the plain text that gets fed back to the model as a
 * tool result. Errors are thrown; the loop turns them into an "errored"
 * result the model can react to.
 */

import { basename,resolve } from "node:path";
import { parseDocument } from "../services/documentParse";
import type { ScratchPad } from "../services/scratchPad";
import type { ToolsRegistry,Tool } from "./registry";

const MAX_RESULT_CHARS = 20_000; // keep tool results from blowing up context

export interface InternalToolsDeps {
  scratch: ScratchPad;
  registry?: ToolsRegistry;
}

export function buildInternalTools(deps: InternalToolsDeps): Tool[] {
  return [
    {
      name: "document_parse",
      description:
        "Read an uploaded scratch-pad document (PDF, DOCX, XLSX, Markdown). Use offset and maxChars to read a long file in sections. Returns the text and its source range.",
      parameters: {
        type: "object",
        properties: {
          path: { type: "string", description: "Absolute path to the file to parse" },
          offset: { type: "integer", description: "Starting character offset, default 0" },
          maxChars: { type: "integer", description: "Characters to read, up to 20000" },
          mimeType: { type: "string", description: "Optional MIME type override (usually inferred from the extension)" },
        },
        required: ["path"],
      },
      handler: async (args) => {
        const { path, mimeType } = args as { path?: string; mimeType?: string };
        if (!path) throw new Error('document_parse requires a "path" argument');
        const file=deps.scratch.list().find(f=>resolve(f.path)===resolve(path));
        if(!file)throw new Error('Upload this document to the scratch pad first, or use a folder server connected through Tools.');
        const offset=Number(args.offset??0),maxChars=Number(args.maxChars??20000);
        if(!Number.isInteger(offset)||offset<0||!Number.isInteger(maxChars)||maxChars<1||maxChars>20000)throw new Error('Use a nonnegative offset and maxChars from 1 to 20000.');
        const result=await parseDocument(file.path,mimeType);
        const end=Math.min(result.text.length,offset+maxChars);
        return `## document_parse: ${basename(path)} (${result.mimeType})\nCharacters ${Math.min(offset,result.text.length)}–${end} of ${result.text.length}${end<result.text.length?'; read the next section with offset '+end:''}\n\n${result.text.slice(offset,end)}`;
      },
    },
    {
      name: "scratch_list",
      description:
        "List files currently stored in the app's local scratch pad (uploaded or downloaded files), " +
        "with name, size, type, and absolute path.",
      parameters: { type: "object", properties: {} },
      handler: async () => {
        const files = deps.scratch.list();
        if (!files.length) return "The scratch pad is empty.";
        return files
          .map((f) => `- ${f.name} (${f.type}, ${f.size} bytes)\n  path: ${f.path}`)
          .join("\n");
      },
    },
    {
      name: "scratch_read",
      description:
        "Read a scratch-pad file as text (by file name as shown by scratch_list). " +
        "Binary files return a note instead of their bytes.",
      parameters: {
        type: "object",
        properties: { name: { type: "string", description: "File name in the scratch pad" } },
        required: ["name"],
      },
      handler: async (args) => {
        const { name } = args as { name?: string };
        if (!name) throw new Error('scratch_read requires a "name" argument');
        const buf = deps.scratch.read(name);
        if (looksBinary(buf)) {
          return `scratch_read: ${name} looks like a binary file (${buf.length} bytes) — use document_parse with its full path, or a vision model.`;
        }
        return truncate(`## scratch_read: ${name}\n\n${buf.toString("utf8")}`);
      },
    },
    {
      name: "web_search",
      description:
        "Search the web using a connected Tavily or Exa connector and return sources.",
      parameters: {
        type: "object",
        properties: {
          query: { type: "string", description: "Search query" },
          max_results: { type: "number", description: "Max results (default 5, cap 10)" },
        },
        required: ["query"],
      },
      handler: async (args) => {
        const { query, max_results } = args as { query?: string; max_results?: number };
        if (!query) throw new Error('web_search requires a "query" argument');
        const connected=deps.registry?.specs().find(t=>t.name.startsWith('mcp__')&&/(?:tavily[_-]search|web_search_exa)$/.test(t.name));
        if(connected){
          const n=Math.min(Math.max(Math.trunc(max_results??5),1),10);
          return deps.registry!.handle(connected.name,{query,...(connected.name.endsWith('web_search_exa')?{numResults:n}:{max_results:n})});
        }
        const key = process.env.TAVILY_API_KEY;
        if (!key) {
          return "Web search needs a connector. Open Tools & MCP and connect Tavily or Exa; no file editing is needed.";
        }
        const n = Math.min(Math.max(Math.trunc(max_results ?? 5), 1), 10);
        const res = await fetch("https://api.tavily.com/search", {
          method: "POST",
          headers: { "content-type": "application/json", authorization: `Bearer ${key}` },
          body: JSON.stringify({ query, max_results: n }),
          signal: AbortSignal.timeout(20_000),
        });
        if (!res.ok) throw new Error(`Tavily search failed ${res.status}`);
        const data: any = await res.json();
        const results: any[] = data.results ?? [];
        if (!results.length) return `web_search: no results for "${query}".`;
        return truncate(
          `## web_search: ${query}\n\n` +
            results
              .map((r, i) => `${i + 1}. ${r.title ?? "(untitled)"}\n   ${r.url ?? ""}\n   ${r.content ?? ""}`)
              .join("\n\n"),
        );
      },
    },
    {
      name: "web_extract",
      description:
        "Fetch a URL and return its readable text (HTML reduced to plain text). Good for reading a page found via web_search.",
      parameters: {
        type: "object",
        properties: { url: { type: "string", description: "Absolute http(s) URL to fetch" } },
        required: ["url"],
      },
      handler: async (args) => {
        const { url } = args as { url?: string };
        if (!url || !/^https?:\/\//i.test(url)) {
          throw new Error('web_extract requires an absolute http(s) "url" argument');
        }
        const res = await fetch(url, {
          headers: { "user-agent": "BrowserChat/0.1 (+desktop)" },
          signal: AbortSignal.timeout(30_000),
          redirect: "follow",
        });
        if (!res.ok) throw new Error(`fetch failed ${res.status} for ${url}`);
        const ctype = res.headers.get("content-type") ?? "";
        const raw = await res.text();
        let text: string;
        if (/html/i.test(ctype) || /^\s*</.test(raw)) {
          text = htmlToText(raw);
        } else {
          text = raw.trim();
        }
        if (!text) return `web_extract: no readable text at ${url}`;
        return truncate(`## web_extract: ${url}\n\n${text}`);
      },
    },
  ];
}

/* ------------------------------ helpers ------------------------------- */

function truncate(s: string): string {
  if (s.length <= MAX_RESULT_CHARS) return s;
  return s.slice(0, MAX_RESULT_CHARS) + `\n\n[truncated at ${MAX_RESULT_CHARS} chars]`;
}

/** Cheap binary sniff: NUL bytes in the first 8 KB. */
function looksBinary(buf: Buffer): boolean {
  const n = Math.min(buf.length, 8192);
  for (let i = 0; i < n; i++) if (buf[i] === 0) return true;
  return false;
}

/** Reduce an HTML page to readable text (best-effort, dependency-free). */
function htmlToText(html: string): string {
  const title = html.match(/<title[^>]*>([\s\S]*?)<\/title>/i)?.[1]?.trim();
  const text = html
    .replace(/<(script|style|noscript|svg|template|head)\b[\s\S]*?<\/\1>/gi, " ")
    .replace(/<!--[\s\S]*?-->/g, " ")
    .replace(/<\/(p|div|section|article|li|tr|h[1-6]|table|blockquote|pre|ul|ol|figure|header|footer|main)>/gi, "\n")
    .replace(/<br\s*\/?>/gi, "\n")
    .replace(/<[^>]+>/g, "")
    .replace(/&nbsp;/g, " ")
    .replace(/&amp;/g, "&")
    .replace(/&lt;/g, "<")
    .replace(/&gt;/g, ">")
    .replace(/&quot;/g, '"')
    .replace(/&#39;|&apos;/g, "'")
    .replace(/[ \t]+/g, " ")
    .replace(/\n\s*\n+/g, "\n")
    .trim();
  return title ? `${title}\n${text}` : text;
}
