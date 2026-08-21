// The Codex workspace: same sidebar, same three-step wizard, same settings
// screen as the Pi side, filled with Codex's own vocabulary.
//
// Two facts drive most of what differs here. Codex 0.149.0 speaks only the
// Responses API, so step one picks the *upstream shape* rather than a protocol.
// And Codex keeps exactly one credential and one manager-owned provider table,
// so switching providers is an explicit act with a scope worth stating.

import { useEffect, useMemo, useRef, useState } from "react";
import {
  ArrowLeft,
  ArrowRight,
  Check,
  CheckCircle,
  Copy,
  Info,
  Key,
  ListPlus,
  Plus,
  Plugs,
  PlugsConnected,
  Question,
  ShieldCheck,
  SlidersHorizontal,
  TerminalWindow,
  Trash,
  WarningCircle,
} from "@phosphor-icons/react";

import { TomlDocument } from "../lib/toml-document.mjs";
import { BulkModal, Spinner, createRadioKeyHandler, titleFromId } from "./ui-kit.jsx";

export const CODEX_EFFORTS = ["none", "minimal", "low", "medium", "high", "xhigh", "max", "ultra"];
export const CODEX_VERBOSITIES = ["low", "medium", "high"];

const UPSTREAM_OPTIONS = [
  {
    id: "direct",
    title: "上游支持 Responses",
    subtitle: "直连",
    description: "网关提供 /v1/responses。绝大多数面向 Codex 的服务都属于这一类。",
    icon: PlugsConnected,
  },
  {
    id: "bridge",
    title: "上游只有 chat/completions",
    subtitle: "经本地桥",
    description: "Codex 已不再支持 chat 协议，需要一个本地翻译桥把 Responses 转成 Chat Completions。",
    icon: Plugs,
  },
];

// Whether Codex will be talking to this machine. This is a fact about the
// address; whether the thing listening is a translation bridge is not, so only
// copy tied to the user's own choice may say "bridge".
export function isLocalAddress(value) {
  try {
    return ["localhost", "127.0.0.1", "[::1]", "::1"].includes(new URL(value).hostname.toLowerCase());
  } catch {
    return false;
  }
}

function slugify(value) {
  return String(value).toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-+|-+$/g, "");
}

function blankCodexModel(id = "") {
  return { rowId: crypto.randomUUID(), id, reasoningEffort: "high" };
}

export function blankCodexForm() {
  const first = blankCodexModel("gpt-5.6-sol");
  return {
    providerId: "",
    name: "",
    baseUrl: "",
    upstream: "direct",
    requiresAuth: true,
    credentialMode: "new",
    apiKey: "",
    migrateFrom: "",
    models: [first],
    // Keyed by row rather than by model id, for the same reason as the Pi side:
    // the id is editable and keying on it drops the default on a typo fix.
    defaultRowId: first.rowId,
  };
}

export function codexProviderToForm(provider, codex) {
  const models = provider.models.length
    ? provider.models.map((model) => ({
        rowId: crypto.randomUUID(),
        id: model.id,
        reasoningEffort: model.reasoningEffort || "high",
      }))
    : [blankCodexModel()];
  const sources = codex.providers.filter((item) => item.id !== provider.id && item.credentialConfigured);
  return {
    providerId: provider.id,
    name: provider.name || titleFromId(provider.id),
    baseUrl: provider.baseUrl,
    upstream: provider.upstream || "direct",
    requiresAuth: provider.requiresAuth !== false,
    credentialMode: provider.credentialConfigured ? "keep" : "new",
    apiKey: "",
    migrateFrom: sources[0]?.id || "",
    models,
    defaultRowId: (models.find((model) => model.id === provider.defaultModelId) || models[0]).rowId,
  };
}

// Vendors publish exactly the block this manager writes, so pasting their
// snippet is the shortest path from their docs to a working provider.
export function parseCodexSnippet(text) {
  let document;
  try {
    document = TomlDocument.parse(text);
  } catch {
    return null;
  }
  const names = document.tableNames("model_providers");
  if (names.length === 0) return null;
  const keys = document.tableKeys(`model_providers.${names[0]}`) || {};
  const model = document.getTopLevel("model");
  const effort = document.getTopLevel("model_reasoning_effort");
  return {
    providerId: slugify(names[0]),
    name: typeof keys.name === "string" && keys.name ? keys.name : titleFromId(names[0]),
    baseUrl: typeof keys.base_url === "string" ? keys.base_url : "",
    requiresAuth: keys.requires_openai_auth !== false,
    model: typeof model === "string" ? model : "",
    reasoningEffort: CODEX_EFFORTS.includes(effort) ? effort : "high",
  };
}

export function CodexStepper({ step, onStep }) {
  const items = [
    [1, "接入方式", "上游是否支持 Responses"],
    [2, "填写凭据", "填写地址与访问凭据"],
    [3, "确认模型", "选择模型与推理强度"],
  ];
  return (
    <div className="stepper" aria-label="配置步骤">
      {items.map(([number, title, subtitle], index) => (
        <div className="step-wrap" key={number}>
          <button
            type="button"
            className={`step ${number === step ? "is-active" : ""} ${number < step ? "is-complete" : ""}`}
            onClick={() => number < step && onStep(number)}
            disabled={number > step}
            aria-current={number === step ? "step" : undefined}
            title={number < step ? "回到这一步" : number > step ? "完成当前步骤后可用" : undefined}
          >
            <span className="step-number">{number < step ? <CheckCircle size={24} weight="fill" /> : number}</span>
            <span><strong>{title}</strong><small>{subtitle}</small></span>
          </button>
          {index < items.length - 1 && <span className={`step-line ${number < step ? "is-complete" : ""}`} />}
        </div>
      ))}
    </div>
  );
}

