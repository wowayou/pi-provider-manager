import assert from "node:assert/strict";
import test from "node:test";
import { applyAnthropicBeta, normalizeAnthropicBeta, readAnthropicBeta } from "../lib/pi-anthropic-beta.mjs";

test("normalizes beta tokens and deduplicates",()=>assert.equal(normalizeAnthropicBeta(" context-1m-2025-08-07, foo, context-1m-2025-08-07 "),"context-1m-2025-08-07, foo"));
test("rejects dynamic, control, unicode, and invalid tokens",()=>{
  for (const value of ["!secret", "$BETA", "a\n b", "\n", "\r\n", " ".repeat(2049), "中文", "a:b", ",foo"]) assert.throws(()=>normalizeAnthropicBeta(value));
});
test("summarizes safe, absent, and external values without leaking",()=>{
  assert.deepEqual(readAnthropicBeta(undefined),{kind:"none"});
  assert.deepEqual(readAnthropicBeta({"anthropic-beta":"a, b"}),{kind:"literal",value:"a, b"});
  assert.deepEqual(readAnthropicBeta({"Anthropic-Beta":""}),{kind:"external"});
  assert.deepEqual(readAnthropicBeta({"anthropic-beta":"!secret"}),{kind:"external"});
  assert.deepEqual(readAnthropicBeta({"anthropic-beta":"a","ANTHROPIC-BETA":"b"}),{kind:"external"});
});
test("writes only canonical key and preserves other headers",()=>{
  assert.deepEqual(applyAnthropicBeta({X:"keep","ANTHROPIC-BETA":"old"},"a, a"),{X:"keep","anthropic-beta":"a"});
  assert.deepEqual(applyAnthropicBeta({"anthropic-beta":"old"},""),undefined);
  assert.throws(()=>applyAnthropicBeta({X:"keep"},"a:b"));
  assert.throws(()=>applyAnthropicBeta("bad","a"));
});
