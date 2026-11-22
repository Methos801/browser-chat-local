/** Read complete SSE data frames across arbitrary network chunk boundaries. */
export async function* sseData(body: ReadableStream<Uint8Array>): AsyncGenerator<string> {
  const reader = body.getReader();
  const decoder = new TextDecoder();
  let buffer = "";
  let data: string[] = [];
  try {
    while (true) {
      const {done,value} = await reader.read();
      buffer += done ? decoder.decode() : decoder.decode(value,{stream:true});
      let index: number;
      while ((index = buffer.indexOf("\n")) >= 0) {
        const line = buffer.slice(0,index).replace(/\r$/,"");
        buffer = buffer.slice(index+1);
        if (!line) { if (data.length) yield data.join("\n"); data = []; }
        else if (line.startsWith("data:")) data.push(line.slice(5).replace(/^ /,""));
      }
      if (done) {
        if (buffer.startsWith("data:")) data.push(buffer.slice(5).trim());
        if (data.length) yield data.join("\n");
        break;
      }
    }
  } finally { await reader.cancel().catch(()=>{}); reader.releaseLock(); }
}