function UpstreamStep({ form, setForm, codexVersion, onNext }) {
  const [showHint, setShowHint] = useState(false);
  const cardRefs = useRef([]);
  const selectedIndex = Math.max(0, UPSTREAM_OPTIONS.findIndex((option) => option.id === form.upstream));
  const choose = (upstream) => setForm((current) => ({
    ...current,
    upstream,
    // A bridge holds the upstream key itself, so Codex usually needs none.
    requiresAuth: upstream === "bridge" ? false : true,
    baseUrl: upstream === "bridge" && !current.baseUrl ? "http://127.0.0.1:4000/v1" : current.baseUrl,
  }));
  const onKeyDown = createRadioKeyHandler({
    refs: cardRefs,
    values: UPSTREAM_OPTIONS.map((option) => option.id),
    selectedIndex,
    onSelect: choose,
  });
  return (
    <section className="step-content">
      <div className="step-scroll">
        <div className="section-heading">
          <div><h1>这个上游怎么接？</h1><p>Codex 只会说 Responses API，所以这里选的是上游的形态，而不是协议。</p></div>
          <button type="button" className="help-link" aria-expanded={showHint} onClick={() => setShowHint((value) => !value)}>
            <Question size={19} />怎么判断？
          </button>
        </div>
        {showHint && (
          <div className="hint-panel">
            <p>看供应商文档给的接口路径：</p>
            <ul>
              <li><code>/v1/responses</code> → 选「上游支持 Responses」，直连即可</li>
              <li>只有 <code>/v1/chat/completions</code> → 选「上游只有 chat/completions」</li>
            </ul>
            <p>
              第二种需要你自己跑一个翻译桥，例如 <code>litellm</code>（在 <code>config.yaml</code> 里给模型加
              {" "}<code>use_chat_completions_api: true</code>）或 <code>codex-relay</code>。桥负责保管上游的 key，
              Codex 只连本机。README 的「Codex 桥接」一节有 WSL 下的最小可跑步骤。
            </p>
          </div>
        )}
        <div className="protocol-grid is-duo" role="radiogroup" aria-label="上游形态" onKeyDown={onKeyDown}>
          {UPSTREAM_OPTIONS.map((option, index) => {
            const Icon = option.icon;
            const isSelected = form.upstream === option.id;
            return (
              <button
                type="button"
                key={option.id}
                ref={(node) => { cardRefs.current[index] = node; }}
                role="radio"
                aria-checked={isSelected}
                tabIndex={index === selectedIndex ? 0 : -1}
                className={`protocol-card ${isSelected ? "is-selected" : ""}`}
                onClick={() => choose(option.id)}
              >
                <span className="protocol-icon"><Icon size={36} weight="duotone" /></span>
                <strong>{option.title}</strong>
                <b>{option.subtitle}</b>
                <p>{option.description}</p>
                {isSelected && <CheckCircle className="selected-check" size={24} weight="fill" />}
              </button>
            );
          })}
        </div>
        <div className="safe-note">
          <ShieldCheck size={22} weight="duotone" />
          <span>写入的固定是 <code className="mono">wire_api = "responses"</code>。
          {codexVersion && codexVersion !== "unknown" && <>检测到你安装的 Codex 是 <code className="mono">{codexVersion}</code>。</>}
          Codex 自 2026 年 2 月起移除了 <code className="mono">chat</code>，写入该值会让整份 config.toml 解析失败。</span>
        </div>
      </div>
      <footer className="wizard-footer"><span /><button type="button" className="primary-button" onClick={onNext}>下一步<ArrowRight size={19} /></button></footer>
    </section>
  );
}

function BridgeProbe({ baseUrl, onProbe }) {
  const [result, setResult] = useState(null);
  const [checking, setChecking] = useState(false);
  useEffect(() => { setResult(null); }, [baseUrl]);
  const run = async () => {
    setChecking(true);
    try {
      setResult(await onProbe(baseUrl));
    } catch (error) {
      setResult({ status: "error", message: error.message });
    } finally {
      setChecking(false);
    }
  };
  // Refused and timed out are one answer to the user: nothing replied. Under
  // WSL2 mirrored networking they are not even distinguishable — a connect to
  // an unbound loopback port hangs instead of being refused.
  const label = {
    listening: "这个端口上有服务在监听",
    "no-answer": "没有拿到应答：桥可能没启动，或这个端口上没有监听",
  }[result?.status];
  return (
    <div className="bridge-probe">
      <button type="button" className="secondary-button compact-button" disabled={checking || !baseUrl} onClick={run}>
        {checking ? <><Spinner size={16} />探测中…</> : <><Plugs size={18} />检查桥是否启动</>}
      </button>
      {result && (
        <span className={`probe-result is-${result.status === "listening" ? "ok" : "warn"}`} role="status">
          {result.status === "listening" ? <CheckCircle size={17} weight="fill" /> : <WarningCircle size={17} weight="fill" />}
          {label || result.message}
        </span>
      )}
      <small>只对本机端口做一次 TCP 连接，不发送任何凭据、不请求任何路径。有服务在监听不代表它就是正确的桥。</small>
    </div>
  );
}

