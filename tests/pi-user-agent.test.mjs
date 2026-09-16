import assert from "node:assert/strict";
import test from "node:test";

import { applyUserAgent, readUserAgent, validateUserAgent } from "../lib/pi-user-agent.mjs";
import { USER_AGENT_PRESETS } from "../src/user-agent-presets.mjs";

test("validates literal User-Agent values without evaluating Pi expressions", () => {
  assert.equal(validateUserAgent("  client/1.0  "), "client/1.0");
  assert.equal(validateUserAgent(""), "");
  assert.equal(validateUserAgent("a".repeat(512)), "a".repeat(512));
  for (const value of ["client\n/1.0", "client\t/1.0", "客户端/1.0", "😀/1.0", "client\u007f/1.0", "client/$VERSION", "!secret-tool read ua"]) {
    assert.throws(() => validateUserAgent(value));
  }
  assert.throws(() => validateUserAgent("a".repeat(513)));
  assert.throws(() => validateUserAgent(null));
});

test("exposes only safe literal provider UA states", () => {
  assert.deepEqual(readUserAgent(undefined), { kind: "none" });
  assert.deepEqual(readUserAgent({}), { kind: "none" });
  assert.deepEqual(readUserAgent({ "user-agent": "client/1.0" }), { kind: "literal", value: "client/1.0" });
  assert.deepEqual(readUserAgent({ "User-Agent": "  client/1.0  " }), { kind: "literal", value: "client/1.0" });
  assert.deepEqual(readUserAgent({ "User-Agent": "$UA" }), { kind: "external" });
  assert.deepEqual(readUserAgent({ "User-Agent": "client/1.0", "user-agent": "client/2.0" }), { kind: "external" });
  assert.deepEqual(readUserAgent({ "User-Agent": 42 }), { kind: "external" });
  assert.deepEqual(readUserAgent(["User-Agent"]), { kind: "external" });
});

test("applies an explicit UA change without touching other headers", () => {
  const original = {
    "x-secret": "!op read secret",
    "user-agent": "old/1.0",
    "USER-AGENT": "ambiguous/1.0",
    "x-route": "keep",
  };
  const changed = applyUserAgent(original, { userAgent: "new/1.0" });
  assert.deepEqual(changed, { "x-secret": "!op read secret", "x-route": "keep", "User-Agent": "new/1.0" });
  assert.deepEqual(original, {
    "x-secret": "!op read secret",
    "user-agent": "old/1.0",
    "USER-AGENT": "ambiguous/1.0",
    "x-route": "keep",
  });

  assert.deepEqual(applyUserAgent(changed, { userAgent: "" }), {
    "x-secret": "!op read secret",
    "x-route": "keep",
  });
  assert.equal(applyUserAgent({ "User-Agent": "old/1.0" }, { userAgent: "" }), undefined);
  assert.deepEqual(applyUserAgent(original, {}), original);
  assert.throws(() => applyUserAgent(["bad"], { userAgent: "new/1.0" }));
  assert.throws(() => applyUserAgent({ "x": "keep" }, { userAgent: null }));
});

test("the Grok Build preset uses the official grok-shell product prefix", () => {
  assert.equal(USER_AGENT_PRESETS.find((preset) => preset.id === "grok-build")?.value, "grok-shell/1.0.0 (linux; x86_64)");
});
