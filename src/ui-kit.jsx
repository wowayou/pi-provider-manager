// Pieces the Pi and Codex workspaces both use. They live here rather than in
// App.jsx so the Codex view can import them without the two files importing
// each other.

import { useEffect } from "react";
import { CircleNotch, X } from "@phosphor-icons/react";

export function Spinner({ size = 18 }) {
  return <CircleNotch className="spinner" size={size} weight="bold" aria-hidden="true" />;
}

export function titleFromId(id) {
  return String(id)
    .split(/[-_.]+/)
    .filter(Boolean)
    .map((part) => part.charAt(0).toUpperCase() + part.slice(1))
    .join(" ");
}

export function createRadioKeyHandler({ refs, values, selectedIndex, onSelect }) {
  return (event) => {
    const step = { ArrowRight: 1, ArrowDown: 1, ArrowLeft: -1, ArrowUp: -1 }[event.key];
    if (!step) return;
    event.preventDefault();
    const next = (selectedIndex + step + values.length) % values.length;
    onSelect(values[next]);
    refs.current[next]?.focus();
  };
}

export async function readApiResponse(response, fallbackMessage) {
  const data = await response.json();
  if (response.ok) return data;
  const error = new Error(data.error || fallbackMessage);
  error.status = response.status;
  throw error;
}

export function BulkModal({ text, ids, newIds, onText, onClose, onImport }) {
  useEffect(() => {
    const onKeyDown = (event) => { if (event.key === "Escape") onClose(); };
    document.addEventListener("keydown", onKeyDown);
    return () => document.removeEventListener("keydown", onKeyDown);
  }, [onClose]);
  return (
    <div className="modal-backdrop" role="presentation" onMouseDown={(event) => { if (event.target === event.currentTarget) onClose(); }}>
      <section className="bulk-modal" role="dialog" aria-modal="true" aria-labelledby="bulk-title">
        <div className="modal-heading">
          <div><h2 id="bulk-title">批量添加模型 ID</h2><p>每行一个，也可以用英文逗号分隔。重复项会自动忽略。</p></div>
          <button type="button" className="icon-button" onClick={onClose} aria-label="关闭"><X size={20} /></button>
        </div>
        <textarea
          autoFocus
          value={text}
          onChange={(event) => onText(event.target.value)}
          onKeyDown={(event) => { if ((event.metaKey || event.ctrlKey) && event.key === "Enter") { event.preventDefault(); onImport(); } }}
          placeholder={"anthropic/claude-opus\nopenai/gpt-5.6-sol\ngoogle/gemini-pro"}
        />
        <div className="modal-actions">
          <span className="modal-count" aria-live="polite">
            {ids.length === 0
              ? "还没有可导入的 ID"
              : ids.length === newIds.length
                ? `识别到 ${ids.length} 个模型 ID`
                : `识别到 ${ids.length} 个，其中 ${ids.length - newIds.length} 个已在列表中`}
          </span>
          <button type="button" className="secondary-button" onClick={onClose}>取消</button>
          <button type="button" className="primary-button" disabled={newIds.length === 0} onClick={onImport}>{newIds.length > 0 ? `导入 ${newIds.length} 个模型` : "导入模型"}</button>
        </div>
        <p className="modal-shortcut"><kbd>⌘</kbd>/<kbd>Ctrl</kbd> + <kbd>Enter</kbd> 直接导入，<kbd>Esc</kbd> 关闭</p>
      </section>
    </div>
  );
}
