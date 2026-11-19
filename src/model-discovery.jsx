import { useEffect, useRef, useState } from "react";
import { createPortal } from "react-dom";
import { ArrowsClockwise, CloudArrowDown, MagnifyingGlass, X } from "@phosphor-icons/react";
import { ErrorBanner, Spinner, useDialog } from "./ui-kit.jsx";
import { postJson } from "./api-client.mjs";
import { defaultDiscoveryPath, resolveDiscoveryUrl } from "../lib/model-discovery.mjs";

const noIds = new Set();
const sampleIds = ["anthropic/claude-opus-4-1", "anthropic/claude-sonnet-4-5", "openai/gpt-5.6-sol", "google/gemini-2.5-pro"];

export async function requestCatalogue(payload, demoMode) {
  if (!demoMode) return postJson("/api/providers/discover-models", payload, "获取模型列表失败");
  const root = payload.baseUrl.replace(/\/+$/, "");
  return {
    models: sampleIds.map(id => ({ id })),
    endpoint: payload.path ? resolveDiscoveryUrl(root, payload.path) : root + defaultDiscoveryPath(payload.api),
  };
}

export function ModelDiscovery({ baseUrl, api, onDiscover, existingIds = noIds, onImport, single = false, destination }) {
  // Capture the request on the click. A render or a StrictMode effect replay must never issue another GET.
  const [session, setSession] = useState(null);
  const open = () => setSession({ request: onDiscover });
  return <>
    <button type="button" className="secondary-button button-md discover-trigger" onClick={open} title="向网关请求模型清单" aria-label="获取模型"><CloudArrowDown size={16} /><span className="button-label">获取模型</span></button>
    {session && createPortal(<DiscoverModal baseUrl={baseUrl} defaultPath={defaultDiscoveryPath(api)} existingIds={existingIds} session={session} single={single} destination={destination} onClose={() => setSession(null)} onImport={entries => { onImport(entries); setSession(null); }} />, document.body)}
  </>;
}

