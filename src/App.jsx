import { useEffect, useMemo, useState } from "react";
import {
  ArrowLeft,
  ArrowRight,
  Asterisk,
  Brain,
  CaretDown,
  ChatCircleDots,
  CheckCircle,
  Cube,
  Gear,
  GoogleLogo,
  ImageSquare,
  Info,
  Key,
  OpenAiLogo,
  Plus,
  Question,
  ShieldCheck,
  SlidersHorizontal,
  Stack,
  Trash,
  WarningCircle,
} from "@phosphor-icons/react";

const API_OPTIONS = [
  {
    id: "openai-responses",
    short: "Responses",
    title: "OpenAI Responses",
    subtitle: "新接口",
    description: "适合支持 Responses API 的网关与新模型。",
    icon: OpenAiLogo,
  },
  {
    id: "openai-completions",
    short: "OpenAI Chat",
    title: "OpenAI Chat",
    subtitle: "兼容接口",
    description: "常见的 Chat Completions 兼容网关。",
    icon: ChatCircleDots,
  },
  {
    id: "anthropic-messages",
    short: "Anthropic",
    title: "Anthropic Messages",
    subtitle: "Claude",
    description: "适合提供 Anthropic Messages 接口的网关。",
    icon: Asterisk,
  },
  {
    id: "google-generative-ai",
    short: "Gemini",
    title: "Google Gemini",
    subtitle: "Generative AI",
    description: "适合 Gemini 原生格式的服务。",
    icon: GoogleLogo,
  },
];

const THINKING_OPTIONS = [
  { value: "off", label: "不支持" },
  { value: "medium", label: "支持 · 中等" },
  { value: "high", label: "支持 · 强" },
  { value: "xhigh", label: "支持 · XHigh" },
  { value: "max", label: "支持 · Max" },
];

function apiMeta(id) {
  return API_OPTIONS.find((item) => item.id === id) || {
    id,
    short: id || "仅凭据",
    title: id || "仅凭据",
    icon: Cube,
  };
}

function titleFromId(id) {
  return id
    .split(/[-_.]+/)
    .filter(Boolean)
    .map((part) => part.charAt(0).toUpperCase() + part.slice(1))
    .join(" ");
}

function safeDefaults(modelId = "") {
  if (modelId === "gpt-5.6-sol") return { contextWindow: 1_050_000, maxTokens: 128_000 };
  return { contextWindow: 128_000, maxTokens: 16_384 };
}

function blankModel(id = "") {
  const limits = safeDefaults(id);
  return {
    rowId: crypto.randomUUID(),
    id,
    name: id,
    contextWindow: limits.contextWindow,
    maxTokens: limits.maxTokens,
    supportsImages: true,
    maximumThinking: "high",
    api: "inherit",
    forceAdaptiveThinking: false,
  };
}

function blankForm() {
  return {
    providerId: "",
    baseUrl: "",
    api: "openai-responses",
    credentialMode: "new",
    apiKey: "",
    migrateFrom: "",
    moveCredential: true,
    models: [blankModel("gpt-5.6-sol")],
    defaultModelId: "gpt-5.6-sol",
    defaultThinkingLevel: "high",
    compat: {},
  };
}

const DEMO_STATE = {
  agentDir: "/home/forbackup/.pi/agent",
  authProviders: ["any-claude", "openai", "deepseek", "moonshot", "qwen", "gemini", "minimax"],
  settings: { defaultProvider: "any-claude", defaultModel: "claude-3-5-sonnet", defaultThinkingLevel: "high" },
  providers: [
    {
      id: "any-claude",
      name: "Any Claude",
      api: "anthropic-messages",
      baseUrl: "https://api.any-claude.com/v1",
      credentialConfigured: true,
      isDefault: true,
      models: [
        { id: "claude-3-5-sonnet", name: "claude-3-5-sonnet", contextWindow: 200000, maxTokens: 8192, input: ["text", "image"], reasoning: true },
        { id: "claude-3-5-haiku", name: "claude-3-5-haiku", contextWindow: 200000, maxTokens: 8192, input: ["text", "image"], reasoning: true, maximumThinking: "medium" },
      ],
    },
    { id: "openai", name: "OpenAI", api: "openai-responses", baseUrl: "https://api.openai.com/v1", credentialConfigured: true, models: [] },
    { id: "deepseek", name: "DeepSeek", api: "openai-completions", baseUrl: "https://api.deepseek.com/v1", credentialConfigured: true, models: [] },
    { id: "moonshot", name: "Moonshot", api: "openai-completions", baseUrl: "", credentialConfigured: false, models: [] },
    { id: "qwen", name: "Qwen", api: "openai-completions", baseUrl: "", credentialConfigured: true, models: [] },
    { id: "gemini", name: "Gemini", api: "google-generative-ai", baseUrl: "", credentialConfigured: true, models: [] },
    { id: "minimax", name: "MiniMax", api: "openai-completions", baseUrl: "", credentialConfigured: true, models: [] },
    { id: "baichuan", name: "Baichuan", api: "openai-completions", baseUrl: "", credentialConfigured: false, models: [] },
    { id: "yi", name: "Yi", api: "openai-completions", baseUrl: "", credentialConfigured: false, models: [] },
  ],
};

