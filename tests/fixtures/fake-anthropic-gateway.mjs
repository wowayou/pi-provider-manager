import fs from "node:fs";
import http from "node:http";
const port = Number(process.argv[2] || 45997);
const record = process.argv[3];
function sse(response, event, data) { response.write(`event: ${event}\ndata: ${JSON.stringify(data)}\n\n`); }
const server = http.createServer((request, response) => {
  const chunks = [];
  request.on("data", (chunk) => chunks.push(chunk));
  request.on("end", () => {
    const body = Buffer.concat(chunks).toString("utf8");
    if (record) fs.appendFileSync(record, `${JSON.stringify({ url: request.url, headers: request.headers, body: JSON.parse(body || "{}") })}\n`);
    // The Anthropic SDK's beta surface posts to /v1/messages?beta=true, so the
    // path is matched without its query.
    if (request.method !== "POST" || new URL(request.url, "http://127.0.0.1").pathname !== "/v1/messages") { response.writeHead(404); response.end(); return; }
    const model = JSON.parse(body || "{}").model || "fake-anthropic-model";
    const message = { id: "msg_fake", type: "message", role: "assistant", model, content: [], stop_reason: null, stop_sequence: null, usage: { input_tokens: 8, output_tokens: 4 } };
    response.writeHead(200, { "Content-Type": "text/event-stream", "Cache-Control": "no-cache", Connection: "keep-alive" });
    sse(response, "message_start", { type: "message_start", message });
    sse(response, "content_block_start", { type: "content_block_start", index: 0, content_block: { type: "text", text: "" } });
    sse(response, "content_block_delta", { type: "content_block_delta", index: 0, delta: { type: "text_delta", text: "PONG" } });
    sse(response, "content_block_stop", { type: "content_block_stop", index: 0 });
    sse(response, "message_delta", { type: "message_delta", delta: { stop_reason: "end_turn", stop_sequence: null }, usage: { output_tokens: 4 } });
    sse(response, "message_stop", { type: "message_stop" });
    response.end();
  });
});
server.listen(port, "127.0.0.1", () => process.stderr.write(`[anthropic] listening on 127.0.0.1:${port}\n`));
