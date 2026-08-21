// A gateway that implements only /v1/chat/completions — the exact case the
// managed bridge exists for. It refuses /v1/responses the way such a gateway
// would, so if Codex ever reaches it directly the run fails loudly instead of
// quietly appearing to work.
import http from "node:http";

const PORT = Number(process.argv[2] || 45999);
const EXPECTED_KEY = process.argv[3] || "upstream-test-key";
const seen = [];

const server = http.createServer((request, response) => {
  const chunks = [];
  request.on("data", (chunk) => chunks.push(chunk));
  request.on("end", () => {
    const body = Buffer.concat(chunks).toString("utf8");
    seen.push({ url: request.url, auth: request.headers.authorization || "" });
    process.stderr.write(`[upstream] ${request.method} ${request.url} auth=${request.headers.authorization ? "yes" : "NO"}\n`);

    if (request.url.startsWith("/v1/responses")) {
      response.writeHead(404, { "Content-Type": "application/json" });
      response.end(JSON.stringify({ error: { message: "this gateway only implements /v1/chat/completions" } }));
      return;
    }
    if (request.url.startsWith("/v1/models")) {
      response.writeHead(200, { "Content-Type": "application/json" });
      response.end(JSON.stringify({ object: "list", data: [{ id: "fake-chat-model", object: "model" }] }));
      return;
    }
    if (!request.url.startsWith("/v1/chat/completions")) {
      response.writeHead(404, { "Content-Type": "application/json" });
      response.end(JSON.stringify({ error: { message: "not found" } }));
      return;
    }
    if (request.headers.authorization !== `Bearer ${EXPECTED_KEY}`) {
      response.writeHead(401, { "Content-Type": "application/json" });
      response.end(JSON.stringify({ error: { message: "bad key" } }));
      return;
    }

    let parsed = {};
    try {
      parsed = JSON.parse(body || "{}");
    } catch {}
    const reply = `PONG from the fake upstream. I saw ${(parsed.messages || []).length} message(s).`;

    if (parsed.stream) {
      response.writeHead(200, {
        "Content-Type": "text/event-stream",
        "Cache-Control": "no-cache",
        Connection: "keep-alive",
      });
      const frame = (delta, finish = null) => {
        response.write(`data: ${JSON.stringify({
          id: "chatcmpl-fake",
          object: "chat.completion.chunk",
          created: Math.floor(Date.now() / 1000),
          model: parsed.model || "fake-chat-model",
          choices: [{ index: 0, delta, finish_reason: finish }],
        })}\n\n`);
      };
      frame({ role: "assistant", content: "" });
      for (const piece of reply.match(/.{1,12}/g) || []) frame({ content: piece });
      frame({}, "stop");
      response.write("data: [DONE]\n\n");
      response.end();
      return;
    }

    response.writeHead(200, { "Content-Type": "application/json" });
    response.end(JSON.stringify({
      id: "chatcmpl-fake",
      object: "chat.completion",
      created: Math.floor(Date.now() / 1000),
      model: parsed.model || "fake-chat-model",
      choices: [{ index: 0, message: { role: "assistant", content: reply }, finish_reason: "stop" }],
      usage: { prompt_tokens: 8, completion_tokens: 12, total_tokens: 20 },
    }));
  });
});

server.listen(PORT, "127.0.0.1", () => {
  process.stderr.write(`[upstream] chat-completions-only gateway on 127.0.0.1:${PORT}\n`);
});

process.on("SIGTERM", () => {
  process.stderr.write(`[upstream] saw ${seen.length} request(s): ${seen.map((s) => s.url).join(", ")}\n`);
  server.close(() => process.exit(0));
});
