// Pieces the Pi and Codex workspaces both use. They live here rather than in
// App.jsx so the Codex view can import them without the two files importing
// each other.

import { useEffect, useRef, useState } from "react";
import { ArrowsClockwise, CheckCircle, CircleNotch, WarningCircle, X } from "@phosphor-icons/react";

// Marks which edges of a scroll container have content beyond them, so the
// list can fade there. A list that clips mid-row with no cue reads as a
// rendering fault rather than as "there is more" — which is what nine
// providers in a 900px window actually looked like.
export function useScrollEdges(ref, signal) {
  const [edges, setEdges] = useState({ above: false, below: false });
  useEffect(() => {
    const node = ref.current;
    if (!node) return undefined;
    const update = () => {
      // Round: fractional scroll positions leave a pixel of slack at the end.
      const slack = node.scrollHeight - node.clientHeight - node.scrollTop;
      setEdges({ above: node.scrollTop > 1, below: slack > 1 });
    };
    update();
    node.addEventListener("scroll", update, { passive: true });
    // scrollHeight changes do not resize the container, so the content is
    // watched as well as the box.
    const observer = new ResizeObserver(update);
    observer.observe(node);
    for (const child of node.children) observer.observe(child);
    return () => {
      node.removeEventListener("scroll", update);
      observer.disconnect();
    };
  }, [ref, signal]);
  return edges;
}

export function Spinner({ size = 18 }) {
  return <CircleNotch className="spinner" size={size} weight="bold" aria-hidden="true" />;
}

