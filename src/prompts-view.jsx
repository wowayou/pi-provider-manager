// One prompt screen for both agents.
//
// The server sends which files the selected agent reads and what each one does,
// so nothing here is Pi-specific or Codex-specific: Pi shows three files,
// Codex shows one, and neither case is special-cased. Same shape as the
// provider list — a library of named documents, exactly one of them live.

import { useEffect, useMemo, useState } from "react";
import {
  ArrowLeft,
  CheckCircle,
  FileText,
  Info,
  Plus,
  Trash,
  WarningCircle,
} from "@phosphor-icons/react";

import { Spinner } from "./ui-kit.jsx";

const NEW_DOCUMENT = "";

function byteLength(text) {
  return new TextEncoder().encode(text).length;
}

export function PromptsScreen({ target, state, saving, error, onSave, onActivate, onDelete, onNotify, onBack }) {
  const library = state.prompts?.[target] || { slots: [], limits: {} };
  const slots = library.slots || [];
  const [slotId, setSlotId] = useState(slots[0]?.id || "");
  const slot = useMemo(
    () => slots.find((entry) => entry.id === slotId) || slots[0],
    [slots, slotId],
  );
  const documents = slot?.documents || [];

  const [selectedId, setSelectedId] = useState(NEW_DOCUMENT);
  const [draft, setDraft] = useState({ name: "", text: "" });
  const [armedDelete, setArmedDelete] = useState("");
  const [replacementId, setReplacementId] = useState("");

  // Follow the file into view: whatever is live is the thing someone opening
  // this screen wants to look at first.
  useEffect(() => {
    if (!slot) return;
    const live = documents.find((document) => document.id === slot.activeId) || documents[0];
    setSelectedId(live ? live.id : NEW_DOCUMENT);
    setDraft(live ? { name: live.name, text: live.text } : { name: "", text: "" });
    setArmedDelete("");
  }, [slot?.id, slot?.activeId, documents.length]);

  if (!slot) {
    return (
      <section className="settings-page">
        <div className="settings-scroll">
          <p className="list-empty">这个目标没有可管理的提示词文件。</p>
        </div>
      </section>
    );
  }

  const selected = documents.find((document) => document.id === selectedId) || null;
  const isNew = selectedId === NEW_DOCUMENT;
  const isLive = Boolean(selected) && selected.id === slot.activeId;
  const edited = isNew
    ? draft.name.trim() !== "" || draft.text !== ""
    : Boolean(selected) && (draft.name !== selected.name || draft.text !== selected.text);
  const size = byteLength(draft.text);
  const overLimit = size > (library.limits?.maxBytes || Infinity);

  function pick(document) {
    setSelectedId(document.id);
    setDraft({ name: document.name, text: document.text });
    setArmedDelete("");
  }

  function startNew() {
    setSelectedId(NEW_DOCUMENT);
    setDraft({ name: "", text: "" });
    setArmedDelete("");
  }

  function requestDelete() {
    if (!selected) return;
    if (armedDelete !== selected.id) {
      setArmedDelete(selected.id);
      // Deleting what is in the file needs somewhere for the file to land, so
      // preselect a plausible replacement rather than demanding one blindly.
      setReplacementId(documents.find((document) => document.id !== selected.id)?.id || "");
      return;
    }
    onDelete({ slot: slot.id, id: selected.id, replacementId: isLive ? replacementId : "" });
    setArmedDelete("");
  }

  const deletableLive = isLive && documents.length > 1;
  const deleteBlocked = isLive && documents.length <= 1;

  return (
    <section className="settings-page">
      <div className="settings-scroll">
        <div className="settings-title">
          <div>
            <p>{target === "codex" ? "Codex" : "Pi"} 全局提示词</p>
            <h1>提示词</h1>
            <span>每个文件同时只有一份内容生效，其余存在本管理器里。</span>
          </div>
          <button type="button" className="secondary-button" onClick={onBack}><ArrowLeft size={18} />返回</button>
        </div>

        {slots.length > 1 && (
          <div className="prompt-slots" role="tablist" aria-label="提示词文件">
            {slots.map((entry) => (
              <button
                key={entry.id}
                type="button"
                role="tab"
                aria-selected={entry.id === slot.id}
                className={`prompt-slot ${entry.id === slot.id ? "is-active" : ""}`}
                onClick={() => setSlotId(entry.id)}
              >
                <code className="mono">{entry.file}</code>
                <small>{entry.present ? `${entry.documents.length} 份 · 已写入` : "尚未写入"}</small>
              </button>
            ))}
          </div>
        )}

        <p className="prompt-note">
          <Info size={19} weight="duotone" />
          <span>
            <code className="mono">{slot.path}</code> —— {slot.note}
          </span>
        </p>
        {slot.adoptedId && (
          <p className="compat-note is-warning">
            <WarningCircle size={20} weight="fill" />
            <span>
              这个文件里现有的内容不是本管理器写的，已作为「现有内容」接管进来。保存或切换之前不会动它。
            </span>
          </p>
        )}

        <div className="prompt-layout">
          <nav className="prompt-list" aria-label="提示词列表">
            <button type="button" className="add-provider" onClick={startNew}>
              <Plus size={18} weight="bold" />新建提示词
            </button>
            {documents.length === 0 && <p className="list-empty">还没有提示词。</p>}
            {documents.map((document) => (
              <button
                key={document.id}
                type="button"
                className={`prompt-item ${document.id === selectedId ? "is-selected" : ""}`}
                onClick={() => pick(document)}
              >
                <FileText size={18} />
                <span className="prompt-item-name">{document.name}</span>
                {document.id === slot.activeId && <span className="live-default-badge">生效中</span>}
                {document.adopted && <span className="provider-badge">已接管</span>}
              </button>
            ))}
          </nav>

          <div className="prompt-editor">
            <label>
              <span>名称</span>
              <input
                value={draft.name}
                onChange={(event) => setDraft((current) => ({ ...current, name: event.target.value }))}
                placeholder="例如：中文优先"
              />
            </label>
            <label className="prompt-text">
              <span>
                内容
                <small className={overLimit ? "is-error" : ""}>{size.toLocaleString()} 字节</small>
              </span>
              <textarea
                className="mono"
                value={draft.text}
                spellCheck={false}
                rows={18}
                onChange={(event) => setDraft((current) => ({ ...current, text: event.target.value }))}
                placeholder={`写进 ${slot.file} 的内容`}
              />
            </label>

            {error && <p className="compat-note is-warning"><WarningCircle size={20} weight="fill" />{error}</p>}

            {armedDelete === selectedId && selected && (
              <div className="prompt-danger">
                {deleteBlocked ? (
                  <span>这是这个文件里唯一的一份，而且正在生效。先新建一份再删除它。</span>
                ) : deletableLive ? (
                  <label>
                    <span>它正在生效，删除后改用：</span>
                    <select value={replacementId} onChange={(event) => setReplacementId(event.target.value)}>
                      {documents.filter((document) => document.id !== selected.id).map((document) => (
                        <option key={document.id} value={document.id}>{document.name}</option>
                      ))}
                    </select>
                  </label>
                ) : (
                  <span>再次点击删除会移除「{selected.name}」，文件内容不受影响。</span>
                )}
              </div>
            )}

            <div className="prompt-actions">
              {selected && !isNew && (
                <button
                  type="button"
                  className={`danger-button ${armedDelete === selectedId ? "is-armed" : ""}`}
                  disabled={saving || deleteBlocked}
                  onClick={requestDelete}
                >
                  <Trash size={18} />{armedDelete === selectedId ? "确认删除" : "删除"}
                </button>
              )}
              <span className="prompt-status">
                {isNew
                  ? "保存后会立即写入文件"
                  : isLive
                    ? <><CheckCircle size={17} weight="fill" />正在生效</>
                    : "保存后不会改动文件，除非点「启用」"}
              </span>
              {selected && !isNew && !isLive && (
                <button
                  type="button"
                  className="secondary-button"
                  disabled={saving || edited}
                  title={edited ? "先保存修改再启用" : ""}
                  onClick={() => onActivate({ slot: slot.id, id: selected.id })}
                >
                  启用这一份
                </button>
              )}
              <button
                type="button"
                className="primary-button"
                disabled={saving || overLimit || !draft.name.trim() || (!edited && !isNew)}
                onClick={() => onSave({
                  slot: slot.id,
                  id: isNew ? "" : selected.id,
                  name: draft.name,
                  text: draft.text,
                  // A new document goes live; editing one that is not live must
                  // not silently swap the file underneath the agent.
                  activate: isNew || isLive,
                })}
              >
                {saving ? <><Spinner />正在保存…</> : isNew || isLive ? "保存并写入文件" : "保存"}
              </button>
            </div>
          </div>
        </div>
      </div>
    </section>
  );
}
