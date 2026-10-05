// One origin, one credential, three native wire protocols. Deliberately refuse
// missing /v1 and doubled /v1 so an incorrect base URL cannot pass this test.
import fs from "node:fs";
import http from "node:http";

const [port, record] = process.argv.slice(2);
const server = http.createServer((request, response) => {
  if (request.url === "/health") { response.end("ready"); return; }
  const chunks = [];
  request.on("data", (chunk) => chunks.push(chunk));
  request.on("end", () => {
    const body = JSON.parse(Buffer.concat(chunks).toString() || "{}");
    const pathname = new URL(request.url, "http://localhost").pathname;
    fs.appendFileSync(record, `${JSON.stringify({ url: pathname, headers: request.headers, body })}\n`);
    const anthropic = ["/v1/messages", "/anthropic/v1/messages"].includes(pathname);
    const chat = ["/v1/chat/completions", "/openai/v1/chat/completions"].includes(pathname);
    const responses = ["/v1/responses", "/openai/v1/responses"].includes(pathname);
    if (!anthropic && !chat && !responses) { response.writeHead(404); response.end(); return; }
    response.writeHead(200, { "Content-Type": "text/event-stream", "Cache-Control": "no-cache" });
    const event = (type, payload) => response.write(`event: ${type}\ndata: ${JSON.stringify({ type, ...payload })}\n\n`);
    if (anthropic) {
      event("message_start", { message: { id: "msg_fake", type: "message", role: "assistant", model: body.model, content: [], stop_reason: null, stop_sequence: null, usage: { input_tokens: 8, output_tokens: 0 } } });
      event("content_block_start", { index: 0, content_block: { type: "text", text: "" } });
      event("content_block_delta", { index: 0, delta: { type: "text_delta", text: "PONG" } });
      event("content_block_stop", { index: 0 });
      event("message_delta", { delta: { stop_reason: "end_turn", stop_sequence: null }, usage: { output_tokens: 4 } });
      event("message_stop", {});
    } else if (chat) {
      for (const [delta, finish_reason] of [[{ role: "assistant", content: "PONG" }, null], [{}, "stop"]]) {
        response.write(`data: ${JSON.stringify({ id: "chat_fake", object: "chat.completion.chunk", created: 0, model: body.model, choices: [{ index: 0, delta, finish_reason }] })}\n\n`);
      }
      response.write("data: [DONE]\n\n");
    } else {
      const base = { id: "resp_fake", object: "response", model: body.model, status: "in_progress", output: [] };
      const item = { id: "msg_fake", type: "message", role: "assistant", status: "in_progress", content: [] };
      const part = { type: "output_text", text: "PONG", annotations: [] };
      event("response.created", { response: base });
      event("response.output_item.added", { output_index: 0, item });
      event("response.content_part.added", { item_id: item.id, output_index: 0, content_index: 0, part: { ...part, text: "" } });
      event("response.output_text.delta", { item_id: item.id, output_index: 0, content_index: 0, delta: "PONG" });
      event("response.output_text.done", { item_id: item.id, output_index: 0, content_index: 0, text: "PONG" });
      const finished = { ...item, status: "completed", content: [part] };
      event("response.output_item.done", { output_index: 0, item: finished });
      event("response.completed", { response: { ...base, status: "completed", output: [finished], usage: { input_tokens: 8, output_tokens: 4, total_tokens: 12 } } });
    }
    response.end();
  });
});
server.listen(Number(port), "127.0.0.1");
