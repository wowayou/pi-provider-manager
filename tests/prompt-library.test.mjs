import assert from "node:assert/strict";
import crypto from "node:crypto";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";

import { ConflictError } from "../lib/validation.mjs";
import { MAX_DOCUMENTS_PER_SLOT, MAX_PROMPT_BYTES, createPromptLibrary } from "../lib/prompt-library.mjs";

function sandbox() {
  return fs.mkdtempSync(path.join(os.tmpdir(), "ppm-prompts-"));
}

// Two slots, so the tests cover both the single-file shape Codex has and the
// multi-file shape Pi has.
function library(dir) {
  return createPromptLibrary({
    dir,
    revisionKey: crypto.randomBytes(32),
    subject: "测试提示词",
    slots: [
      { id: "agents", file: "AGENTS.md", label: "AGENTS.md", note: "" },
      { id: "system", file: "SYSTEM.md", label: "SYSTEM.md", note: "" },
    ],
  });
}

function slotOf(state, id) {
  return state.slots.find((slot) => slot.id === id);
}

function withLibrary(run) {
  const dir = sandbox();
  try {
    run(library(dir), dir);
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
}

test("reports every declared slot, absent until something is written", () => {
  withLibrary((prompts) => {
    const state = prompts.publicState();
    assert.deepEqual(state.slots.map((slot) => slot.file), ["AGENTS.md", "SYSTEM.md"]);
    for (const slot of state.slots) {
      assert.equal(slot.present, false);
      assert.equal(slot.activeId, "");
      assert.deepEqual(slot.documents, []);
    }
  });
});

test("saving writes the file the agent actually reads", () => {
  withLibrary((prompts, dir) => {
    const { id } = prompts.saveDocument({
      target: "pi",
      slot: "agents",
      name: "日常",
      text: "# 我的规则\n始终使用中文回复。\n",
      revision: prompts.publicState().revision,
    });
    assert.equal(fs.readFileSync(path.join(dir, "AGENTS.md"), "utf8"), "# 我的规则\n始终使用中文回复。\n");

    const slot = slotOf(prompts.publicState(), "agents");
    assert.equal(slot.present, true);
    assert.equal(slot.activeId, id);
    assert.equal(slot.documents.length, 1);
    // The text comes back: unlike a credential, a prompt nobody can read back
    // cannot be edited.
    assert.equal(slot.documents[0].text, "# 我的规则\n始终使用中文回复。\n");
  });
});

test("switching swaps the file contents and leaves the other slot alone", () => {
  withLibrary((prompts, dir) => {
    const first = prompts.saveDocument({
      slot: "agents", name: "中文", text: "用中文。\n", revision: prompts.publicState().revision,
    });
    prompts.saveDocument({
      slot: "system", name: "系统", text: "SYSTEM 内容\n", revision: prompts.publicState().revision,
    });
    const second = prompts.saveDocument({
      slot: "agents", name: "English", text: "Answer in English.\n", revision: prompts.publicState().revision,
    });
    assert.equal(fs.readFileSync(path.join(dir, "AGENTS.md"), "utf8"), "Answer in English.\n");

    prompts.activate({ slot: "agents", id: first.id, revision: prompts.publicState().revision });
    assert.equal(fs.readFileSync(path.join(dir, "AGENTS.md"), "utf8"), "用中文。\n");
    assert.equal(fs.readFileSync(path.join(dir, "SYSTEM.md"), "utf8"), "SYSTEM 内容\n");

    const slot = slotOf(prompts.publicState(), "agents");
    assert.equal(slot.activeId, first.id);
    assert.equal(slot.documents.length, 2);
    assert.equal(slot.documents.find((document) => document.id === second.id).isActive, false);
  });
});

test("adopts a file that predates the manager instead of presenting it as absent", () => {
  withLibrary((prompts, dir) => {
    fs.writeFileSync(path.join(dir, "AGENTS.md"), "手写的规则，别弄丢。\n");
    const before = fs.statSync(path.join(dir, "AGENTS.md")).mtimeMs;

    const slot = slotOf(prompts.publicState(), "agents");
    assert.equal(slot.present, true);
    assert.equal(slot.documents.length, 1);
    assert.equal(slot.documents[0].adopted, true);
    assert.equal(slot.documents[0].text, "手写的规则，别弄丢。\n");
    assert.equal(slot.activeId, slot.documents[0].id);

    // Reading state must never write: opening the page cannot disturb a file
    // that is already working.
    assert.equal(fs.statSync(path.join(dir, "AGENTS.md")).mtimeMs, before);
    assert.equal(fs.existsSync(prompts.storePath), false);
  });
});

test("saving alongside an adopted file keeps the adopted one", () => {
  withLibrary((prompts, dir) => {
    fs.writeFileSync(path.join(dir, "AGENTS.md"), "手写的规则。\n");
    const adoptedId = slotOf(prompts.publicState(), "agents").documents[0].id;

    prompts.saveDocument({
      slot: "agents", name: "新的", text: "新内容。\n", revision: prompts.publicState().revision,
    });

    const slot = slotOf(prompts.publicState(), "agents");
    assert.equal(slot.documents.length, 2, "the adopted file became a real entry rather than being dropped");
    const adopted = slot.documents.find((document) => document.id === adoptedId);
    assert.equal(adopted.text, "手写的规则。\n");
    assert.equal(fs.readFileSync(path.join(dir, "AGENTS.md"), "utf8"), "新内容。\n");
  });
});

test("an edit to the active document rewrites the file", () => {
  withLibrary((prompts, dir) => {
    const { id } = prompts.saveDocument({
      slot: "agents", name: "规则", text: "第一版\n", revision: prompts.publicState().revision,
    });
    prompts.saveDocument({
      slot: "agents", id, name: "规则", text: "第二版\n", activate: false, revision: prompts.publicState().revision,
    });
    // activate:false must not strand the file on stale text while the UI shows
    // the document as live.
    assert.equal(fs.readFileSync(path.join(dir, "AGENTS.md"), "utf8"), "第二版\n");
  });
});

test("refuses to delete the document that is currently in the file", () => {
  withLibrary((prompts, dir) => {
    const { id } = prompts.saveDocument({
      slot: "agents", name: "唯一", text: "内容\n", revision: prompts.publicState().revision,
    });
    assert.throws(
      () => prompts.deleteDocument({ slot: "agents", id, revision: prompts.publicState().revision }),
      /正在生效/,
    );
    assert.equal(fs.readFileSync(path.join(dir, "AGENTS.md"), "utf8"), "内容\n");

    const replacement = prompts.saveDocument({
      slot: "agents", name: "替代", text: "替代内容\n", activate: false, revision: prompts.publicState().revision,
    });
    prompts.deleteDocument({
      slot: "agents", id, replacementId: replacement.id, revision: prompts.publicState().revision,
    });
    assert.equal(fs.readFileSync(path.join(dir, "AGENTS.md"), "utf8"), "替代内容\n");
    assert.equal(slotOf(prompts.publicState(), "agents").documents.length, 1);
  });
});

test("a stale revision is refused and nothing on disk moves", () => {
  withLibrary((prompts, dir) => {
    prompts.saveDocument({
      slot: "agents", name: "原始", text: "原始内容\n", revision: prompts.publicState().revision,
    });
    const stale = prompts.publicState().revision;
    prompts.saveDocument({
      slot: "agents", name: "第二条", text: "第二条内容\n", revision: prompts.publicState().revision,
    });
    const onDisk = fs.readFileSync(path.join(dir, "AGENTS.md"), "utf8");

    assert.throws(
      () => prompts.saveDocument({ slot: "agents", name: "第三条", text: "不该写入\n", revision: stale }),
      ConflictError,
    );
    assert.equal(fs.readFileSync(path.join(dir, "AGENTS.md"), "utf8"), onDisk);
  });
});

test("editing one slot does not invalidate a draft for the other agent", () => {
  const dir = sandbox();
  const other = sandbox();
  try {
    const key = crypto.randomBytes(32);
    const slots = [{ id: "agents", file: "AGENTS.md", label: "AGENTS.md", note: "" }];
    const pi = createPromptLibrary({ dir, revisionKey: key, subject: "Pi", slots });
    const codex = createPromptLibrary({ dir: other, revisionKey: key, subject: "Codex", slots });

    const codexRevision = codex.publicState().revision;
    pi.saveDocument({ slot: "agents", name: "Pi 的", text: "pi\n", revision: pi.publicState().revision });
    assert.equal(codex.publicState().revision, codexRevision, "a Pi write must not stale a Codex draft");
    codex.saveDocument({ slot: "agents", name: "Codex 的", text: "codex\n", revision: codexRevision });
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
    fs.rmSync(other, { recursive: true, force: true });
  }
});

test("rejects an unknown slot, an oversized document, and too many documents", () => {
  withLibrary((prompts) => {
    assert.throws(() => prompts.saveDocument({
      slot: "nope", name: "x", text: "", revision: prompts.publicState().revision,
    }), /未知的提示词文件/);

    assert.throws(() => prompts.saveDocument({
      slot: "agents", name: "太大", text: "a".repeat(MAX_PROMPT_BYTES + 1), revision: prompts.publicState().revision,
    }), /过长/);

    assert.throws(() => prompts.saveDocument({
      slot: "agents", name: "   ", text: "x", revision: prompts.publicState().revision,
    }), /名称/);

    for (let index = 0; index < MAX_DOCUMENTS_PER_SLOT; index += 1) {
      prompts.saveDocument({
        slot: "agents", name: `第 ${index} 条`, text: `内容 ${index}\n`, revision: prompts.publicState().revision,
      });
    }
    assert.throws(() => prompts.saveDocument({
      slot: "agents", name: "再一条", text: "满了\n", revision: prompts.publicState().revision,
    }), /最多保存/);
  });
});

test("keeps the store private and distinguishes an empty file from a missing one", () => {
  withLibrary((prompts, dir) => {
    prompts.saveDocument({
      slot: "agents", name: "空的", text: "", revision: prompts.publicState().revision,
    });
    const slot = slotOf(prompts.publicState(), "agents");
    assert.equal(slot.present, true, "an empty file is present, not missing");
    assert.notEqual(slot.activeId, "");
    assert.equal(slotOf(prompts.publicState(), "system").present, false);

    if (process.platform !== "win32") {
      assert.equal(fs.statSync(prompts.storePath).mode & 0o777, 0o600);
      assert.equal(fs.statSync(path.join(dir, "AGENTS.md")).mode & 0o777, 0o600);
    }
  });
});