function providerToForm(provider, state) {
  const convertedModels = provider.models.length
    ? provider.models.map((model) => ({
        rowId: crypto.randomUUID(),
        id: model.id,
        name: model.name || model.id,
        contextWindow: model.contextWindow || 128000,
        maxTokens: model.maxTokens || 16384,
        supportsImages: Array.isArray(model.input) && model.input.includes("image"),
        maximumThinking: model.maximumThinking || (model.thinkingLevelMap?.max
          ? "max"
          : model.thinkingLevelMap?.xhigh
            ? "xhigh"
            : model.reasoning
              ? "high"
              : "off"),
        api: model.api || "inherit",
        forceAdaptiveThinking: Boolean(model.compat?.forceAdaptiveThinking),
      }))
    : [blankModel()];
  return {
    providerId: provider.id,
    baseUrl: provider.baseUrl,
    api: provider.api || "openai-responses",
    credentialMode: provider.credentialConfigured ? "keep" : "new",
    apiKey: "",
    migrateFrom: state.authProviders.find((id) => id !== provider.id) || "",
    moveCredential: true,
    models: convertedModels,
    defaultModelId:
      state.settings.defaultProvider === provider.id && convertedModels.some((model) => model.id === state.settings.defaultModel)
        ? state.settings.defaultModel
        : convertedModels[0].id,
    defaultThinkingLevel: state.settings.defaultThinkingLevel || "high",
    compat: provider.compat || {},
  };
}

function ProviderIcon({ api, size = 24 }) {
  const Icon = apiMeta(api).icon;
  return <Icon size={size} weight="duotone" aria-hidden="true" />;
}

function Stepper({ step, onStep }) {
  const items = [
    [1, "选择协议", "选择网关默认接口"],
    [2, "填写凭据", "填写地址与访问凭据"],
    [3, "确认模型", "添加并确认可用模型"],
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
          >
            <span className="step-number">{number < step ? <CheckCircle size={24} weight="fill" /> : number}</span>
            <span>
              <strong>{title}</strong>
              <small>{subtitle}</small>
            </span>
          </button>
          {index < items.length - 1 && <span className={`step-line ${number < step ? "is-complete" : ""}`} />}
        </div>
      ))}
    </div>
  );
}

function Sidebar({ state, selectedId, onSelect, onAdd }) {
  const [showPath, setShowPath] = useState(false);
  return (
    <aside className="sidebar">
      <div className="brand">
        <span className="brand-icon"><img src="/favicon.png" alt="" /></span>
        <span>Pi Provider Manager</span>
      </div>
      <button type="button" className="add-provider" onClick={onAdd}>
        <Plus size={22} weight="bold" />添加供应商
      </button>
      <p className="sidebar-label">我的供应商 / API 网关</p>
      <nav className="provider-list" aria-label="供应商列表">
        {state.providers.map((provider) => (
          <button
            type="button"
            key={provider.id}
            className={`provider-item ${selectedId === provider.id ? "is-selected" : ""}`}
            onClick={() => onSelect(provider)}
          >
            <span className="provider-icon"><ProviderIcon api={provider.api} size={23} /></span>
            <span className="provider-copy">
              <strong>{provider.name || titleFromId(provider.id)}</strong>
              <small>{provider.models.length} 个模型 · {apiMeta(provider.api).short}</small>
            </span>
            {provider.credentialConfigured ? (
              <CheckCircle className="status-ok" size={18} weight="fill" aria-label="凭据已配置" />
            ) : (
              <WarningCircle className="status-warn" size={18} weight="fill" aria-label="未配置凭据" />
            )}
          </button>
        ))}
      </nav>
      <div className="beginner-tip">
        <Info size={22} weight="duotone" />
        <div><strong>新手提示</strong><span>一个 API 网关可以添加多个不同厂商的模型。</span></div>
      </div>
      <button type="button" className="settings-button" onClick={() => setShowPath((current) => !current)}><Gear size={20} />设置</button>
      {showPath && <div className="agent-path" title={state.agentDir}>配置目录：{state.agentDir}</div>}
    </aside>
  );
}