function CodexCredentialsStep({ form, setForm, codex, error, onBack, onNext, onProbeBridge, onNotify }) {
  const [snippet, setSnippet] = useState("");
  const [showSnippet, setShowSnippet] = useState(false);
  const sources = codex.providers.filter((item) => item.id !== form.providerId && item.credentialConfigured);
  const existing = codex.providers.find((item) => item.id === form.providerId);
  const isLocal = isLocalAddress(form.baseUrl);

  const applySnippet = () => {
    const parsed = parseCodexSnippet(snippet);
    if (!parsed) { onNotify("没有在这段配置里找到 [model_providers.*] 表。", "error"); return; }
    const previous = form;
    // The imported model has to become the selected default too; leaving
    // defaultRowId dangling makes the next save fail with "pick a model".
    const imported = parsed.model
      ? { rowId: crypto.randomUUID(), id: parsed.model, reasoningEffort: parsed.reasoningEffort }
      : null;
    setForm((current) => ({
      ...current,
      providerId: current.providerId || parsed.providerId,
      name: parsed.name,
      baseUrl: parsed.baseUrl,
      requiresAuth: parsed.requiresAuth,
      models: imported ? [imported] : current.models,
      defaultRowId: imported ? imported.rowId : current.defaultRowId,
    }));
    setShowSnippet(false);
    setSnippet("");
    // This overwrites fields the user may have typed, so it has to be undoable.
    onNotify(<>已从配置片段填入 <code>{parsed.name}</code></>, "success", {
      label: "撤销",
      onAction: () => setForm(previous),
    });
  };

  return (
    <section className="step-content form-step">
      <div className="step-scroll">
        <div className="section-heading">
          <div><h1>填写地址与凭据</h1><p>key 由本管理器保管，生效时写入 Codex 的 auth.json；保存后不会再显示。</p></div>
          <button type="button" className="help-link" aria-expanded={showSnippet} onClick={() => setShowSnippet((value) => !value)}>
            <ListPlus size={19} />粘贴厂商给的 config.toml
          </button>
        </div>
        {showSnippet && (
          <div className="hint-panel">
            <p>把供应商文档里的那段 TOML 贴进来，会自动填好下面的字段。</p>
            <textarea
              className="snippet-input mono"
              rows={8}
              value={snippet}
              onChange={(event) => setSnippet(event.target.value)}
              placeholder={'model_provider = "custom"\nmodel = "gpt-5.6-sol"\n\n[model_providers.custom]\nname = "示例网关"\nbase_url = "https://api.example.com/v1"\nwire_api = "responses"\nrequires_openai_auth = true'}
              spellCheck={false}
            />
            <div className="modal-actions">
              <button type="button" className="secondary-button" onClick={() => setShowSnippet(false)}>取消</button>
              <button type="button" className="primary-button" disabled={!snippet.trim()} onClick={applySnippet}>填入表单</button>
            </div>
          </div>
        )}
        <div className="form-grid">
          <label>
            <span>供应商 ID</span><small>本管理器内部标识，用于生成 profile 名</small>
            <input className="mono" value={form.providerId} onChange={(event) => setForm((current) => ({ ...current, providerId: slugify(event.target.value) }))} placeholder="packy" spellCheck={false} autoCapitalize="off" autoCorrect="off" autoComplete="off" />
          </label>
          <label>
            <span>显示名称</span><small>写入 config.toml 的 name 字段</small>
            <input value={form.name} onChange={(event) => setForm((current) => ({ ...current, name: event.target.value }))} placeholder="PackyCode" autoComplete="off" />
          </label>
          <label className="form-grid-wide">
            <span>{form.upstream === "bridge" ? "本地桥地址" : "API 地址"}</span>
            <small>
              {form.upstream === "bridge"
                ? "指向你自己跑的翻译桥，必须是本机地址"
                : isLocal
                  ? "这是本机地址：Codex 会连到这台机器上的这个端口"
                  : "填写接口根地址，不要包含具体模型路径"}
            </small>
            <input className="mono" type="url" inputMode="url" value={form.baseUrl} onChange={(event) => setForm((current) => ({ ...current, baseUrl: event.target.value }))} placeholder={form.upstream === "bridge" ? "http://127.0.0.1:4000/v1" : "https://api.example.com/v1"} spellCheck={false} autoCapitalize="off" autoCorrect="off" autoComplete="off" />
          </label>
        </div>
        {isLocal && <BridgeProbe baseUrl={form.baseUrl} onProbe={onProbeBridge} />}
        <fieldset className="credential-box">
          <legend>访问凭据</legend>
          {isLocal && (
            <label className="checkbox-row">
              <input type="checkbox" checked={!form.requiresAuth} onChange={(event) => setForm((current) => ({ ...current, requiresAuth: !event.target.checked }))} />
              <span>
                {form.upstream === "bridge" ? "这个桥不需要 key" : "这个本机服务不需要 key"}
                （写入 <code className="mono">requires_openai_auth = false</code>，Codex 不带 Authorization）
              </span>
            </label>
          )}
          {form.requiresAuth && (
            <>
              <div className="credential-tabs">
                {existing?.credentialConfigured && <button type="button" className={form.credentialMode === "keep" ? "is-active" : ""} onClick={() => setForm((current) => ({ ...current, credentialMode: "keep" }))}>保留现有 key</button>}
                <button type="button" className={form.credentialMode === "new" ? "is-active" : ""} onClick={() => setForm((current) => ({ ...current, credentialMode: "new" }))}>输入新 key</button>
                {sources.length > 0 && <button type="button" className={form.credentialMode === "migrate" ? "is-active" : ""} onClick={() => setForm((current) => ({ ...current, credentialMode: "migrate", migrateFrom: current.migrateFrom || sources[0].id }))}>从已有凭据复制</button>}
              </div>
              {form.credentialMode === "keep" && <div className="credential-status"><ShieldCheck size={24} weight="duotone" /><div><strong>凭据已安全保存</strong><span>浏览器无法读取已保存的 key。</span></div></div>}
              {form.credentialMode === "new" && <label className="key-field"><span>API Key</span><div><Key size={20} /><input className="mono" type="password" autoComplete="new-password" value={form.apiKey} onChange={(event) => setForm((current) => ({ ...current, apiKey: event.target.value }))} placeholder="输入后不会回显" /></div></label>}
              {form.credentialMode === "migrate" && <div className="migrate-fields"><label><span>选择已有供应商</span><select value={form.migrateFrom} onChange={(event) => setForm((current) => ({ ...current, migrateFrom: event.target.value }))}>{sources.map((item) => <option key={item.id} value={item.id}>{item.name}（{item.id}）</option>)}</select></label><small>Codex 的凭据由本管理器保管，复制不会删除来源供应商的 key。</small></div>}
            </>
          )}
          {!form.requiresAuth && (
            <div className="credential-status">
              <Info size={24} weight="duotone" />
              <div><strong>Codex 不会带凭据</strong><span>{form.upstream === "bridge" ? "上游真正的 key 归桥自己管，本管理器不接触。" : "这个本机地址自己处理鉴权，本管理器不接触上游的 key。"}</span></div>
            </div>
          )}
        </fieldset>
        {error && <div className="error-banner" role="alert"><WarningCircle size={20} weight="fill" />{error}</div>}
      </div>
      <footer className="wizard-footer"><button type="button" className="secondary-button" onClick={onBack}><ArrowLeft size={19} />上一步</button><button type="button" className="primary-button" onClick={onNext}>下一步<ArrowRight size={19} /></button></footer>
    </section>
  );
}

