import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test, { after } from "node:test";

import { publicModelHints, readModelHints, recordModelHints } from "../lib/model-hints.mjs";

const temporary = [];
after(() => { for (const entry of temporary) fs.rmSync(entry, { recursive: true, force: true }); });

function hintsFile() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "ppm-hints-"));
  temporary.push(dir);
  return path.join(dir, "pi-provider-manager-model-hints.json");
}

test("records capacities keyed by gateway and id, and reads them back", () => {
  const file = hintsFile();
  recordModelHints(file, "relay-a", [
    { id: "claude-opus", contextWindow: 1_000_000, maxTokens: 128_000 },
    { id: "cheap", contextWindow: 128_000, maxTokens: 8_192 },
  ]);
  recordModelHints(file, "relay-b", [{ id: "claude-opus", contextWindow: 200_000, maxTokens: 64_000 }]);
  const hints = publicModelHints(file);
  assert.deepEqual(hints["relay-a"]["claude-opus"], { contextWindow: 1_000_000, maxTokens: 128_000 });
  // Same id, different gateway, different ceiling — never merged across gateways.
  assert.deepEqual(hints["relay-b"]["claude-opus"], { contextWindow: 200_000, maxTokens: 64_000 });
  assert.equal(Object.hasOwn(hints["relay-a"], "cheap"), true);
});

test("a later save updates the remembered value in place", () => {
  const file = hintsFile();
  recordModelHints(file, "relay", [{ id: "m", contextWindow: 128_000, maxTokens: 16_384 }]);
  recordModelHints(file, "relay", [{ id: "m", contextWindow: 400_000, maxTokens: 128_000 }]);
  assert.deepEqual(publicModelHints(file)["relay"]["m"], { contextWindow: 400_000, maxTokens: 128_000 });
});

test("ignores invalid pairs and never writes junk", () => {
  const file = hintsFile();
  recordModelHints(file, "relay", [
    { id: "ok", contextWindow: 200_000, maxTokens: 64_000 },
    { id: "bad-string", contextWindow: "200000", maxTokens: 64_000 },
    { id: "bad-zero", contextWindow: 0, maxTokens: 64_000 },
    { id: "bad-huge", contextWindow: 999_999_999_999, maxTokens: 64_000 },
    { id: "bad-pair", contextWindow: 8192, maxTokens: 8192 },
    { id: "", contextWindow: 200_000, maxTokens: 64_000 },
  ]);
  assert.deepEqual(Object.keys(publicModelHints(file)["relay"]), ["ok"]);
  // A provider id with no valid model writes nothing at all.
  recordModelHints(file, "empty", [{ id: "x", contextWindow: -1, maxTokens: 1 }]);
  assert.equal(Object.hasOwn(publicModelHints(file), "empty"), false);
});

test("provider and model IDs remain own data properties, including prototype names", () => {
  const file = hintsFile();
  const pair = { contextWindow: 64000, maxTokens: 8192 };
  const beforeObject = Object.getOwnPropertyDescriptors(Object);
  const beforePrototype = Object.getOwnPropertyDescriptors(Object.prototype);
  for (const providerId of ["constructor", "__proto__", "relay"]) {
    recordModelHints(file, providerId, ["__proto__", "constructor", "acceptance-probe"].map((id) => ({ id, ...pair })));
  }
  const hints = publicModelHints(file);
  for (const providerId of ["constructor", "__proto__", "relay"]) {
    assert.equal(Object.hasOwn(hints, providerId), true);
    for (const id of ["__proto__", "constructor", "acceptance-probe"]) {
      assert.equal(Object.hasOwn(hints[providerId], id), true);
      assert.deepEqual(hints[providerId][id], pair);
    }
  }
  assert.deepEqual(Object.getOwnPropertyDescriptors(Object), beforeObject);
  assert.deepEqual(Object.getOwnPropertyDescriptors(Object.prototype), beforePrototype);
});

test("malformed timestamp data cannot break reads or the next save", () => {
  const file = hintsFile();
  fs.writeFileSync(file, JSON.stringify({ hints: { relay: {
    valid: { contextWindow: 64000, maxTokens: 8192, at: { valueOf: null, toString: null } },
    invalid: { contextWindow: 8192, maxTokens: 64000 },
  } } }));
  assert.deepEqual(publicModelHints(file), { relay: { valid: { contextWindow: 64000, maxTokens: 8192 } } });
  recordModelHints(file, "relay", [{ id: "new", contextWindow: 128000, maxTokens: 16384 }]);
  assert.deepEqual(Object.keys(publicModelHints(file).relay), ["valid", "new"]);
});

test("prunes the oldest hint and keeps the cache bounded across providers", () => {
  const file = hintsFile();
  fs.writeFileSync(file, JSON.stringify({ hints: { old: { gone: { contextWindow: 64000, maxTokens: 8192, at: 1 } } } }));
  recordModelHints(file, "current", Array.from({ length: 1000 }, (_, index) => ({ id: `m-${index}`, contextWindow: 64000, maxTokens: 8192 })));
  const hints = publicModelHints(file);
  assert.equal(Object.hasOwn(hints, "old"), false);
  assert.equal(Object.keys(hints.current).length, 1000);
});

test("a missing or corrupt file reads as empty rather than throwing", () => {
  assert.deepEqual(readModelHints(path.join(os.tmpdir(), "ppm-hints-does-not-exist.json")), {});
  const file = hintsFile();
  fs.writeFileSync(file, "not json at all");
  assert.deepEqual(readModelHints(file), {});
  fs.writeFileSync(file, JSON.stringify({ hints: { relay: { m: { contextWindow: 400_000, maxTokens: 128_000 } } } }));
  assert.deepEqual(publicModelHints(file)["relay"]["m"], { contextWindow: 400_000, maxTokens: 128_000 });
});
