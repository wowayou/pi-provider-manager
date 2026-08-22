// Keeps several named instruction documents for one agent, of which exactly one
// occupies each file that agent actually reads.
//
// This is the same shape as the Codex provider store, for the same reason: the
// agent has one slot on disk and no notion of an inactive alternative, so the
// file stays the truth for what the agent will do and this manager's own store
// holds everything else. Both agents keep these files in the directory this
// manager already manages, so one module serves both — the caller only says
// which files exist and what each one means.
//
// Pi:    AGENTS.md (concatenated with the project's), SYSTEM.md (replaces the
//        default system prompt), APPEND_SYSTEM.md (appends to it).
// Codex: AGENTS.md (concatenated with the project's).
//
// Unlike credentials, prompt text IS returned to the browser. That is not an
// oversight in the rule that an API key must never travel back: the whole point
// of this screen is editing the text, and a document nobody can read back
// cannot be edited. Anything secret belongs in a credential, not in a prompt.

import path from "node:path";

import { isObject, readJson, snapshot, writeJsonAtomic, writeTextAtomic } from "./atomic-files.mjs";
import { createFileGuard } from "./managed-files.mjs";
import { PROVIDER_ID_PATTERN } from "./validation.mjs";

// Generous enough for any real instruction file, small enough that a paste
// accident cannot put the config directory under memory pressure.
export const MAX_PROMPT_BYTES = 256 * 1024;
export const MAX_DOCUMENTS_PER_SLOT = 50;

function uniqueId(base, taken) {
  const seed = base || "prompt";
  if (!Object.hasOwn(taken, seed)) return seed;
  for (let suffix = 2; ; suffix += 1) {
    const candidate = `${seed}-${suffix}`;
    if (!Object.hasOwn(taken, candidate)) return candidate;
  }
}

export function slugId(value) {
  return String(value).toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-+|-+$/g, "");
}