const CONFIRM_ARM_DELAY = 400;

function CodexModelRow({ model, isDefault, isLiveModel, onChange, onDefault, onArmRemove, onRemove, onBlockedRemove, canRemove }) {
  const [armedAt, setArmedAt] = useState(0);
  const confirmRemove = armedAt > 0;
  useEffect(() => {
    if (!confirmRemove) return undefined;
    const timer = setTimeout(() => setArmedAt(0), 3200);
    return () => clearTimeout(timer);
  }, [confirmRemove, armedAt]);
  return (
    <div className={`model-row is-codex ${isDefault ? "is-default" : ""}`}>
      <label className="model-name-cell">
        <span className="sr-only">模型 ID</span>
        <input
          className="mono"
          value={model.id}
          onChange={(event) => onChange({ ...model, id: event.target.value })}
          aria-label="模型 ID"
          placeholder="例如 gpt-5.6-sol"
          spellCheck={false}
          autoCapitalize="off"
          autoCorrect="off"
          autoComplete="off"
        />
        <span className="model-row-annotations">
          {isLiveModel && <small className="live-default-badge">Codex 当前使用</small>}
        </span>
      </label>
      <label>
        <span className="sr-only">推理强度</span>
        <select value={model.reasoningEffort} onChange={(event) => onChange({ ...model, reasoningEffort: event.target.value })}>
          {CODEX_EFFORTS.map((effort) => <option key={effort} value={effort}>{effort}</option>)}
        </select>
      </label>
      <label className="default-radio">
        <input type="radio" name="codex-default-model" checked={isDefault} onChange={onDefault} disabled={!model.id.trim()} aria-label={`将 ${model.id || "该模型"} 设为该供应商的默认模型`} />
      </label>
      <span className="model-action-cell">
        <button
          type="button"
          className={`icon-button ${confirmRemove ? "is-confirming" : ""}`}
          onClick={() => {
            if (!canRemove) { onBlockedRemove(); return; }
            if (!confirmRemove) { setArmedAt(Date.now()); onArmRemove(); return; }
            if (Date.now() - armedAt < CONFIRM_ARM_DELAY) return;
            onRemove();
          }}
          onBlur={() => setArmedAt(0)}
          aria-disabled={!canRemove}
          title={canRemove ? (confirmRemove ? "再点一次确认删除" : "删除这一行") : "不能删除唯一模型；先添加替代模型"}
          aria-label={canRemove
            ? confirmRemove ? `再点一次删除 ${model.id || "该模型"}` : `删除 ${model.id || "该模型"}`
            : `不能删除 ${model.id || "该模型"}，它是这个供应商的唯一模型；先添加替代模型`}
        >
          <Trash size={18} weight={confirmRemove ? "fill" : "regular"} />
        </button>
      </span>
    </div>
  );
}