function ProtocolStep({ form, setForm, onNext }) {
  return (
    <section className="step-content">
      <div className="section-heading">
        <div><h1>选择网关的默认接口协议</h1><p>供应商类似 OpenRouter：先选默认协议，下面可以挂多个模型。</p></div>
        <span className="help-link"><Question size={19} />不确定？查看供应商文档中的接口类型</span>
      </div>
      <div className="protocol-grid">
        {API_OPTIONS.map((option) => {
          const Icon = option.icon;
          return (
            <button
              type="button"
              key={option.id}
              className={`protocol-card ${form.api === option.id ? "is-selected" : ""}`}
              onClick={() => setForm((current) => {
                const hasOnlyGptPreset = current.models.length === 1 && current.models[0].id === "gpt-5.6-sol";
                if (option.id !== "openai-responses" && hasOnlyGptPreset) {
                  const model = blankModel();
                  return { ...current, api: option.id, models: [model], defaultModelId: "" };
                }
                return { ...current, api: option.id };
              })}
            >
              <span className="protocol-icon"><Icon size={36} weight="duotone" /></span>
              <strong>{option.title}</strong>
              <b>{option.subtitle}</b>
              <p>{option.description}</p>
              {form.api === option.id && <CheckCircle className="selected-check" size={24} weight="fill" />}
            </button>
          );
        })}
      </div>
      <div className="safe-note"><ShieldCheck size={22} weight="duotone" />高级参数会自动使用安全默认值，无需在这里配置。</div>
      <footer className="wizard-footer"><span /><button type="button" className="primary-button" onClick={onNext}>下一步<ArrowRight size={19} /></button></footer>
    </section>
  );
}

function CredentialsStep({ form, setForm, state, error, onBack, onNext }) {
  const sources = state.authProviders.filter((id) => id !== form.providerId);
  return (
    <section className="step-content form-step">
      <div className="section-heading"><div><h1>填写网关地址与凭据</h1><p>key 只会写入 Pi 的 auth.json，保存后不会再显示。</p></div></div>
      <div className="form-grid">
        <label><span>供应商 ID</span><small>例如 any-router；用于 Pi 内部识别</small><input value={form.providerId} onChange={(event) => setForm((current) => ({ ...current, providerId: event.target.value.toLowerCase().replace(/\s+/g, "-") }))} placeholder="any-router" /></label>
        <label><span>API 地址</span><small>填写接口根地址，不要包含具体模型路径</small><input value={form.baseUrl} onChange={(event) => setForm((current) => ({ ...current, baseUrl: event.target.value }))} placeholder="https://api.example.com/v1" /></label>
      </div>
      <fieldset className="credential-box">
        <legend>访问凭据</legend>
        <div className="credential-tabs">
          {state.authProviders.includes(form.providerId) && <button type="button" className={form.credentialMode === "keep" ? "is-active" : ""} onClick={() => setForm((current) => ({ ...current, credentialMode: "keep" }))}>保留现有 key</button>}
          <button type="button" className={form.credentialMode === "new" ? "is-active" : ""} onClick={() => setForm((current) => ({ ...current, credentialMode: "new" }))}>输入新 key</button>
          {sources.length > 0 && <button type="button" className={form.credentialMode === "migrate" ? "is-active" : ""} onClick={() => setForm((current) => ({ ...current, credentialMode: "migrate", migrateFrom: current.migrateFrom || sources[0] }))}>从已有凭据迁移</button>}
        </div>
        {form.credentialMode === "keep" && <div className="credential-status"><ShieldCheck size={24} weight="duotone" /><div><strong>凭据已安全保存</strong><span>浏览器无法读取已保存的 key。</span></div></div>}
        {form.credentialMode === "new" && <label className="key-field"><span>API Key</span><div><Key size={20} /><input type="password" autoComplete="new-password" value={form.apiKey} onChange={(event) => setForm((current) => ({ ...current, apiKey: event.target.value }))} placeholder="输入后不会回显" /></div></label>}
        {form.credentialMode === "migrate" && <div className="migrate-fields"><label><span>选择已有供应商</span><select value={form.migrateFrom} onChange={(event) => setForm((current) => ({ ...current, migrateFrom: event.target.value }))}>{sources.map((id) => <option key={id} value={id}>{titleFromId(id)} ({id})</option>)}</select></label><label className="checkbox-row"><input type="checkbox" checked={form.moveCredential} onChange={(event) => setForm((current) => ({ ...current, moveCredential: event.target.checked }))} />迁移成功后删除旧条目</label></div>}
      </fieldset>
      {error && <div className="error-banner"><WarningCircle size={20} weight="fill" />{error}</div>}
      <footer className="wizard-footer"><button type="button" className="secondary-button" onClick={onBack}><ArrowLeft size={19} />上一步</button><button type="button" className="primary-button" onClick={onNext}>下一步<ArrowRight size={19} /></button></footer>
    </section>
  );
}