export function createPromptLibrary({ dir, slots, revisionKey, subject }) {
  const storePath = path.join(dir, "pi-provider-manager-prompts.json");
  const slotList = slots.map((slot) => ({ ...slot, path: path.join(dir, slot.file) }));
  const slotById = new Map(slotList.map((slot) => [slot.id, slot]));
  const guard = createFileGuard({
    paths: [...slotList.map((slot) => slot.path), storePath],
    revisionKey,
    subject,
  });

  function normalizeStore(source) {
    const out = { version: 1, slots: {} };
    const rawSlots = isObject(source.slots) ? source.slots : {};
    for (const slot of slotList) {
      const raw = isObject(rawSlots[slot.id]) ? rawSlots[slot.id] : {};
      const documents = {};
      if (isObject(raw.documents)) {
        for (const [id, document] of Object.entries(raw.documents)) {
          if (!PROVIDER_ID_PATTERN.test(id) || !isObject(document)) continue;
          documents[id] = {
            name: String(document.name || "").trim() || id,
            text: typeof document.text === "string" ? document.text : "",
          };
        }
      }
      const activeId = typeof raw.activeId === "string" && Object.hasOwn(documents, raw.activeId)
        ? raw.activeId
        : "";
      out.slots[slot.id] = { activeId, documents };
    }
    return out;
  }

  function load() {
    const files = guard.stableSnapshots();
    return { files, store: normalizeStore(readJson(storePath)) };
  }

  // Derives what is really in effect, without writing. A file whose contents
  // match no stored document is adopted into the view as its own entry, so a
  // hand-written AGENTS.md that predates this manager shows up as the active
  // one instead of being silently presented as absent — and then overwritten
  // by the first activation.
  function resolve(store) {
    const view = {};
    for (const slot of slotList) {
      const state = store.slots[slot.id];
      const documents = { ...state.documents };
      // snapshot() rather than readText(): an absent file and an empty one are
      // different answers here, and readText reports both as "".
      const bytes = snapshot(slot.path);
      const onDisk = bytes === null ? null : bytes.toString("utf8");
      let activeId = state.activeId;
      let adoptedId = "";
      if (onDisk !== null) {
        const match = Object.keys(documents).find((id) => documents[id].text === onDisk);
        if (match) {
          activeId = match;
        } else {
          adoptedId = uniqueId("existing", documents);
          documents[adoptedId] = { name: "现有内容", text: onDisk, adopted: true };
          activeId = adoptedId;
        }
      } else {
        // Nothing on disk, so nothing is in effect no matter what the store says.
        activeId = "";
      }
      view[slot.id] = { documents, activeId, adoptedId, present: onDisk !== null };
    }
    return view;
  }

  function publicState() {
    const { files, store } = load();
    const view = resolve(store);
    return {
      dir,
      revision: guard.revisionOf(files),
      slots: slotList.map((slot) => {
        const resolved = view[slot.id];
        return {
          id: slot.id,
          file: slot.file,
          path: slot.path,
          label: slot.label,
          note: slot.note,
          present: resolved.present,
          activeId: resolved.activeId,
          adoptedId: resolved.adoptedId,
          documents: Object.keys(resolved.documents).sort().map((id) => ({
            id,
            name: resolved.documents[id].name,
            text: resolved.documents[id].text,
            adopted: resolved.documents[id].adopted === true,
            isActive: id === resolved.activeId,
          })),
        };
      }),
      limits: { maxBytes: MAX_PROMPT_BYTES, maxDocuments: MAX_DOCUMENTS_PER_SLOT },
    };
  }

  function requireSlot(payload) {
    const slot = slotById.get(String(payload.slot || ""));
    if (!slot) throw new Error("未知的提示词文件。");
    return slot;
  }

  // Folds whatever `resolve` adopted into the store, so a save never discards
  // the file that was in effect when the page was rendered.
  function materialize(store, slotId) {
    const resolved = resolve(store)[slotId];
    const state = store.slots[slotId];
    state.documents = Object.fromEntries(
      Object.entries(resolved.documents).map(([id, document]) => [id, { name: document.name, text: document.text }]),
    );
    state.activeId = resolved.activeId;
    return state;
  }

  function writeSlot(slot, state) {
    const active = state.activeId ? state.documents[state.activeId] : null;
    if (!active) throw new Error("没有可写入的提示词。");
    writeTextAtomic(slot.path, active.text);
  }

  function saveDocument(payload) {
    const slot = requireSlot(payload);
    const revision = guard.requireCurrentRevision(payload);
    const { store } = load();
    const state = materialize(store, slot.id);

    const name = String(payload.name || "").trim();
    if (!name) throw new Error("请填写提示词名称。");
    const text = typeof payload.text === "string" ? payload.text : "";
    if (Buffer.byteLength(text, "utf8") > MAX_PROMPT_BYTES) {
      throw new Error(`提示词过长，上限 ${Math.floor(MAX_PROMPT_BYTES / 1024)} KiB。`);
    }

    const requested = String(payload.id || "");
    let id = requested;
    if (!Object.hasOwn(state.documents, id)) {
      if (Object.keys(state.documents).length >= MAX_DOCUMENTS_PER_SLOT) {
        throw new Error(`每个文件最多保存 ${MAX_DOCUMENTS_PER_SLOT} 条提示词。`);
      }
      id = uniqueId(slugId(requested) || slugId(name), state.documents);
    }
    // An adopted entry becomes a real one the moment it is saved.
    state.documents[id] = { name, text };
    const activate = payload.activate !== false || state.activeId === id;
    if (activate) state.activeId = id;

    guard.writeAll(revision, () => {
      if (activate) writeSlot(slot, state);
      writeJsonAtomic(storePath, store);
    });
    return { slotId: slot.id, id, activated: activate };
  }

  function activate(payload) {
    const slot = requireSlot(payload);
    const revision = guard.requireCurrentRevision(payload);
    const { store } = load();
    const state = materialize(store, slot.id);
    const id = String(payload.id || "");
    if (!Object.hasOwn(state.documents, id)) throw new Error("要启用的提示词不存在。");
    state.activeId = id;
    guard.writeAll(revision, () => {
      writeSlot(slot, state);
      writeJsonAtomic(storePath, store);
    });
    return { slotId: slot.id, id };
  }

  function deleteDocument(payload) {
    const slot = requireSlot(payload);
    const revision = guard.requireCurrentRevision(payload);
    const { store } = load();
    const state = materialize(store, slot.id);
    const id = String(payload.id || "");
    if (!Object.hasOwn(state.documents, id)) throw new Error("要删除的提示词不存在。");

    // Deleting what is currently in the file would leave the agent reading text
    // this manager no longer knows about. Same rule as deleting a live
    // provider: name the replacement, or the delete is refused.
    const replacementId = String(payload.replacementId || "");
    const isActive = state.activeId === id;
    if (isActive) {
      if (!Object.hasOwn(state.documents, replacementId) || replacementId === id) {
        throw new Error("这条提示词正在生效，请指定一条替代它的提示词。");
      }
    }
    delete state.documents[id];
    if (isActive) state.activeId = replacementId;

    guard.writeAll(revision, () => {
      if (isActive) writeSlot(slot, state);
      writeJsonAtomic(storePath, store);
    });
    return { slotId: slot.id, activeId: state.activeId };
  }

  return { storePath, slots: slotList, publicState, saveDocument, activate, deleteDocument };
}