function CodexModelsStep({ form, setForm, codex, error, saving, onBack, onSave, onNotify, onDeleteProvider, canDeleteProvider, isActive }) {
  const adopted = codex.providers.find((provider) => provider.id === form.providerId.trim())?.adopted;
  const [showBulk, setShowBulk] = useState(false);
  const [bulkText, setBulkText] = useState("");
  const [scrolled, setScrolled] = useState(false);
  const liveModel = isActive ? codex.settings?.model || "" : "";
  const updateModel = (rowId, value) => setForm((current) => ({ ...current, models: current.models.map((model) => model.rowId === rowId ? value : model) }));
  const addModel = () => setForm((current) => ({ ...current, models: [...current.models, blankCodexModel()], defaultRowId: current.defaultRowId || current.models[0]?.rowId || "" }));

  const armRemoveModel = (model) => onNotify(
    model.id.trim()
      ? <>再次点击会移除 <code>{model.id.trim()}</code>，它生成的 profile 也会一并删除。</>
      : "再次点击会移除这个未命名模型行。",
    "error",
  );
  const blockLastModelRemoval = () => onNotify(
    canDeleteProvider
      ? "不能单独删除这个供应商的唯一模型。如需移除整个供应商，请使用“删除供应商”。"
      : "不能删除唯一模型。先添加替代模型。",
    "error",
    canDeleteProvider ? { label: "删除供应商", onAction: onDeleteProvider } : { label: "添加模型", onAction: addModel },
  );
  const removeModel = (rowId) => {
    const index = form.models.findIndex((model) => model.rowId === rowId);
    const removed = form.models[index];
    const previousDefaultRowId = form.defaultRowId;
    setForm((current) => {
      const models = current.models.filter((model) => model.rowId !== rowId);
      const selected = models.find((model) => model.rowId === current.defaultRowId && model.id.trim())
        || models.find((model) => model.id.trim());
      return { ...current, models, defaultRowId: selected?.rowId || "" };
    });
    if (!removed) return;
    const name = removed.id.trim();
    onNotify(name ? <>已删除 <code>{name}</code></> : "已删除未命名模型行", "success", {
      label: "撤销",
      onAction: () => setForm((current) => {
        if (current.models.some((model) => model.rowId === rowId)) return current;
        const models = [...current.models];
        models.splice(Math.min(index, models.length), 0, removed);
        return {
          ...current,
          models,
          defaultRowId: models.some((model) => model.rowId === previousDefaultRowId) ? previousDefaultRowId : current.defaultRowId,
        };
      }),
    });
  };

  const bulkIds = useMemo(
    () => [...new Set(bulkText.split(/\r?\n|,/).map((value) => value.trim()).filter(Boolean))],
    [bulkText],
  );
  const existingIds = useMemo(() => new Set(form.models.map((model) => model.id).filter(Boolean)), [form.models]);
  const newBulkIds = bulkIds.filter((id) => !existingIds.has(id));
  const importModels = () => {
    if (newBulkIds.length === 0) return;
    setForm((current) => {
      const taken = new Set(current.models.map((model) => model.id).filter(Boolean));
      const additions = bulkIds.filter((id) => !taken.has(id)).map((id) => blankCodexModel(id));
      const hasOnlyBlank = current.models.length === 1 && !current.models[0].id;
      const models = [...(hasOnlyBlank ? [] : current.models), ...additions];
      const defaultRowId = models.some((model) => model.rowId === current.defaultRowId) ? current.defaultRowId : models[0]?.rowId || "";
      return { ...current, models, defaultRowId };
    });
    setBulkText("");
    setShowBulk(false);
  };

  const namedModels = form.models.filter((model) => model.id.trim()).length;
  return (
    <section className="step-content models-step">
      <div className="step-scroll">
        <div className="section-heading">
          <div><h1>确认模型与推理强度</h1><p>每个模型会生成一个 profile，可以用 <code>codex --profile</code> 单独调用。</p></div>
        </div>
        <div className="gateway-summary">
          <span className="summary-icon">{isLocalAddress(form.baseUrl) ? <Plugs size={34} weight="duotone" /> : <PlugsConnected size={34} weight="duotone" />}</span>
          <div>
            <strong>{form.name || titleFromId(form.providerId || "new-provider")}</strong>
            <span className="protocol-badge">{isLocalAddress(form.baseUrl) ? "本机地址" : "Responses 直连"}</span>
            <p title={form.baseUrl || undefined}>API 地址　<code>{form.baseUrl || "尚未填写"}</code></p>
            {/* Adoption is derived on the read path, so say it out loud rather
                than letting an entry appear from nowhere. */}
            {adopted && <p className="adopted-note"><Info size={17} weight="duotone" />已从现有 config.toml 接管，保存后才会记入本管理器。</p>}
          </div>
          <div className="gateway-side">
            <div className="saved-credential">
              <ShieldCheck size={29} weight="duotone" />
              <span>
                <strong>{!form.requiresAuth ? "无需凭据" : form.credentialMode === "keep" ? "凭据已安全保存" : "凭据将在保存时写入"}</strong>
                <small>{!form.requiresAuth ? "Codex 不会带 Authorization" : form.credentialMode === "keep" ? "浏览器无法读取旧 key" : "当前草稿尚未写入 Codex 配置"}</small>
              </span>
            </div>
            {canDeleteProvider && (
              <button type="button" className="delete-provider-button" onClick={onDeleteProvider}><Trash size={18} />删除供应商</button>
            )}
          </div>
        </div>
        <div className="models-header">
          <div><h2>模型列表<span className="count-pill">{namedModels}</span></h2><p>默认模型会写入 config.toml 的 <code className="mono">model</code>，其余模型只生成 profile。</p></div>
          <div className="models-actions">
            <button type="button" className="secondary-button compact-button" onClick={() => setShowBulk(true)} title="批量添加模型 ID" aria-label="批量添加"><ListPlus size={18} /><span className="button-label">批量添加</span></button>
            <button type="button" className="outline-button compact-button" onClick={addModel} title="添加模型" aria-label="添加模型"><Plus size={19} /><span className="button-label">添加模型</span></button>
          </div>
        </div>
        <div className={`models-table ${scrolled ? "is-scrolled" : ""}`} onScroll={(event) => setScrolled(event.currentTarget.scrollTop > 2)}>
          <div className="model-table-head is-codex"><span>模型 ID</span><span>推理强度</span><span>默认模型</span><span className="model-action-cell" /></div>
          {form.models.map((model) => (
            <CodexModelRow
              key={model.rowId}
              model={model}
              isDefault={form.defaultRowId === model.rowId && Boolean(model.id.trim())}
              isLiveModel={Boolean(liveModel) && model.id.trim() === liveModel}
              onChange={(value) => updateModel(model.rowId, value)}
              onDefault={() => setForm((current) => ({ ...current, defaultRowId: model.rowId }))}
              onArmRemove={() => armRemoveModel(model)}
              onRemove={() => removeModel(model.rowId)}
              onBlockedRemove={blockLastModelRemoval}
              canRemove={form.models.length > 1}
            />
          ))}
        </div>
        <div className="models-note">
          <Info size={21} weight="duotone" />
          {/* Wrapped: .models-note is a flex row, so bare text beside an inline
              <code> would become two flex items and break the sentence. */}
          <span>切换供应商只对<strong>新开的</strong> codex 会话生效；正在运行的会话不受影响，也不要指望 <code className="mono">codex resume</code> 能跨供应商续聊。</span>
        </div>
        {error && <div className="error-banner" role="alert"><WarningCircle size={20} weight="fill" />{error}</div>}
      </div>
      <footer className="wizard-footer">
        <button type="button" className="secondary-button" onClick={onBack}><ArrowLeft size={19} />上一步</button>
        {isActive ? (
          <button type="button" className="primary-button" disabled={saving} onClick={() => onSave(true)}>{saving ? <><Spinner />正在保存…</> : "保存更改"}</button>
        ) : (
          <div className="footer-actions">
            <button type="button" className="outline-button" disabled={saving} onClick={() => onSave(false)}>只保存，不切换</button>
            <button type="button" className="primary-button" disabled={saving} onClick={() => onSave(true)}>{saving ? <><Spinner />正在保存…</> : "保存并设为当前生效"}</button>
          </div>
        )}
      </footer>
      {showBulk && <BulkModal text={bulkText} ids={bulkIds} newIds={newBulkIds} onText={setBulkText} onClose={() => setShowBulk(false)} onImport={importModels} />}
    </section>
  );
}