function formatTokens(value) {
  const number = Number(value);
  if (!Number.isFinite(number)) return "";
  if (number >= 1_000_000 && number % 1_000_000 === 0) return `${number / 1_000_000}M`;
  if (number >= 1_000 && number % 1_000 === 0) return `${number / 1_000}K`;
  if (number >= 1_024 && number < 100_000 && number % 1_024 === 0) return `${number / 1_024}K`;
  return String(number);
}

function TokenField({ value, onChange, label }) {
  const [focused, setFocused] = useState(false);
  const [draft, setDraft] = useState(String(value));
  useEffect(() => { if (!focused) setDraft(String(value)); }, [value, focused]);
  return (
    <input
      type="text"
      inputMode="numeric"
      aria-label={label}
      value={focused ? draft : formatTokens(value)}
      onFocus={() => { setDraft(String(value)); setFocused(true); }}
      onChange={(event) => setDraft(event.target.value.replace(/[^0-9]/g, ""))}
      onBlur={() => {
        const parsed = Number(draft);
        if (Number.isSafeInteger(parsed) && parsed > 0) onChange(parsed);
        setFocused(false);
      }}
    />
  );
}

function ModelRow({ model, isDefault, onChange, onDefault, onRemove, canRemove }) {
  const applySafe = () => onChange({ ...model, ...safeDefaults(model.id) });
  return (
    <div className="model-row">
      <span className="drag-handle"><Stack size={17} /></span>
      <label className="model-name-cell"><span className="sr-only">模型 ID</span><input value={model.id} onChange={(event) => onChange({ ...model, id: event.target.value, name: event.target.value })} placeholder="例如 anthropic/claude-opus" /></label>
      <label><TokenField label="上下文容量" value={model.contextWindow} onChange={(value) => onChange({ ...model, contextWindow: value })} /><button type="button" className="safe-default" onClick={applySafe}>不知道？用安全值</button></label>
      <label><TokenField label="最大输出" value={model.maxTokens} onChange={(value) => onChange({ ...model, maxTokens: value })} /><button type="button" className="safe-default" onClick={applySafe}>不知道？用安全值</button></label>
      <label><span className="sr-only">图像能力</span><select value={model.supportsImages ? "yes" : "no"} onChange={(event) => onChange({ ...model, supportsImages: event.target.value === "yes" })}><option value="yes">支持</option><option value="no">不支持</option></select></label>
      <label><span className="sr-only">推理能力</span><select value={model.maximumThinking} onChange={(event) => onChange({ ...model, maximumThinking: event.target.value })}>{THINKING_OPTIONS.map((option) => <option key={option.value} value={option.value}>{option.label}</option>)}</select></label>
      <label className="default-radio"><input type="radio" name="default-model" checked={isDefault} onChange={onDefault} aria-label={`将 ${model.id || "该模型"} 设为默认`} /></label>
      <button type="button" className="icon-button" onClick={onRemove} disabled={!canRemove} aria-label="删除模型"><Trash size={18} /></button>
      {model.api !== "inherit" && <small className="protocol-override">覆盖协议：{apiMeta(model.api).short}</small>}
    </div>
  );
}

