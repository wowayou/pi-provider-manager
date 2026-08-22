import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import {
  ArrowLeft,
  ArrowRight,
  Asterisk,
  CaretDown,
  ChatCircleDots,
  Check,
  CheckCircle,
  CircleNotch,
  Copy,
  Cube,
  Desktop,
  FileText,
  Gear,
  GoogleLogo,
  Info,
  Key,
  ListPlus,
  LockSimple,
  MagnifyingGlass,
  Moon,
  OpenAiLogo,
  Plugs,
  PlugsConnected,
  Plus,
  Question,
  ShieldCheck,
  SlidersHorizontal,
  Stack,
  Sun,
  TerminalWindow,
  Trash,
  WarningCircle,
  X,
} from "@phosphor-icons/react";
import { changedPersistedModel, selectedNamedModel } from "./model-draft.mjs";
import { PromptsScreen } from "./prompts-view.jsx";
import { BulkModal, Spinner, createRadioKeyHandler, readApiResponse, titleFromId } from "./ui-kit.jsx";
import {
  CodexDeleteDialog,
  CodexSettingsScreen,
  CodexStepper,
  CodexSuccessScreen,
  CodexWizard,
  blankCodexForm,
  codexProviderToForm,
  isLocalAddress,
} from "./codex-view.jsx";

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

const THEME_KEY = "ppm-theme";
const THEME_OPTIONS = [
  { value: "system", label: "跟随系统", icon: Desktop },
  { value: "light", label: "浅色", icon: Sun },
  { value: "dark", label: "深色", icon: Moon },
];

function readStoredTheme() {
  try {
    const stored = localStorage.getItem(THEME_KEY);
    return stored === "dark" || stored === "light" ? stored : "system";
  } catch {
    return "system";
  }
}

function useTheme() {
  const [theme, setTheme] = useState(readStoredTheme);
  useEffect(() => {
    const media = window.matchMedia("(prefers-color-scheme: dark)");
    const apply = () => {
      const resolved = theme === "system" ? (media.matches ? "dark" : "light") : theme;
      document.documentElement.dataset.theme = resolved;
    };
    apply();
    try {
      if (theme === "system") localStorage.removeItem(THEME_KEY);
      else localStorage.setItem(THEME_KEY, theme);
    } catch { /* storage blocked: the choice just will not persist */ }
    if (theme !== "system") return undefined;
    media.addEventListener("change", apply);
    return () => media.removeEventListener("change", apply);
  }, [theme]);
  return [theme, setTheme];
}

function ThemeSwitch({ theme, onTheme }) {
  const buttonRefs = useRef([]);
  const selectedIndex = Math.max(0, THEME_OPTIONS.findIndex((option) => option.value === theme));
  const onKeyDown = createRadioKeyHandler({
    refs: buttonRefs,
    values: THEME_OPTIONS.map((option) => option.value),
    selectedIndex,
    onSelect: onTheme,
  });
  return (
    <div className="theme-toggle">
      <span>外观</span>
      <div className="theme-switch" role="radiogroup" aria-label="外观" onKeyDown={onKeyDown}>
        {THEME_OPTIONS.map((option, index) => {
          const Icon = option.icon;
          return (
            <button
              key={option.value}
              type="button"
              ref={(node) => { buttonRefs.current[index] = node; }}
              role="radio"
              aria-checked={theme === option.value}
              tabIndex={index === selectedIndex ? 0 : -1}
              aria-label={option.label}
              title={option.label}
              onClick={() => onTheme(option.value)}
            >
              <Icon size={16} weight={theme === option.value ? "fill" : "regular"} />
            </button>
          );
        })}
      </div>
    </div>
  );
}

function safeDefaults(modelId = "") {
  if (modelId === "gpt-5.6-sol") return { contextWindow: 1_050_000, maxTokens: 128_000 };
  return { contextWindow: 128_000, maxTokens: 16_384 };
}

