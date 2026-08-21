// A minimal Responses-API gateway, enough for `codex exec` to complete a turn.
// It records the Authorization header it was given, which is the point: it
// proves Codex resolved the manager-written provider and took the auth.json
// credential path rather than sending nothing or falling back to ChatGPT.
import fs from "node:fs";
import http from "node:http";

const PORT = Number(process.argv[2] || 45998);
const RECORD = process.argv[3];
const REPLY = "PONG from the fake Responses gateway.";

function sse(response, event, data) {
  response.write(`event: ${event}\ndata: ${JSON.stringify(data)}\n\n`);
}

const server = http.createServer((request, response) => {
  const chunks = [];
  request.on("data", (chunk) => chunks.push(chunk));
  request.on("end", () => {
    const body = Buffer.concat(chunks).toString("utf8");
    if (RECORD) {
      fs.appendFileSync(RECORD, `${JSON.stringify({
        url: request.url,
        authorization: request.headers.authorization || null,
        bodyPreview: body.slice(0, 400),
      })}\n`);
    }
    if (!request.url.startsWith("/v1/responses")) {
      response.writeHead(404, { "Content-Type": "application/json" });
      response.end(JSON.stringify({ error: { message: "not found" } }));
      return;
    }

    const id = "resp_fake";
    const itemId = "msg_fake";
    response.writeHead(200, {
      "Content-Type": "text/event-stream",
      "Cache-Control": "no-cache",
      Connection: "keep-alive",
    });
    const base = { id, object: "response", model: "fake-responses-model", status: "in_progress", output: [] };
    sse(response, "response.created", { type: "response.created", response: base });
    sse(response, "response.in_progress", { type: "response.in_progress", response: base });
    sse(response, "response.output_item.added", {
      type: "response.output_item.added",
      output_index: 0,
      item: { id: itemId, type: "message", role: "assistant", status: "in_progress", content: [] },
    });
    sse(response, "response.content_part.added", {
      type: "response.content_part.added",
      item_id: itemId,
      output_index: 0,
      content_index: 0,
      part: { type: "output_text", text: "" },
    });
    sse(response, "response.output_text.delta", {
      type: "response.output_text.delta",
      item_id: itemId,
      output_index: 0,
      content_index: 0,
      delta: REPLY,
    });
    sse(response, "response.output_text.done", {
      type: "response.output_text.done",
      item_id: itemId,
      output_index: 0,
      content_index: 0,
      text: REPLY,
    });
    sse(response, "response.content_part.done", {
      type: "response.content_part.done",
      item_id: itemId,
      output_index: 0,
      content_index: 0,
      part: { type: "output_text", text: REPLY },
    });
    const finishedItem = {
      id: itemId,
      type: "message",
      role: "assistant",
      status: "completed",
      content: [{ type: "output_text", text: REPLY, annotations: [] }],
    };
    sse(response, "response.output_item.done", { type: "response.output_item.done", output_index: 0, item: finishedItem });
    sse(response, "response.completed", {
      type: "response.completed",
      response: {
        ...base,
        status: "completed",
        output: [finishedItem],
        usage: { input_tokens: 8, output_tokens: 9, total_tokens: 17 },
      },
    });
    response.end();
  });
});

server.listen(PORT, "127.0.0.1", () => {
  process.stderr.write(`[responses] listening on 127.0.0.1:${PORT}\n`);
});