function ModelsStep({ form, setForm, error, saving, onBack, onSave }) {
  const updateModel = (rowId, value) => setForm((current) => ({ ...current, models: current.models.map((model) => model.rowId === rowId ? value : model) }));
  const addModel = () => setForm((current) => ({ ...current, models: [...current.models, blankModel()], defaultModelId: current.defaultModelId || current.models[0]?.id || "" }));
  const removeModel = (rowId) => setForm((current) => {
    const models = current.models.filter((model) => model.rowId !== rowId);
    return { ...current, models, defaultModelId: models.some((model) => model.id === current.defaultModelId) ? current.defaultModelId : models[0]?.id || "" };
  });
  const currentApi = apiMeta(form.api);
  return (
    <section className="step-content models-step">
      <div className="section-heading"><div><h1>确认并选择可用模型</h1><p>一个 API 网关可以添加多个不同厂商的模型，并指定 Pi 默认使用哪个。</p></div><span className="help-link"><Question size={19} />不知道？使用安全默认值</span></div>
      <div className="gateway-summary">
        <span className="summary-icon"><ProviderIcon api={form.api} size={34} /></span>
        <div><strong>{titleFromId(form.providerId || "new-provider")}</strong><span className="protocol-badge">{currentApi.title}</span><p>API 地址　{form.baseUrl || "尚未填写"}</p></div>
        <div className="saved-credential"><ShieldCheck size={29} weight="duotone" /><span><strong>凭据已安全保存</strong><small>浏览器无法读取旧 key</small></span></div>
      </div>
      <div className="models-header"><div><h2>模型列表</h2><p>填写网关提供的模型 ID；不同模型可来自不同上游厂商。</p></div><button type="button" className="outline-button" onClick={addModel}><Plus size={19} />添加模型</button></div>
      <div className="models-table">
        <div className="model-table-head"><span /><span>模型 ID</span><span>上下文容量</span><span>最大输出</span><span>图像能力</span><span>推理能力</span><span>默认模型</span><span /></div>
        {form.models.map((model) => <ModelRow key={model.rowId} model={model} isDefault={form.defaultModelId === model.id && Boolean(model.id)} onChange={(value) => updateModel(model.rowId, value)} onDefault={() => setForm((current) => ({ ...current, defaultModelId: model.id }))} onRemove={() => removeModel(model.rowId)} canRemove={form.models.length > 1} />)}
      </div>
      <div className="models-note"><ShieldCheck size={21} weight="duotone" />未指定的能力项将使用保守默认值，不影响正常使用。</div>
      <details className="advanced-panel">
        <summary><span><SlidersHorizontal size={21} />高级兼容设置 <small>通常无需修改</small></span><CaretDown size={19} /></summary>
        <div className="advanced-content">
          <div><h3>模型协议覆盖</h3><p>只有网关针对某个模型使用不同接口时才需要设置。</p></div>
          {form.models.map((model) => <label key={model.rowId}><span>{model.id || "未命名模型"}</span><select value={model.api} onChange={(event) => updateModel(model.rowId, { ...model, api: event.target.value })}><option value="inherit">继承网关默认协议</option>{API_OPTIONS.map((option) => <option key={option.id} value={option.id}>{option.title}</option>)}</select></label>)}
        </div>
      </details>
      {error && <div className="error-banner"><WarningCircle size={20} weight="fill" />{error}</div>}
      <footer className="wizard-footer"><button type="button" className="secondary-button" onClick={onBack}><ArrowLeft size={19} />上一步</button><button type="button" className="primary-button" disabled={saving} onClick={() => onSave(true)}>{saving ? "正在保存…" : "保存并设为默认"}</button></footer>
    </section>
  );
}