export function CodexWizard(props) {
  if (props.step === 1) return <UpstreamStep form={props.form} setForm={props.setForm} codexVersion={props.codexVersion} onNext={props.onNext} />;
  if (props.step === 2) return <CodexCredentialsStep {...props} />;
  return <CodexModelsStep {...props} />;
}

export function CodexDeleteDialog({ provider, codex, deleting, requestError, onClose, onConfirm }) {
  const alternatives = codex.providers.filter((item) => item.id !== provider.id);
  const [replacementProviderId, setReplacementProviderId] = useState(alternatives[0]?.id || "");
  const cancelRef = useRef(null);
  const isActive = provider.isActive;
  const blocked = isActive && alternatives.length === 0;
  useEffect(() => { cancelRef.current?.focus(); }, []);
  useEffect(() => {
    const onKeyDown = (event) => { if (event.key === "Escape") onClose(); };
    document.addEventListener("keydown", onKeyDown);
    return () => document.removeEventListener("keydown", onKeyDown);
  }, [onClose]);
  return (
    <div className="modal-backdrop" role="presentation" onMouseDown={(event) => { if (event.target === event.currentTarget) onClose(); }}>
      <section className="bulk-modal" role="dialog" aria-modal="true" aria-labelledby="codex-delete-title">
        <div className="modal-heading">
          <div>
            <h2 id="codex-delete-title">删除 Codex 供应商 <code>{provider.id}</code>？</h2>
            <p>会移除它的地址、模型列表和保存的 key。Codex 的 config.toml 只保留当前生效的那一个供应商表。</p>
          </div>
        </div>
        {isActive && (
          blocked ? (
            <div className="error-banner" role="alert">
              <WarningCircle size={20} weight="fill" />
              这是当前生效的供应商，而且没有别的供应商可以接替。请先添加一个再回来删除。
            </div>
          ) : (
            <label>
              <span>接替它成为当前生效的供应商</span>
              <select value={replacementProviderId} onChange={(event) => setReplacementProviderId(event.target.value)}>
                {alternatives.map((item) => <option key={item.id} value={item.id}>{item.name}（{item.id}）</option>)}
              </select>
              <small>删除后会立即把这个供应商写入 config.toml 并换上它的 key。</small>
            </label>
          )
        )}
        {requestError && <div className="error-banner" role="alert"><WarningCircle size={20} weight="fill" />{requestError}</div>}
        <div className="modal-actions">
          <button type="button" ref={cancelRef} className="secondary-button" onClick={onClose}>取消</button>
          <button
            type="button"
            className="primary-button is-destructive"
            disabled={deleting || blocked}
            onClick={() => onConfirm({ providerId: provider.id, replacementProviderId: isActive ? replacementProviderId : undefined })}
          >
            {deleting ? <><Spinner />正在删除…</> : "删除供应商"}
          </button>
        </div>
      </section>
    </div>
  );
}

