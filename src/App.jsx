import { useEffect, useMemo, useState } from "react";
import {
  ArrowLeft,
  ArrowRight,
  Asterisk,
  Brain,
  CaretDown,
  ChatCircleDots,
  CheckCircle,
  Copy,
  Cube,
  Gear,
  GoogleLogo,
  ImageSquare,
  Info,
  Key,
  ListPlus,
  OpenAiLogo,
  Plus,
  Question,
  ShieldCheck,
  SlidersHorizontal,
  Stack,
  TerminalWindow,
  Trash,
  UploadSimple,
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
  agentDir: "~/.pi/agent",
  compatibility: { appVersion: "0.1.1", piVersion: "0.84.2", configMode: "preserve-unknown-fields" },
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

function Sidebar({ state, selectedId, onSelect, onAdd, onSettings, activeView }) {
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
      <button type="button" className={`settings-button ${activeView === "settings" ? "is-active" : ""}`} onClick={onSettings}><Gear size={20} />设置与兼容性</button>
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
  const [showBulk, setShowBulk] = useState(false);
  const [bulkText, setBulkText] = useState("");
  const updateModel = (rowId, value) => setForm((current) => ({ ...current, models: current.models.map((model) => model.rowId === rowId ? value : model) }));
  const addModel = () => setForm((current) => ({ ...current, models: [...current.models, blankModel()], defaultModelId: current.defaultModelId || current.models[0]?.id || "" }));
  const removeModel = (rowId) => setForm((current) => {
    const models = current.models.filter((model) => model.rowId !== rowId);
    return { ...current, models, defaultModelId: models.some((model) => model.id === current.defaultModelId) ? current.defaultModelId : models[0]?.id || "" };
  });
  const importModels = () => {
    const ids = [...new Set(bulkText.split(/\r?\n|,/).map((value) => value.trim()).filter(Boolean))];
    if (ids.length === 0) return;
    setForm((current) => {
      const existingIds = new Set(current.models.map((model) => model.id).filter(Boolean));
      const additions = ids.filter((id) => !existingIds.has(id)).map((id) => blankModel(id));
      const hasOnlyBlank = current.models.length === 1 && !current.models[0].id;
      const models = [...(hasOnlyBlank ? [] : current.models), ...additions];
      return { ...current, models, defaultModelId: current.defaultModelId || models[0]?.id || "" };
    });
    setBulkText("");
    setShowBulk(false);
  };
  const thinkingAliasModels = form.models.filter((model) => /-(max|xhigh)$/i.test(model.id));
  const currentApi = apiMeta(form.api);
  return (
    <section className="step-content models-step">
      <div className="section-heading"><div><h1>确认并选择可用模型</h1><p>一个 API 网关可以添加多个不同厂商的模型，并指定 Pi 默认使用哪个。</p></div><span className="help-link"><Question size={19} />不知道？使用安全默认值</span></div>
      <div className="gateway-summary">
        <span className="summary-icon"><ProviderIcon api={form.api} size={34} /></span>
        <div><strong>{titleFromId(form.providerId || "new-provider")}</strong><span className="protocol-badge">{currentApi.title}</span><p>API 地址　{form.baseUrl || "尚未填写"}</p></div>
        <div className="saved-credential"><ShieldCheck size={29} weight="duotone" /><span><strong>凭据已安全保存</strong><small>浏览器无法读取旧 key</small></span></div>
      </div>
      <div className="models-header"><div><h2>模型列表</h2><p>Pi 以 provider/model 选择模型，thinking level 是独立设置。</p></div><div className="models-actions"><button type="button" className="secondary-button compact-button" onClick={() => setShowBulk(true)}><ListPlus size={18} />批量添加</button><button type="button" className="outline-button" onClick={addModel}><Plus size={19} />添加模型</button></div></div>
      {thinkingAliasModels.length > 0 && <div className="model-warning"><WarningCircle size={20} weight="fill" /><span><strong>发现疑似思考档位后缀：</strong>{thinkingAliasModels.map((model) => model.id).join("、")}。只有网关真的把它们作为模型 ID 时才应保留；否则用右侧“推理能力”和 Pi 的 Shift+Tab 切换。</span></div>}
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
      {showBulk && <div className="modal-backdrop" role="presentation"><section className="bulk-modal" role="dialog" aria-modal="true" aria-labelledby="bulk-title"><div className="modal-heading"><div><h2 id="bulk-title">批量添加模型 ID</h2><p>每行一个，也可以用英文逗号分隔。重复项会自动忽略。</p></div><UploadSimple size={28} weight="duotone" /></div><textarea autoFocus value={bulkText} onChange={(event) => setBulkText(event.target.value)} placeholder={"anthropic/claude-opus\nopenai/gpt-5.6-sol\ngoogle/gemini-pro"} /><div className="modal-actions"><button type="button" className="secondary-button" onClick={() => setShowBulk(false)}>取消</button><button type="button" className="primary-button" onClick={importModels}>导入模型</button></div></section></div>}
    </section>
  );
}

function SuccessScreen({ result, onCopy, onReturn, onAdd }) {
  return (
    <section className="success-page">
      <div className="success-mark"><CheckCircle size={72} weight="fill" /></div>
      <p className="success-eyebrow">配置已写入 Pi</p>
      <h1>{titleFromId(result.providerId)} 已保存</h1>
      <p className="success-summary">Pi 已识别 {result.modelCount} 个模型，默认模型是 <strong>{result.defaultModelId}</strong>。</p>
      <div className="next-step-card">
        <div className="next-step-heading"><TerminalWindow size={28} weight="duotone" /><div><h2>下一步：在 Pi 中验证模型</h2><p>无需重启。回到 Pi 打开 <code>/model</code>，或直接运行下面的命令。</p></div></div>
        <div className="command-row"><code>{result.command}</code><button type="button" className="copy-button" onClick={() => onCopy(result.command)}><Copy size={18} />复制</button></div>
        <ol>
          <li>选择刚保存的 <strong>{result.defaultModelId}</strong></li>
          <li>确认底部显示 provider 为 <strong>{result.providerId}</strong></li>
          <li>发送一句简单测试消息；通道限流或 500 属于上游服务状态，不代表配置文件未保存</li>
        </ol>
      </div>
      <div className="success-actions"><button type="button" className="secondary-button" onClick={onAdd}><Plus size={18} />添加另一个网关</button><button type="button" className="primary-button" onClick={onReturn}>返回供应商详情<ArrowRight size={19} /></button></div>
    </section>
  );
}

function SettingsScreen({ state, saving, error, onSave, onBack }) {
  const initialProvider = state.settings.defaultProvider || state.providers[0]?.id || "";
  const [draft, setDraft] = useState({
    defaultProvider: initialProvider,
    defaultModel: state.settings.defaultModel || "",
    defaultThinkingLevel: state.settings.defaultThinkingLevel || "medium",
    hideThinkingBlock: Boolean(state.settings.hideThinkingBlock),
    transport: state.settings.transport || "auto",
  });
  useEffect(() => {
    setDraft({
      defaultProvider: state.settings.defaultProvider || state.providers[0]?.id || "",
      defaultModel: state.settings.defaultModel || "",
      defaultThinkingLevel: state.settings.defaultThinkingLevel || "medium",
      hideThinkingBlock: Boolean(state.settings.hideThinkingBlock),
      transport: state.settings.transport || "auto",
    });
  }, [state]);
  const selectedProvider = state.providers.find((provider) => provider.id === draft.defaultProvider);
  const availableModels = selectedProvider?.models || [];
  const changeProvider = (providerId) => {
    const provider = state.providers.find((item) => item.id === providerId);
    setDraft((current) => ({ ...current, defaultProvider: providerId, defaultModel: provider?.models?.[0]?.id || "" }));
  };
  return (
    <section className="settings-page">
      <div className="settings-title"><div><p>真实设置</p><h1>设置与兼容性</h1><span>这里的修改会写入 Pi 的 settings.json。</span></div><button type="button" className="secondary-button" onClick={onBack}><ArrowLeft size={18} />返回</button></div>
      <div className="settings-grid">
        <section className="settings-card">
          <h2>默认模型</h2><p>Pi 启动新会话时优先使用这里的 provider/model。</p>
          <label><span>默认供应商</span><select value={draft.defaultProvider} onChange={(event) => changeProvider(event.target.value)}>{state.providers.filter((provider) => provider.models.length > 0).map((provider) => <option key={provider.id} value={provider.id}>{titleFromId(provider.id)} ({provider.id})</option>)}</select></label>
          <label><span>默认模型</span><select value={draft.defaultModel} onChange={(event) => setDraft((current) => ({ ...current, defaultModel: event.target.value }))}>{availableModels.map((model) => <option key={model.id} value={model.id}>{model.name || model.id}</option>)}</select></label>
          <label><span>默认思考强度</span><select value={draft.defaultThinkingLevel} onChange={(event) => setDraft((current) => ({ ...current, defaultThinkingLevel: event.target.value }))}>{["off", "minimal", "low", "medium", "high", "xhigh", "max"].map((level) => <option key={level} value={level}>{level}</option>)}</select></label>
        </section>
        <section className="settings-card">
          <h2>会话行为</h2><p>这些选项由 Pi 官方 settings.json 支持。</p>
          <label><span>传输方式</span><select value={draft.transport} onChange={(event) => setDraft((current) => ({ ...current, transport: event.target.value }))}><option value="auto">自动选择</option><option value="sse">SSE</option><option value="websocket">WebSocket</option></select></label>
          <label className="setting-toggle"><input type="checkbox" checked={draft.hideThinkingBlock} onChange={(event) => setDraft((current) => ({ ...current, hideThinkingBlock: event.target.checked }))} /><span><strong>隐藏 thinking 内容块</strong><small>只隐藏显示，不会关闭模型推理。</small></span></label>
        </section>
        <section className="settings-card compatibility-card">
          <h2>兼容状态</h2><dl><div><dt>Pi 版本</dt><dd>{state.compatibility?.piVersion || "unknown"}</dd></div><div><dt>管理器版本</dt><dd>{state.compatibility?.appVersion || "0.1.1"}</dd></div><div><dt>配置策略</dt><dd>保留未知字段</dd></div><div><dt>配置目录</dt><dd title={state.agentDir}>{state.agentDir}</dd></div></dl>
          <p className="compat-note"><ShieldCheck size={20} weight="duotone" />Pi 更新后若出现新字段，本程序会保留未识别字段；涉及字段改名或 API 类型变化时仍需发布兼容更新。</p>
        </section>
      </div>
      {error && <div className="error-banner"><WarningCircle size={20} weight="fill" />{error}</div>}
      <footer className="settings-footer"><button type="button" className="primary-button" disabled={saving || !draft.defaultModel} onClick={() => onSave(draft)}>{saving ? "正在保存…" : "保存设置"}</button></footer>
    </section>
  );
}

export function App() {
  const demoMode = useMemo(() => new URLSearchParams(window.location.search).get("demo") === "1", []);
  const [state, setState] = useState(demoMode ? DEMO_STATE : { providers: [], authProviders: [], settings: {}, compatibility: {}, agentDir: "" });
  const [loading, setLoading] = useState(!demoMode);
  const [selectedId, setSelectedId] = useState(demoMode ? "any-claude" : "");
  const [step, setStep] = useState(demoMode ? 3 : 1);
  const [view, setView] = useState("wizard");
  const [form, setForm] = useState(() => demoMode ? providerToForm(DEMO_STATE.providers[0], DEMO_STATE) : blankForm());
  const [error, setError] = useState("");
  const [saving, setSaving] = useState(false);
  const [toast, setToast] = useState("");
  const [saveResult, setSaveResult] = useState(null);

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
    setView("wizard");
    setError("");
  };

  const selectProvider = (provider) => {
    setForm(providerToForm(provider, state));
    setSelectedId(provider.id);
    setStep(provider.models.length > 0 ? 3 : 1);
    setView("wizard");
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
        api: model.api,
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
        const demoProvider = {
          id: payload.providerId,
          name: titleFromId(payload.providerId),
          baseUrl: payload.baseUrl,
          api: payload.api,
          credentialConfigured: true,
          isDefault: true,
          compat: payload.compat || {},
          models: payload.models.map((model) => ({
            id: model.id,
            name: model.name,
            contextWindow: model.contextWindow,
            maxTokens: model.maxTokens,
            input: model.supportsImages ? ["text", "image"] : ["text"],
            reasoning: model.reasoning,
            api: model.api === "inherit" ? undefined : model.api,
          })),
        };
        const demoState = {
          ...state,
          providers: [...state.providers.filter((provider) => provider.id !== payload.providerId).map((provider) => ({ ...provider, isDefault: false })), demoProvider],
          authProviders: [...new Set([...state.authProviders, payload.providerId])],
          settings: { ...state.settings, defaultProvider: payload.providerId, defaultModel: payload.defaultModelId, defaultThinkingLevel: payload.defaultThinkingLevel },
        };
        setState(demoState);
        setSelectedId(payload.providerId);
        setForm(providerToForm(demoProvider, demoState));
        const result = {
          providerId: payload.providerId,
          modelCount: payload.models.length,
          defaultModelId: payload.defaultModelId,
          defaultThinkingLevel: payload.defaultThinkingLevel,
          command: `pi --model ${payload.providerId}/${payload.defaultModelId}:${payload.defaultThinkingLevel}`,
        };
        setSaveResult(result);
        setView("success");
        return;
      }
      const response = await fetch("/api/providers", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(payload) });
      const data = await response.json();
      if (!response.ok) throw new Error(data.error || "保存失败");
      setState(data.state);
      const saved = data.state.providers.find((provider) => provider.id === payload.providerId);
      if (saved) { setSelectedId(saved.id); setForm(providerToForm(saved, data.state)); }
      setSaveResult({
        providerId: payload.providerId,
        modelCount: payload.models.length,
        defaultModelId: payload.defaultModelId,
        defaultThinkingLevel: payload.defaultThinkingLevel,
        command: `pi --model ${payload.providerId}/${payload.defaultModelId}:${payload.defaultThinkingLevel}`,
      });
      setView("success");
    } catch (requestError) {
      setError(requestError.message);
    } finally {
      setSaving(false);
    }
  };

  const saveSettings = async (draft) => {
    setSaving(true);
    setError("");
    try {
      if (demoMode) {
        await new Promise((resolve) => setTimeout(resolve, 350));
        setState((current) => ({ ...current, settings: { ...current.settings, ...draft } }));
        setToast("演示模式：设置校验通过");
      } else {
        const response = await fetch("/api/settings", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(draft) });
        const data = await response.json();
        if (!response.ok) throw new Error(data.error || "保存设置失败");
        setState(data.state);
        setToast("Pi 设置已保存");
      }
      setTimeout(() => setToast(""), 2600);
    } catch (requestError) {
      setError(requestError.message);
    } finally {
      setSaving(false);
    }
  };

  const copyCommand = async (command) => {
    try {
      await navigator.clipboard.writeText(command);
      setToast("启动命令已复制");
    } catch {
      setToast(command);
    }
    setTimeout(() => setToast(""), 2600);
  };

  const returnToSavedProvider = () => {
    const provider = state.providers.find((item) => item.id === saveResult?.providerId);
    if (provider) selectProvider(provider);
    else setView("wizard");
  };

  return (
    <main className="app-shell">
      <Sidebar state={state} selectedId={selectedId} onSelect={selectProvider} onAdd={startNew} onSettings={() => { setView("settings"); setError(""); }} activeView={view} />
      <section className="workspace">
        {loading ? <div className="loading-state">正在读取 Pi 配置…</div> : view === "settings" ? <SettingsScreen state={state} saving={saving} error={error} onSave={saveSettings} onBack={() => setView("wizard")} /> : view === "success" && saveResult ? <SuccessScreen result={saveResult} onCopy={copyCommand} onReturn={returnToSavedProvider} onAdd={startNew} /> : <><Stepper step={step} onStep={setStep} />{step === 1 ? <ProtocolStep form={form} setForm={setForm} onNext={() => setStep(2)} /> : step === 2 ? <CredentialsStep form={form} setForm={setForm} state={state} error={error} onBack={() => setStep(1)} onNext={goToModels} /> : <ModelsStep form={form} setForm={setForm} error={error} saving={saving} onBack={() => setStep(2)} onSave={save} />}</>}
      </section>
      {toast && <div className="toast"><CheckCircle size={21} weight="fill" />{toast}</div>}
    </main>
  );
}