export function App() {
  const demoMode = useMemo(() => new URLSearchParams(window.location.search).get("demo") === "1", []);
  const [state, setState] = useState(demoMode ? DEMO_STATE : { providers: [], authProviders: [], settings: {}, agentDir: "" });
  const [loading, setLoading] = useState(!demoMode);
  const [selectedId, setSelectedId] = useState(demoMode ? "any-claude" : "");
  const [step, setStep] = useState(demoMode ? 3 : 1);
  const [form, setForm] = useState(() => demoMode ? providerToForm(DEMO_STATE.providers[0], DEMO_STATE) : blankForm());
  const [error, setError] = useState("");
  const [saving, setSaving] = useState(false);
  const [toast, setToast] = useState("");

  useEffect(() => {
    if (demoMode) return;
    fetch("/api/state", { cache: "no-store" })
      .then(async (response) => {
        const data = await response.json();
        if (!response.ok) throw new Error(data.error || "读取配置失败");
        setState(data);
        if (data.providers.length > 0) {
          const provider = data.providers.find((item) => item.isDefault) || data.providers[0];
          setSelectedId(provider.id);
          setForm(providerToForm(provider, data));
          setStep(provider.models.length > 0 ? 3 : 1);
        }
      })
      .catch((requestError) => setError(requestError.message))
      .finally(() => setLoading(false));
  }, [demoMode]);

  const startNew = () => {
    const fresh = blankForm();
    fresh.migrateFrom = state.authProviders[0] || "";
    setForm(fresh);
    setSelectedId("");
    setStep(1);
    setError("");
  };

  const selectProvider = (provider) => {
    setForm(providerToForm(provider, state));
    setSelectedId(provider.id);
    setStep(provider.models.length > 0 ? 3 : 1);
    setError("");
  };

  const validateCredentials = () => {
    if (!form.providerId.trim()) return "请输入供应商 ID。";
    if (!form.baseUrl.trim()) return "请输入 API 地址。";
    if (form.credentialMode === "new" && !form.apiKey.trim()) return "请输入 API Key。";
    if (form.credentialMode === "migrate" && !form.migrateFrom) return "请选择要迁移的已有凭据。";
    return "";
  };

  const goToModels = () => {
    const message = validateCredentials();
    if (message) { setError(message); return; }
    setError("");
    setStep(3);
  };

  const save = async (setDefault) => {
    const message = validateCredentials();
    if (message) { setError(message); setStep(2); return; }
    if (!form.models.some((model) => model.id.trim())) { setError("至少填写一个模型 ID。"); return; }
    setSaving(true);
    setError("");
    const payload = {
      providerId: form.providerId.trim(),
      baseUrl: form.baseUrl.trim(),
      api: form.api,
      credential: {
        mode: form.credentialMode,
        apiKey: form.credentialMode === "new" ? form.apiKey : undefined,
        fromProvider: form.credentialMode === "migrate" ? form.migrateFrom : undefined,
        move: form.moveCredential,
      },
      models: form.models.filter((model) => model.id.trim()).map((model) => ({
        id: model.id.trim(),
        name: model.name || model.id.trim(),
        contextWindow: Number(model.contextWindow),
        maxTokens: Number(model.maxTokens),
        supportsImages: model.supportsImages,
        reasoning: model.maximumThinking !== "off",
        maximumThinking: model.maximumThinking,
        api: model.api === "inherit" ? undefined : model.api,
        forceAdaptiveThinking: model.forceAdaptiveThinking,
      })),
      setDefault,
      defaultModelId: form.defaultModelId || form.models[0]?.id,
      defaultThinkingLevel: form.defaultThinkingLevel,
      compat: form.compat,
    };
    try {
      if (demoMode) {
        await new Promise((resolve) => setTimeout(resolve, 500));
        setToast("演示模式：配置校验通过");
        return;
      }
      const response = await fetch("/api/providers", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(payload) });
      const data = await response.json();
      if (!response.ok) throw new Error(data.error || "保存失败");
      setState(data.state);
      const saved = data.state.providers.find((provider) => provider.id === payload.providerId);
      if (saved) { setSelectedId(saved.id); setForm(providerToForm(saved, data.state)); }
      setToast(setDefault ? "已保存并设为 Pi 默认模型" : "供应商配置已保存");
    } catch (requestError) {
      setError(requestError.message);
    } finally {
      setSaving(false);
      setTimeout(() => setToast(""), 3000);
    }
  };

  return (
    <main className="app-shell">
      <Sidebar state={state} selectedId={selectedId} onSelect={selectProvider} onAdd={startNew} />
      <section className="workspace">
        <Stepper step={step} onStep={setStep} />
        {loading ? <div className="loading-state">正在读取 Pi 配置…</div> : step === 1 ? <ProtocolStep form={form} setForm={setForm} onNext={() => setStep(2)} /> : step === 2 ? <CredentialsStep form={form} setForm={setForm} state={state} error={error} onBack={() => setStep(1)} onNext={goToModels} /> : <ModelsStep form={form} setForm={setForm} error={error} saving={saving} onBack={() => setStep(2)} onSave={save} />}
      </section>
      {toast && <div className="toast"><CheckCircle size={21} weight="fill" />{toast}</div>}
    </main>
  );
}