// The shared request-error banner. A 409 also arrives as a toast whose action
// reloads the page, but that toast expires after seven seconds — the banner is
// the part that persists, so on a conflict it carries the same action itself.
export function ErrorBanner({ message, conflict, id }) {
  const ref = useRef(null);
  // Bring the banner into view when its message changes: on the models step it
  // can sit below a long model list and a collapsed advanced panel, well off
  // screen when Save is pressed.
  useEffect(() => {
    if (message && ref.current) ref.current.scrollIntoView({ block: "nearest", behavior: "smooth" });
  }, [message]);
  if (!message) return null;
  return (
    <div className="error-banner" role="alert" id={id} ref={ref}>
      <WarningCircle size={20} weight="fill" />
      <span>{message}</span>
      {conflict && (
        <button type="button" className="banner-reload" onClick={() => window.location.reload()}>
          <ArrowsClockwise size={14} />重新读取
        </button>
      )}
    </div>
  );
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

// What every dialog owes the keyboard: Escape closes it, Tab stays inside
// it, and focus goes back to the control that opened it once it is gone.
// `locked` keeps it up while a request is in flight, so a stray key cannot
// discard the error that request is about to report.
export function useDialog({ ref, initialFocusRef, onClose, locked = false }) {
  useEffect(() => {
    const previousFocus = document.activeElement;
    const first = initialFocusRef?.current
      || ref.current?.querySelector("button:not(:disabled), input:not(:disabled), select:not(:disabled), textarea:not(:disabled)");
    first?.focus();
    return () => previousFocus?.focus?.();
    // Runs once per dialog lifetime by design.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);
  useEffect(() => {
    const onKeyDown = (event) => {
      if (event.key === "Escape") {
        if (!locked) onClose();
        return;
      }
      if (event.key !== "Tab") return;
      const focusable = [...(ref.current?.querySelectorAll(
        "button:not(:disabled), input:not(:disabled), select:not(:disabled), textarea:not(:disabled)",
      ) || [])];
      if (focusable.length === 0) return;
      const first = focusable[0];
      const last = focusable[focusable.length - 1];
      if (event.shiftKey && document.activeElement === first) {
        event.preventDefault();
        last.focus();
      } else if (!event.shiftKey && document.activeElement === last) {
        event.preventDefault();
        first.focus();
      }
    };
    document.addEventListener("keydown", onKeyDown);
    return () => document.removeEventListener("keydown", onKeyDown);
  }, [ref, locked, onClose]);
}

export function BulkModal({ text, ids, newIds, onText, onClose, onImport }) {
  const dialogRef = useRef(null);
  const textRef = useRef(null);
  useDialog({ ref: dialogRef, initialFocusRef: textRef, onClose });
  return (
    <div className="modal-backdrop" role="presentation" onMouseDown={(event) => { if (event.target === event.currentTarget) onClose(); }}>
      <section ref={dialogRef} className="bulk-modal" role="dialog" aria-modal="true" aria-labelledby="bulk-title">
        <div className="modal-heading">
          <div><h2 id="bulk-title">批量添加模型 ID</h2><p>每行一个，也可以用英文逗号分隔。重复项会自动忽略。</p></div>
          <button type="button" className="icon-button" onClick={onClose} aria-label="关闭"><X size={20} /></button>
        </div>
        <textarea
          ref={textRef}
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

// A monospace editor for the people who would rather edit the config as text:
// a line-numbered gutter, live syntax checking through a caller-supplied
// `validate`, and 校验 / 自动格式化 buttons — the pair CC-Switch offers — when the
// caller can validate and pretty-print. It stays a plain <textarea> underneath
// — the gutter mirrors its scroll — so keyboard support, selection, and IME all
// come for free. Highlighting is deliberately left out: an overlay that has to
// stay pixel-aligned with the textarea is the usual source of drift, and the
// functional asks here are validation and formatting, not colour.
//
// `validate(value)` returns `{ ok: true }` or `{ ok: false, message, line }`.
// `format(value)` returns the formatted string, or throws to decline.
export function ConfigEditor({
  value,
  onChange,
  validate,
  format,
  rows = 14,
  label,
  language = "json",
  placeholder,
  ariaLabel,
}) {
  const textareaRef = useRef(null);
  const gutterRef = useRef(null);
  const [checked, setChecked] = useState(false);
  const lineCount = Math.max(1, value.split("\n").length);
  const result = validate ? validate(value) : { ok: true };
  const invalid = value.trim() !== "" && result && result.ok === false;
  // Keep the gutter's scroll locked to the textarea's, so line numbers track
  // the visible content. The frame is one fixed-height, internally scrolling
  // box: the textarea scrolls, the gutter follows. Resizing is offered on the
  // frame, never on the textarea alone — an independently resized textarea was
  // what let the two heights drift apart and the numbers fall out of step.
  const syncScroll = () => {
    if (gutterRef.current && textareaRef.current) {
      gutterRef.current.scrollTop = textareaRef.current.scrollTop;
    }
  };
  // On open the value is seeded and the caret can land at the end, scrolling the
  // textarea before the first user scroll event fires. Start both at the top.
  useEffect(() => {
    if (textareaRef.current) textareaRef.current.scrollTop = 0;
    if (gutterRef.current) gutterRef.current.scrollTop = 0;
    // Runs once when the editor appears.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);
  const doFormat = () => {
    if (!format) return;
    try {
      const next = format(value);
      if (typeof next === "string" && next !== value) onChange(next);
    } catch {
      // A value that will not parse cannot be formatted; the validation line
      // already says why, so formatting simply declines rather than shouting.
    }
  };
  // On-demand check: the status line already tracks validity live, but the
  // button is the deliberate "tell me now" moment. On a good parse it flashes a
  // confirmation; on a bad one it drops the caret at the offending line and
  // scrolls it into view, so the error is not just named but reachable.
  const doValidate = () => {
    if (invalid && result.line && textareaRef.current) {
      const lines = value.split("\n");
      let offset = 0;
      for (let i = 0; i < result.line - 1 && i < lines.length; i += 1) offset += lines[i].length + 1;
      const node = textareaRef.current;
      node.focus();
      node.setSelectionRange(offset, offset + (lines[result.line - 1]?.length || 0));
      node.scrollTop = Math.max(0, (result.line - 1) * 20 - node.clientHeight / 2);
      syncScroll();
      return;
    }
    setChecked(true);
    setTimeout(() => setChecked(false), 1600);
  };
  return (
    <div className={`config-editor ${invalid ? "is-invalid" : ""}`} style={{ "--editor-rows": rows }}>
      <div className="config-editor-frame">
        <div className="config-editor-gutter" ref={gutterRef} aria-hidden="true">
          {Array.from({ length: lineCount }, (_, index) => (
            <span key={index}>{index + 1}</span>
          ))}
        </div>
        <textarea
          ref={textareaRef}
          className="config-editor-input mono"
          value={value}
          onChange={(event) => { setChecked(false); onChange(event.target.value); }}
          onScroll={syncScroll}
          rows={rows}
          spellCheck={false}
          autoCapitalize="off"
          autoCorrect="off"
          autoComplete="off"
          placeholder={placeholder}
          aria-label={ariaLabel || label}
          aria-invalid={invalid || undefined}
        />
      </div>
      <div className="config-editor-footer">
        <span className={`config-editor-status ${invalid ? "is-error" : checked && result?.ok ? "is-ok" : result?.ok ? "is-ok" : ""}`} aria-live="polite">
          {invalid
            ? <><WarningCircle size={15} weight="fill" />{result.line ? `第 ${result.line} 行：` : ""}{result.message}</>
            : value.trim() === ""
              ? `空内容`
              : checked
                ? <><CheckCircle size={15} weight="fill" />{language.toUpperCase()} 语法正确</>
                : <>{language.toUpperCase()} 语法正确</>}
        </span>
        <div className="config-editor-buttons">
          {validate && (
            <button type="button" className="outline-button compact-button" onClick={doValidate} disabled={value.trim() === ""}>
              <CheckCircle size={16} />校验
            </button>
          )}
          {format && (
            <button type="button" className="outline-button compact-button" onClick={doFormat} disabled={invalid || value.trim() === ""}>
              <ArrowsClockwise size={16} />自动格式化
            </button>
          )}
        </div>
      </div>
    </div>
  );
}

// A JSON validator shaped for ConfigEditor: parses, and on failure digs a line
// number out of V8's "position N" message so the gutter can point at it.
export function validateJson(value) {
  try {
    JSON.parse(value);
    return { ok: true };
  } catch (error) {
    const message = String(error?.message || "JSON 无法解析");
    const at = message.match(/position (\d+)/);
    let line;
    if (at) {
      const position = Number(at[1]);
      line = value.slice(0, position).split("\n").length;
    }
    return { ok: false, message: message.replace(/ in JSON.*$/, ""), line };
  }
}

export function formatJson(value) {
  return JSON.stringify(JSON.parse(value), null, 2);
}