export function CodexSuccessScreen({ result, onCopy, onReturn, onAdd }) {
  const [copied, setCopied] = useState(false);
  const commandRef = useRef(null);
  const copy = async () => {
    const ok = await onCopy(result.command);
    if (ok) { setCopied(true); return; }
    const node = commandRef.current;
    if (!node) return;
    const selection = window.getSelection();
    if (!selection) return;
    const range = document.createRange();
    range.selectNodeContents(node);
    selection.removeAllRanges();
    selection.addRange(range);
  };
  useEffect(() => {
    if (!copied) return undefined;
    const timer = setTimeout(() => setCopied(false), 2000);
    return () => clearTimeout(timer);
  }, [copied]);
  return (
    <section className="success-page">
      <div className="success-mark"><CheckCircle size={72} weight="fill" /></div>
      <p className="success-eyebrow">配置已写入 Codex</p>
      <h1>{result.name} 已保存</h1>
      <p className="success-summary">
        {result.activated
          ? <>已写入 <code>config.toml</code> 并换上这个供应商的 key，默认模型是 <code>{result.defaultModelId}</code>。</>
          : <>已保存 {result.modelCount} 个模型。当前生效的供应商没有改动。</>}
      </p>
      <div className="next-step-card">
        <div className="next-step-heading">
          <TerminalWindow size={28} weight="duotone" />
          <div>
            <h2>下一步：开一个新的 codex 会话</h2>
            <p>配置只在 Codex 启动时读取。<strong>正在运行的会话不受影响</strong>，需要新开一个终端才会生效。</p>
          </div>
        </div>
        <div className="command-row">
          <code ref={commandRef}>{result.command}</code>
          <button type="button" className={`copy-button ${copied ? "is-copied" : ""}`} onClick={copy}>
            {copied ? <><Check size={18} weight="bold" />已复制</> : <><Copy size={18} />复制</>}
          </button>
        </div>
        <ol>
          <li>启动后用 <code>/model</code> 确认模型是 <code>{result.defaultModelId}</code></li>
          {result.profiles.length > 1 && (
            <li>
              同一供应商的其它模型可以直接指定 profile：
              {result.profiles.slice(1).map((name) => <code key={name} className="profile-chip">codex --profile {name}</code>)}
            </li>
          )}
          <li>发一句简单消息试通；限流或 5xx 属于上游服务状态，不代表配置没写进去</li>
        </ol>
      </div>
      <p className="success-caveat">
        <Info size={19} weight="duotone" />
        {/* One flex item, or the inline <code> becomes a sibling of the text and
            the sentence breaks around it. */}
        <span>换供应商后不要用 <code>codex resume</code> 接续旧会话：Codex 会把上一家加密的 reasoning 内容原样回传，另一家读不了。</span>
      </p>
      <div className="success-actions">
        <button type="button" className="secondary-button" onClick={onAdd}><Plus size={18} />添加另一个供应商</button>
        <button type="button" className="primary-button" onClick={onReturn}>返回供应商详情<ArrowRight size={19} /></button>
      </div>
    </section>
  );
}

