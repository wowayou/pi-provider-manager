import assert from "node:assert/strict";
import test from "node:test";
import { changedPersistedModel, selectedNamedModel } from "../src/model-draft.mjs";

test("persisted model identities cannot be renamed or cleared in a draft", () => {
  const unchanged = { rowId: "stored", persistedId: "anthropic/claude-opus", id: "anthropic/claude-opus" };
  const created = { rowId: "new", persistedId: "", id: "openai/gpt-router" };

  assert.equal(changedPersistedModel([unchanged, created]), null);
  assert.equal(
    changedPersistedModel([{ ...unchanged, id: "anthropic/claude-opus-new" }, created])?.persistedId,
    "anthropic/claude-opus",
  );
  assert.equal(
    changedPersistedModel([{ ...unchanged, id: "" }, created])?.persistedId,
    "anthropic/claude-opus",
  );
  assert.equal(changedPersistedModel([created]), null);
});

test("default selection never falls back to a different named row", () => {
  const models = [
    { rowId: "cleared", id: "" },
    { rowId: "named", id: "openai/gpt-router" },
  ];

  assert.equal(selectedNamedModel(models, "cleared"), null);
  assert.equal(selectedNamedModel(models, "missing"), null);
  assert.equal(selectedNamedModel(models, "named"), models[1]);
});