function DiscoverModal({ baseUrl, defaultPath, existingIds, session, single, destination, onClose, onImport }) {
  const dialogRef = useRef(null);
  const filterRef = useRef(null);
  const [status, setStatus] = useState("loading");
  const [models, setModels] = useState([]);
  const [message, setMessage] = useState("");
  const [filter, setFilter] = useState("");
  const [selected, setSelected] = useState(() => new Set());
  const [attempt, setAttempt] = useState(0);
  // The override the next attempt will use, and the one the current result came
  // from. Kept apart so editing the field does not relabel a list already shown.
  const [showPath, setShowPath] = useState(false);
  const [pathDraft, setPathDraft] = useState("");
  const [askedPath, setAskedPath] = useState("");
  const [endpoint, setEndpoint] = useState("");
  const pending = useRef(null);
  const pathRef = useRef(null);
  useDialog({ ref: dialogRef, initialFocusRef: filterRef, onClose, locked: status === "loading" });
  useEffect(() => {
    let cancelled = false;
    setStatus("loading");
    setMessage("");
    setEndpoint("");
    setSelected(new Set());
    if (pending.current?.attempt !== attempt) {
      pending.current = { attempt, result: session.request(askedPath) };
    }
    pending.current.result
      .then((result) => {
        if (cancelled) return;
        setModels(result.models);
        setEndpoint(result.endpoint || "");
        setSelected(new Set());
        setStatus("ready");
      })
      .catch((problem) => {
        if (cancelled) return;
        setShowPath(true);
        setMessage(problem.message);
        setStatus("error");
      });
    return () => { cancelled = true; };
  }, [attempt, askedPath, session]);
  // The filter is not in the tree while the request runs, so it is focused
  // once the list exists rather than by the dialog's first-focus rule.
  useEffect(() => { if (status === "ready") filterRef.current?.focus(); }, [status]);
  // A failure is most often the path being wrong for this relay, and the field
  // that fixes it is the one thing worth having the caret in.
  useEffect(() => { if (status === "error") pathRef.current?.focus(); }, [status]);
  const needle = filter.trim().toLowerCase();
  const visible = needle ? models.filter((model) => model.id.toLowerCase().includes(needle) || (model.name || "").toLowerCase().includes(needle)) : models;
  const selectable = visible.filter((model) => !existingIds.has(model.id));
  const chosen = models.filter((model) => selected.has(model.id) && !existingIds.has(model.id));
  const toggle = (id) => setSelected((current) => {
    if (single) return new Set([id]);
    const next = new Set(current);
    if (next.has(id)) next.delete(id); else next.add(id);
    return next;
  });
  const retry = () => { setAskedPath(pathDraft.trim()); setAttempt((current) => current + 1); };
  const selectVisible = () => setSelected((current) => new Set([...current, ...selectable.map((model) => model.id)]));
  const clearSelection = () => setSelected(new Set());
  return (
    <div className="modal-backdrop" role="presentation" onMouseDown={(event) => { if (event.target === event.currentTarget && status !== "loading") onClose(); }}>
      <section ref={dialogRef} className="bulk-modal discover-modal" role="dialog" aria-modal="true" aria-labelledby="discover-title">
        <div className="modal-heading">
          <div><h2 id="discover-title">从网关获取模型列表</h2><p>向 <code>{endpoint || `${baseUrl || "（尚未填写地址）"}${askedPath || defaultPath}`}</code> 请求模型清单。网关列出的模型仍受分组权限限制。{single ? `选择后填入${destination}` : "勾选后加入草稿"}，保存后写入。</p></div>
          <button type="button" className="icon-button" onClick={onClose} disabled={status === "loading"} aria-label="关闭"><X size={20} /></button>
        </div>
        {status === "loading" && <div className="discover-status" role="status"><Spinner />正在向网关请求模型列表…</div>}
        {status === "error" && <ErrorBanner message={message} />}
        {status !== "loading" && (
          <details className="discover-options" open={showPath} onToggle={event => setShowPath(event.currentTarget.open)}>
            <summary>模型列表路径</summary>
            <label className="discover-path">
            <small id="discover-path-help">留空使用协议默认值 <code>{defaultPath}</code>。相对于 API 地址，必须同源。</small>
            <span className="discover-path-row">
              <input
                aria-label="模型列表路径"
                ref={pathRef}
                className="mono"
                value={pathDraft}
                onChange={(event) => setPathDraft(event.target.value)}
                onKeyDown={(event) => { if (event.key === "Enter") { event.preventDefault(); retry(); } }}
                placeholder={defaultPath}
                aria-describedby="discover-path-help"
                spellCheck={false}
                autoCapitalize="off"
                autoCorrect="off"
                autoComplete="off"
              />
              <button type="button" className="outline-button button-md" onClick={retry}><ArrowsClockwise size={16} />用这个路径重试</button>
            </span>
            </label>
          </details>
        )}
        {status === "ready" && (
          <>
            <div className="discover-filter"><MagnifyingGlass size={17} aria-hidden="true" /><input ref={filterRef} className="mono" value={filter} onChange={(event) => setFilter(event.target.value)} placeholder="筛选模型 ID" aria-label="筛选模型 ID" spellCheck={false} autoCapitalize="off" autoCorrect="off" autoComplete="off" /></div>
            <div className="discover-list" role="group" aria-label="网关返回的模型">
              {visible.length === 0 && <p className="discover-empty">{models.length === 0 ? "网关没有返回任何模型。请手动填写模型 ID。" : "没有匹配的模型 ID。"}</p>}
              {visible.map((model) => {
                const exists = existingIds.has(model.id);
                return (
                  <label key={model.id} className={`checkbox-row discover-row ${exists ? "is-existing" : ""}`}>
                    <input type={single ? "radio" : "checkbox"} name={single ? "discovery-model" : undefined} checked={exists || selected.has(model.id)} disabled={exists} onChange={() => toggle(model.id)} aria-label={model.id} />
                    <span className="mono">{model.id}</span>
                    <small>{exists ? "已在列表中" : model.name || ""}</small>
                  </label>
                );
              })}
            </div>
          </>
        )}
        <div className="modal-actions">
          {status === "ready" && !single && (
            <div className="discover-bulk-actions">
              <button type="button" className="outline-button button-sm" onClick={selectVisible} disabled={selectable.length === 0}>全选{needle ? "匹配项" : ""}</button>
              <button type="button" className="outline-button button-sm" onClick={clearSelection} disabled={chosen.length === 0}>清空</button>
            </div>
          )}
          <span className="modal-count" aria-live="polite">
            {status === "ready" ? (models.length === 0 ? "没有可导入的模型" : `网关返回 ${models.length} 个模型，已选 ${chosen.length} 个`) : ""}
          </span>
          <button type="button" className="secondary-button button-md" onClick={onClose} disabled={status === "loading"}>取消</button>
          <button type="button" className="primary-button button-md" disabled={status !== "ready" || chosen.length === 0} onClick={() => onImport(chosen)}>{single ? `填入${destination}` : chosen.length > 0 ? `导入 ${chosen.length} 个模型` : "导入模型"}</button>
        </div>
      </section>
    </div>
  );
}