export function CodexSettingsScreen({ state, saving, error, onSave, onBack }) {
  const codex = state.codex || {};
  const providers = codex.providers || [];
  const saved = useMemo(() => ({
    activeProviderId: codex.activeProviderId || providers[0]?.id || "",
    reasoningEffort: codex.settings?.reasoningEffort || "medium",
    planModeReasoningEffort: codex.settings?.planModeReasoningEffort || "medium",
    verbosity: codex.settings?.verbosity || "medium",
    contextWindow: codex.settings?.contextWindow || 0,
    ownedProviderId: codex.ownedProviderId || "custom",
    generateProfiles: codex.generateProfiles !== false,
    disableResponseStorage: Boolean(codex.settings?.disableResponseStorage),
  }), [codex, providers]);
  const [draft, setDraft] = useState(saved);
  useEffect(() => { setDraft(saved); }, [saved]);

  const present = new Set(Array.isArray(codex.settingsPresent) ? codex.settingsPresent : []);
  const unwritten = ["model", "model_provider", "model_reasoning_effort"].filter((key) => !present.has(key));
  const edited = JSON.stringify(saved) !== JSON.stringify(draft);
  const installed = state.compatibility?.codexVersion;
  const validated = state.compatibility?.validatedCodexVersion;
  const versionDiffers = Boolean(installed) && installed !== "unknown"
    && Boolean(validated) && validated !== "unknown" && installed !== validated;

  return (
    <section className="settings-page">
      <div className="settings-scroll">
        <div className="settings-title">
          <div><p>Codex 全局设置</p><h1>设置与兼容性</h1><span>这里的修改会写入 Codex 的 config.toml。</span></div>
          <button type="button" className="secondary-button" onClick={onBack}><ArrowLeft size={18} />返回</button>
        </div>
        <div className="settings-grid">
          <section className="settings-card">
            <h2>当前生效的供应商</h2><p>决定直接运行 <code className="mono">codex</code> 时用哪一家。</p>
            <label>
              <span>供应商</span>
              <select value={draft.activeProviderId} disabled={providers.length === 0} onChange={(event) => setDraft((current) => ({ ...current, activeProviderId: event.target.value }))}>
                {providers.map((provider) => <option key={provider.id} value={provider.id}>{provider.name}（{provider.id}）</option>)}
              </select>
              {providers.length === 0 && <small>还没有 Codex 供应商。先添加一个再回来。</small>}
            </label>
            <label>
              <span>默认模型</span>
              <input className="mono" value={codex.settings?.model || ""} readOnly aria-readonly="true" />
              <small>模型与推理强度属于供应商，在它的「确认模型」一步里选。</small>
            </label>
          </section>
          <section className="settings-card">
            <h2>推理与输出</h2><p>这些选项由 Codex 官方 config.toml 支持。</p>
            <label>
              <span>推理强度 <code className="mono">model_reasoning_effort</code></span>
              <select value={draft.reasoningEffort} onChange={(event) => setDraft((current) => ({ ...current, reasoningEffort: event.target.value }))}>
                {CODEX_EFFORTS.map((effort) => <option key={effort} value={effort}>{effort}</option>)}
              </select>
            </label>
            <label>
              <span>Plan 模式推理强度 <code className="mono">plan_mode_reasoning_effort</code></span>
              <select value={draft.planModeReasoningEffort} onChange={(event) => setDraft((current) => ({ ...current, planModeReasoningEffort: event.target.value }))}>
                {CODEX_EFFORTS.map((effort) => <option key={effort} value={effort}>{effort}</option>)}
              </select>
            </label>
            <label>
              <span>输出详尽度 <code className="mono">model_verbosity</code></span>
              <select value={draft.verbosity} onChange={(event) => setDraft((current) => ({ ...current, verbosity: event.target.value }))}>
                {CODEX_VERBOSITIES.map((value) => <option key={value} value={value}>{value}</option>)}
              </select>
            </label>
          </section>
          <section className="settings-card compatibility-card">
            <h2>兼容状态</h2>
            <dl>
              <div><dt>Codex 版本</dt><dd className="mono">{installed || "unknown"}</dd></div>
              <div><dt>已验证兼容</dt><dd className="mono">Codex {validated || "unknown"}</dd></div>
              <div><dt>接口协议</dt><dd className="mono">wire_api = "responses"</dd></div>
              <div><dt>供应商表名</dt><dd className="mono">model_providers.{draft.ownedProviderId}</dd></div>
              <div><dt>配置目录</dt><dd className="mono" title={codex.dir}>{codex.dir}</dd></div>
              <div><dt>路径来源</dt><dd>{codex.dirSource === "PI_PROVIDER_MANAGER_CODEX_DIR" ? "PI_PROVIDER_MANAGER_CODEX_DIR" : codex.dirSource === "CODEX_HOME" ? "CODEX_HOME" : "自动识别 · 用户主目录"}</dd></div>
            </dl>
            {versionDiffers && (
              <p className="compat-note is-warning">
                <WarningCircle size={20} weight="fill" />
                你安装的 Codex 是 {installed}，本版本验证过的是 {validated}。未知字段仍会保留，但若 Codex 改动了配置结构，请对照兼容性说明确认。
              </p>
            )}
            <p className="compat-note"><ShieldCheck size={20} weight="duotone" />config.toml 里本管理器不认识的键、注释和你手写的其它 <code className="mono">[model_providers.*]</code> 表都会原样保留。</p>
          </section>
        </div>
        <details className="advanced-panel">
          <summary><span><SlidersHorizontal size={21} />高级设置 <small>通常无需修改</small></span></summary>
          <div className="advanced-content">
            <label>
              <span>供应商表名 <code className="mono">model_providers.&lt;id&gt;</code></span>
              <input className="mono" value={draft.ownedProviderId} onChange={(event) => setDraft((current) => ({ ...current, ownedProviderId: slugify(event.target.value) }))} spellCheck={false} />
              <small>本管理器只写这一张表。不能使用 Codex 的内建 id（openai、ollama、lmstudio 等）。</small>
            </label>
            <label>
              <span>上下文容量 <code className="mono">model_context_window</code></span>
              <input className="mono" inputMode="numeric" value={draft.contextWindow || ""} onChange={(event) => setDraft((current) => ({ ...current, contextWindow: Number(event.target.value.replace(/[^0-9]/g, "")) || 0 }))} placeholder="留空表示不写入" />
            </label>
            <label className="setting-toggle">
              <input type="checkbox" checked={draft.generateProfiles} onChange={(event) => setDraft((current) => ({ ...current, generateProfiles: event.target.checked }))} />
              <span><strong>为每个模型生成 profile</strong><small>可以用 <code className="mono">codex --profile</code> 在同一供应商内换模型。</small></span>
            </label>
            <label className="setting-toggle">
              <input type="checkbox" checked={draft.disableResponseStorage} onChange={(event) => setDraft((current) => ({ ...current, disableResponseStorage: event.target.checked }))} />
              <span><strong><code className="mono">disable_response_storage</code></strong><small>新版 Codex 已从配置里移除该项，请求里的 <code className="mono">store</code> 固定为 false。只对旧版本有意义。</small></span>
            </label>
          </div>
        </details>
        {error && <div className="error-banner" role="alert"><WarningCircle size={20} weight="fill" />{error}</div>}
      </div>
      <footer className="settings-footer">
        <span className="dirty-note" aria-live="polite">
          {edited
            ? "有未保存的修改"
            : unwritten.length > 0
              ? `有 ${unwritten.length} 项还没写入 config.toml`
              : "所有修改已写入 config.toml"}
        </span>
        <button type="button" className="primary-button" disabled={saving || (!edited && unwritten.length === 0)} onClick={() => onSave(draft)}>
          {saving ? <><Spinner />正在保存…</> : "保存设置"}
        </button>
      </footer>
    </section>
  );
}