function blankModel(id = "") {
  const limits = safeDefaults(id);
  return {
    rowId: crypto.randomUUID(),
    persistedId: "",
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
  const firstModel = blankModel("gpt-5.6-sol");
  return {
    providerId: "",
    baseUrl: "",
    api: "openai-responses",
    credentialMode: "new",
    apiKey: "",
    migrateFrom: "",
    moveCredential: true,
    models: [firstModel],
    // Keyed by row, not by model id: the id is an editable field, and keying on it
    // silently dropped the default the moment a user corrected a typo.
    defaultRowId: firstModel.rowId,
    defaultThinkingLevel: "high",
    compat: {},
  };
}

const DEMO_PROMPT_LIMITS = { maxBytes: 262144, maxDocuments: 50 };
function demoSlot(id, file, note, documents, activeId) {
  return { id, file, path: `…/${file}`, label: file, note, present: documents.length > 0, activeId, adoptedId: "", documents, };
}

const DEMO_STATE = {
  agentDir: "~/.pi/agent",
  prompts: {
    pi: {
      dir: "~/.pi/agent",
      revision: "",
      limits: DEMO_PROMPT_LIMITS,
      slots: [
        demoSlot("agents", "AGENTS.md", "与父目录、当前目录的 AGENTS.md 拼接后一起送给模型。", [
          { id: "chinese", name: "中文优先", text: "# 我的规则\n\n始终使用中文回复。\n提交前先跑测试。\n", adopted: false, isActive: true },
          { id: "english", name: "English", text: "Answer in English.\n", adopted: false, isActive: false },
        ], "chinese"),
        demoSlot("system", "SYSTEM.md", "整体替换默认系统提示。写错会影响 Pi 的全部行为。", [], ""),
        demoSlot("append-system", "APPEND_SYSTEM.md", "追加在默认系统提示之后，不替换它。", [
          { id: "safety", name: "安全守则", text: "永远不要提交密钥。\n", adopted: false, isActive: true },
        ], "safety"),
      ],
    },
    codex: {
      dir: "~/.codex",
      revision: "",
      limits: DEMO_PROMPT_LIMITS,
      slots: [
        demoSlot("agents", "AGENTS.md", "与项目里的 AGENTS.md 拼接后一起送给模型。", [
          { id: "default", name: "默认", text: "# Codex\n\n改动要小而可复核。\n", adopted: false, isActive: true },
        ], "default"),
      ],
    },
  },
  compatibility: { appVersion: __APP_VERSION__, piVersion: __PI_VALIDATED_VERSION__, validatedPiVersion: __PI_VALIDATED_VERSION__, codexVersion: __CODEX_VALIDATED_VERSION__, validatedCodexVersion: __CODEX_VALIDATED_VERSION__, configMode: "preserve-unknown-fields", configDirSource: "default-home", nodeVersion: "v22.0.0", serviceHost: "127.0.0.1", servicePort: 43127 },
  authProviders: ["any-claude", "openai", "deepseek", "moonshot", "qwen", "gemini", "minimax"],
  codex: {
    available: true,
    dir: "~/.codex",
    dirSource: "default-home",
    revision: "",
    ownedProviderId: "custom",
    activeProviderId: "packy",
    settings: { model: "gpt-5.6-sol", modelProvider: "custom", reasoningEffort: "high", planModeReasoningEffort: "xhigh", verbosity: "medium", contextWindow: 0, disableResponseStorage: false },
    settingsPresent: ["model", "model_provider", "model_reasoning_effort"],
    providers: [
      { id: "packy", name: "PackyCode", baseUrl: "https://api.packycode.com/v1", requiresAuth: true, models: [{ id: "gpt-5.6-sol", reasoningEffort: "high" }, { id: "gpt-5.1-codex", reasoningEffort: "xhigh" }], defaultModelId: "gpt-5.6-sol", credentialConfigured: true, adopted: false, isActive: true },
      { id: "kimi", name: "Kimi", baseUrl: "https://api.moonshot.cn/v1", requiresAuth: true, models: [{ id: "kimi-k2.6", reasoningEffort: "medium" }], defaultModelId: "kimi-k2.6", credentialConfigured: true, adopted: false, isActive: false },
      { id: "deepseek-relay", name: "DeepSeek via relay", baseUrl: "http://127.0.0.1:4446/v1", requiresAuth: false, models: [{ id: "deepseek-reasoner", reasoningEffort: "high" }], defaultModelId: "deepseek-reasoner", credentialConfigured: false, adopted: false, isActive: false },
    ],
  },
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
        persistedId: model.id,
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
    defaultRowId: (
      convertedModels.find((model) => state.settings.defaultProvider === provider.id && model.id === state.settings.defaultModel)
      || convertedModels[0]
    ).rowId,
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
            aria-current={number === step ? "step" : undefined}
            title={number < step ? "回到这一步" : number > step ? "完成当前步骤后可用" : undefined}
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

const TARGET_OPTIONS = [
  { value: "pi", label: "Pi" },
  { value: "codex", label: "Codex" },
];

// One list component for both targets. Each target maps its own provider shape
// onto the same row vocabulary so the navigation stays identical.
function sidebarProviders(state, target) {
  if (target === "codex") {
    return (state.codex?.providers || []).map((provider) => ({
      id: provider.id,
      name: provider.name || titleFromId(provider.id),
      keywords: `${provider.id} ${provider.name || ""} ${provider.baseUrl}`,
      // Whether a managed bridge exists is a fact this manager owns, so it is
      // stated. A merely loopback address is a weaker fact and says so; neither
      // is the guess the old `upstream` field used to make.
      subtitle: `${provider.models.length} 个模型 · ${provider.bridge ? "托管桥" : isLocalAddress(provider.baseUrl) ? "本机地址" : "Responses"}`,
      ready: provider.credentialConfigured || provider.requiresAuth === false,
      readyLabel: "凭据已配置",
      notReadyLabel: "未配置凭据",
      badge: provider.isActive ? "生效中" : "",
      icon: provider.bridge || isLocalAddress(provider.baseUrl) ? Plugs : PlugsConnected,
      source: provider,
    }));
  }
  return state.providers.map((provider) => ({
    id: provider.id,
    name: provider.name || titleFromId(provider.id),
    keywords: `${provider.id} ${provider.name || ""} ${apiMeta(provider.api).short}`,
    subtitle: `${provider.models.length} 个模型 · ${apiMeta(provider.api).short}`,
    ready: provider.credentialConfigured,
    readyLabel: "凭据已配置",
    notReadyLabel: "未配置凭据",
    // The Pi sidebar keeps the look it already had; the default provider is
    // already marked inside the workspace.
    badge: "",
    icon: apiMeta(provider.api).icon,
    source: provider,
  }));
}

function TargetSwitch({ target, onTarget }) {
  const buttonRefs = useRef([]);
  const selectedIndex = Math.max(0, TARGET_OPTIONS.findIndex((option) => option.value === target));
  const onKeyDown = createRadioKeyHandler({
    refs: buttonRefs,
    values: TARGET_OPTIONS.map((option) => option.value),
    selectedIndex,
    onSelect: onTarget,
  });
  return (
    <div className="target-switch" role="radiogroup" aria-label="配置目标" onKeyDown={onKeyDown}>
      {TARGET_OPTIONS.map((option, index) => (
        <button
          key={option.value}
          type="button"
          ref={(node) => { buttonRefs.current[index] = node; }}
          role="radio"
          aria-checked={target === option.value}
          tabIndex={index === selectedIndex ? 0 : -1}
          onClick={() => onTarget(option.value)}
        >
          {option.label}
        </button>
      ))}
    </div>
  );
}

function Sidebar({ state, target, onTarget, selectedId, onSelect, onAdd, onSettings, onPrompts, activeView, theme, onTheme }) {
  const [query, setQuery] = useState("");
  const providers = sidebarProviders(state, target);
  const keyword = query.trim().toLowerCase();
  const visible = keyword ? providers.filter((provider) => provider.keywords.toLowerCase().includes(keyword)) : providers;
  const isCodex = target === "codex";
  return (
    <aside className="sidebar">
      <div className="brand">
        <span className="brand-icon"><img src="/favicon.png" alt="" /></span>
        <span>Pi Provider Manager</span>
      </div>
      <TargetSwitch target={target} onTarget={(value) => { setQuery(""); onTarget(value); }} />
      <button type="button" className="add-provider" onClick={() => { setQuery(""); onAdd(); }}>
        <Plus size={22} weight="bold" />添加供应商
      </button>
      <p className="sidebar-label">
        {isCodex ? "Codex 供应商" : "我的供应商 / API 网关"}
        {providers.length > 0 && <span className="count-pill">{providers.length}</span>}
      </p>
      {providers.length > 6 && (
        <div className="provider-search">
          <MagnifyingGlass size={16} aria-hidden="true" />
          <input
            type="search"
            value={query}
            onChange={(event) => setQuery(event.target.value)}
            placeholder="筛选供应商"
            aria-label="筛选供应商"
            spellCheck={false}
          />
        </div>
      )}
      <nav className="provider-list" aria-label="供应商列表">
        {visible.map((provider) => {
          const Icon = provider.icon;
          const isSelected = selectedId === provider.id && activeView === "wizard";
          return (
            <button
              type="button"
              key={provider.id}
              className={`provider-item ${isSelected ? "is-selected" : ""}`}
              onClick={() => onSelect(provider.source)}
              aria-current={isSelected ? "true" : undefined}
              title={`${provider.name} · ${provider.id}`}
            >
              <span className="provider-icon"><Icon size={23} weight="duotone" aria-hidden="true" /></span>
              <span className="provider-copy">
                <strong>{provider.name}</strong>
                <small>{provider.subtitle}</small>
              </span>
              <span className="provider-badge">{provider.badge}</span>
              {provider.ready ? (
                <CheckCircle className="status-ok" size={18} weight="fill" aria-label={provider.readyLabel} />
              ) : (
                <WarningCircle className="status-warn" size={18} weight="fill" aria-label={provider.notReadyLabel} />
              )}
            </button>
          );
        })}
        {providers.length === 0 && (
          <p className="list-empty">
            {isCodex
              ? "还没有 Codex 供应商。点击上面的“添加供应商”，三步就能接上一个网关。"
              : "还没有供应商。点击上面的“添加供应商”，三步就能接上一个网关。"}
          </p>
        )}
        {providers.length > 0 && visible.length === 0 && (
          <p className="list-empty">没有名称或 ID 包含“{query.trim()}”的供应商。</p>
        )}
      </nav>
      <div className="beginner-tip">
        <Info size={22} weight="duotone" />
        <div>
          <strong>新手提示</strong>
          <span>{isCodex ? "Codex 只保留一个生效供应商，切换只影响新开的会话。" : "一个 API 网关可以添加多个不同厂商的模型。"}</span>
        </div>
      </div>
      <button type="button" className={`settings-button nav-prompts ${activeView === "prompts" ? "is-active" : ""}`} onClick={onPrompts}><FileText size={20} />提示词</button>
      <button type="button" className={`settings-button nav-settings ${activeView === "settings" ? "is-active" : ""}`} onClick={onSettings}><Gear size={20} />设置与兼容性</button>
      <ThemeSwitch theme={theme} onTheme={onTheme} />
    </aside>
  );
}

function ProtocolStep({ form, setForm, onNext }) {
  const [showHint, setShowHint] = useState(false);
  const cardRefs = useRef([]);
  const selectedIndex = Math.max(0, API_OPTIONS.findIndex((option) => option.id === form.api));
  const choose = (optionId) => setForm((current) => {
    const hasOnlyGptPreset = current.models.length === 1 && current.models[0].id === "gpt-5.6-sol";
    if (optionId !== "openai-responses" && hasOnlyGptPreset) {
      const replacement = blankModel();
      return { ...current, api: optionId, models: [replacement], defaultRowId: replacement.rowId };
    }
    return { ...current, api: optionId };
  });
  const onKeyDown = createRadioKeyHandler({
    refs: cardRefs,
    values: API_OPTIONS.map((option) => option.id),
    selectedIndex,
    onSelect: choose,
  });
  return (
    <section className="step-content">
      <div className="step-scroll">
        <div className="section-heading">
          <div><h1>选择网关的默认接口协议</h1><p>供应商类似 OpenRouter：先选默认协议，下面可以挂多个模型。</p></div>
          <button type="button" className="help-link" aria-expanded={showHint} onClick={() => setShowHint((value) => !value)}>
            <Question size={19} />不确定选哪个？
          </button>
        </div>
        {showHint && (
          <div className="hint-panel">
            <p>打开供应商文档，看接口路径的结尾：</p>
            <ul>
              <li><code>/responses</code> → OpenAI Responses</li>
              <li><code>/chat/completions</code> → OpenAI Chat</li>
              <li><code>/messages</code> → Anthropic Messages</li>
              <li><code>:generateContent</code> → Google Gemini</li>
            </ul>
            <p>仍然不确定就先选 OpenAI Chat，多数网关都兼容；之后随时可以改。</p>
          </div>
        )}
        <div className="protocol-grid" role="radiogroup" aria-label="接口协议" onKeyDown={onKeyDown}>
          {API_OPTIONS.map((option, index) => {
            const Icon = option.icon;
            const isSelected = form.api === option.id;
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
        <div className="safe-note"><ShieldCheck size={22} weight="duotone" />高级参数会自动使用安全默认值，无需在这里配置。</div>
      </div>
      <footer className="wizard-footer"><span /><button type="button" className="primary-button" onClick={onNext}>下一步<ArrowRight size={19} /></button></footer>
    </section>
  );
}

function CredentialsStep({ form, setForm, state, error, onBack, onNext }) {
  const sources = state.authProviders.filter((id) => id !== form.providerId);
  return (
    <section className="step-content form-step">
      <div className="step-scroll">
        <div className="section-heading"><div><h1>填写网关地址与凭据</h1><p>key 只会写入 Pi 的 auth.json，保存后不会再显示。</p></div></div>
        <div className="form-grid">
          <label><span>供应商 ID</span><small>例如 any-router；用于 Pi 内部识别</small><input className="mono" value={form.providerId} onChange={(event) => setForm((current) => {
            const providerId = event.target.value.toLowerCase().replace(/\s+/g, "-");
            // "keep" only means something while the id still names a stored credential.
            const keepStillValid = state.authProviders.includes(providerId);
            return { ...current, providerId, credentialMode: current.credentialMode === "keep" && !keepStillValid ? "new" : current.credentialMode };
          })} placeholder="any-router" spellCheck={false} autoCapitalize="off" autoCorrect="off" autoComplete="off" /></label>
          <label><span>API 地址</span><small>填写接口根地址，不要包含具体模型路径</small><input className="mono" type="url" inputMode="url" value={form.baseUrl} onChange={(event) => setForm((current) => ({ ...current, baseUrl: event.target.value }))} placeholder="https://api.example.com/v1" spellCheck={false} autoCapitalize="off" autoCorrect="off" autoComplete="off" /></label>
        </div>
        <fieldset className="credential-box">
          <legend>访问凭据</legend>
          <div className="credential-tabs">
            {state.authProviders.includes(form.providerId) && <button type="button" className={form.credentialMode === "keep" ? "is-active" : ""} onClick={() => setForm((current) => ({ ...current, credentialMode: "keep" }))}>保留现有 key</button>}
            <button type="button" className={form.credentialMode === "new" ? "is-active" : ""} onClick={() => setForm((current) => ({ ...current, credentialMode: "new" }))}>输入新 key</button>
            {sources.length > 0 && <button type="button" className={form.credentialMode === "migrate" ? "is-active" : ""} onClick={() => setForm((current) => ({ ...current, credentialMode: "migrate", migrateFrom: current.migrateFrom || sources[0] }))}>从已有凭据迁移</button>}
          </div>
          {form.credentialMode === "keep" && <div className="credential-status"><ShieldCheck size={24} weight="duotone" /><div><strong>凭据已安全保存</strong><span>浏览器无法读取已保存的 key。</span></div></div>}
          {form.credentialMode === "new" && <label className="key-field"><span>API Key</span><div><Key size={20} /><input className="mono" type="password" autoComplete="new-password" value={form.apiKey} onChange={(event) => setForm((current) => ({ ...current, apiKey: event.target.value }))} placeholder="输入后不会回显" /></div></label>}
          {form.credentialMode === "migrate" && <div className="migrate-fields"><label><span>选择已有供应商</span><select value={form.migrateFrom} onChange={(event) => setForm((current) => ({ ...current, migrateFrom: event.target.value }))}>{sources.map((id) => <option key={id} value={id}>{titleFromId(id)} ({id})</option>)}</select></label><label className="checkbox-row"><input type="checkbox" checked={form.moveCredential} onChange={(event) => setForm((current) => ({ ...current, moveCredential: event.target.checked }))} />迁移成功后删除旧条目</label></div>}
        </fieldset>
        {error && <div className="error-banner" role="alert"><WarningCircle size={20} weight="fill" />{error}</div>}
      </div>
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

// A bare decimal is always a mistake here: "128.5" means 128.5k to a human and
// 129 tokens to the parser, so only accept decimals that carry a unit.
function parseTokens(text) {
  const raw = String(text).trim();
  const scaled = raw.match(/^(\d+(?:\.\d+)?)\s*([kKmM])$/);
  if (scaled) return Math.round(Number(scaled[1]) * (scaled[2].toLowerCase() === "m" ? 1_000_000 : 1_000));
  return /^\d+$/.test(raw) ? Number(raw) : NaN;
}

// Generous ceiling: the largest published context windows are still an order of
// magnitude below this, so anything above it is a typo, not a model.
const MAX_TOKENS = 100_000_000;

function isValidTokens(text) {
  const parsed = parseTokens(text);
  return Number.isSafeInteger(parsed) && parsed > 0 && parsed <= MAX_TOKENS;
}

function TokenField({ value, onChange, label }) {
  const [focused, setFocused] = useState(false);
  const [draft, setDraft] = useState(String(value));
  useEffect(() => { if (!focused) setDraft(String(value)); }, [value, focused]);
  const invalid = focused && draft.trim() !== "" && !isValidTokens(draft);
  const commit = () => {
    if (isValidTokens(draft)) onChange(parseTokens(draft));
    setFocused(false);
  };
  return (
    <input
      className="mono"
      type="text"
      inputMode="numeric"
      aria-label={label}
      aria-invalid={invalid || undefined}
      title={invalid
        ? "只接受 1 到 100m 之间的整数，或带 k / m 单位的数字，例如 200000、200k、1.05m"
        : `${label}：${Number(value).toLocaleString("en-US")} tokens`}
      value={focused ? draft : formatTokens(value)}
      onFocus={(event) => { setDraft(String(value)); setFocused(true); event.target.select(); }}
      onChange={(event) => setDraft(event.target.value.replace(/[^0-9.kKmM]/g, ""))}
      onKeyDown={(event) => { if (event.key === "Enter") { event.preventDefault(); event.currentTarget.blur(); } }}
      onBlur={commit}
    />
  );
}

// Arming and confirming must be two deliberate clicks, so a double-click on the
// trash icon cannot delete the row with the second half of the same gesture.
const CONFIRM_ARM_DELAY = 400;

function ModelRow({ model, isDefault, isLiveDefault, onChange, onDefault, onArmRemove, onRemove, onBlockedRemove, onSafeDefaults, canRemove }) {
  const [armedAt, setArmedAt] = useState(0);
  const confirmRemove = armedAt > 0;
  const isPersisted = Boolean(model.persistedId);
  const identityHelpId = `model-id-help-${model.rowId}`;
  useEffect(() => {
    if (!confirmRemove) return undefined;
    const timer = setTimeout(() => setArmedAt(0), 3200);
    return () => clearTimeout(timer);
  }, [confirmRemove, armedAt]);
  return (
    <div className={`model-row ${isDefault ? "is-default" : ""}`}>
      <span className="drag-handle"><Stack size={17} aria-hidden="true" /></span>
      <label className="model-name-cell">
        <span className="sr-only">模型 ID</span>
        <span className="model-id-field">
          <input
            className={`mono ${isPersisted ? "is-readonly" : ""}`}
            value={model.id}
            onChange={(event) => {
              if (!isPersisted) onChange({ ...model, id: event.target.value, name: event.target.value });
            }}
            readOnly={isPersisted}
            aria-label="模型 ID"
            aria-describedby={isPersisted ? identityHelpId : undefined}
            title={isPersisted ? "已保存的模型 ID 不可直接改名；请添加新模型后删除旧模型" : undefined}
            placeholder="例如 anthropic/claude-opus"
            spellCheck={false}
            autoCapitalize="off"
            autoCorrect="off"
            autoComplete="off"
          />
          {isPersisted && <span className="persisted-id-lock" title="已保存的模型 ID 不可直接改名；请添加新模型后删除旧模型"><LockSimple size={14} aria-hidden="true" /></span>}
          {isPersisted && <span id={identityHelpId} className="sr-only">已保存的模型 ID 不可直接改名；请添加新模型后删除旧模型。</span>}
        </span>
        <span className="model-row-annotations">
          {model.api !== "inherit" && <small className="protocol-override">协议覆盖为 {apiMeta(model.api).short}</small>}
          {isLiveDefault && <small className="live-default-badge">Pi 当前默认</small>}
        </span>
      </label>
      <label>
        <TokenField label="上下文容量" value={model.contextWindow} onChange={(value) => onChange({ ...model, contextWindow: value })} />
        <button type="button" className="safe-default" onClick={onSafeDefaults}>这一行用安全值</button>
      </label>
      <label><TokenField label="最大输出" value={model.maxTokens} onChange={(value) => onChange({ ...model, maxTokens: value })} /></label>
      <label><span className="sr-only">图像能力</span><select value={model.supportsImages ? "yes" : "no"} onChange={(event) => onChange({ ...model, supportsImages: event.target.value === "yes" })}><option value="yes">支持</option><option value="no">不支持</option></select></label>
      <label><span className="sr-only">推理能力</span><select value={model.maximumThinking} onChange={(event) => onChange({ ...model, maximumThinking: event.target.value })}>{THINKING_OPTIONS.map((option) => <option key={option.value} value={option.value}>{option.label}</option>)}</select></label>
      <label className="default-radio"><input type="radio" name="default-model" checked={isDefault} onChange={onDefault} disabled={!model.id.trim()} aria-label={`将 ${model.id || "该模型"} 设为默认`} /></label>
      <span className="model-action-cell">
        <button
          type="button"
          className={`icon-button ${confirmRemove ? "is-confirming" : ""}`}
          onClick={() => {
            if (!canRemove) {
              onBlockedRemove();
              return;
            }
            if (!confirmRemove) {
              setArmedAt(Date.now());
              onArmRemove();
              return;
            }
            if (Date.now() - armedAt < CONFIRM_ARM_DELAY) return;
            onRemove();
          }}
          onBlur={() => setArmedAt(0)}
          aria-disabled={!canRemove}
          title={canRemove ? (confirmRemove ? (isLiveDefault ? "再点一次删除 Pi 当前默认的模型" : "再点一次确认删除") : "删除这一行") : "不能删除唯一模型；先添加替代模型"}
          aria-label={canRemove
            ? confirmRemove
              ? `再点一次删除 ${model.id || "该模型"}${isLiveDefault ? "，它是 Pi 当前的默认模型" : ""}`
              : `删除 ${model.id || "该模型"}${isLiveDefault ? "（Pi 当前默认）" : ""}`
            : `不能删除 ${model.id || "该模型"}，它是这个供应商的唯一模型；先添加替代模型`}
        >
          <Trash size={18} weight={confirmRemove ? "fill" : "regular"} />
        </button>
      </span>
    </div>
  );
}

function ModelsStep({ form, setForm, error, saving, onBack, onSave, onNotify, onDeleteProvider, canDeleteProvider, isExistingProvider, isCurrentDefault, liveDefaultModelId }) {
  const [showBulk, setShowBulk] = useState(false);
  const [bulkText, setBulkText] = useState("");
  const [scrolled, setScrolled] = useState(false);
  const updateModel = (rowId, value) => setForm((current) => ({ ...current, models: current.models.map((model) => model.rowId === rowId ? value : model) }));
  const addModel = () => setForm((current) => ({ ...current, models: [...current.models, blankModel()], defaultRowId: current.defaultRowId || current.models[0]?.rowId || "" }));
  // Which row would inherit the default marker once this one is gone: the radio
  // stays where it is unless it is the row being removed.
  const nextDefaultAfterRemoving = (rowId) => {
    const models = form.models.filter((model) => model.rowId !== rowId);
    const next = models.find((model) => model.rowId === form.defaultRowId && model.id.trim())
      || models.find((model) => model.id.trim());
    return next?.id.trim() || "";
  };
  const removalMessage = (model) => {
    const name = model.id.trim();
    const nextDefaultId = nextDefaultAfterRemoving(model.rowId);
    const wasLiveDefault = Boolean(name) && name === liveDefaultModelId;
    if (wasLiveDefault) {
      return nextDefaultId
        ? <>删除 <code>{name}</code> 后，保存并设为默认会将 Pi 默认模型改为 <code>{nextDefaultId}</code>，并移除此模型保存的兼容信息。</>
        : <>删除 <code>{name}</code> 后，需要先指定另一个已命名模型才能保存；此模型保存的兼容信息也会被移除。</>;
    }
    if (model.persistedId) {
      return <>删除 <code>{name}</code> 后，保存会移除此模型及其保存的兼容信息。</>;
    }
    return name
      ? <>再次点击会从本次编辑中移除 <code>{name}</code>。</>
      : "再次点击会移除这个未命名模型行。";
  };
  const armRemoveModel = (model) => onNotify(removalMessage(model), "error");
  const blockLastModelRemoval = () => onNotify(
    canDeleteProvider
      ? "不能单独删除这个供应商的唯一模型。如需移除整个供应商，请使用“删除供应商”。"
      : "不能删除唯一模型。先添加替代模型并设为默认。",
    "error",
    canDeleteProvider
      ? { label: "删除供应商", onAction: onDeleteProvider }
      : { label: "添加模型", onAction: addModel },
  );
  // A removed row does not just leave the list: saving replaces the stored models,
  // so whatever models.json kept for it — compat flags, thinkingLevelMap, fields
  // Pi wrote that we preserve but never edit — goes with it. Hence the undo.
  const removeModel = (rowId) => {
    const index = form.models.findIndex((model) => model.rowId === rowId);
    const removed = form.models[index];
    const previousDefaultRowId = form.defaultRowId;
    const nextDefaultId = nextDefaultAfterRemoving(rowId);
    const wasLiveDefault = Boolean(removed?.id.trim()) && removed.id.trim() === liveDefaultModelId;
    setForm((current) => {
      const models = current.models.filter((model) => model.rowId !== rowId);
      const selected = models.find((model) => model.rowId === current.defaultRowId && model.id.trim())
        || models.find((model) => model.id.trim());
      return { ...current, models, defaultRowId: selected?.rowId || "" };
    });
    if (!removed) return;
    const name = removed.id.trim();
    onNotify(
      wasLiveDefault
        ? nextDefaultId
          ? <>已删除 <code>{name}</code>，保存后 Pi 的默认模型会变成 <code>{nextDefaultId}</code></>
          : <>已删除 <code>{name}</code>；保存前需要先指定另一个已命名模型</>
        : name
          ? <>已删除 <code>{name}</code></>
          : "已删除未命名模型行",
      wasLiveDefault ? "error" : "success",
      {
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
      },
    );
  };
  const applySafeToAll = () => {
    const previous = form.models;
    const changed = previous.filter((model) => {
      const safe = safeDefaults(model.id);
      return model.contextWindow !== safe.contextWindow || model.maxTokens !== safe.maxTokens;
    });
    if (changed.length === 0) { onNotify("所有模型已经是安全默认值"); return; }
    setForm((current) => ({
      ...current,
      models: current.models.map((model) => ({ ...model, ...safeDefaults(model.id) })),
    }));
    // This overwrites numbers the user may have typed themselves, so it has to be reversible.
    onNotify(`已把 ${changed.length} 个模型的容量与输出改为安全值`, "success", {
      label: "撤销",
      onAction: () => setForm((current) => ({
        ...current,
        models: current.models.map((model) => {
          const before = previous.find((item) => item.rowId === model.rowId);
          return before ? { ...model, contextWindow: before.contextWindow, maxTokens: before.maxTokens } : model;
        }),
      })),
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
      const existingIds = new Set(current.models.map((model) => model.id).filter(Boolean));
      const additions = bulkIds.filter((id) => !existingIds.has(id)).map((id) => blankModel(id));
      const hasOnlyBlank = current.models.length === 1 && !current.models[0].id;
      const models = [...(hasOnlyBlank ? [] : current.models), ...additions];
      const defaultRowId = models.some((model) => model.rowId === current.defaultRowId) ? current.defaultRowId : models[0]?.rowId || "";
      return { ...current, models, defaultRowId };
    });
    setBulkText("");
    setShowBulk(false);
  };
  const thinkingAliasModels = form.models.filter((model) => /-(max|xhigh)$/i.test(model.id));
  const currentApi = apiMeta(form.api);
  const namedModels = form.models.filter((model) => model.id.trim()).length;
  return (
    <section className="step-content models-step">
      <div className="step-scroll">
        <div className="section-heading">
          <div><h1>确认并选择可用模型</h1><p>一个 API 网关可以添加多个不同厂商的模型，并指定 Pi 默认使用哪个。</p></div>
        </div>
        <div className="gateway-summary">
          <span className="summary-icon"><ProviderIcon api={form.api} size={34} /></span>
          <div><strong>{titleFromId(form.providerId || "new-provider")}</strong><span className="protocol-badge">{currentApi.title}</span><p title={form.baseUrl || undefined}>API 地址　<code>{form.baseUrl || "尚未填写"}</code></p></div>
          <div className="gateway-side">
            <div className="saved-credential"><ShieldCheck size={29} weight="duotone" /><span><strong>{form.credentialMode === "keep" ? "凭据已安全保存" : "凭据将在保存时写入"}</strong><small>{form.credentialMode === "keep" ? "浏览器无法读取旧 key" : "当前草稿尚未写入 Pi 配置"}</small></span></div>
            {canDeleteProvider && (
              <button type="button" className="delete-provider-button" onClick={onDeleteProvider}>
                <Trash size={18} />删除供应商
              </button>
            )}
          </div>
        </div>
        <div className="models-header">
          <div><h2>模型列表<span className="count-pill">{namedModels}</span></h2><p>Pi 以 provider/model 选择模型，thinking level 是独立设置。</p></div>
          <div className="models-actions">
            <button type="button" className="secondary-button compact-button" onClick={applySafeToAll} title="把所有模型的上下文容量与最大输出改为安全值，可撤销" aria-label="全部用安全值"><ShieldCheck size={18} /><span className="button-label">全部用安全值</span></button>
            <button type="button" className="secondary-button compact-button" onClick={() => setShowBulk(true)} title="批量添加模型 ID" aria-label="批量添加"><ListPlus size={18} /><span className="button-label">批量添加</span></button>
            <button type="button" className="outline-button compact-button" onClick={addModel} title="添加模型" aria-label="添加模型"><Plus size={19} /><span className="button-label">添加模型</span></button>
          </div>
        </div>
        {thinkingAliasModels.length > 0 && <div className="model-warning"><WarningCircle size={20} weight="fill" /><span><strong>发现疑似思考档位后缀：</strong>{thinkingAliasModels.map((model) => model.id).join("、")}。只有网关真的把它们作为模型 ID 时才应保留；否则用右侧“推理能力”和 Pi 的 Shift+Tab 切换。</span></div>}
        <div className={`models-table ${scrolled ? "is-scrolled" : ""}`} onScroll={(event) => setScrolled(event.currentTarget.scrollTop > 2)}>
          <div className="model-table-head"><span /><span>模型 ID</span><span>上下文容量</span><span>最大输出</span><span>图像能力</span><span>推理能力</span><span>默认模型</span><span className="model-action-cell" /></div>
          {form.models.map((model) => <ModelRow key={model.rowId} model={model} isDefault={form.defaultRowId === model.rowId && Boolean(model.id.trim())} isLiveDefault={Boolean(liveDefaultModelId) && model.id.trim() === liveDefaultModelId} onChange={(value) => updateModel(model.rowId, value)} onSafeDefaults={() => updateModel(model.rowId, { ...model, ...safeDefaults(model.id) })} onDefault={() => setForm((current) => ({ ...current, defaultRowId: model.rowId }))} onArmRemove={() => armRemoveModel(model)} onRemove={() => removeModel(model.rowId)} onBlockedRemove={blockLastModelRemoval} canRemove={form.models.length > 1} />)}
        </div>
        <p className="scroll-hint">表格可左右滑动，查看上下文容量、图像与推理能力等字段。</p>
        <div className="models-note"><ShieldCheck size={21} weight="duotone" />未指定的能力项将使用保守默认值，不影响正常使用。</div>
        <details className="advanced-panel">
          <summary><span><SlidersHorizontal size={21} />高级兼容设置 <small>通常无需修改</small></span><CaretDown size={19} /></summary>
          <div className="advanced-content">
            <div><h3>模型协议覆盖</h3><p>只有网关针对某个模型使用不同接口时才需要设置。</p></div>
            {form.models.map((model) => <label key={model.rowId}><span className="mono">{model.id || "未命名模型"}</span><select value={model.api} onChange={(event) => updateModel(model.rowId, { ...model, api: event.target.value })}><option value="inherit">继承网关默认协议</option>{API_OPTIONS.map((option) => <option key={option.id} value={option.id}>{option.title}</option>)}</select></label>)}
          </div>
        </details>
        {error && <div className="error-banner" role="alert"><WarningCircle size={20} weight="fill" />{error}</div>}
      </div>
      <footer className="wizard-footer">
        <button type="button" className="secondary-button" onClick={onBack}><ArrowLeft size={19} />上一步</button>
        {isExistingProvider && !isCurrentDefault ? (
          <div className="footer-actions">
            <button type="button" className="outline-button" disabled={saving} onClick={() => onSave(true)}>保存并设为默认</button>
            <button type="button" className="primary-button" disabled={saving} onClick={() => onSave(false)}>{saving ? <><Spinner />正在保存…</> : "保存更改"}</button>
          </div>
        ) : (
          <button type="button" className="primary-button" disabled={saving} onClick={() => onSave(true)}>{saving ? <><Spinner />正在保存…</> : "保存并设为默认"}</button>
        )}
      </footer>
      {showBulk && <BulkModal text={bulkText} ids={bulkIds} newIds={newBulkIds} onText={setBulkText} onClose={() => setShowBulk(false)} onImport={importModels} />}
    </section>
  );
}

function ProviderDeleteDialog({ provider, state, deleting, requestError, onClose, onConfirm }) {
  const alternatives = state.providers.filter((item) => item.id !== provider.id && item.models.length > 0);
  const [keepCredential, setKeepCredential] = useState(false);
  const [replacementProviderId, setReplacementProviderId] = useState(alternatives[0]?.id || "");
  const [replacementModelId, setReplacementModelId] = useState(alternatives[0]?.models[0]?.id || "");
  const [localError, setLocalError] = useState("");
  const cancelRef = useRef(null);
  const dialogRef = useRef(null);
  const isCurrentDefault = state.settings.defaultProvider === provider.id;
  const replacementProvider = alternatives.find((item) => item.id === replacementProviderId);
  const canDelete = !isCurrentDefault || Boolean(replacementProvider && replacementModelId);

  useEffect(() => {
    const previousFocus = document.activeElement;
    cancelRef.current?.focus();
    return () => previousFocus?.focus?.();
  }, []);

  useEffect(() => {
    const onKeyDown = (event) => {
      if (event.key === "Escape" && !deleting) {
        onClose();
        return;
      }
      if (event.key !== "Tab") return;
      const focusable = [...(dialogRef.current?.querySelectorAll(
        "button:not(:disabled), input:not(:disabled), select:not(:disabled)",
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
  }, [deleting, onClose]);

  const changeReplacementProvider = (providerId) => {
    const next = alternatives.find((item) => item.id === providerId);
    setReplacementProviderId(providerId);
    setReplacementModelId(next?.models[0]?.id || "");
    setLocalError("");
  };
  const confirm = () => {
    if (!canDelete) {
      setLocalError("先添加另一个带模型的供应商，才能替换 Pi 当前默认项。");
      return;
    }
    setLocalError("");
    onConfirm({
      providerId: provider.id,
      keepCredential,
      replacementProviderId: isCurrentDefault ? replacementProviderId : undefined,
      replacementModelId: isCurrentDefault ? replacementModelId : undefined,
    });
  };

  return (
    <div className="modal-backdrop" role="presentation" onMouseDown={(event) => { if (event.target === event.currentTarget && !deleting) onClose(); }}>
      <section ref={dialogRef} className="provider-delete-dialog" role="dialog" aria-modal="true" aria-labelledby="provider-delete-title" aria-describedby="provider-delete-description">
        <div className="delete-dialog-heading">
          <span className="delete-dialog-icon"><Trash size={24} weight="duotone" /></span>
          <div>
            <h2 id="provider-delete-title">删除 {provider.name || titleFromId(provider.id)}？</h2>
            <p id="provider-delete-description">供应商 <code>{provider.id}</code> 的 {provider.models.length} 个模型会从 <code>models.json</code> 移除。</p>
          </div>
        </div>

        {isCurrentDefault && (
          <div className="replacement-panel">
            <div className="replacement-warning"><WarningCircle size={20} weight="fill" /><span><strong>这是 Pi 当前的默认供应商</strong>删除前必须选择一个可用的替代模型。</span></div>
            {alternatives.length > 0 ? (
              <div className="replacement-fields">
                <label><span>替代供应商</span><select value={replacementProviderId} onChange={(event) => changeReplacementProvider(event.target.value)}>{alternatives.map((item) => <option key={item.id} value={item.id}>{item.name || titleFromId(item.id)} · {item.id}</option>)}</select></label>
                <label><span>替代模型</span><select value={replacementModelId} onChange={(event) => { setReplacementModelId(event.target.value); setLocalError(""); }}>{(replacementProvider?.models || []).map((model) => <option key={model.id} value={model.id}>{model.name || model.id} · {model.id}</option>)}</select></label>
              </div>
            ) : (
              <p className="no-replacement">目前没有其他带模型的供应商。请先取消并添加替代供应商。</p>
            )}
          </div>
        )}

        {provider.credentialConfigured && (
          <label className="keep-credential-option">
            <input type="checkbox" checked={keepCredential} onChange={(event) => setKeepCredential(event.target.checked)} />
            <span><strong>保留凭据，供以后重新配置使用</strong><small>凭据会留在 <code>auth.json</code>，但不会继续显示为供应商。</small></span>
          </label>
        )}
        <p className="delete-consequence">
          {!provider.credentialConfigured
            ? "供应商和全部模型会被永久删除；该供应商没有已保存的凭据。"
            : keepCredential
            ? "供应商和模型会被永久删除，已保存的凭据会保留。"
            : "供应商、全部模型和已保存的凭据会被永久删除。"}
        </p>
        {(localError || requestError) && <div className="error-banner" role="alert"><WarningCircle size={20} weight="fill" />{localError || requestError}</div>}

        <div className="modal-actions">
          <button ref={cancelRef} type="button" className="secondary-button" disabled={deleting} onClick={onClose}>取消</button>
          <button type="button" className="danger-button" disabled={deleting} aria-disabled={!canDelete || deleting} onClick={confirm}>
            {deleting ? <><Spinner />正在删除…</> : <><Trash size={18} />确认删除</>}
          </button>
        </div>
      </section>
    </div>
  );
}

function SuccessScreen({ result, onCopy, onReturn, onAdd }) {
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
      <p className="success-eyebrow">配置已写入 Pi</p>
      <h1>{titleFromId(result.providerId)} 已保存</h1>
      <p className="success-summary">
        {result.setDefault
          ? <>Pi 已识别 {result.modelCount} 个模型，默认模型是 <code>{result.defaultModelId}</code>。</>
          : <>Pi 已识别 {result.modelCount} 个模型。全局默认模型没有改动。</>}
      </p>
      <div className="next-step-card">
        <div className="next-step-heading"><TerminalWindow size={28} weight="duotone" /><div><h2>下一步：在 Pi 中验证模型</h2><p>无需重启。回到 Pi 打开 <code>/model</code>，或直接运行下面的命令。</p></div></div>
        <div className="command-row">
          <code ref={commandRef}>{result.command}</code>
          <button type="button" className={`copy-button ${copied ? "is-copied" : ""}`} onClick={copy}>
            {copied ? <><Check size={18} weight="bold" />已复制</> : <><Copy size={18} />复制</>}
          </button>
        </div>
        <ol>
          <li>选择刚保存的 <code>{result.defaultModelId}</code>{result.setDefault ? "" : "（本次没有改动全局默认，用上面的命令直接指定）"}</li>
          <li>确认底部显示 provider 为 <code>{result.providerId}</code></li>
          <li>发送一句简单测试消息；通道限流或 500 属于上游服务状态，不代表配置文件未保存</li>
        </ol>
      </div>
      <div className="success-actions"><button type="button" className="secondary-button" onClick={onAdd}><Plus size={18} />添加另一个网关</button><button type="button" className="primary-button" onClick={onReturn}>返回供应商详情<ArrowRight size={19} /></button></div>
    </section>
  );
}

function SettingsScreen({ state, saving, error, onSave, onBack }) {
  const saved = useMemo(() => ({
    defaultProvider: state.settings.defaultProvider || state.providers[0]?.id || "",
    defaultModel: state.settings.defaultModel || "",
    defaultThinkingLevel: state.settings.defaultThinkingLevel || "medium",
    hideThinkingBlock: Boolean(state.settings.hideThinkingBlock),
    transport: state.settings.transport || "auto",
  }), [state]);
  const [draft, setDraft] = useState(saved);
  useEffect(() => { setDraft(saved); }, [saved]);
  // Anything this screen owns but settings.json does not carry yet is unwritten, not "saved".
  // publicState normalizes every key, so a fallback looks identical to a stored
  // value. settingsPresent is the server telling us what settings.json really has.
  const present = new Set(
    Array.isArray(state.settingsPresent) ? state.settingsPresent : Object.keys(state.settings || {}),
  );
  const unwritten = ["defaultProvider", "defaultModel", "defaultThinkingLevel", "hideThinkingBlock", "transport"]
    .filter((key) => !present.has(key));
  const edited = JSON.stringify(saved) !== JSON.stringify(draft);
  const dirty = edited || unwritten.length > 0;
  const installedPi = state.compatibility?.piVersion;
  const validatedPi = state.compatibility?.validatedPiVersion;
  const piVersionDiffers = Boolean(installedPi) && installedPi !== "unknown"
    && Boolean(validatedPi) && validatedPi !== "unknown" && installedPi !== validatedPi;
  const selectedProvider = state.providers.find((provider) => provider.id === draft.defaultProvider);
  const availableModels = selectedProvider?.models || [];
  // Keep whatever is currently selected in the list, even with no models, so the
  // control never displays a different provider from the one it holds.
  const selectableProviders = state.providers.filter(
    (provider) => provider.models.length > 0 || provider.id === draft.defaultProvider,
  );
  const changeProvider = (providerId) => {
    const provider = state.providers.find((item) => item.id === providerId);
    setDraft((current) => ({ ...current, defaultProvider: providerId, defaultModel: provider?.models?.[0]?.id || "" }));
  };
  return (
    <section className="settings-page">
      <div className="settings-scroll">
        <div className="settings-title"><div><p>Pi 全局设置</p><h1>设置与兼容性</h1><span>这里的修改会写入 Pi 的 settings.json。</span></div><button type="button" className="secondary-button" onClick={onBack}><ArrowLeft size={18} />返回</button></div>
        <div className="settings-grid">
          <section className="settings-card">
            <h2>默认模型</h2><p>Pi 启动新会话时优先使用这里的 provider/model。</p>
            <label><span>默认供应商</span><select value={draft.defaultProvider} onChange={(event) => changeProvider(event.target.value)}>{selectableProviders.map((provider) => <option key={provider.id} value={provider.id}>{titleFromId(provider.id)} · {provider.id}{provider.models.length === 0 ? "（无模型）" : ""}</option>)}</select></label>
            <label><span>默认模型</span><select value={draft.defaultModel} disabled={availableModels.length === 0} onChange={(event) => setDraft((current) => ({ ...current, defaultModel: event.target.value }))}>{availableModels.map((model) => <option key={model.id} value={model.id}>{model.name || model.id}</option>)}</select>{availableModels.length === 0 && <small>该供应商还没有模型。先为它添加模型，才能设为默认。</small>}</label>
            <label><span>默认思考强度</span><select value={draft.defaultThinkingLevel} onChange={(event) => setDraft((current) => ({ ...current, defaultThinkingLevel: event.target.value }))}>{["off", "minimal", "low", "medium", "high", "xhigh", "max"].map((level) => <option key={level} value={level}>{level}</option>)}</select></label>
          </section>
          <section className="settings-card">
            <h2>会话行为</h2><p>这些选项由 Pi 官方 settings.json 支持。</p>
            <label><span>传输方式</span><select value={draft.transport} onChange={(event) => setDraft((current) => ({ ...current, transport: event.target.value }))}><option value="auto">自动选择</option><option value="sse">SSE</option><option value="websocket">WebSocket</option></select></label>
            <label className="setting-toggle"><input type="checkbox" checked={draft.hideThinkingBlock} onChange={(event) => setDraft((current) => ({ ...current, hideThinkingBlock: event.target.checked }))} /><span><strong>隐藏 thinking 内容块</strong><small>只隐藏显示，不会关闭模型推理。</small></span></label>
          </section>
          <section className="settings-card compatibility-card">
            <h2>兼容状态</h2><dl><div><dt>Pi 版本</dt><dd className="mono">{state.compatibility?.piVersion || "unknown"}</dd></div><div><dt>已验证兼容</dt><dd className="mono">Pi {state.compatibility?.validatedPiVersion || "unknown"}</dd></div><div><dt>管理器版本</dt><dd className="mono">{state.compatibility?.appVersion || "unknown"}</dd></div><div><dt>配置策略</dt><dd>保留未知字段</dd></div><div><dt>配置目录</dt><dd className="mono" title={state.agentDir}>{state.agentDir}</dd></div><div><dt>路径来源</dt><dd>{state.compatibility?.configDirSource === "PI_CODING_AGENT_DIR" ? "PI_CODING_AGENT_DIR" : "自动识别 · 用户主目录"}</dd></div><div><dt>Node</dt><dd className="mono">{state.compatibility?.nodeVersion || "unknown"}</dd></div><div><dt>本地服务</dt><dd className="mono">{state.compatibility?.serviceHost || "127.0.0.1"}:{state.compatibility?.servicePort || 43127}</dd></div></dl>
            {piVersionDiffers && (
              <p className="compat-note is-warning">
                <WarningCircle size={20} weight="fill" />
                你安装的 Pi 是 {state.compatibility.piVersion}，本版本验证过的是 {state.compatibility.validatedPiVersion}。未知字段仍会保留，但若 Pi 改动了配置结构，请对照兼容性说明确认。
              </p>
            )}
            <p className="compat-note"><ShieldCheck size={20} weight="duotone" />Pi 更新后若出现新字段，本程序会保留未识别字段；涉及字段改名或 API 类型变化时仍需发布兼容更新。</p>
          </section>
        </div>
        {error && <div className="error-banner" role="alert"><WarningCircle size={20} weight="fill" />{error}</div>}
      </div>
      <footer className="settings-footer">
        <span className="dirty-note" aria-live="polite">
          {edited
            ? "有未保存的修改"
            : unwritten.length > 0
              ? `有 ${unwritten.length} 项默认值还没写入 settings.json`
              : "所有修改已写入 settings.json"}
        </span>
        <button type="button" className="primary-button" disabled={saving || !dirty || !draft.defaultModel || availableModels.length === 0} onClick={() => onSave(draft)}>{saving ? <><Spinner />正在保存…</> : "保存设置"}</button>
      </footer>
    </section>
  );
}

export function App() {
  const demoMode = useMemo(() => new URLSearchParams(window.location.search).get("demo") === "1", []);
  const [theme, setTheme] = useTheme();
  const [state, setState] = useState(demoMode ? DEMO_STATE : { revision: "", providers: [], authProviders: [], settings: {}, compatibility: {}, agentDir: "" });
  const [loading, setLoading] = useState(!demoMode);
  const [selectedId, setSelectedId] = useState(demoMode ? "any-claude" : "");
  const [step, setStep] = useState(demoMode ? 3 : 1);
  const [view, setView] = useState("wizard");
  const [form, setForm] = useState(() => demoMode ? providerToForm(DEMO_STATE.providers[0], DEMO_STATE) : blankForm());
  const [error, setError] = useState("");
  const [saving, setSaving] = useState(false);
  const [toast, setToast] = useState(null);
  const [saveResult, setSaveResult] = useState(null);
  const [deleteTargetId, setDeleteTargetId] = useState("");
  const [deletingProvider, setDeletingProvider] = useState(false);
  const [deleteProviderError, setDeleteProviderError] = useState("");
  const [target, setTarget] = useState("pi");
  const [codexForm, setCodexForm] = useState(blankCodexForm);
  const [codexStep, setCodexStep] = useState(1);
  const [codexSelectedId, setCodexSelectedId] = useState("");
  const [codexSaveResult, setCodexSaveResult] = useState(null);
  const [codexDeleteTargetId, setCodexDeleteTargetId] = useState("");
  const toastTimer = useRef(null);
  const showToast = useCallback((message, tone = "success", action = null) => {
    setToast({ message, tone, action });
    clearTimeout(toastTimer.current);
    toastTimer.current = setTimeout(() => setToast(null), action ? 7000 : 3200);
  }, []);
  const reportRequestError = useCallback((requestError, setMessage) => {
    setMessage(requestError.message);
    if (requestError.status === 409) {
      showToast(requestError.message, "error", {
        label: "重新读取",
        onAction: () => window.location.reload(),
      });
    }
  }, [showToast]);
  useEffect(() => () => clearTimeout(toastTimer.current), []);
  useEffect(() => {
    const frame = window.requestAnimationFrame(() => {
      document.querySelector(".step-scroll, .settings-scroll, .success-page")?.scrollTo({ top: 0, behavior: "instant" });
    });
    return () => window.cancelAnimationFrame(frame);
  }, [view, step]);

  useEffect(() => {
    if (demoMode) return;
    fetch("/api/state", { cache: "no-store" })
      .then(async (response) => {
        const data = await readApiResponse(response, "读取配置失败");
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

  const openDeleteProvider = () => {
    const providerId = selectedId;
    if (!state.providers.some((provider) => provider.id === providerId)) return;
    setDeleteProviderError("");
    setDeleteTargetId(providerId);
  };

  const closeDeleteProvider = useCallback(() => {
    setDeleteTargetId("");
    setDeleteProviderError("");
  }, []);

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
    const changedIdentity = changedPersistedModel(form.models);
    if (changedIdentity) {
      setError(<>已保存的模型 ID <code>{changedIdentity.persistedId}</code> 不能直接改名或清空；请添加新模型，再用删除按钮移除旧模型。</>);
      return;
    }
    const selectedModel = selectedNamedModel(form.models, form.defaultRowId);
    if (!selectedModel) { setError("请选择一个已命名模型作为默认模型。"); return; }
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
      defaultModelId: selectedModel.id.trim(),
      defaultThinkingLevel: form.defaultThinkingLevel,
      compat: form.compat,
      revision: state.revision,
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
          isDefault: setDefault,
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
          providers: [
            ...state.providers
              .filter((provider) => provider.id !== payload.providerId)
              .map((provider) => ({ ...provider, isDefault: setDefault ? false : provider.isDefault })),
            demoProvider,
          ],
          authProviders: [...new Set([...state.authProviders, payload.providerId])],
          settings: setDefault
            ? { ...state.settings, defaultProvider: payload.providerId, defaultModel: payload.defaultModelId, defaultThinkingLevel: payload.defaultThinkingLevel }
            : state.settings,
        };
        setState(demoState);
        setSelectedId(payload.providerId);
        setForm(providerToForm(demoProvider, demoState));
        const result = {
          providerId: payload.providerId,
          modelCount: payload.models.length,
          defaultModelId: payload.defaultModelId,
          defaultThinkingLevel: payload.defaultThinkingLevel,
          setDefault,
          command: `pi --model ${payload.providerId}/${payload.defaultModelId}:${payload.defaultThinkingLevel}`,
        };
        setSaveResult(result);
        setView("success");
        return;
      }
      const response = await fetch("/api/providers", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(payload) });
      const data = await readApiResponse(response, "保存失败");
      setState(data.state);
      const saved = data.state.providers.find((provider) => provider.id === payload.providerId);
      if (saved) { setSelectedId(saved.id); setForm(providerToForm(saved, data.state)); }
      setSaveResult({
        providerId: payload.providerId,
        modelCount: payload.models.length,
        defaultModelId: payload.defaultModelId,
        defaultThinkingLevel: payload.defaultThinkingLevel,
        setDefault,
        command: `pi --model ${payload.providerId}/${payload.defaultModelId}:${payload.defaultThinkingLevel}`,
      });
      setView("success");
    } catch (requestError) {
      reportRequestError(requestError, setError);
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
        showToast("演示模式：设置校验通过");
      } else {
        const response = await fetch("/api/settings", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ ...draft, revision: state.revision }) });
        const data = await readApiResponse(response, "保存设置失败");
        setState(data.state);
        showToast("Pi 设置已保存");
      }
    } catch (requestError) {
      reportRequestError(requestError, setError);
    } finally {
      setSaving(false);
    }
  };

  const deleteProvider = async (payload) => {
    setDeletingProvider(true);
    setDeleteProviderError("");
    try {
      const deletedProvider = state.providers.find((provider) => provider.id === payload.providerId);
      let nextState;
      if (demoMode) {
        await new Promise((resolve) => setTimeout(resolve, 350));
        const deletingDefault = state.settings.defaultProvider === payload.providerId;
        nextState = {
          ...state,
          providers: state.providers
            .filter((provider) => provider.id !== payload.providerId)
            .map((provider) => ({
              ...provider,
              isDefault: deletingDefault ? provider.id === payload.replacementProviderId : provider.isDefault,
            })),
          authProviders: payload.keepCredential
            ? state.authProviders
            : state.authProviders.filter((id) => id !== payload.providerId),
          settings: deletingDefault
            ? {
                ...state.settings,
                defaultProvider: payload.replacementProviderId,
                defaultModel: payload.replacementModelId,
              }
            : state.settings,
        };
      } else {
        const response = await fetch("/api/providers/delete", {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ ...payload, revision: state.revision }),
        });
        const data = await readApiResponse(response, "删除供应商失败");
        nextState = data.state;
      }

      setState(nextState);
      setDeleteTargetId("");
      setDeleteProviderError("");
      setSaveResult(null);
      setView("wizard");
      setError("");
      const nextProvider = nextState.providers.find((provider) => provider.id === payload.replacementProviderId)
        || nextState.providers.find((provider) => provider.id === nextState.settings.defaultProvider)
        || nextState.providers[0];
      if (nextProvider) {
        setSelectedId(nextProvider.id);
        setForm(providerToForm(nextProvider, nextState));
        setStep(nextProvider.models.length > 0 ? 3 : 1);
      } else {
        const fresh = blankForm();
        fresh.migrateFrom = nextState.authProviders[0] || "";
        setSelectedId("");
        setForm(fresh);
        setStep(1);
      }
      showToast(
        <>已删除供应商 <code>{payload.providerId}</code>；{!deletedProvider?.credentialConfigured ? "没有已保存的凭据" : payload.keepCredential ? "凭据已保留" : "凭据也已删除"}</>,
      );
    } catch (requestError) {
      reportRequestError(requestError, setDeleteProviderError);
    } finally {
      setDeletingProvider(false);
    }
  };

  const codex = state.codex || { providers: [], settings: {}, revision: "" };
  const codexProvider = (id) => codex.providers.find((provider) => provider.id === id);

  const switchTarget = (next) => {
    if (next === target) return;
    setTarget(next);
    setView("wizard");
    setError("");
    setSaveResult(null);
    setCodexSaveResult(null);
    if (next === "codex") {
      const provider = codexProvider(codexSelectedId)
        || codex.providers.find((item) => item.isActive)
        || codex.providers[0];
      if (provider) {
        setCodexSelectedId(provider.id);
        setCodexForm(codexProviderToForm(provider, codex));
        setCodexStep(3);
      } else {
        setCodexSelectedId("");
        setCodexForm(blankCodexForm());
        setCodexStep(1);
      }
    }
  };

  const startNewCodex = () => {
    setCodexForm(blankCodexForm());
    setCodexSelectedId("");
    setCodexStep(1);
    setView("wizard");
    setError("");
  };

  const selectCodexProvider = (provider) => {
    setCodexForm(codexProviderToForm(provider, codex));
    setCodexSelectedId(provider.id);
    setCodexStep(provider.models.length > 0 ? 3 : 1);
    setView("wizard");
    setError("");
  };

  const validateCodexCredentials = () => {
    if (!codexForm.providerId.trim()) return "请输入供应商 ID。";
    if (!codexForm.name.trim()) return "请填写供应商名称。";
    if (codexForm.upstream === "bridge") {
      if (!codexForm.bridgeUpstreamUrl.trim()) return "请输入上游 API 地址。";
      const savedBridge = codexProvider(codexForm.providerId.trim())?.bridge;
      if (!codexForm.bridgeApiKey.trim() && !savedBridge?.credentialConfigured) return "请输入上游 API Key。";
      return "";
    }
    if (!codexForm.baseUrl.trim()) return "请输入 API 地址。";
    if (codexForm.requiresAuth && codexForm.credentialMode === "new" && !codexForm.apiKey.trim()) return "请输入 API Key。";
    if (codexForm.requiresAuth && codexForm.credentialMode === "migrate" && !codexForm.migrateFrom) return "请选择要复制的已有凭据。";
    return "";
  };

  const goToCodexModels = () => {
    const message = validateCodexCredentials();
    if (message) { setError(message); return; }
    setError("");
    setCodexStep(3);
  };

  const bridgeAction = async (action) => {
    const response = await fetch(`/api/codex/bridge/${action}`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ providerId: codexForm.providerId.trim() }),
    });
    const data = await readApiResponse(response, action === "start" ? "启动桥失败" : "停止桥失败");
    // The bridge is runtime state, not configuration, so refresh it without
    // disturbing a draft: only the codex.bridge slice changes.
    setState((current) => ({ ...current, codex: { ...current.codex, bridge: data.bridge } }));
    showToast(action === "start"
      ? "已启动本地桥；几秒后再看状态，首次启动 LiteLLM 会慢一些"
      : "已停止本地桥");
  };

  const saveCodex = async (setActive) => {
    const message = validateCodexCredentials();
    if (message) { setError(message); setCodexStep(2); return; }
    const named = codexForm.models.filter((model) => model.id.trim());
    if (named.length === 0) { setError("至少填写一个模型 ID。"); return; }
    const selected = codexForm.models.find((model) => model.rowId === codexForm.defaultRowId && model.id.trim());
    if (!selected) { setError("请选择一个已命名模型作为该供应商的默认模型。"); return; }
    setSaving(true);
    setError("");
    try {
      const response = await fetch("/api/codex/providers", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          revision: codex.revision,
          providerId: codexForm.providerId.trim(),
          name: codexForm.name.trim(),
          baseUrl: codexForm.baseUrl.trim(),
          // A bridged provider carries no credential of its own: the server
          // forces requires_openai_auth = false, and the upstream key travels
          // in the bridge block instead.
          requiresAuth: codexForm.upstream === "bridge" ? false : codexForm.requiresAuth,
          credential: codexForm.upstream !== "bridge" && codexForm.requiresAuth
            ? {
                mode: codexForm.credentialMode,
                apiKey: codexForm.apiKey,
                fromProvider: codexForm.migrateFrom,
              }
            : { mode: "keep" },
          models: named.map((model) => ({ id: model.id.trim(), reasoningEffort: model.reasoningEffort })),
          defaultModelId: selected.id.trim(),
          bridge: codexForm.upstream === "bridge"
            ? { upstreamBaseUrl: codexForm.bridgeUpstreamUrl.trim(), apiKey: codexForm.bridgeApiKey }
            : undefined,
          setActive,
        }),
      });
      const data = await readApiResponse(response, "保存失败");
      setState(data.state);
      const saved = (data.state.codex?.providers || []).find((provider) => provider.id === codexForm.providerId.trim());
      setCodexSelectedId(codexForm.providerId.trim());
      if (saved) setCodexForm(codexProviderToForm(saved, data.state.codex));
      setCodexSaveResult({
        providerId: codexForm.providerId.trim(),
        name: codexForm.name.trim(),
        modelCount: named.length,
        defaultModelId: selected.id.trim(),
        activated: Boolean(saved?.isActive),
        requiresAuth: saved?.requiresAuth !== false,
        command: "codex",
        // The provider's other models, for the `codex -m` hint. Codex sends
        // whatever string it is given, so these need no slugging.
        otherModels: named.map((model) => model.id.trim()).filter((id) => id !== selected.id.trim()),
      });
      setView("success");
    } catch (requestError) {
      reportRequestError(requestError, setError);
    } finally {
      setSaving(false);
    }
  };

  const promptRequest = async (route, payload) => {
    setSaving(true);
    setError("");
    try {
      const response = await fetch(route, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ ...payload, target, revision: state.prompts?.[target]?.revision }),
      });
      const data = await readApiResponse(response, "保存失败");
      setState(data.state);
      return true;
    } catch (requestError) {
      reportRequestError(requestError, setError);
      return false;
    } finally {
      setSaving(false);
    }
  };
  const savePrompt = async (payload) => {
    if (await promptRequest("/api/prompts", payload)) {
      showToast(payload.activate ? `已保存并写入 ${payload.slot === "agents" ? "AGENTS.md" : "文件"}` : "已保存");
    }
  };
  const activatePrompt = async (payload) => {
    if (await promptRequest("/api/prompts/activate", payload)) showToast("已切换生效的提示词");
  };
  const deletePrompt = async (payload) => {
    if (await promptRequest("/api/prompts/delete", payload)) showToast("已删除");
  };

  const deleteCodexProvider = async (payload) => {
    setDeletingProvider(true);
    setDeleteProviderError("");
    try {
      const response = await fetch("/api/codex/providers/delete", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ ...payload, revision: codex.revision }),
      });
      const data = await readApiResponse(response, "删除失败");
      setState(data.state);
      setCodexDeleteTargetId("");
      setCodexSaveResult(null);
      setView("wizard");
      setError("");
      const next = (data.state.codex?.providers || []).find((provider) => provider.id === payload.replacementProviderId)
        || (data.state.codex?.providers || []).find((provider) => provider.isActive)
        || (data.state.codex?.providers || [])[0];
      if (next) {
        setCodexSelectedId(next.id);
        setCodexForm(codexProviderToForm(next, data.state.codex));
        setCodexStep(3);
      } else {
        setCodexSelectedId("");
        setCodexForm(blankCodexForm());
        setCodexStep(1);
      }
      showToast(<>已删除 Codex 供应商 <code>{payload.providerId}</code></>);
    } catch (requestError) {
      reportRequestError(requestError, setDeleteProviderError);
    } finally {
      setDeletingProvider(false);
    }
  };

  const saveCodexSettings = async (draft) => {
    setSaving(true);
    setError("");
    try {
      const response = await fetch("/api/codex/settings", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ ...draft, revision: codex.revision }),
      });
      const data = await readApiResponse(response, "保存设置失败");
      setState(data.state);
      showToast("Codex 设置已写入 config.toml；对新开的会话生效");
    } catch (requestError) {
      reportRequestError(requestError, setError);
    } finally {
      setSaving(false);
    }
  };

  const copyCommand = async (command) => {
    try {
      await navigator.clipboard.writeText(command);
      showToast("启动命令已复制");
      return true;
    } catch {
      showToast("浏览器拒绝了复制，命令已选中，按 Ctrl/⌘ + C", "error");
      return false;
    }
  };

  const returnToSavedCodexProvider = () => {
    const provider = codexProvider(codexSaveResult?.providerId);
    if (provider) selectCodexProvider(provider);
    else setView("wizard");
  };

  const returnToSavedProvider = () => {
    const provider = state.providers.find((item) => item.id === saveResult?.providerId);
    if (provider) selectProvider(provider);
    else setView("wizard");
  };

  return (
    <main className="app-shell">
      <Sidebar
        state={state}
        target={target}
        onTarget={switchTarget}
        selectedId={target === "codex" ? codexSelectedId : selectedId}
        onSelect={target === "codex" ? selectCodexProvider : selectProvider}
        onAdd={target === "codex" ? startNewCodex : startNew}
        onSettings={() => { setView("settings"); setError(""); }}
        onPrompts={() => { setView("prompts"); setError(""); }}
        activeView={view}
        theme={theme}
        onTheme={setTheme}
      />
      <section className="workspace">
        {loading ? (
          <div className="loading-state" role="status" aria-live="polite">
            <span className="skeleton skeleton-title" />
            <span className="skeleton skeleton-line" />
            <span className="skeleton skeleton-block" />
            <p>正在读取{target === "codex" ? " Codex " : " Pi "}配置…</p>
          </div>
        ) : view === "prompts" ? (
          <PromptsScreen
            target={target}
            state={state}
            saving={saving}
            error={error}
            onSave={savePrompt}
            onActivate={activatePrompt}
            onDelete={deletePrompt}
            onNotify={showToast}
            onBack={() => { setView("wizard"); setError(""); }}
          />
        ) : target === "codex" ? (
          codex.available === false ? (
            <div className="error-banner is-standalone" role="alert">
              <WarningCircle size={20} weight="fill" />
              读取 Codex 配置失败：{codex.error || "未知错误"}（{codex.dir}）
            </div>
          ) : view === "settings" ? (
            <CodexSettingsScreen state={state} saving={saving} error={error} onSave={saveCodexSettings} onBack={() => setView("wizard")} />
          ) : view === "success" && codexSaveResult ? (
            <CodexSuccessScreen result={codexSaveResult} onCopy={copyCommand} onReturn={returnToSavedCodexProvider} onAdd={startNewCodex} />
          ) : (
            <>
              <CodexStepper step={codexStep} onStep={setCodexStep} />
              <CodexWizard
                step={codexStep}
                form={codexForm}
                setForm={setCodexForm}
                codex={codex}
                codexVersion={state.compatibility?.codexVersion}
                error={error}
                saving={saving}
                onNext={codexStep === 1 ? () => setCodexStep(2) : goToCodexModels}
                onBack={() => setCodexStep(codexStep - 1)}
                onSave={saveCodex}
                onNotify={showToast}
                onStartBridge={() => bridgeAction("start")}
                onStopBridge={() => bridgeAction("stop")}
                onDeleteProvider={() => setCodexDeleteTargetId(codexSelectedId)}
                canDeleteProvider={Boolean(codexProvider(codexSelectedId))}
                isActive={Boolean(codexProvider(codexForm.providerId.trim())?.isActive)}
              />
            </>
          )
        ) : view === "settings" ? <SettingsScreen state={state} saving={saving} error={error} onSave={saveSettings} onBack={() => setView("wizard")} /> : view === "success" && saveResult ? <SuccessScreen result={saveResult} onCopy={copyCommand} onReturn={returnToSavedProvider} onAdd={startNew} /> : <><Stepper step={step} onStep={setStep} />{step === 1 ? <ProtocolStep form={form} setForm={setForm} onNext={() => setStep(2)} /> : step === 2 ? <CredentialsStep form={form} setForm={setForm} state={state} error={error} onBack={() => setStep(1)} onNext={goToModels} /> : <ModelsStep form={form} setForm={setForm} error={error} saving={saving} onBack={() => setStep(2)} onSave={save} onNotify={showToast} onDeleteProvider={openDeleteProvider} canDeleteProvider={state.providers.some((provider) => provider.id === selectedId)} isExistingProvider={state.providers.some((provider) => provider.id === form.providerId.trim())} isCurrentDefault={state.settings.defaultProvider === form.providerId.trim()} liveDefaultModelId={form.providerId.trim() && state.settings.defaultProvider === form.providerId.trim() ? state.settings.defaultModel || "" : ""} />}</>}
      </section>
      {codexDeleteTargetId && codexProvider(codexDeleteTargetId) && (
        <CodexDeleteDialog
          provider={codexProvider(codexDeleteTargetId)}
          codex={codex}
          deleting={deletingProvider}
          requestError={deleteProviderError}
          onClose={() => { setCodexDeleteTargetId(""); setDeleteProviderError(""); }}
          onConfirm={deleteCodexProvider}
        />
      )}
      {deleteTargetId && state.providers.find((provider) => provider.id === deleteTargetId) && (
        <ProviderDeleteDialog
          provider={state.providers.find((provider) => provider.id === deleteTargetId)}
          state={state}
          deleting={deletingProvider}
          requestError={deleteProviderError}
          onClose={closeDeleteProvider}
          onConfirm={deleteProvider}
        />
      )}
      <div className="toast-region" role="status" aria-live="polite">
        {toast && (
          <div className={`toast is-${toast.tone}`}>
            {toast.tone === "error" ? <WarningCircle size={21} weight="fill" /> : <CheckCircle size={21} weight="fill" />}
            <span>{toast.message}</span>
            {toast.action && (
              <button
                type="button"
                className="toast-action"
                onClick={() => { toast.action.onAction(); clearTimeout(toastTimer.current); setToast(null); }}
              >
                {toast.action.label}
              </button>
            )}
            <button type="button" className="toast-close" onClick={() => { clearTimeout(toastTimer.current); setToast(null); }} aria-label="关闭提示"><X size={16} weight="bold" /></button>
          </div>
        )}
      </div>
    </main>
  );
}
