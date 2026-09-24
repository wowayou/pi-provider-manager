import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import {
  ArrowLeft,
  ArrowRight,
  ArrowsClockwise,
  Asterisk,
  CaretDown,
  ChatCircleDots,
  Check,
  CheckCircle,
  CircleHalfTilt,
  CircleNotch,
  CloudArrowDown,
  Copy,
  Cube,
  DotsThree,
  FileText,
  Gear,
  GoogleLogo,
  Heart,
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
  Tray,
  Sun,
  TerminalWindow,
  Trash,
  WarningCircle,
  X,
} from "@phosphor-icons/react";
import { PROVIDER_ID_PATTERN, normalizeUrl } from "../lib/validation.mjs";
import { validateUserAgent } from "../lib/pi-user-agent.mjs";
import { changedPersistedModel, draftSignature, duplicateCodexForm, duplicatePiForm, selectedNamedModel, userAgentSaveIntent, anthropicBetaSaveIntent, piFormToConfigJson, piConfigJsonToForm } from "./model-draft.mjs";
import { normalizeAnthropicBeta } from "../lib/pi-anthropic-beta.mjs";
import { defaultDiscoveryPath } from "../lib/model-discovery.mjs";
import { USER_AGENT_PRESETS } from "./user-agent-presets.mjs";
import { PromptsScreen } from "./prompts-view.jsx";
import { BulkModal, ConfigEditor, ErrorBanner, Spinner, createRadioKeyHandler, readApiResponse, titleFromId, useDialog, useScrollEdges, validateJson, formatJson } from "./ui-kit.jsx";
import {
  CodexDeleteDialog,
  CodexProviderBulkDeleteDialog,
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

// The `:level` suffix is Pi's runtime thinking level, a global setting owned by
// the Settings screen — not the per-model "推理能力" ceiling and not anything the
// wizard sets. Reflect the level settings.json actually carries, and drop the
// suffix entirely when it carries none, so the command never invents a level.
function piModelCommand(providerId, modelId, settings, settingsPresent) {
  const base = `pi --model ${providerId}/${modelId}`;
  const present = new Set(
    Array.isArray(settingsPresent) ? settingsPresent : Object.keys(settings || {}),
  );
  const level = settings?.defaultThinkingLevel;
  return present.has("defaultThinkingLevel") && level ? `${base}:${level}` : base;
}

// The four states that actually differ once written to models.json: no reasoning,
// reasoning at Pi's default ladder, and the two tiers that need a thinkingLevelMap
// to unlock (xhigh, then xhigh+max). An earlier version offered 中等 and 强 as
// separate choices, but both wrote the identical model — reasoning on, no map —
// so 中等 silently became 强 on the next read. This is a capability declaration
// (does the model think, and how high can it go), not the runtime thinking level;
// that one is global, in Settings.
const THINKING_OPTIONS = [
  { value: "off", label: "不支持思考" },
  { value: "on", label: "支持思考" },
  { value: "xhigh", label: "支持思考 · 含 XHigh" },
  { value: "max", label: "支持思考 · 含 Max" },
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
  { value: "system", label: "跟随系统", icon: CircleHalfTilt, weight: "duotone" },
  { value: "light", label: "浅色", icon: Sun, weight: "regular" },
  { value: "dark", label: "深色", icon: Moon, weight: "regular" },
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

// The appearance control is a single corner icon that cycles system → light →
// dark. The icon reflects the current theme (CircleHalfTilt for system, Sun, Moon),
// so no label is needed; the title/aria-label state the current value and that a
// click cycles. It shares the settings row rather than taking a row of its own.
function ThemeToggle({ theme, onTheme }) {
  const selectedIndex = Math.max(0, THEME_OPTIONS.findIndex((option) => option.value === theme));
  const current = THEME_OPTIONS[selectedIndex];
  const CurrentIcon = current.icon;
  const cycle = () => {
    const next = THEME_OPTIONS[(selectedIndex + 1) % THEME_OPTIONS.length];
    onTheme(next.value);
  };
  return (
    <button type="button" className="theme-cycle-icon" onClick={cycle} title={`外观：${current.label}，点击切换`} aria-label={`外观：${current.label}，点击切换`}>
      <CurrentIcon size={18} weight={current.weight} />
    </button>
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
    maximumThinking: "on",
    api: "inherit",
    forceAdaptiveThinking: false,
    anthropicBeta: "",
    anthropicBetaKind: "none",
    anthropicBetaEdited: false,
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
    compat: {},
    userAgent: "",
    userAgentKind: "none",
    userAgentEdited: false,
    hasModelUserAgentOverride: false,
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
        { id: "claude-3-5-haiku", name: "claude-3-5-haiku", contextWindow: 200000, maxTokens: 8192, input: ["text", "image"], reasoning: true },
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
        maximumThinking: model.thinkingLevelMap?.max
          ? "max"
          : model.thinkingLevelMap?.xhigh
            ? "xhigh"
            : model.reasoning
              ? "on"
              : "off",
        api: model.api || "inherit",
        forceAdaptiveThinking: Boolean(model.compat?.forceAdaptiveThinking),
        anthropicBeta: model.anthropicBeta?.kind === "literal" ? model.anthropicBeta.value : "",
        anthropicBetaKind: model.anthropicBeta?.kind || "none",
        anthropicBetaEdited: false,
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
    compat: provider.compat || {},
    userAgent: provider.userAgent?.kind === "literal" ? provider.userAgent.value : "",
    userAgentKind: provider.userAgent?.kind || "none",
    userAgentEdited: false,
    hasModelUserAgentOverride: Boolean(provider.hasModelUserAgentOverride),
  };
}

function ProviderIcon({ api, size = 24 }) {
  const Icon = apiMeta(api).icon;
  return <Icon size={size} weight="duotone" aria-hidden="true" />;
}

function Stepper({ step, onStep, allowJump }) {
  const items = [
    [1, "选择协议", "选择网关默认接口"],
    [2, "填写凭据", "填写地址与访问凭据"],
    [3, "确认模型", "添加并确认可用模型"],
  ];
  return (
    <nav className="stepper" aria-label="配置步骤">
      {items.map(([number, title, subtitle], index) => {
        const clickable = allowJump || number < step;
        return (
        <div className="step-wrap" key={number}>
          <button
            type="button"
            className={`step ${number === step ? "is-active" : ""} ${number < step ? "is-complete" : ""}`}
            onClick={() => clickable && onStep(number)}
            disabled={!clickable}
            aria-current={number === step ? "step" : undefined}
            title={allowJump ? "跳到这一步" : number < step ? "回到这一步" : number > step ? "完成当前步骤后可用" : undefined}
          >
            <span className="step-number">{number < step ? <CheckCircle size={24} weight="fill" /> : number}</span>
            <span>
              <strong>{title}</strong>
              <small>{subtitle}</small>
            </span>
          </button>
          {index < items.length - 1 && <span className={`step-line ${number < step ? "is-complete" : ""}`} />}
        </div>
        );
      })}
    </nav>
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
      // A provider that declares it needs no credential is not "configured";
      // the tick means ready either way, but saying "凭据已配置" would claim a key
      // exists where none was ever asked for.
      readyLabel: provider.requiresAuth === false ? "无需凭据" : "凭据已配置",
      notReadyLabel: "未配置凭据",
      badge: provider.isActive ? "生效中" : "",
      icon: provider.bridge || isLocalAddress(provider.baseUrl) ? Plugs : PlugsConnected,
      source: provider,
    }));
  }
  return state.providers.map((provider) => ({
    id: provider.id,
    name: provider.name || titleFromId(provider.id),
    // The base URL is searchable on both targets: with several entries from one
    // gateway vendor the host is often the only thing the user remembers.
    keywords: `${provider.id} ${provider.name || ""} ${provider.baseUrl} ${apiMeta(provider.api).short}`,
    subtitle: `${provider.models.length} 个模型 · ${apiMeta(provider.api).short}`,
    ready: provider.credentialConfigured,
    readyLabel: "凭据已配置",
    notReadyLabel: "未配置凭据",
    // Which provider Pi will actually use is the same question Codex answers in
    // its sidebar, so it is answered in the same place. Read from settings rather
    // than provider.isDefault: a local save updates settings.defaultProvider, and
    // deriving the mark from the same field keeps the two from disagreeing.
    // "默认", not "生效中": Pi resolves a provider per model, so nothing about the
    // other entries is switched off.
    badge: state.settings.defaultProvider && provider.id === state.settings.defaultProvider ? "默认" : "",
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

// A per-row overflow menu so 复制 / 删除 do not require opening the provider into
// the wizard first. It is a menu, not the model-row arm flow: 删除 opens the same
// named confirmation dialog the in-wizard button does, which is where the
// destructive step and its undo live. Closes on outside click, Escape, or a
// choice, and returns focus to the trigger.
function ProviderRowMenu({ provider, onDuplicate, onDelete }) {
  const [open, setOpen] = useState(false);
  const triggerRef = useRef(null);
  const menuRef = useRef(null);
  useEffect(() => {
    if (!open) return undefined;
    const onDocClick = (event) => {
      if (!menuRef.current?.contains(event.target) && !triggerRef.current?.contains(event.target)) setOpen(false);
    };
    const onKey = (event) => {
      if (event.key === "Escape") { setOpen(false); triggerRef.current?.focus(); }
    };
    document.addEventListener("mousedown", onDocClick);
    document.addEventListener("keydown", onKey);
    return () => {
      document.removeEventListener("mousedown", onDocClick);
      document.removeEventListener("keydown", onKey);
    };
  }, [open]);
  const choose = (action) => { setOpen(false); action(); };
  return (
    <span className="row-menu">
      <button
        type="button"
        ref={triggerRef}
        className="row-menu-trigger"
        aria-haspopup="menu"
        aria-expanded={open}
        aria-label={`${provider.name} 的更多操作`}
        onClick={(event) => { event.stopPropagation(); setOpen((value) => !value); }}
      >
        <DotsThree size={20} weight="bold" />
      </button>
      {open && (
        <span className="row-menu-popup" role="menu" ref={menuRef}>
          <button type="button" role="menuitem" onClick={(event) => { event.stopPropagation(); choose(() => onDuplicate(provider.id)); }}><Copy size={16} />复制供应商</button>
          <button type="button" role="menuitem" className="is-danger" onClick={(event) => { event.stopPropagation(); choose(() => onDelete(provider.id)); }}><Trash size={16} />删除供应商</button>
        </span>
      )}
    </span>
  );
}

function Sidebar({ state, target, loading, loadFailed, onTarget, onReload, onSelect, onAdd, onSettings, onPrompts, activeView, theme, onTheme, onDuplicate, onDelete, canBulkDelete, selectMode, selectedForDelete, onEnterSelect, onExitSelect, onToggleSelect, onReplaceSelection, onBulkDelete, selectedId }) {
  const [query, setQuery] = useState("");
  const providers = sidebarProviders(state, target);
  const listRef = useRef(null);
  const activeRowRef = useRef(null);
  // The row Pi marks 默认 / Codex marks 生效中 is the one worth surfacing: in a long
  // catalog it can sit below the fold, so bring it into view on mount and on a
  // target switch. Derived from the same badge the row renders, so "active" here
  // is exactly the mark the user is looking for.
  const activeId = providers.find((provider) => provider.badge)?.id || null;
  const [tipDismissed, setTipDismissed] = useState(() => {
    try {
      return localStorage.getItem("ppm.tip-dismissed") === "1";
    } catch {
      return false;
    }
  });
  const dismissTip = () => {
    setTipDismissed(true);
    try {
      localStorage.setItem("ppm.tip-dismissed", "1");
    } catch {
      // A dismissal that cannot be remembered still applies to this session.
    }
  };
  const keyword = query.trim().toLowerCase();
  const visible = keyword ? providers.filter((provider) => provider.keywords.toLowerCase().includes(keyword)) : providers;
  // Only auto-locate an unfiltered list: while the user is typing a filter, the
  // scroll position is theirs to control.
  useEffect(() => {
    if (keyword || !activeId) return;
    const row = activeRowRef.current;
    const list = listRef.current;
    if (!row || !list) return;
    const rowBox = row.getBoundingClientRect();
    const listBox = list.getBoundingClientRect();
    if (rowBox.top < listBox.top || rowBox.bottom > listBox.bottom) {
      row.scrollIntoView({ block: "nearest" });
    }
  }, [target, activeId, keyword]);
  // Re-measured whenever the rendered rows change, since a filtered list
  // changes scrollHeight without resizing the container.
  const listEdges = useScrollEdges(listRef, visible.length);
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
        {canBulkDelete && providers.length > 0 && !selectMode && (
          <button type="button" className="select-toggle" onClick={onEnterSelect}>选择</button>
        )}
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
      <nav
        ref={listRef}
        className={`provider-list ${listEdges.above ? "has-more-above" : ""} ${listEdges.below ? "has-more-below" : ""}`}
        aria-label="供应商列表"
      >
        {visible.map((provider) => {
          const Icon = provider.icon;
          const isSelected = selectedId === provider.id && activeView === "wizard";
          const checked = selectMode && selectedForDelete.has(provider.id);
          return (
            <div
              key={provider.id}
              ref={provider.id === activeId ? activeRowRef : undefined}
              className={`provider-item ${!selectMode && isSelected ? "is-selected" : ""} ${selectMode ? "is-selecting" : ""} ${checked ? "is-checked" : ""}`}
            >
              <button
                type="button"
                className="provider-select"
                onClick={selectMode ? () => onToggleSelect(provider.id) : () => onSelect(provider.source)}
                aria-current={!selectMode && isSelected ? "true" : undefined}
                role={selectMode ? "checkbox" : undefined}
                aria-checked={selectMode ? checked : undefined}
                title={`${provider.name} · ${provider.id}`}
              >
                {selectMode && <span className="provider-check" aria-hidden="true">{checked && <Check size={13} weight="bold" />}</span>}
                <span className="provider-icon"><Icon size={23} weight="duotone" aria-hidden="true" /></span>
                <span className="provider-copy">
                  <strong>{provider.name}</strong>
                  <small>{provider.subtitle}</small>
                </span>
                <span className="provider-trailing">
                  <span className="provider-badge">{provider.badge}</span>
                  <span
                    className={`status-dot ${provider.ready ? "is-ok" : "is-warn"}`}
                    role="img"
                    aria-label={provider.ready ? provider.readyLabel : provider.notReadyLabel}
                  />
                </span>
              </button>
              {!selectMode && <ProviderRowMenu provider={provider} onDuplicate={onDuplicate} onDelete={onDelete} />}
            </div>
          );
        })}
        {providers.length === 0 && !loading && loadFailed && (
          <p className="list-empty list-empty-first">
            <WarningCircle size={22} weight="duotone" aria-hidden="true" />
            <span>读取配置失败。<button type="button" className="link-button" onClick={onReload}>重新加载</button>后重试。</span>
          </p>
        )}
        {providers.length === 0 && !loading && !loadFailed && (
          <p className="list-empty list-empty-first">
            <Tray size={22} weight="duotone" aria-hidden="true" />
            <span>
              {isCodex
                ? "还没有 Codex 供应商。点击上面的“添加供应商”，三步就能接上一个网关。"
                : "还没有供应商。点击上面的“添加供应商”，三步就能接上一个网关。"}
            </span>
          </p>
        )}
        {providers.length > 0 && visible.length === 0 && (
          <p className="list-empty">没有名称或 ID 包含“{query.trim()}”的供应商。</p>
        )}
      </nav>
      {selectMode && (() => {
        const visibleIds = visible.map((provider) => provider.id);
        const allSelected = visibleIds.length > 0 && visibleIds.every((id) => selectedForDelete.has(id));
        return (
          <div className="bulk-action-bar">
            <button type="button" className="bulk-select-all" onClick={() => onReplaceSelection(allSelected ? [] : visibleIds)}>
              <span className={`provider-check ${allSelected ? "is-on" : ""}`} aria-hidden="true">{allSelected && <Check size={13} weight="bold" />}</span>
              {allSelected ? "取消全选" : "全选"}
            </button>
            <span className="bulk-action-count" aria-live="polite">已选 {selectedForDelete.size} 个</span>
            <button type="button" className="secondary-button compact-button" onClick={onExitSelect}>取消</button>
            <button type="button" className="danger-button compact-button" disabled={selectedForDelete.size === 0} onClick={onBulkDelete}><Trash size={16} />删除{selectedForDelete.size > 0 ? ` (${selectedForDelete.size})` : "选中"}</button>
          </div>
        );
      })()}
      {!tipDismissed && (
      <div className="beginner-tip">
        <Info size={22} weight="duotone" />
        <div>
          <strong>新手提示</strong>
          <span>{isCodex ? "Codex 只保留一个生效供应商，切换只影响新开的会话。" : "一个 API 网关可以添加多个不同厂商的模型。"}</span>
        </div>
        <button type="button" className="tip-dismiss" onClick={dismissTip} aria-label="不再显示新手提示"><X size={15} weight="bold" /></button>
      </div>
      )}
      <div className="sidebar-footer">
        <nav className="footer-nav" aria-label="次要导航">
          <button type="button" className={`settings-button nav-prompts ${activeView === "prompts" ? "is-active" : ""}`} onClick={onPrompts}><FileText size={20} />提示词</button>
          <button type="button" className={`settings-button nav-settings ${activeView === "settings" ? "is-active" : ""}`} onClick={onSettings}><Gear size={20} />设置与兼容性</button>
        </nav>
        {/* A utility row balanced at the two ends: the voluntary support link on
            the left, the appearance control on the right. The link leaves for
            eigentime.org/support — the one place that owns the payment platform
            — carrying a source so that page can tell this project apart. Nothing
            is tracked here: a loopback tool with a strict CSP and no analytics. */}
        <div className="footer-utility">
          <a
            className="sidebar-support"
            href="https://eigentime.org/support?from=pi-provider-manager"
            target="_blank"
            rel="noopener noreferrer"
          >
            <Heart size={16} weight="fill" />支持作者
          </a>
          <ThemeToggle theme={theme} onTheme={onTheme} />
        </div>
      </div>
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
          <button type="button" className="help-link" aria-expanded={showHint} aria-controls="protocol-hint" onClick={() => setShowHint((value) => !value)}>
            <Question size={19} />不确定选哪个？
          </button>
        </div>
        {showHint && (
          <div className="hint-panel" id="protocol-hint">
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

function CredentialsStep({ form, setForm, state, error, overwrites, apiFocusRequest, credentialFocus, onBack, onNext }) {
  const sources = state.authProviders.filter((id) => id !== form.providerId);
  const providerIdRef = useRef(null);
  const baseUrlRef = useRef(null);
  const apiKeyRef = useRef(null);
  const migrateRef = useRef(null);
  // A jump from the gateway summary lands the caret on the API address.
  useEffect(() => {
    if (!apiFocusRequest) return;
    requestAnimationFrame(() => baseUrlRef.current?.focus());
  }, [apiFocusRequest]);
  // A failed credential check focuses the offending field so the fix starts
  // where the problem is, not on the footer button that raised it.
  const erroredField = credentialFocus?.field || "";
  useEffect(() => {
    if (!credentialFocus?.serial) return;
    const target = { providerId: providerIdRef, baseUrl: baseUrlRef, apiKey: apiKeyRef, migrateFrom: migrateRef }[credentialFocus.field];
    requestAnimationFrame(() => target?.current?.focus());
  }, [credentialFocus?.serial]);
  const providerIdInvalid = form.providerId !== "" && !PROVIDER_ID_PATTERN.test(form.providerId);
  return (
    <section className="step-content form-step">
      <div className="step-scroll">
        <div className="section-heading"><div><h1>填写网关地址与凭据</h1><p>key 只会写入 Pi 的 auth.json，保存后不会再显示。</p></div></div>
        <div className="step-card">
        <div className="form-grid">
          <label><span>供应商 ID</span><small>例如 any-router；用于 Pi 内部识别</small><input className="mono" value={form.providerId} onChange={(event) => setForm((current) => {
            const providerId = event.target.value.toLowerCase().replace(/\s+/g, "-");
            // "keep" only means something while the id still names a stored credential.
            const keepStillValid = state.authProviders.includes(providerId);
            return { ...current, providerId, credentialMode: current.credentialMode === "keep" && !keepStillValid ? "new" : current.credentialMode };
          })} placeholder="any-router" spellCheck={false} autoCapitalize="off" autoCorrect="off" autoComplete="off" ref={providerIdRef} aria-invalid={providerIdInvalid || erroredField === "providerId" || undefined} aria-describedby={erroredField === "providerId" ? "credential-error-banner" : undefined} />{providerIdInvalid && <span className="field-warning"><WarningCircle size={15} weight="fill" />只能使用小写字母、数字、点、下划线和连字符，且以字母或数字开头。</span>}{overwrites && !providerIdInvalid && <span className="field-warning"><WarningCircle size={15} weight="fill" />已有同名供应商，保存会替换它的地址与模型列表。</span>}</label>
          <label><span>API 地址</span><small>填写接口根地址，不要包含具体模型路径</small><input ref={baseUrlRef} className="mono" type="url" inputMode="url" value={form.baseUrl} onChange={(event) => setForm((current) => ({ ...current, baseUrl: event.target.value }))} placeholder="https://api.example.com/v1" spellCheck={false} autoCapitalize="off" autoCorrect="off" autoComplete="off" aria-invalid={erroredField === "baseUrl" || undefined} aria-describedby={erroredField === "baseUrl" ? "credential-error-banner" : undefined} /></label>
        </div>
        <fieldset className="credential-box">
          <legend>访问凭据</legend>
          <div className="credential-tabs">
            {state.authProviders.includes(form.providerId) && <button type="button" className={form.credentialMode === "keep" ? "is-active" : ""} onClick={() => setForm((current) => ({ ...current, credentialMode: "keep" }))}>保留现有 key</button>}
            <button type="button" className={form.credentialMode === "new" ? "is-active" : ""} onClick={() => setForm((current) => ({ ...current, credentialMode: "new" }))}>输入新 key</button>
            {sources.length > 0 && <button type="button" className={form.credentialMode === "migrate" ? "is-active" : ""} onClick={() => setForm((current) => ({ ...current, credentialMode: "migrate", migrateFrom: current.migrateFrom || sources[0] }))}>从已有凭据迁移</button>}
          </div>
          {form.credentialMode === "keep" && <div className="credential-status"><ShieldCheck size={24} weight="duotone" /><div><strong>凭据已安全保存</strong><span>浏览器无法读取已保存的 key。</span></div></div>}
          {form.credentialMode === "new" && <label className="key-field"><span>API Key</span><div><Key size={20} /><input ref={apiKeyRef} className="mono" type="password" autoComplete="new-password" value={form.apiKey} onChange={(event) => setForm((current) => ({ ...current, apiKey: event.target.value }))} placeholder="输入后不会回显" aria-invalid={erroredField === "apiKey" || undefined} aria-describedby={erroredField === "apiKey" ? "credential-error-banner" : undefined} /></div></label>}
          {form.credentialMode === "migrate" && <div className="migrate-fields"><label><span>选择已有供应商</span><select ref={migrateRef} value={form.migrateFrom} onChange={(event) => setForm((current) => ({ ...current, migrateFrom: event.target.value }))} aria-invalid={erroredField === "migrateFrom" || undefined}>{sources.map((id) => <option key={id} value={id}>{titleFromId(id)} ({id})</option>)}</select></label><label className="checkbox-row"><input type="checkbox" checked={form.moveCredential} onChange={(event) => setForm((current) => ({ ...current, moveCredential: event.target.checked }))} />迁移成功后删除旧条目</label></div>}
        </fieldset>
        </div>
        <ErrorBanner message={error} id="credential-error-banner" />
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

function userAgentValidationError(value) {
  try {
    validateUserAgent(value);
    return "";
  } catch (problem) {
    return problem.message;
  }
}

function ModelsStep({ form, setForm, error, conflict, saving, onBack, onSave, onNotify, onDuplicate, onDeleteProvider, onDiscover, onEditProtocol, onEditGateway, canDeleteProvider, isExistingProvider, isCurrentDefault, hasProviders, dirty, liveDefaultModelId, userAgentFocusRequest, betaFocusRequest }) {
  const [showBulk, setShowBulk] = useState(false);
  const [bulkText, setBulkText] = useState("");
  const [showDiscover, setShowDiscover] = useState(false);
  const [scrolled, setScrolled] = useState(false);
  const [jsonDraft, setJsonDraft] = useState(null);
  const advancedRef = useRef(null);
  const userAgentRef = useRef(null);
  const betaRef = useRef(null);
  const betaInputRef = useRef(null);
  const betaModels = form.models.filter((model) => model.id.trim());
  const initialBetaModel = betaModels.find((model) => (model.api === "inherit" ? form.api : model.api) === "anthropic-messages" || model.anthropicBetaKind !== "none") || betaModels[0];
  const [betaRowId, setBetaRowId] = useState("");
  const betaModel = betaModels.find((model) => model.rowId === betaRowId) || initialBetaModel;
  const betaIsAnthropic = betaModel ? (betaModel.api === "inherit" ? form.api : betaModel.api) === "anthropic-messages" : false;
  const betaError = betaModel && betaModel.anthropicBetaKind === "literal" ? (() => { try { normalizeAnthropicBeta(betaModel.anthropicBeta); return ""; } catch (problem) { return problem.message; } })() : "";
  useEffect(() => { if (!betaFocusRequest?.serial) return; setBetaRowId(betaFocusRequest.rowId || ""); advancedRef.current?.setAttribute("open", ""); requestAnimationFrame(() => betaInputRef.current?.focus()); }, [betaFocusRequest?.serial]);
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
  // Shared by the paste dialog and the gateway listing: rows are appended, IDs
  // already in the draft are skipped, and a lone blank first row gives way.
  const addModelEntries = (entries) => {
    setForm((current) => {
      const existing = new Set(current.models.map((model) => model.id).filter(Boolean));
      const additions = [];
      for (const entry of entries) {
        if (existing.has(entry.id)) continue;
        existing.add(entry.id);
        additions.push({ ...blankModel(entry.id), name: entry.name || entry.id });
      }
      const hasOnlyBlank = current.models.length === 1 && !current.models[0].id;
      const models = [...(hasOnlyBlank ? [] : current.models), ...additions];
      const defaultRowId = models.some((model) => model.rowId === current.defaultRowId) ? current.defaultRowId : models[0]?.rowId || "";
      return { ...current, models, defaultRowId };
    });
  };
  const importModels = () => {
    if (newBulkIds.length === 0) return;
    addModelEntries(bulkIds.map((id) => ({ id })));
    setBulkText("");
    setShowBulk(false);
  };
  const importDiscovered = (entries) => {
    const fresh = entries.filter((entry) => !existingIds.has(entry.id));
    if (fresh.length === 0) return;
    addModelEntries(fresh);
    setShowDiscover(false);
    onNotify(`已从网关导入 ${fresh.length} 个模型；保存后才会写入`);
  };
  const thinkingAliasModels = form.models.filter((model) => /-(max|xhigh)$/i.test(model.id));
  const currentApi = apiMeta(form.api);
  const namedModels = form.models.filter((model) => model.id.trim()).length;
  // A long catalogue gets a display-only filter (never touches the default radio
  // or what a save posts) once it passes eight rows, mirroring the sidebar's own
  // filter threshold.
  const [modelFilter, setModelFilter] = useState("");
  const showModelFilter = form.models.length > 8;
  const modelFilterText = modelFilter.trim().toLowerCase();
  const visibleModels = showModelFilter && modelFilterText
    ? form.models.filter((model) => model.id.toLowerCase().includes(modelFilterText))
    : form.models;
  // Protocol overrides: list only the models that actually carry one, plus a
  // picker to add an override to a model that inherits — instead of a select for
  // every row in a long catalogue.
  const overriddenModels = form.models.filter((model) => model.api && model.api !== "inherit");
  const inheritingModels = form.models.filter((model) => (!model.api || model.api === "inherit") && model.id.trim());
  const userAgentError = userAgentValidationError(form.userAgent);
  const externalUserAgent = form.userAgentKind === "external" && !form.userAgentEdited;
  const userAgentSummary = externalUserAgent
    ? "UA 由外部配置"
    : form.userAgentKind === "literal" && !form.userAgentEdited
      ? "已配置 UA"
      : "";
  useEffect(() => {
    if (!userAgentFocusRequest || !userAgentError) return;
    advancedRef.current?.setAttribute("open", "");
    requestAnimationFrame(() => {
      userAgentRef.current?.scrollIntoView({ block: "center", behavior: "smooth" });
      userAgentRef.current?.focus();
    });
  }, [userAgentFocusRequest, userAgentError]);
  const changeUserAgent = (value) => {
    setForm((current) => ({
      ...current,
      userAgent: value,
      userAgentKind: value.trim() ? "literal" : "none",
      userAgentEdited: true,
    }));
  };
  const fillUserAgent = (value) => {
    const before = {
      userAgent: form.userAgent,
      userAgentKind: form.userAgentKind,
      userAgentEdited: form.userAgentEdited,
    };
    const providerId = form.providerId;
    changeUserAgent(value);
    onNotify("已更新草稿", "success", {
      label: "撤销",
      onAction: () => setForm((current) => (
        current.providerId === providerId && current.userAgent === value && current.userAgentEdited
          ? { ...current, ...before }
          : current
      )),
    });
  };
  const clearUserAgent = () => fillUserAgent("");
  // The advanced JSON editor holds its own text while open, seeded from the
  // current draft. 应用到表单 parses it and maps it back through the same form the
  // table edits, so Save still runs every check (default model, identity drift,
  // and the server's revision/409). Editing is opt-in: the seed is taken when
  // the editor opens, not kept in sync, so table edits and the textarea never
  // fight over the same state.
  const openJsonEditor = () => setJsonDraft(piFormToConfigJson(form));
  const applyJsonDraft = () => {
    let parsed;
    try {
      parsed = JSON.parse(jsonDraft);
    } catch {
      onNotify("JSON 无法解析，请先修正语法。", "error");
      return;
    }
    let next;
    try {
      next = piConfigJsonToForm(parsed, form);
    } catch (problem) {
      onNotify(problem.message, "error");
      return;
    }
    const previous = form;
    setForm(next);
    setJsonDraft(null);
    onNotify("已把配置 JSON 应用到表单；保存前不会写入 Pi。", "success", { label: "撤销", onAction: () => setForm(previous) });
  };
  return (
    <section className="step-content models-step">
      <div className="step-scroll">
        <div className="section-heading">
          <div><h1>确认并选择可用模型</h1><p>一个 API 网关可以添加多个不同厂商的模型，并指定 Pi 默认使用哪个。</p></div>
        </div>
        <div className="gateway-summary">
          <span className="summary-icon"><ProviderIcon api={form.api} size={34} /></span>
          <div><strong>{titleFromId(form.providerId || "new-provider")}</strong>{isExistingProvider ? <button type="button" className="protocol-badge protocol-badge-button" onClick={onEditProtocol} title="回到第一步改协议">{currentApi.title}</button> : <span className="protocol-badge">{currentApi.title}</span>}{isExistingProvider ? <p>API 地址　<button type="button" className="gateway-address-button mono" onClick={onEditGateway} title={form.baseUrl || undefined}>{form.baseUrl || "尚未填写"}</button></p> : <p title={form.baseUrl || undefined}>API 地址　<code>{form.baseUrl || "尚未填写"}</code></p>}</div>
          <div className="gateway-side">
            <div className="saved-credential"><ShieldCheck size={29} weight="duotone" /><span><strong>{form.credentialMode === "keep" ? "凭据已安全保存" : "凭据将在保存时写入"}</strong><small>{form.credentialMode === "keep" ? "浏览器无法读取旧 key" : "当前草稿尚未写入 Pi 配置"}</small></span></div>
            {isExistingProvider && (
              <button type="button" className="duplicate-provider-button" onClick={onDuplicate} title="以当前配置为模板新建：模型与兼容设置照搬，凭据需要另填">
                <Copy size={18} />复制供应商
              </button>
            )}
            {canDeleteProvider && (
              <button type="button" className="delete-provider-button" onClick={() => onDeleteProvider()}>
                <Trash size={18} />删除供应商
              </button>
            )}
          </div>
        </div>
        <div className="models-header">
          <div><h2>模型列表<span className="count-pill">{showModelFilter && modelFilterText ? `匹配 ${visibleModels.length} / 共 ${form.models.length}` : namedModels}</span></h2><p>Pi 以 provider/model 选择模型，thinking level 是独立设置。</p>{showModelFilter && <input className="model-filter mono" type="search" value={modelFilter} onChange={(event) => setModelFilter(event.target.value)} placeholder="筛选模型 ID" aria-label="筛选模型 ID" spellCheck={false} autoCapitalize="off" autoCorrect="off" autoComplete="off" />}</div>
          <div className="models-actions">
            <button type="button" className="secondary-button compact-button" onClick={applySafeToAll} title="把所有模型的上下文容量与最大输出改为安全值，可撤销" aria-label="全部用安全值"><ShieldCheck size={18} /><span className="button-label">全部用安全值</span></button>
            <button type="button" className="secondary-button compact-button" onClick={() => setShowDiscover(true)} title="向网关请求模型清单，勾选后加入列表" aria-label="获取模型"><CloudArrowDown size={18} /><span className="button-label">获取模型</span></button>
            <button type="button" className="secondary-button compact-button" onClick={() => setShowBulk(true)} title="批量添加模型 ID" aria-label="批量添加"><ListPlus size={18} /><span className="button-label">批量添加</span></button>
            <button type="button" className="outline-button compact-button" onClick={addModel} title="添加模型" aria-label="添加模型"><Plus size={19} /><span className="button-label">添加模型</span></button>
          </div>
        </div>
        {thinkingAliasModels.length > 0 && <div className="model-warning"><WarningCircle size={20} weight="fill" /><span><strong>发现疑似思考档位后缀：</strong>{thinkingAliasModels.map((model) => model.id).join("、")}。只有网关真的把它们作为模型 ID 时才应保留；否则用右侧“推理能力”和 Pi 的 Shift+Tab 切换。</span></div>}
        <div className={`models-table ${scrolled ? "is-scrolled" : ""}`} onScroll={(event) => setScrolled(event.currentTarget.scrollTop > 2)}>
          <div className="model-table-head"><span>模型 ID</span><span>上下文容量</span><span>最大输出</span><span>图像能力</span><span>推理能力</span><span>默认模型</span><span className="model-action-cell" /></div>
          {visibleModels.map((model) => <ModelRow key={model.rowId} model={model} isDefault={form.defaultRowId === model.rowId && Boolean(model.id.trim())} isLiveDefault={Boolean(liveDefaultModelId) && model.id.trim() === liveDefaultModelId} onChange={(value) => updateModel(model.rowId, value)} onSafeDefaults={() => updateModel(model.rowId, { ...model, ...safeDefaults(model.id) })} onDefault={() => setForm((current) => ({ ...current, defaultRowId: model.rowId }))} onArmRemove={() => armRemoveModel(model)} onRemove={() => removeModel(model.rowId)} onBlockedRemove={blockLastModelRemoval} canRemove={form.models.length > 1} />)}
          {showModelFilter && modelFilterText && visibleModels.length === 0 && <p className="list-empty">没有匹配 <code className="mono">{modelFilter.trim()}</code> 的模型。</p>}
        </div>
        <p className="scroll-hint">表格可左右滑动，查看上下文容量、图像与推理能力等字段。</p>
        <div className="models-note"><ShieldCheck size={21} weight="duotone" />未指定的能力项将使用保守默认值，不影响正常使用。</div>
        <details ref={advancedRef} className="advanced-panel">
          <summary><span><SlidersHorizontal size={21} />高级兼容设置 <small>通常无需修改</small>{userAgentSummary && <small>{userAgentSummary}</small>}</span><CaretDown size={19} /></summary>
          <div className="advanced-content">
            <div className="advanced-group user-agent-group">
              <div className="advanced-group-heading"><h3>供应商请求设置</h3><p>User-Agent 是供应商级配置，会作用于此供应商下的模型；模型自身或扩展配置可能覆盖它。</p></div>
              {externalUserAgent && <p className="advanced-external-note"><Info size={17} weight="duotone" />已有外部 UA 配置，保存其他设置将保留它。输入或清除后才会明确替换。</p>}
              <label className="user-agent-field">
                <span>User-Agent</span>
                <small>仅在网关明确要求时填写；不执行动态表达式。</small>
                <input
                  ref={userAgentRef}
                  className="mono"
                  value={form.userAgent}
                  onChange={(event) => changeUserAgent(event.target.value)}
                  placeholder="未设置供应商 UA 覆盖"
                  aria-invalid={Boolean(userAgentError) || undefined}
                  aria-describedby={userAgentError ? "user-agent-error" : undefined}
                  spellCheck={false}
                  autoCapitalize="off"
                  autoCorrect="off"
                  autoComplete="off"
                />
                {userAgentError && <span id="user-agent-error" className="field-error"><WarningCircle size={15} weight="fill" />{userAgentError}</span>}
              </label>
              <div className="user-agent-actions">
                <span>快速填充：</span>
                {USER_AGENT_PRESETS.map((preset) => <button key={preset.id} type="button" className="outline-button compact-button" onClick={() => fillUserAgent(preset.value)} title="仅作填写示例，不保证网关接受">{preset.label}</button>)}
                <button type="button" className="secondary-button compact-button" onClick={clearUserAgent}>清除供应商 UA 覆盖</button>
              </div>
              <p className="user-agent-disclaimer">四个值仅作填写示例，不保证网关接受；模板不会保存为单独的 preset。</p>
              {form.hasModelUserAgentOverride && <p className="compat-note"><Info size={17} weight="duotone" />检测到模型级 UA 覆盖，实际请求可能优先使用模型配置。</p>}
            </div>
            <div className="advanced-group beta-group" ref={betaRef}>
              <div className="advanced-group-heading"><h3>Anthropic Beta 请求头（覆盖）</h3><p>仅在网关要求时配置。Pi 会用这里的列表替换默认 Beta 列表，可能影响工具流式、思考与 OAuth；供应商或扩展配置仍可能覆盖它。</p></div>
              <label className="beta-model-field"><span>选择模型</span><select className="mono" value={betaModel?.rowId || ""} onChange={(event) => setBetaRowId(event.target.value)} aria-label="选择要编辑 Anthropic Beta 的模型">{betaModels.length === 0 && <option value="">暂无已命名模型</option>}{betaModels.map((model) => { const effective = model.api === "inherit" ? form.api : model.api; const status = model.anthropicBetaKind === "literal" ? " · 已设置" : model.anthropicBetaKind === "external" ? " · 外部配置" : ""; return <option key={model.rowId} value={model.rowId}>{model.id}{effective === "anthropic-messages" ? " · Anthropic" : " · " + apiMeta(effective).short}{status}</option>; })}</select></label>
              {betaModel && betaModel.anthropicBetaKind === "external" && <p className="advanced-external-note"><Info size={17} weight="duotone" />已有外部配置，原文不会回传到浏览器。清除后才会明确移除模型覆盖。</p>}
              {betaModel && !betaIsAnthropic && <p className="compat-note"><Info size={17} weight="duotone" />这个模型的有效协议不是 Anthropic Messages。Pi 仍会把这个请求头原样发出，但多数非 Anthropic 网关会忽略它。</p>}
              <label className="beta-value-field"><span>Beta token 列表</span><small id="anthropic-beta-help">逗号分隔的 ASCII token，例如 <code>context-1m-2025-08-07</code>。动态表达式不会执行。</small><input ref={betaInputRef} className="mono" value={betaModel?.anthropicBetaKind === "external" ? "" : betaModel?.anthropicBeta || ""} disabled={!betaModel} onChange={(event) => { const value = event.target.value; if (!betaModel) return; updateModel(betaModel.rowId, { ...betaModel, anthropicBeta: value, anthropicBetaKind: value ? "literal" : "none", anthropicBetaEdited: true }); }} placeholder="未设置模型 Beta 覆盖" aria-invalid={Boolean(betaError) || undefined} aria-describedby={betaError ? "anthropic-beta-help anthropic-beta-error" : "anthropic-beta-help"} spellCheck={false} autoCapitalize="off" autoCorrect="off" autoComplete="off" />{betaError && <span id="anthropic-beta-error" className="field-error"><WarningCircle size={15} weight="fill" />{betaError}</span>}</label>
              <div className="beta-actions"><button type="button" className="outline-button compact-button" disabled={!betaModel} onClick={() => { if (!betaModel) return; const before = betaModel; const nextValue = "context-1m-2025-08-07"; updateModel(betaModel.rowId, { ...betaModel, anthropicBeta: nextValue, anthropicBetaKind: "literal", anthropicBetaEdited: true }); onNotify("已填入网关旧版 1M 示例；保存后才会写入", "success", { label: "撤销", onAction: () => setForm((current) => ({ ...current, models: current.models.map((item) => item.rowId === before.rowId && item.anthropicBeta === nextValue ? { ...item, anthropicBeta: before.anthropicBeta, anthropicBetaKind: before.anthropicBetaKind, anthropicBetaEdited: before.anthropicBetaEdited } : item) })) }); }}>填入网关旧版 1M 示例</button><button type="button" className="secondary-button compact-button" disabled={!betaModel} onClick={() => { if (!betaModel) return; const before = betaModel; updateModel(betaModel.rowId, { ...betaModel, anthropicBeta: "", anthropicBetaKind: "none", anthropicBetaEdited: true }); onNotify("已清除模型 Beta 覆盖；保存后才会移除", "success", { label: "撤销", onAction: () => setForm((current) => ({ ...current, models: current.models.map((item) => item.rowId === before.rowId && item.anthropicBeta === "" ? { ...item, anthropicBeta: before.anthropicBeta, anthropicBetaKind: before.anthropicBetaKind, anthropicBetaEdited: before.anthropicBetaEdited } : item) })) }); }}>清除模型覆盖</button></div>
              <p className="user-agent-disclaimer">留空表示没有模型级覆盖；Pi 默认值或其他配置仍可能提供 Beta 请求头。</p>
            </div>
            <div className="advanced-group protocol-group">
              <div className="advanced-group-heading"><h3>模型协议覆盖</h3><p>只有网关针对某个模型使用不同接口时才需要设置。默认全部继承网关协议。</p></div>
              {overriddenModels.length === 0 && <p className="user-agent-disclaimer">当前没有模型设置协议覆盖。</p>}
              {overriddenModels.map((model) => <label key={model.rowId}><span className="mono">{model.id || "未命名模型"}</span><select value={model.api} onChange={(event) => updateModel(model.rowId, { ...model, api: event.target.value })}><option value="inherit">继承网关默认协议（移除覆盖）</option>{API_OPTIONS.map((option) => <option key={option.id} value={option.id}>{option.title}</option>)}</select></label>)}
              {inheritingModels.length > 0 && (
                <label className="protocol-add-field"><span>为模型添加覆盖</span><select value="" onChange={(event) => { const rowId = event.target.value; if (!rowId) return; const model = form.models.find((item) => item.rowId === rowId); if (model) updateModel(rowId, { ...model, api: API_OPTIONS[0].id }); }}><option value="">选择一个模型…</option>{inheritingModels.map((model) => <option key={model.rowId} value={model.rowId}>{model.id}</option>)}</select></label>
              )}
            </div>
            <div className="advanced-group json-group">
              <div className="advanced-group-heading"><h3>配置 JSON（进阶）</h3><p>直接编辑该供应商的地址、协议与模型列表（不包含凭据）。应用后仍需点保存，服务端会做完整校验。</p></div>
              {jsonDraft === null ? (
                <button type="button" className="outline-button compact-button" onClick={openJsonEditor}><SlidersHorizontal size={16} />编辑原始配置</button>
              ) : (
                <>
                  <ConfigEditor
                    value={jsonDraft}
                    onChange={setJsonDraft}
                    validate={validateJson}
                    format={formatJson}
                    rows={16}
                    language="json"
                    ariaLabel="供应商配置 JSON"
                  />
                  <div className="json-editor-actions">
                    <button type="button" className="secondary-button compact-button" onClick={() => setJsonDraft(null)}>取消</button>
                    <button type="button" className="primary-button compact-button" onClick={applyJsonDraft}>应用到表单</button>
                  </div>
                  <p className="user-agent-disclaimer">在这里改模型 ID 等同于删掉旧模型、新增一个：旧模型保存的兼容信息会一并丢失。</p>
                </>
              )}
            </div>
          </div>
        </details>
        <ErrorBanner message={error} conflict={conflict} />
      </div>
      <footer className="wizard-footer">
        <button type="button" className="secondary-button" onClick={onBack}><ArrowLeft size={19} />上一步</button>
        <div className="footer-end">
          {isExistingProvider && (
            <span className="dirty-note" aria-live="polite">{dirty ? "有未保存的修改" : "没有改动"}</span>
          )}
          {isExistingProvider ? (
            isCurrentDefault ? (
              // Already Pi's default: one button, still setDefault:true so the
              // default model follows the selected radio, worded as a plain save.
              <button type="button" className="primary-button" disabled={saving || !dirty} onClick={() => onSave(true)}>{saving ? <><Spinner />正在保存…</> : "保存更改"}</button>
            ) : (
              <div className="footer-actions">
                <button type="button" className="outline-button" disabled={saving || !dirty} onClick={() => onSave(true)}>保存并设为默认</button>
                <button type="button" className="primary-button" disabled={saving || !dirty} onClick={() => onSave(false)}>{saving ? <><Spinner />正在保存…</> : "保存更改"}</button>
              </div>
            )
          ) : hasProviders ? (
            // A new provider added alongside existing ones must not silently
            // steal the global default: offer 只保存 as well as 保存并设为默认.
            <div className="footer-actions">
              <button type="button" className="outline-button" disabled={saving} onClick={() => onSave(false)}>只保存</button>
              <button type="button" className="primary-button" disabled={saving} onClick={() => onSave(true)}>{saving ? <><Spinner />正在保存…</> : "保存并设为默认"}</button>
            </div>
          ) : (
            // The very first provider has nothing to displace, so setting it as
            // the default is the only sensible action.
            <button type="button" className="primary-button" disabled={saving} onClick={() => onSave(true)}>{saving ? <><Spinner />正在保存…</> : "保存并设为默认"}</button>
          )}
        </div>
      </footer>
      {showBulk && <BulkModal text={bulkText} ids={bulkIds} newIds={newBulkIds} onText={setBulkText} onClose={() => setShowBulk(false)} onImport={importModels} />}
      {showDiscover && <DiscoverModal baseUrl={form.baseUrl.trim()} defaultPath={defaultDiscoveryPath(form.api)} existingIds={existingIds} onDiscover={onDiscover} onClose={() => setShowDiscover(false)} onImport={importDiscovered} />}
    </section>
  );
}

// The gateway's own catalogue, offered as checkboxes. The request runs on the
// server with the credential the draft would save with — a key typed at step
// two or the one already stored — so nothing secret passes through here; the
// dialog only ever sees IDs and display names.
function DiscoverModal({ baseUrl, defaultPath, existingIds, onDiscover, onClose, onImport }) {
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
  const [pathDraft, setPathDraft] = useState("");
  const [askedPath, setAskedPath] = useState("");
  const [endpoint, setEndpoint] = useState("");
  const pathRef = useRef(null);
  useDialog({ ref: dialogRef, initialFocusRef: filterRef, onClose, locked: status === "loading" });
  useEffect(() => {
    let cancelled = false;
    setStatus("loading");
    setMessage("");
    onDiscover(askedPath)
      .then((result) => {
        if (cancelled) return;
        setModels(result.models);
        setEndpoint(result.endpoint || "");
        setSelected(new Set());
        setStatus("ready");
      })
      .catch((problem) => {
        if (cancelled) return;
        setMessage(problem.message);
        setStatus("error");
      });
    return () => { cancelled = true; };
    // askedPath only changes together with attempt, via retry.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [attempt, onDiscover]);
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
          <div><h2 id="discover-title">从网关获取模型列表</h2><p>向 <code>{endpoint || `${baseUrl || "（尚未填写地址）"}${askedPath || defaultPath}`}</code> 请求模型清单。key 只在本机服务里使用，不会回传浏览器；勾选后加入列表，保存后才会写入。</p></div>
          <button type="button" className="icon-button" onClick={onClose} disabled={status === "loading"} aria-label="关闭"><X size={20} /></button>
        </div>
        {status === "loading" && <div className="discover-status" role="status"><Spinner />正在向网关请求模型列表…</div>}
        {status === "error" && <ErrorBanner message={message} />}
        {status !== "loading" && (
          <label className="discover-path">
            <span>模型列表路径</span>
            <small id="discover-path-help">留空使用协议默认值 <code>{defaultPath}</code>。相对于 API 地址，必须同源。</small>
            <span className="discover-path-row">
              <input
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
              <button type="button" className="outline-button compact-button" onClick={retry}><ArrowsClockwise size={16} />用这个路径重试</button>
            </span>
          </label>
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
                    <input type="checkbox" checked={exists || selected.has(model.id)} disabled={exists} onChange={() => toggle(model.id)} aria-label={model.id} />
                    <span className="mono">{model.id}</span>
                    <small>{exists ? "已在列表中" : model.name || ""}</small>
                  </label>
                );
              })}
            </div>
          </>
        )}
        <div className="modal-actions">
          {status === "ready" && (
            <div className="discover-bulk-actions">
              <button type="button" className="outline-button compact-button" onClick={selectVisible} disabled={selectable.length === 0}>全选{needle ? "匹配项" : ""}</button>
              <button type="button" className="outline-button compact-button" onClick={clearSelection} disabled={chosen.length === 0}>清空</button>
            </div>
          )}
          <span className="modal-count" aria-live="polite">
            {status === "ready" ? (models.length === 0 ? "没有可导入的模型" : `网关返回 ${models.length} 个模型，已选 ${chosen.length} 个`) : ""}
          </span>
          <button type="button" className="secondary-button" onClick={onClose} disabled={status === "loading"}>取消</button>
          <button type="button" className="primary-button" disabled={chosen.length === 0} onClick={() => onImport(chosen)}>{chosen.length > 0 ? `导入 ${chosen.length} 个模型` : "导入模型"}</button>
        </div>
      </section>
    </div>
  );
}

function ProviderDeleteDialog({ provider, state, deleting, requestError, conflict, onClose, onConfirm }) {
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

  useDialog({ ref: dialogRef, initialFocusRef: cancelRef, onClose, locked: deleting });

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
        <ErrorBanner message={localError || requestError} conflict={conflict && !localError} />

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

// The bulk counterpart to ProviderDeleteDialog. It names the whole set, and when
// Pi's default is among them it asks for a replacement drawn only from the
// survivors — the server refuses a replacement that is itself being deleted, so
// the picker must never offer one.
function ProviderBulkDeleteDialog({ providerIds, state, deleting, requestError, conflict, onClose, onConfirm }) {
  const idSet = new Set(providerIds);
  const chosen = state.providers.filter((item) => idSet.has(item.id));
  const defaultIncluded = Boolean(state.settings.defaultProvider) && idSet.has(state.settings.defaultProvider);
  const survivors = state.providers.filter((item) => !idSet.has(item.id) && item.models.length > 0);
  const [keepCredentials, setKeepCredentials] = useState(false);
  const [replacementProviderId, setReplacementProviderId] = useState(survivors[0]?.id || "");
  const [replacementModelId, setReplacementModelId] = useState(survivors[0]?.models[0]?.id || "");
  const [localError, setLocalError] = useState("");
  const cancelRef = useRef(null);
  const dialogRef = useRef(null);
  const replacementProvider = survivors.find((item) => item.id === replacementProviderId);
  const anyCredential = chosen.some((item) => item.credentialConfigured);
  const canDelete = !defaultIncluded || Boolean(replacementProvider && replacementModelId);

  useDialog({ ref: dialogRef, initialFocusRef: cancelRef, onClose, locked: deleting });

  const changeReplacementProvider = (providerId) => {
    const next = survivors.find((item) => item.id === providerId);
    setReplacementProviderId(providerId);
    setReplacementModelId(next?.models[0]?.id || "");
    setLocalError("");
  };
  const confirm = () => {
    if (!canDelete) {
      setLocalError("待删除的集合包含 Pi 当前默认供应商，请先选一个保留下来的供应商作为替代。");
      return;
    }
    setLocalError("");
    onConfirm({
      providerIds,
      keepCredentials,
      replacementProviderId: defaultIncluded ? replacementProviderId : undefined,
      replacementModelId: defaultIncluded ? replacementModelId : undefined,
    });
  };

  return (
    <div className="modal-backdrop" role="presentation" onMouseDown={(event) => { if (event.target === event.currentTarget && !deleting) onClose(); }}>
      <section ref={dialogRef} className="provider-delete-dialog" role="dialog" aria-modal="true" aria-labelledby="provider-bulk-delete-title" aria-describedby="provider-bulk-delete-description">
        <div className="delete-dialog-heading">
          <span className="delete-dialog-icon"><Trash size={24} weight="duotone" /></span>
          <div>
            <h2 id="provider-bulk-delete-title">删除选中的 {chosen.length} 个供应商？</h2>
            <p id="provider-bulk-delete-description">以下供应商及其全部模型会从 <code>models.json</code> 移除。</p>
          </div>
        </div>

        <ul className="bulk-delete-list">
          {chosen.map((item) => (
            <li key={item.id}>
              <span className="bulk-delete-name">{item.name || titleFromId(item.id)}</span>
              <code>{item.id}</code>
              <span className="bulk-delete-count">{item.models.length} 个模型</span>
              {state.settings.defaultProvider === item.id && <span className="provider-badge">默认</span>}
            </li>
          ))}
        </ul>

        {defaultIncluded && (
          <div className="replacement-panel">
            <div className="replacement-warning"><WarningCircle size={20} weight="fill" /><span><strong>集合里包含 Pi 当前的默认供应商</strong>删除前必须从保留下来的供应商里选一个替代模型。</span></div>
            {survivors.length > 0 ? (
              <div className="replacement-fields">
                <label><span>替代供应商</span><select value={replacementProviderId} onChange={(event) => changeReplacementProvider(event.target.value)}>{survivors.map((item) => <option key={item.id} value={item.id}>{item.name || titleFromId(item.id)} · {item.id}</option>)}</select></label>
                <label><span>替代模型</span><select value={replacementModelId} onChange={(event) => { setReplacementModelId(event.target.value); setLocalError(""); }}>{(replacementProvider?.models || []).map((model) => <option key={model.id} value={model.id}>{model.name || model.id} · {model.id}</option>)}</select></label>
              </div>
            ) : (
              <p className="no-replacement">删除这些之后没有带模型的供应商了。请取消后保留至少一个可承载默认的供应商。</p>
            )}
          </div>
        )}

        {anyCredential && (
          <label className="keep-credential-option">
            <input type="checkbox" checked={keepCredentials} onChange={(event) => setKeepCredentials(event.target.checked)} />
            <span><strong>保留凭据，供以后重新配置使用</strong><small>凭据会留在 <code>auth.json</code>，但不会继续显示为供应商。</small></span>
          </label>
        )}
        <p className="delete-consequence">
          {!anyCredential
            ? "选中的供应商和全部模型会被永久删除。"
            : keepCredentials
            ? "选中的供应商和模型会被永久删除，已保存的凭据会保留。"
            : "选中的供应商、全部模型和已保存的凭据会被永久删除。"}
        </p>
        <ErrorBanner message={localError || requestError} conflict={conflict && !localError} />

        <div className="modal-actions">
          <button ref={cancelRef} type="button" className="secondary-button" disabled={deleting} onClick={onClose}>取消</button>
          <button type="button" className="danger-button" disabled={deleting} aria-disabled={!canDelete || deleting} onClick={confirm}>
            {deleting ? <><Spinner />正在删除…</> : <><Trash size={18} />删除 {chosen.length} 个供应商</>}
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
  const userAgentSummary = result.userAgent?.kind === "external"
    ? "由外部配置"
    : result.userAgent?.kind === "literal"
      ? <code>{result.userAgent.value}</code>
      : "未设置覆盖";
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
      <p className="success-caveat"><Info size={18} weight="duotone" />供应商 UA：{userAgentSummary}{result.hasModelUserAgentOverride ? "；模型级配置可能覆盖它" : ""}</p>
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

function SettingsScreen({ state, saving, error, conflict, demoMode, onSave, onBack, onDirtyChange }) {
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
  // Report only real edits up to the shared leave guard: an unwritten default is
  // not something navigation can lose (settings.json does not carry it, and will
  // not afterwards), so it must not arm a discard prompt.
  useEffect(() => {
    onDirtyChange?.(edited);
    return () => onDirtyChange?.(false);
  }, [edited, onDirtyChange]);
  const installedPi = state.compatibility?.piVersion;
  const validatedPi = state.compatibility?.validatedPiVersion;
  const piVersionDiffers = Boolean(installedPi) && installedPi !== "unknown"
    && Boolean(validatedPi) && validatedPi !== "unknown" && installedPi !== validatedPi;
  // Held locally rather than read from `state`: the page's copy of the server state
  // was fetched at mount, and a check made now is newer than that. The apply job
  // reports through /api/state, so the same field is refreshed while it runs.
  const [updateInfo, setUpdateInfo] = useState(state.update || {});
  const [updateBusy, setUpdateBusy] = useState("");
  const [updateError, setUpdateError] = useState("");
  // A successful pull moves the version on disk, which this page learned before
  // `state` could. Without this the restart button below would still offer a plain
  // restart with an upgrade sitting there waiting.
  const [pendingOverride, setPendingOverride] = useState("");
  // null means "nothing newer than `state` to say". A pull that has not been built
  // yet appears between mount and the end of an upgrade, so the answer has to be
  // allowed to change without a page load.
  const [bundleOverride, setBundleOverride] = useState(null);
  // The versions on the card describe the running process, not the checkout on
  // disk. Without this, an upgrade that was installed but not restarted reads as an
  // upgrade that failed — every number there is simply the old one.
  const pendingApp = pendingOverride || state.compatibility?.pendingAppVersion || "";
  // A source tree newer than the bundle it is served from. Restarting there swaps
  // the server and leaves the page, which is the one outcome of a half-finished
  // upgrade that looks like it worked.
  const bundleProblem = bundleOverride === null ? (state.compatibility?.bundleProblem || "") : bundleOverride;
  const checkUpdate = async () => {
    setUpdateBusy("checking");
    setUpdateError("");
    try {
      const data = await readApiResponse(
        await fetch("/api/update/check", { method: "POST", headers: { "Content-Type": "application/json" }, body: "{}" }),
        "检查更新失败。",
      );
      setUpdateInfo(data.update || {});
    } catch (problem) {
      setUpdateError(problem.message);
    } finally {
      setUpdateBusy("");
    }
  };
  const applyUpdate = async () => {
    setUpdateBusy("applying");
    setUpdateError("");
    try {
      await readApiResponse(
        await fetch("/api/update/apply", { method: "POST", headers: { "Content-Type": "application/json" }, body: "{}" }),
        "无法开始更新。",
      );
      // Polled rather than awaited: `npm ci` and a build take minutes, and the
      // steps have to appear as they finish rather than all at the end.
      const deadline = Date.now() + 15 * 60_000;
      while (Date.now() < deadline) {
        await new Promise((resolve) => setTimeout(resolve, 1_000));
        const next = await fetch("/api/state", { cache: "no-store" }).then((reply) => reply.json());
        if (next.update) setUpdateInfo(next.update);
        setPendingOverride(next.compatibility?.pendingAppVersion || "");
        setBundleOverride(next.compatibility?.bundleProblem || "");
        if (next.update && !next.update.running) {
          if (next.update.error) setUpdateError(next.update.error);
          return;
        }
      }
      setUpdateError("更新过了 15 分钟还没结束，请查看日志。");
    } catch (problem) {
      setUpdateError(problem.message);
    } finally {
      setUpdateBusy("");
    }
  };
  // idle | confirm | working | done | failed. "confirm" exists only because a
  // restart discards an unsaved draft on this very screen; with nothing to lose,
  // asking would be a step for its own sake. "done" holds a short beat after the
  // handover so the reload reads as completion rather than a random jump.
  const [restartPhase, setRestartPhase] = useState("idle");
  const [restartMessage, setRestartMessage] = useState("");
  // Which half of the handover the working phase is in, and how long the wait has
  // run. A restart usually takes a second or two, but the loop below waits up to
  // 40; without a rising count a slow handoff reads as a frozen button.
  const [restartStage, setRestartStage] = useState("");
  const [restartElapsed, setRestartElapsed] = useState(0);
  // Applying an upgrade replaces the process serving this page, so the page cannot
  // trust anything it reads until a different one answers. The server reports the
  // pid it is replacing for exactly that reason.
  const restartService = async () => {
    setRestartPhase("working");
    setRestartMessage("");
    setRestartStage("requesting");
    try {
      const response = await fetch("/api/restart", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: "{}",
      });
      const accepted = await readApiResponse(response, "无法重启本地服务。");
      setRestartStage("handoff");
      const deadline = Date.now() + 40_000;
      while (Date.now() < deadline) {
        await new Promise((resolve) => setTimeout(resolve, 400));
        try {
          const next = await fetch("/api/state", { cache: "no-store" }).then((reply) => reply.json());
          if (next.restartError) {
            setRestartMessage(next.restartError);
            setRestartPhase("failed");
            return;
          }
          if (next.compatibility?.servicePid && next.compatibility.servicePid !== accepted.pid) {
            // Reloaded rather than merged into this page: the code that served it
            // is not the code answering now. Leave a note so the reloaded page
            // comes back on Settings and confirms the restart, instead of the
            // hard cut to the provider list a bare reload lands on.
            setRestartStage("");
            setRestartPhase("done");
            try { sessionStorage.setItem("ppm.restarted", "1"); } catch { /* private mode: skip the note, still reload */ }
            await new Promise((resolve) => setTimeout(resolve, 650));
            window.location.reload();
            return;
          }
        } catch {
          // The port belongs to nobody for a moment in the middle of the handover.
        }
      }
      setRestartMessage("等了 40 秒也没有新的进程接管端口，请查看日志。");
      setRestartPhase("failed");
    } catch (problem) {
      setRestartMessage(problem.message);
      setRestartPhase("failed");
    }
  };
  // Count seconds from the moment the working phase begins. Derived from a start
  // timestamp each tick rather than accumulated in the updater, so a late or
  // doubled render cannot drift the number.
  useEffect(() => {
    if (restartPhase !== "working") {
      setRestartElapsed(0);
      return undefined;
    }
    const startedAt = Date.now();
    setRestartElapsed(0);
    const timer = setInterval(() => {
      setRestartElapsed(Math.floor((Date.now() - startedAt) / 1000));
    }, 500);
    return () => clearInterval(timer);
  }, [restartPhase]);
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
            <label><span>默认思考强度</span><select className="mono" value={draft.defaultThinkingLevel} onChange={(event) => setDraft((current) => ({ ...current, defaultThinkingLevel: event.target.value }))}>{["off", "minimal", "low", "medium", "high", "xhigh", "max"].map((level) => <option key={level} value={level}>{level}</option>)}</select></label>
          </section>
          <section className="settings-card">
            <h2>会话行为</h2><p>这些选项由 Pi 官方 settings.json 支持。</p>
            <label><span>传输方式</span><select value={draft.transport} onChange={(event) => setDraft((current) => ({ ...current, transport: event.target.value }))}><option value="auto">自动选择</option><option value="sse">SSE</option><option value="websocket">WebSocket</option></select></label>
            <label className="setting-toggle"><input type="checkbox" checked={draft.hideThinkingBlock} onChange={(event) => setDraft((current) => ({ ...current, hideThinkingBlock: event.target.checked }))} /><span><strong>隐藏 thinking 内容块</strong><small>只隐藏显示，不会关闭模型推理。</small></span></label>
          </section>
          <section className="settings-card compatibility-card">
            <h2>兼容状态</h2><dl><div><dt>Pi 版本</dt><dd className="mono">{state.compatibility?.piVersion || "unknown"}</dd></div><div><dt>已验证兼容</dt><dd className="mono">Pi {state.compatibility?.validatedPiVersion || "unknown"}</dd></div><div><dt>管理器版本</dt><dd className="mono">{state.compatibility?.appVersion || "unknown"}</dd></div><div><dt>配置策略</dt><dd>保留未知字段</dd></div><div><dt>配置目录</dt><dd className="mono" title={state.agentDir}>{state.agentDir}</dd></div><div><dt>路径来源</dt><dd>{state.compatibility?.configDirSource === "PI_CODING_AGENT_DIR" ? "PI_CODING_AGENT_DIR" : "自动识别 · 用户主目录"}</dd></div><div><dt>Node</dt><dd className="mono">{state.compatibility?.nodeVersion || "unknown"}</dd></div><div><dt>本地服务</dt><dd className="mono">{state.compatibility?.serviceHost || "127.0.0.1"}:{state.compatibility?.servicePort || 43127}</dd></div></dl>
            {pendingApp && (
              <p className="compat-note is-warning">
                <WarningCircle size={20} weight="fill" />
                磁盘上的管理器已是 {pendingApp}，当前运行的仍是 {state.compatibility?.appVersion || "unknown"}。上面这些数值来自正在运行的进程，重启本地服务后才会更新。
              </p>
            )}
            {piVersionDiffers && (
              <p className="compat-note is-warning">
                <WarningCircle size={20} weight="fill" />
                你安装的 Pi 是 {state.compatibility.piVersion}，本版本验证过的是 {state.compatibility.validatedPiVersion}。未知字段仍会保留，但若 Pi 改动了配置结构，请对照兼容性说明确认。
              </p>
            )}
            <p className="compat-note"><ShieldCheck size={20} weight="duotone" />Pi 更新后若出现新字段，本程序会保留未识别字段；涉及字段改名或 API 类型变化时仍需发布兼容更新。</p>
            <div className="compat-update">
              <div className="compat-update-row">
                <button type="button" className="secondary-button" disabled={Boolean(updateBusy) || demoMode} onClick={checkUpdate}>
                  {updateBusy === "checking" ? <><Spinner />正在检查…</> : <><CloudArrowDown size={18} />检查更新</>}
                </button>
                <span className="compat-restart-hint">
                  {demoMode
                    ? "演示模式不联网。"
                    : updateInfo.checkedAt
                      ? updateInfo.newer
                        ? <>有新版本 <strong>{updateInfo.latestVersion}</strong>，当前运行 {state.compatibility?.appVersion || "unknown"}。{updateInfo.releaseUrl && <> <a href={updateInfo.releaseUrl} target="_blank" rel="noreferrer">发布说明</a></>}</>
                        : <>已是最新：{updateInfo.latestVersion}。</>
                      : "只有按下这个按钮才会联网：向 api.github.com 查询最新发布，其他任何时候本程序都不外联。"}
                </span>
              </div>
              {updateInfo.newer && updateInfo.install?.kind === "checkout" && (
                updateInfo.install.canApply ? (
                  <div className="compat-update-row">
                    <button type="button" className="primary-button" disabled={Boolean(updateBusy)} onClick={applyUpdate}>
                      {updateBusy === "applying" ? <><Spinner />正在更新…</> : <>拉取并构建 {updateInfo.latestVersion}</>}
                    </button>
                    <span className="compat-restart-hint">
                      在 {updateInfo.install.branch} 上快进到 {updateInfo.install.upstream}，只有依赖清单变了才重装依赖，最后重新构建界面。这一步只改磁盘，不动正在运行的进程。
                    </span>
                  </div>
                ) : (
                  <p className="compat-note is-warning">
                    <WarningCircle size={20} weight="fill" />
                    {updateInfo.install.reason}
                    {Array.isArray(updateInfo.install.dirtyFiles) && updateInfo.install.dirtyFiles.length > 0
                      && <> <span className="mono">{updateInfo.install.dirtyFiles.join("、")}</span></>}
                  </p>
                )
              )}
              {updateInfo.newer && updateInfo.install?.kind === "archive" && (
                <div className="compat-update-row">
                  <button type="button" className="primary-button" disabled={Boolean(updateBusy)} onClick={applyUpdate}>
                    {updateBusy === "applying" ? <><Spinner />正在下载…</> : <>下载 {updateInfo.latestVersion} 到相邻目录</>}
                  </button>
                  <span className="compat-restart-hint">
                    这是归档安装，不能原地升级。新版本会解包到当前目录的相邻位置，当前安装一个字节都不动；解包完成后运行新目录里的启动器即可。
                  </span>
                </div>
              )}
              {updateInfo.steps?.length > 0 && (
                <ol className="update-steps">
                  {updateInfo.steps.map((step) => (
                    <li key={step.name} className={`is-${step.state || (step.ok ? "done" : "failed")}`}>
                      <span>{step.state === "running" ? <Spinner size={14} /> : step.ok ? <Check size={14} weight="bold" /> : <X size={14} weight="bold" />}{step.name}</span>
                      {step.output && <pre>{step.output}</pre>}
                    </li>
                  ))}
                </ol>
              )}
              {updateInfo.applied && !updateError && (
                <p className="compat-note">
                  <CheckCircle size={20} weight="duotone" />
                  {updateInfo.applied === "unchanged"
                    ? "磁盘上已经是这个版本了，没有需要拉取的提交。"
                    : <>{updateInfo.applied} 已经在磁盘上，用下面的按钮重启即生效。</>}
                </p>
              )}
              {updateInfo.downloaded && !updateError && (
                <p className="compat-note">
                  <CheckCircle size={20} weight="duotone" />
                  已解包到 <span className="mono">{updateInfo.downloaded.directory}</span>。运行 <span className="mono">{updateInfo.downloaded.launcher}</span> 启动新版本，确认没问题后再删掉旧目录。
                </p>
              )}
              {updateError && (
                <p className="compat-note is-warning" role="alert"><WarningCircle size={20} weight="fill" />{updateError}</p>
              )}
            </div>
            <div className="compat-restart">
              {restartPhase === "confirm" ? (
                <>
                  <span className="compat-restart-hint is-warning">这个页面有未保存的修改，重启会丢弃它们。</span>
                  <button type="button" className="secondary-button" onClick={() => setRestartPhase("idle")}>取消</button>
                  <button type="button" className="primary-button" onClick={restartService}>确认重启</button>
                </>
              ) : (
                <>
                  <button
                    type="button"
                    className={`restart-button ${pendingApp ? "primary-button" : "secondary-button"}`}
                    // The demo has no local service behind it, so the control is
                    // shown and refused rather than hidden: a reader comparing the
                    // demo with their own install should see the same card.
                    disabled={restartPhase === "working" || restartPhase === "done" || demoMode || Boolean(bundleProblem)}
                    // `edited`, not `dirty`: an unwritten default is not something a
                    // restart can lose — it is a key settings.json does not carry,
                    // and will still not carry afterwards. Confirming over that
                    // would ask most users to approve losing nothing.
                    onClick={() => (edited ? setRestartPhase("confirm") : restartService())}
                  >
                    {restartPhase === "working"
                      ? <><Spinner />正在重启…</>
                      : restartPhase === "done"
                        ? <><Check size={18} weight="bold" />已重启，正在刷新…</>
                        : <><ArrowsClockwise size={18} />{pendingApp ? `重启以应用 ${pendingApp}` : "重启本地服务"}</>}
                  </button>
                  <span className={`compat-restart-hint${bundleProblem ? " is-warning" : ""}`}>
                    {bundleProblem
                      ? `${bundleProblem}现在重启只会让新的服务端配上旧界面。`
                      : demoMode
                        ? "演示模式没有本地服务可以重启。"
                        : restartPhase === "done"
                          ? "新进程已接管端口，正在刷新本页…"
                          : restartPhase === "working"
                          ? (restartStage === "requesting"
                              ? "正在请求重启本地服务…"
                              : `新进程正在从磁盘上的文件接管端口。中途会短暂连不上，这是正常的，接管后本页会自动刷新。已等待 ${restartElapsed} 秒，最多 40 秒。`)
                          : "只替换本管理器进程：已经在跑的 LiteLLM 桥和 Pi / Codex 会话不受影响，新进程起不来时会保留当前这个。"}
                  </span>
                </>
              )}
            </div>
            {restartPhase === "failed" && (
              <p className="compat-note is-warning" role="alert"><WarningCircle size={20} weight="fill" />{restartMessage}</p>
            )}
          </section>
        </div>
        <ErrorBanner message={error} conflict={conflict} />
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
  const [loading, setLoading] = useState(!demoMode);  const [selectedId, setSelectedId] = useState(demoMode ? "any-claude" : "");
  const [step, setStep] = useState(demoMode ? 3 : 1);
  const [view, setView] = useState("wizard");
  const [form, setForm] = useState(() => demoMode ? providerToForm(DEMO_STATE.providers[0], DEMO_STATE) : blankForm());
  const [error, setError] = useState("");
  // The initial /api/state read failing is its own state, separate from the
  // per-action `error`: without it a failed first load fell through to an empty
  // wizard with no hint. Cleared once a state read succeeds.
  const [loadError, setLoadError] = useState("");
  // Set alongside a 409 request error and cleared at the entry of every save:
  // it is what lets the persistent banner carry the 重新读取 action after the
  // toast that also offers it has expired.
  const [conflict, setConflict] = useState(false);
  const [saving, setSaving] = useState(false);
  const [saveResult, setSaveResult] = useState(null);
  const [deleteTargetId, setDeleteTargetId] = useState("");
  const [deletingProvider, setDeletingProvider] = useState(false);
  const [deleteProviderError, setDeleteProviderError] = useState("");
  // Pi-only bulk delete: a selection set the sidebar fills, and the ids handed to
  // the confirmation dialog. Kept here rather than in the sidebar so success can
  // clear both the dialog and the selection in one place.
  const [selectMode, setSelectMode] = useState(false);
  const [selectedForDelete, setSelectedForDelete] = useState(() => new Set());
  const [bulkDeleteIds, setBulkDeleteIds] = useState([]);
  const [codexBulkDeleteIds, setCodexBulkDeleteIds] = useState([]);
  const [userAgentFocusRequest, setUserAgentFocusRequest] = useState(0);
  const [betaFocusRequest, setBetaFocusRequest] = useState({ rowId: "", serial: 0 });
  const [target, setTarget] = useState("pi");
  const [codexForm, setCodexForm] = useState(blankCodexForm);
  // Baselines: the signature of the last draft loaded from saved data (or a
  // freshly created blank/duplicate). A draft is dirty when its current
  // signature differs — i.e. the user has edited it since it was loaded. Every
  // place that loads a draft updates the matching baseline through loadForm /
  // loadCodexForm; user edits go through the plain setters and move the draft
  // away from the baseline.
  const [piBaseline, setPiBaseline] = useState(() => draftSignature(demoMode ? providerToForm(DEMO_STATE.providers[0], DEMO_STATE) : blankForm()));
  const [codexBaseline, setCodexBaseline] = useState(() => draftSignature(blankCodexForm()));
  // A settings or prompts screen reports its own edited state up so the shared
  // leave guard and beforeunload can see it. Only one such screen is mounted at
  // a time, so a single flag is enough; each screen clears it on unmount.
  const [screenDirty, setScreenDirty] = useState(false);
  const [codexStep, setCodexStep] = useState(1);
  const [codexSelectedId, setCodexSelectedId] = useState("");
  const [codexSaveResult, setCodexSaveResult] = useState(null);
  const [codexDeleteTargetId, setCodexDeleteTargetId] = useState("");
  // A small toast stack: up to two at once, each on its own timer. A toast that
  // carries an action (an undo, a 重新读取) is never evicted by a plain one, so a
  // burst of arm/notice toasts cannot bury the undo the user still needs.
  const [toasts, setToasts] = useState([]);
  const toastIdRef = useRef(0);
  const toastTimers = useRef(new Map());
  const dismissToast = useCallback((id) => {
    const entry = toastTimers.current.get(id);
    if (entry) { clearTimeout(entry.timeout); toastTimers.current.delete(id); }
    setToasts((current) => current.filter((toast) => toast.id !== id));
  }, []);
  const armToastTimer = useCallback((id, duration) => {
    const timeout = setTimeout(() => dismissToast(id), duration);
    toastTimers.current.set(id, { timeout, startedAt: Date.now(), duration });
  }, [dismissToast]);
  // Pause on hover or focus, resume on leave: a countdown a reader cannot pause
  // fails WCAG 2.2.1, and an undo that vanishes mid-reach is the exact failure.
  const pauseToast = useCallback((id) => {
    const entry = toastTimers.current.get(id);
    if (!entry) return;
    clearTimeout(entry.timeout);
    entry.remaining = Math.max(0, entry.duration - (Date.now() - entry.startedAt));
  }, []);
  const resumeToast = useCallback((id) => {
    const entry = toastTimers.current.get(id);
    if (!entry) return;
    armToastTimer(id, entry.remaining ?? entry.duration);
  }, [armToastTimer]);
  const showToast = useCallback((message, tone = "success", action = null) => {
    const id = ++toastIdRef.current;
    setToasts((current) => {
      // A plain toast replaces other plain toasts, but toasts carrying an action
      // (an undo, a 重新读取) are preserved so a following notice cannot bury the
      // undo the user still needs. At most two show at once.
      const preserved = current.filter((toast) => toast.action);
      for (const toast of current) {
        if (!toast.action) {
          const entry = toastTimers.current.get(toast.id);
          if (entry) { clearTimeout(entry.timeout); toastTimers.current.delete(toast.id); }
        }
      }
      const next = [...preserved, { id, message, tone, action }];
      while (next.length > 2) {
        const [removed] = next.splice(0, 1);
        const entry = toastTimers.current.get(removed.id);
        if (entry) { clearTimeout(entry.timeout); toastTimers.current.delete(removed.id); }
      }
      return next;
    });
    armToastTimer(id, action ? 7000 : 3200);
  }, [armToastTimer]);
  const reportRequestError = useCallback((requestError, setMessage) => {
    setConflict(requestError.status === 409);
    setMessage(requestError.message);
    if (requestError.status === 409) {
      showToast(requestError.message, "error", {
        label: "重新读取",
        onAction: () => window.location.reload(),
      });
    }
  }, [showToast]);
  useEffect(() => () => { for (const entry of toastTimers.current.values()) clearTimeout(entry.timeout); }, []);

  // Loading a draft from saved data (or creating a fresh blank/duplicate) sets
  // both the form and its baseline, so the draft reads as unedited until the
  // user changes something. User edits use the plain setters.
  const loadForm = useCallback((next) => { setForm(next); setPiBaseline(draftSignature(next)); }, []);
  const loadCodexForm = useCallback((next) => { setCodexForm(next); setCodexBaseline(draftSignature(next)); }, []);
  const piDirty = useMemo(() => draftSignature(form) !== piBaseline, [form, piBaseline]);
  const codexDirty = useMemo(() => draftSignature(codexForm) !== codexBaseline, [codexForm, codexBaseline]);
  // The draft the current screen would lose on navigation. Settings and prompts
  // report their own edited state; the wizard's belongs to the active target.
  const currentDirty = view === "settings" || view === "prompts"
    ? screenDirty
    : view === "wizard"
      ? (target === "codex" ? codexDirty : piDirty)
      : false;
  // The shared leave guard: an unedited draft leaves at once; an edited one asks
  // first, and only proceeds through the toast's action — the same rule the
  // prompts screen already applied to its own document switches.
  const guardLeave = useCallback((proceed) => {
    if (!currentDirty) { proceed(); return; }
    showToast("当前草稿有未保存的修改", "error", { label: "放弃修改并离开", onAction: proceed });
  }, [currentDirty, showToast]);
  // Any unsaved draft — in either target or in a settings/prompts screen — arms
  // the browser's native leave confirmation, covering a tab close or a reload
  // (including the 409 banner's reload) that the in-app guard cannot intercept.
  useEffect(() => {
    if (!(piDirty || codexDirty || screenDirty)) return undefined;
    const handler = (event) => { event.preventDefault(); event.returnValue = ""; };
    window.addEventListener("beforeunload", handler);
    return () => window.removeEventListener("beforeunload", handler);
  }, [piDirty, codexDirty, screenDirty]);
  const firstViewRender = useRef(true);
  useEffect(() => {
    const frame = window.requestAnimationFrame(() => {
      document.querySelector(".step-scroll, .settings-scroll, .success-page")?.scrollTo({ top: 0, behavior: "instant" });
      // Moving between steps and views unmounts the control that was focused, so
      // focus falls back to <body> and a screen reader announces nothing. Send
      // it to the new heading instead — unless a field-focus intent (a jump from
      // the gateway summary, an invalid-field save) has already placed focus on
      // a control inside the workspace, in which case that intent wins.
      if (firstViewRender.current) { firstViewRender.current = false; return; }
      const active = document.activeElement;
      const alreadyPlaced = active && active !== document.body && active.closest(".workspace");
      if (alreadyPlaced) return;
      const heading = document.querySelector(".workspace h1");
      if (heading) { heading.tabIndex = -1; heading.focus({ preventScroll: true }); }
    });
    return () => window.cancelAnimationFrame(frame);
  }, [view, step, target, codexStep]);

  useEffect(() => {
    if (demoMode) return;
    fetch("/api/state", { cache: "no-store" })
      .then(async (response) => {
        const data = await readApiResponse(response, "读取配置失败");
        setLoadError("");
        setState(data);
        if (data.providers.length > 0) {
          const provider = data.providers.find((item) => item.isDefault) || data.providers[0];
          setSelectedId(provider.id);
          loadForm(providerToForm(provider, data));
          setStep(provider.models.length > 0 ? 3 : 1);
        }
      })
      .catch((requestError) => setLoadError(requestError.message))
      .finally(() => setLoading(false));
  }, [demoMode]);

  // A restart reloads the page, which otherwise lands on the provider list and
  // reads as a hard jump away from Settings. The restarting page leaves a note;
  // the reloaded one returns to Settings and says the restart took.
  useEffect(() => {
    if (demoMode) return;
    let restarted = false;
    try {
      restarted = sessionStorage.getItem("ppm.restarted") === "1";
      if (restarted) sessionStorage.removeItem("ppm.restarted");
    } catch { /* private mode: nothing to restore */ }
    if (restarted) {
      setView("settings");
      showToast("本地服务已重启，界面已重新加载。", "success");
    }
  }, [demoMode, showToast]);

  const startNew = () => {
    const fresh = blankForm();
    fresh.migrateFrom = state.authProviders[0] || "";
    loadForm(fresh);
    setSelectedId("");
    setStep(1);
    setView("wizard");
    setError("");
  };

  // A duplicate carries the models and compatibility settings into a fresh
  // draft; the credential never does, because the stored key cannot return to
  // the browser — the user lands on the credentials step to type the new one.
  const duplicateProvider = () => {
    if (!state.providers.some((provider) => provider.id === form.providerId.trim())) return;
    const copiedExternalUserAgent = form.userAgentKind === "external" && !form.userAgentEdited;
    const copiedExternalBeta = form.models.some((model) => model.anthropicBetaKind === "external");
    loadForm(duplicatePiForm(form, state.providers.map((provider) => provider.id)));
    setSelectedId("");
    setStep(2);
    setView("wizard");
    setError("");
    showToast(copiedExternalUserAgent || copiedExternalBeta
      ? "已复制模型与兼容设置；外部配置未复制，请在第三步重新填写"
      : "已复制模型与兼容设置；改好 ID 和网关地址，填入新 key 后保存");
  };

  const duplicateCodexProvider = () => {
    if (!codex.providers.some((provider) => provider.id === codexForm.providerId.trim())) return;
    loadCodexForm(duplicateCodexForm(codexForm, codex.providers.map((provider) => provider.id)));
    setCodexSelectedId("");
    setCodexStep(2);
    setView("wizard");
    setError("");
    showToast("已复制模型与推理强度；改好 ID 和网关地址，填入新 key 后保存");
  };

  const selectProvider = (provider) => {
    loadForm(providerToForm(provider, state));
    setSelectedId(provider.id);
    setStep(provider.models.length > 0 ? 3 : 1);
    setView("wizard");
    setError("");
  };

  const openDeleteProvider = (providerId = selectedId) => {
    if (!state.providers.some((provider) => provider.id === providerId)) return;
    setDeleteProviderError("");
    setDeleteTargetId(providerId);
  };

  // Row-level actions from the sidebar operate on any provider by id, not only the
  // one open in the wizard. Duplicate builds the draft from the provider's stored
  // form first, then applies the same copy transform the in-wizard button uses, so
  // the two paths produce an identical draft.
  const duplicateProviderById = (providerId) => {
    const provider = state.providers.find((item) => item.id === providerId);
    if (!provider) return;
    const sourceForm = providerToForm(provider, state);
    const copiedExternalUserAgent = sourceForm.userAgentKind === "external" && !sourceForm.userAgentEdited;
    const copiedExternalBeta = sourceForm.models.some((model) => model.anthropicBetaKind === "external");
    loadForm(duplicatePiForm(sourceForm, state.providers.map((item) => item.id)));
    setSelectedId("");
    setStep(2);
    setView("wizard");
    setError("");
    showToast(copiedExternalUserAgent || copiedExternalBeta
      ? "已复制模型与兼容设置；外部配置未复制，请在第三步重新填写"
      : "已复制模型与兼容设置；改好 ID 和网关地址，填入新 key 后保存");
  };

  const duplicateCodexProviderById = (providerId) => {
    const provider = codex.providers.find((item) => item.id === providerId);
    if (!provider) return;
    const sourceForm = codexProviderToForm(provider, codex);
    loadCodexForm(duplicateCodexForm(sourceForm, codex.providers.map((item) => item.id)));
    setCodexSelectedId("");
    setCodexStep(2);
    setView("wizard");
    setError("");
    showToast("已复制模型与推理强度；改好 ID 和网关地址，填入新 key 后保存");
  };

  const closeDeleteProvider = useCallback(() => {
    setDeleteTargetId("");
    setDeleteProviderError("");
  }, []);

  // The same rules `saveProvider` applies, asked here so the answer arrives
  // on the step that owns the field rather than after a round trip. Returns
  // `{ field, message }` so the caller can mark and focus the offending field,
  // or null when the credentials are valid.
  const validateCredentials = () => {
    const providerId = form.providerId.trim();
    if (!providerId) return { field: "providerId", message: "请输入供应商 ID。" };
    if (!PROVIDER_ID_PATTERN.test(providerId)) return { field: "providerId", message: "供应商 ID 只能使用小写字母、数字、点、下划线和连字符，且以字母或数字开头。" };
    if (!form.baseUrl.trim()) return { field: "baseUrl", message: "请输入 API 地址。" };
    try { normalizeUrl(form.baseUrl); } catch (problem) { return { field: "baseUrl", message: problem.message }; }
    if (form.credentialMode === "new" && !form.apiKey.trim()) return { field: "apiKey", message: "请输入 API Key。" };
    if (form.credentialMode === "migrate" && !form.migrateFrom) return { field: "migrateFrom", message: "请选择要迁移的已有凭据。" };
    return null;
  };
  // Field-level focus for a failed credential check: the wizard jumps to step
  // two, states the reason, and lands the caret on the field, which carries
  // aria-invalid while the error stands.
  const [credentialFocus, setCredentialFocus] = useState({ field: "", serial: 0 });
  const failCredentials = (result) => {
    setError(result.message);
    setStep(2);
    setCredentialFocus((current) => ({ field: result.field, serial: current.serial + 1 }));
  };

  const goToModels = () => {
    const result = validateCredentials();
    if (result) { failCredentials(result); return; }
    setError("");
    setStep(3);
  };

  // Free step-jump for a saved provider: moving to the models step still runs
  // the credential check that step two would, so a jump cannot skip past an
  // invalid gateway; a failure stops on step two with the reason. Backward and
  // step-two jumps are unconditional.
  const goToStep = (targetStep) => {
    if (targetStep === step) return;
    if (targetStep >= 3) {
      const result = validateCredentials();
      if (result) { failCredentials(result); return; }
    }
    setError("");
    setStep(targetStep);
  };
  // A jump from the gateway summary that should land focus on a specific field.
  const [apiFocusRequest, setApiFocusRequest] = useState(0);
  const editGatewayAddress = () => { goToStep(2); setApiFocusRequest((current) => current + 1); };

  // What the discovery dialog runs. The credential is described the way a save
  // describes it, so the server resolves the same key a save would write with
  // and never hands it back; a draft the save endpoint would refuse is refused
  // here first, with the same words.
  const discoverModels = useCallback(async (path = "") => {
    const result = validateCredentials();
    if (result) throw new Error(`${result.message} 请先回到第二步补全。`);
    if (demoMode) {
      await new Promise((resolve) => setTimeout(resolve, 600));
      return {
        models: [
          { id: "anthropic/claude-opus-4-1", name: "Claude Opus 4.1" },
          { id: "anthropic/claude-sonnet-4-5", name: "Claude Sonnet 4.5" },
          { id: "openai/gpt-5.6-sol" },
          { id: "google/gemini-2.5-pro", name: "Gemini 2.5 Pro" },
        ],
        endpoint: `${form.baseUrl.trim()}${path.trim() || defaultDiscoveryPath(form.api)}`,
      };
    }
    const response = await fetch("/api/providers/discover-models", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        baseUrl: form.baseUrl.trim(),
        api: form.api,
        path,
        credential: {
          mode: form.credentialMode,
          apiKey: form.credentialMode === "new" ? form.apiKey : undefined,
          fromProvider: form.credentialMode === "migrate" ? form.migrateFrom : undefined,
          providerId: form.providerId.trim(),
        },
      }),
    });
    return readApiResponse(response, "获取模型列表失败");
    // validateCredentials reads the same form fields listed here.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [demoMode, form.baseUrl, form.api, form.credentialMode, form.apiKey, form.migrateFrom, form.providerId]);

  const save = async (setDefault) => {
    setConflict(false);
    const result = validateCredentials();
    if (result) { failCredentials(result); return; }
    if (!form.models.some((model) => model.id.trim())) { setError("至少填写一个模型 ID。"); return; }
    const userAgentError = userAgentValidationError(form.userAgent);
    if (userAgentError) {
      setError(userAgentError);
      setUserAgentFocusRequest((current) => current + 1);
      return;
    }
    const changedIdentity = changedPersistedModel(form.models);
    if (changedIdentity) {
      setError(<>已保存的模型 ID <code>{changedIdentity.persistedId}</code> 不能直接改名或清空；请添加新模型，再用删除按钮移除旧模型。</>);
      return;
    }
    const selectedModel = selectedNamedModel(form.models, form.defaultRowId);
    if (!selectedModel) { setError("请选择一个已命名模型作为默认模型。"); return; }
    const targetProviderId = form.providerId.trim();
    const targetProvider = state.providers.find((provider) => provider.id === targetProviderId);
    for (const model of form.models.filter((item) => item.id.trim())) {
      const targetModelExists = Boolean(targetProvider?.models?.some((item) => item.id === model.id.trim()));
      const betaIntent = anthropicBetaSaveIntent(model, selectedId, targetProviderId, targetModelExists);
      if (betaIntent.write && betaIntent.value) {
        try { betaIntent.value = normalizeAnthropicBeta(betaIntent.value); } catch (problem) { setError("模型 " + model.id.trim() + " 的 Anthropic Beta 请求头无效：" + problem.message); setBetaFocusRequest((current) => ({ rowId: model.rowId, serial: current.serial + 1 })); setStep(3); return; }
      }
    }
    const userAgentIntent = userAgentSaveIntent(form, selectedId, Boolean(targetProvider));
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
        ...(() => {
          const targetModelExists = Boolean(targetProvider?.models?.some((item) => item.id === model.id.trim()));
          const intent = anthropicBetaSaveIntent(model, selectedId, targetProviderId, targetModelExists);
          return intent.write ? { anthropicBeta: intent.value ? normalizeAnthropicBeta(intent.value) : "" } : {};
        })(),
      })),
      setDefault,
      defaultModelId: selectedModel.id.trim(),
      // Thinking level is not sent: it is a global setting owned by the Settings
      // screen, and the server ignores it here so a stale tab cannot reset it.
      compat: form.compat,
      revision: state.revision,
    };
    if (userAgentIntent.write) payload.userAgent = userAgentIntent.value;
    try {
      if (demoMode) {
        await new Promise((resolve) => setTimeout(resolve, 500));
        const demoProvider = {
          id: payload.providerId,
          name: titleFromId(payload.providerId),
          baseUrl: payload.baseUrl,
          api: payload.api,
          userAgent: Object.hasOwn(payload, "userAgent")
            ? payload.userAgent.trim()
              ? { kind: "literal", value: payload.userAgent.trim() }
              : { kind: "none" }
            : targetProvider?.userAgent?.kind === "external"
              ? { kind: "external" }
              : targetProvider?.userAgent?.kind === "literal"
                ? targetProvider.userAgent
                : { kind: "none" },
          hasModelUserAgentOverride: Boolean(form.hasModelUserAgentOverride),
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
            anthropicBeta: Object.hasOwn(model, "anthropicBeta")
              ? (model.anthropicBeta ? { kind: "literal", value: model.anthropicBeta } : { kind: "none" })
              : (targetProvider?.models?.find((item) => item.id === model.id)?.anthropicBeta || { kind: "none" }),
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
            ? { ...state.settings, defaultProvider: payload.providerId, defaultModel: payload.defaultModelId }
            : state.settings,
        };
        setState(demoState);
        setSelectedId(payload.providerId);
        loadForm(providerToForm(demoProvider, demoState));
        const result = {
          providerId: payload.providerId,
          modelCount: payload.models.length,
          defaultModelId: payload.defaultModelId,
          setDefault,
          userAgent: demoProvider.userAgent,
          hasModelUserAgentOverride: demoProvider.hasModelUserAgentOverride,
          command: piModelCommand(payload.providerId, payload.defaultModelId, demoState.settings, demoState.settingsPresent),
        };
        setSaveResult(result);
        setView("success");
        return;
      }
      const response = await fetch("/api/providers", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(payload) });
      const data = await readApiResponse(response, "保存失败");
      setState(data.state);
      const saved = data.state.providers.find((provider) => provider.id === payload.providerId);
      if (saved) { setSelectedId(saved.id); loadForm(providerToForm(saved, data.state)); }
      setSaveResult({
        providerId: payload.providerId,
        modelCount: payload.models.length,
        defaultModelId: payload.defaultModelId,
        setDefault,
        userAgent: saved?.userAgent,
        hasModelUserAgentOverride: saved?.hasModelUserAgentOverride,
        command: piModelCommand(payload.providerId, payload.defaultModelId, data.state.settings, data.state.settingsPresent),
      });
      setView("success");
    } catch (requestError) {
      reportRequestError(requestError, setError);
    } finally {
      setSaving(false);
    }
  };

  const saveSettings = async (draft) => {
    setConflict(false);
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
    setConflict(false);
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
        loadForm(providerToForm(nextProvider, nextState));
        setStep(nextProvider.models.length > 0 ? 3 : 1);
      } else {
        const fresh = blankForm();
        fresh.migrateFrom = nextState.authProviders[0] || "";
        setSelectedId("");
        loadForm(fresh);
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

  const exitSelectMode = () => {
    setSelectMode(false);
    setSelectedForDelete(new Set());
  };
  const toggleSelectForDelete = (providerId) => {
    setSelectedForDelete((current) => {
      const next = new Set(current);
      if (next.has(providerId)) next.delete(providerId); else next.add(providerId);
      return next;
    });
  };

  const deleteProvidersBulk = async (payload) => {
    setDeletingProvider(true);
    setDeleteProviderError("");
    setConflict(false);
    try {
      const removing = new Set(payload.providerIds);
      let nextState;
      if (demoMode) {
        await new Promise((resolve) => setTimeout(resolve, 350));
        const deletingDefault = removing.has(state.settings.defaultProvider);
        nextState = {
          ...state,
          providers: state.providers
            .filter((provider) => !removing.has(provider.id))
            .map((provider) => ({
              ...provider,
              isDefault: deletingDefault ? provider.id === payload.replacementProviderId : provider.isDefault,
            })),
          authProviders: payload.keepCredentials
            ? state.authProviders
            : state.authProviders.filter((id) => !removing.has(id)),
          settings: deletingDefault
            ? { ...state.settings, defaultProvider: payload.replacementProviderId, defaultModel: payload.replacementModelId }
            : state.settings,
        };
      } else {
        const response = await fetch("/api/providers/delete-bulk", {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ ...payload, revision: state.revision }),
        });
        const data = await readApiResponse(response, "批量删除供应商失败");
        nextState = data.state;
      }

      const removedCount = payload.providerIds.length;
      setState(nextState);
      setBulkDeleteIds([]);
      exitSelectMode();
      setDeleteProviderError("");
      setSaveResult(null);
      setView("wizard");
      setError("");
      const nextProvider = nextState.providers.find((provider) => provider.id === nextState.settings.defaultProvider)
        || nextState.providers[0];
      if (nextProvider) {
        setSelectedId(nextProvider.id);
        loadForm(providerToForm(nextProvider, nextState));
        setStep(nextProvider.models.length > 0 ? 3 : 1);
      } else {
        const fresh = blankForm();
        fresh.migrateFrom = nextState.authProviders[0] || "";
        setSelectedId("");
        loadForm(fresh);
        setStep(1);
      }
      showToast(<>已删除 {removedCount} 个供应商{payload.keepCredentials ? "；凭据已保留" : ""}</>);
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
    exitSelectMode();
    if (view !== "prompts" && view !== "settings") setView("wizard");
    setError("");
    setSaveResult(null);
    setCodexSaveResult(null);
    if (next === "codex") {
      // Switching targets never discards a draft: an edited Codex draft is left
      // exactly as it is so it survives a round trip to Pi and back. Only when
      // the Codex draft is clean is it refreshed from the currently
      // selected/active provider, so it reflects the latest saved state.
      if (!codexDirty) {
        const provider = codexProvider(codexSelectedId)
          || codex.providers.find((item) => item.isActive)
          || codex.providers[0];
        if (provider) {
          setCodexSelectedId(provider.id);
          loadCodexForm(codexProviderToForm(provider, codex));
          setCodexStep(3);
        } else {
          setCodexSelectedId("");
          loadCodexForm(blankCodexForm());
          setCodexStep(1);
        }
      }
    }
  };

  const startNewCodex = () => {
    loadCodexForm(blankCodexForm());
    setCodexSelectedId("");
    setCodexStep(1);
    setView("wizard");
    setError("");
  };

  const selectCodexProvider = (provider) => {
    loadCodexForm(codexProviderToForm(provider, codex));
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
      try { normalizeUrl(codexForm.bridgeUpstreamUrl); } catch (problem) { return problem.message; }
      const savedBridge = codexProvider(codexForm.providerId.trim())?.bridge;
      if (!codexForm.bridgeApiKey.trim() && !savedBridge?.credentialConfigured) return "请输入上游 API Key。";
      return "";
    }
    if (!codexForm.baseUrl.trim()) return "请输入 API 地址。";
    try { normalizeUrl(codexForm.baseUrl); } catch (problem) { return problem.message; }
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

  // Free step-jump for a saved Codex provider, mirroring the Pi side: a jump to
  // the models step still validates the credentials step and stops there on
  // failure.
  const goToCodexStep = (targetStep) => {
    if (targetStep === codexStep) return;
    if (targetStep >= 3) {
      const message = validateCodexCredentials();
      if (message) { setError(message); setCodexStep(2); return; }
    }
    setError("");
    setCodexStep(targetStep);
  };

  const bridgeAction = async (action) => {
    if (demoMode) {
      await new Promise((resolve) => setTimeout(resolve, 400));
      const providerId = codexForm.providerId.trim();
      setState((current) => ({
        ...current,
        codex: {
          ...current.codex,
          bridge: {
            providerId,
            supervisable: true,
            running: action === "start",
            port: 4000,
            binary: "litellm",
            binarySource: "discovered",
            version: "1.97.0",
          },
        },
      }));
      showToast(action === "start"
        ? "已启动本地桥；几秒后再看状态，首次启动 LiteLLM 会慢一些"
        : "已停止本地桥");
      return;
    }
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
    setConflict(false);
    const message = validateCodexCredentials();
    if (message) { setError(message); setCodexStep(2); return; }
    const named = codexForm.models.filter((model) => model.id.trim());
    if (named.length === 0) { setError("至少填写一个模型 ID。"); return; }
    const selected = codexForm.models.find((model) => model.rowId === codexForm.defaultRowId && model.id.trim());
    if (!selected) { setError("请选择一个已命名模型作为该供应商的默认模型。"); return; }
    setSaving(true);
    setError("");
    try {
      if (demoMode) {
        // Demo has no server behind the codex endpoints: the Pi save path has
        // faked its happy path since V1.1, and without this mirror the Codex
        // workspace could never leave the wizard — the posted draft revision
        // is the fixture's "", which the real API refuses with 409.
        await new Promise((resolve) => setTimeout(resolve, 500));
        const requiresAuth = codexForm.upstream !== "bridge" && codexForm.requiresAuth;
        const saved = {
          id: codexForm.providerId.trim(),
          name: codexForm.name.trim() || titleFromId(codexForm.providerId.trim()),
          baseUrl: codexForm.baseUrl.trim(),
          requiresAuth,
          models: named.map((model) => ({ id: model.id.trim(), reasoningEffort: model.reasoningEffort })),
          defaultModelId: selected.id.trim(),
          credentialConfigured: !requiresAuth || codexForm.credentialMode !== "new" || Boolean(codexForm.apiKey.trim()),
          adopted: false,
          isActive: Boolean(setActive) || codex.activeProviderId === codexForm.providerId.trim(),
        };
        const demoCodex = {
          ...codex,
          activeProviderId: setActive ? saved.id : codex.activeProviderId,
          providers: [
            ...codex.providers
              .filter((provider) => provider.id !== saved.id)
              .map((provider) => (setActive ? { ...provider, isActive: false } : provider)),
            saved,
          ],
        };
        const demoState = { ...state, codex: demoCodex };
        setState(demoState);
        setCodexSelectedId(saved.id);
        loadCodexForm(codexProviderToForm(saved, demoCodex));
        setCodexSaveResult({
          providerId: saved.id,
          name: saved.name,
          modelCount: named.length,
          defaultModelId: selected.id.trim(),
          activated: saved.isActive,
          requiresAuth,
          bridged: codexForm.upstream === "bridge",
          command: "codex",
          otherModels: named.map((model) => model.id.trim()).filter((id) => id !== selected.id.trim()),
        });
        setView("success");
        return;
      }
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
      if (saved) loadCodexForm(codexProviderToForm(saved, data.state.codex));
      setCodexSaveResult({
        providerId: codexForm.providerId.trim(),
        name: codexForm.name.trim(),
        modelCount: named.length,
        defaultModelId: selected.id.trim(),
        activated: Boolean(saved?.isActive),
        requiresAuth: saved?.requiresAuth !== false,
        // Whether the saved provider is bridged decides whether the success
        // screen must first get the local bridge running: the command it
        // advertises fails until the bridge is up.
        bridged: Boolean(saved?.bridge) || codexForm.upstream === "bridge",
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
    setConflict(false);
    try {
      if (demoMode) {
        // Demo mirrors the library's own semantics on the fixture: upsert with
        // a unique slug, activate, and delete-with-replacement for the live one.
        await new Promise((resolve) => setTimeout(resolve, 400));
        const lib = state.prompts?.[target];
        const slot = lib?.slots.find((entry) => entry.id === payload.slot);
        if (!slot) return false;
        const documents = slot.documents.map((document) => ({ ...document }));
        let activeId = slot.activeId;
        if (route === "/api/prompts") {
          const name = String(payload.name || "").trim();
          if (!name) { setError("请填写提示词名称。"); return false; }
          let id = String(payload.id || "");
          if (!documents.some((document) => document.id === id)) {
            const base = (id || name).toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-+|-+$/g, "") || "prompt";
            id = base;
            for (let n = 2; documents.some((document) => document.id === id); n += 1) id = `${base}-${n}`;
            documents.push({ id, name, text: "", adopted: false, isActive: false });
          }
          const entry = documents.find((document) => document.id === id);
          entry.name = name;
          entry.text = typeof payload.text === "string" ? payload.text : "";
          if (payload.activate !== false || activeId === id) activeId = id;
        } else if (route === "/api/prompts/activate") {
          if (!documents.some((document) => document.id === payload.id)) { setError("要启用的提示词不存在。"); return false; }
          activeId = payload.id;
        } else if (route === "/api/prompts/delete") {
          const isActive = activeId === payload.id;
          if (isActive && (!documents.some((document) => document.id === payload.replacementId) || payload.replacementId === payload.id)) {
            setError("这条提示词正在生效，请指定一条替代它的提示词。");
            return false;
          }
          const kept = documents.filter((document) => document.id !== payload.id);
          documents.length = 0;
          documents.push(...kept);
          if (isActive) activeId = payload.replacementId;
        }
        documents.forEach((document) => { document.isActive = document.id === activeId; });
        const nextSlot = { ...slot, documents, activeId, present: documents.length > 0 };
        setState({
          ...state,
          prompts: {
            ...state.prompts,
            [target]: { ...lib, slots: lib.slots.map((entry) => (entry.id === slot.id ? nextSlot : entry)) },
          },
        });
        return true;
      }
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
      let data;
      if (demoMode) {
        // Same demo parity as the Codex save: the fixture's empty revision
        // would be refused by the real endpoint, so the happy plan is faked
        // with the same semantics — the active slot moves to the replacement.
        await new Promise((resolve) => setTimeout(resolve, 400));
        const isActive = codex.activeProviderId === payload.providerId;
        const providers = codex.providers
          .filter((provider) => provider.id !== payload.providerId)
          .map((provider) => (isActive && payload.replacementProviderId
            ? { ...provider, isActive: provider.id === payload.replacementProviderId }
            : provider));
        data = {
          state: {
            ...state,
            codex: {
              ...codex,
              providers,
              activeProviderId: isActive
                ? (payload.replacementProviderId || providers[0]?.id || "")
                : codex.activeProviderId,
            },
          },
        };
      } else {
        const response = await fetch("/api/codex/providers/delete", {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ ...payload, revision: codex.revision }),
        });
        data = await readApiResponse(response, "删除失败");
      }
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
        loadCodexForm(codexProviderToForm(next, data.state.codex));
        setCodexStep(3);
      } else {
        setCodexSelectedId("");
        loadCodexForm(blankCodexForm());
        setCodexStep(1);
      }
      showToast(<>已删除 Codex 供应商 <code>{payload.providerId}</code></>);
    } catch (requestError) {
      reportRequestError(requestError, setDeleteProviderError);
    } finally {
      setDeletingProvider(false);
    }
  };

  const deleteCodexProvidersBulk = async (payload) => {
    setDeletingProvider(true);
    setDeleteProviderError("");
    setConflict(false);
    try {
      const removing = new Set(payload.providerIds);
      let data;
      if (demoMode) {
        await new Promise((resolve) => setTimeout(resolve, 400));
        const activeRemoved = removing.has(codex.activeProviderId);
        const providers = codex.providers
          .filter((provider) => !removing.has(provider.id))
          .map((provider) => (activeRemoved && payload.replacementProviderId
            ? { ...provider, isActive: provider.id === payload.replacementProviderId }
            : provider));
        data = {
          state: {
            ...state,
            codex: {
              ...codex,
              providers,
              activeProviderId: activeRemoved
                ? (payload.replacementProviderId || providers[0]?.id || "")
                : codex.activeProviderId,
            },
          },
        };
      } else {
        const response = await fetch("/api/codex/providers/delete-bulk", {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ ...payload, revision: codex.revision }),
        });
        data = await readApiResponse(response, "批量删除供应商失败");
      }
      const removedCount = payload.providerIds.length;
      setState(data.state);
      setCodexBulkDeleteIds([]);
      exitSelectMode();
      setCodexSaveResult(null);
      setView("wizard");
      setError("");
      const next = (data.state.codex?.providers || []).find((provider) => provider.id === payload.replacementProviderId)
        || (data.state.codex?.providers || []).find((provider) => provider.isActive)
        || (data.state.codex?.providers || [])[0];
      if (next) {
        setCodexSelectedId(next.id);
        loadCodexForm(codexProviderToForm(next, data.state.codex));
        setCodexStep(3);
      } else {
        setCodexSelectedId("");
        loadCodexForm(blankCodexForm());
        setCodexStep(1);
      }
      showToast(<>已删除 {removedCount} 个 Codex 供应商</>);
    } catch (requestError) {
      reportRequestError(requestError, setDeleteProviderError);
    } finally {
      setDeletingProvider(false);
    }
  };

  const saveCodexSettings = async (draft) => {
    setConflict(false);
    setSaving(true);
    setError("");
    try {
      if (demoMode) {
        await new Promise((resolve) => setTimeout(resolve, 400));
        setState({ ...state, codex: { ...codex, settings: { ...codex.settings, ...draft } } });
        showToast("Codex 设置已写入 config.toml；对新开的会话生效");
        return;
      }
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
        loading={loading}
        loadFailed={Boolean(loadError)}
        onReload={() => guardLeave(() => window.location.reload())}
        onTarget={(next) => guardLeave(() => switchTarget(next))}
        selectedId={target === "codex" ? codexSelectedId : selectedId}
        onSelect={(provider) => guardLeave(() => (target === "codex" ? selectCodexProvider : selectProvider)(provider))}
        onAdd={() => guardLeave(target === "codex" ? startNewCodex : startNew)}
        onSettings={() => guardLeave(() => { setView("settings"); setError(""); })}
        onPrompts={() => guardLeave(() => { setView("prompts"); setError(""); })}
        activeView={view}
        theme={theme}
        onTheme={setTheme}
        onDuplicate={(id) => guardLeave(() => (target === "codex" ? duplicateCodexProviderById : duplicateProviderById)(id))}
        onDelete={target === "codex" ? (id) => { setDeleteProviderError(""); setCodexDeleteTargetId(id); } : openDeleteProvider}
        canBulkDelete
        selectMode={selectMode}
        selectedForDelete={selectedForDelete}
        onEnterSelect={() => { setSelectMode(true); setSelectedForDelete(new Set()); }}
        onExitSelect={exitSelectMode}
        onToggleSelect={toggleSelectForDelete}
        onReplaceSelection={(ids) => setSelectedForDelete(new Set(ids))}
        onBulkDelete={() => { setDeleteProviderError(""); if (target === "codex") setCodexBulkDeleteIds(Array.from(selectedForDelete)); else setBulkDeleteIds(Array.from(selectedForDelete)); }}
      />
      <section className="workspace">
        {loading ? (
          <div className="loading-state" role="status" aria-live="polite">
            <span className="skeleton skeleton-title" />
            <span className="skeleton skeleton-line" />
            <span className="skeleton skeleton-block" />
            <p>正在读取{target === "codex" ? " Codex " : " Pi "}配置…</p>
          </div>
        ) : loadError ? (
          <div className="load-error" role="alert">
            <WarningCircle size={40} weight="duotone" />
            <h1>读取配置失败</h1>
            <p>{loadError}</p>
            <p className="load-error-hint">本地服务可能未启动或已重启。重新加载页面再试。</p>
            <button type="button" className="primary-button" onClick={() => window.location.reload()}><ArrowsClockwise size={18} />重新加载</button>
          </div>
        ) : view === "prompts" ? (
          <PromptsScreen
            target={target}
            state={state}
            saving={saving}
            error={error}
            conflict={conflict}
            onSave={savePrompt}
            onActivate={activatePrompt}
            onDelete={deletePrompt}
            onNotify={showToast}
            onBack={() => guardLeave(() => { setView("wizard"); setError(""); })}
            onDirtyChange={setScreenDirty}
          />
        ) : target === "codex" ? (
          codex.available === false ? (
            <div className="error-banner is-standalone" role="alert">
              <WarningCircle size={20} weight="fill" />
              读取 Codex 配置失败：{codex.error || "未知错误"}（{codex.dir}）
            </div>
          ) : view === "settings" ? (
            <CodexSettingsScreen state={state} saving={saving} error={error} conflict={conflict} onSave={saveCodexSettings} onBack={() => guardLeave(() => setView("wizard"))} onDirtyChange={setScreenDirty} />
          ) : view === "success" && codexSaveResult ? (
            <CodexSuccessScreen result={codexSaveResult} codex={codex} onCopy={copyCommand} onReturn={returnToSavedCodexProvider} onAdd={startNewCodex} onStartBridge={() => bridgeAction("start")} onStopBridge={() => bridgeAction("stop")} onNotify={showToast} />
          ) : (
            <>
              <CodexStepper step={codexStep} onStep={goToCodexStep} allowJump={Boolean(codexProvider(codexForm.providerId.trim()))} />
              <CodexWizard
                step={codexStep}
                form={codexForm}
                setForm={setCodexForm}
                codex={codex}
                codexVersion={state.compatibility?.codexVersion}
                conflict={conflict}
                error={error}
                saving={saving}
                onNext={codexStep === 1 ? () => setCodexStep(2) : goToCodexModels}
                onBack={() => setCodexStep(codexStep - 1)}
                onSave={saveCodex}
                onNotify={showToast}
                onDuplicate={duplicateCodexProvider}
                onStartBridge={() => bridgeAction("start")}
                onStopBridge={() => bridgeAction("stop")}
                selectedId={codexSelectedId}
                onDeleteProvider={() => setCodexDeleteTargetId(codexSelectedId)}
                canDeleteProvider={Boolean(codexProvider(codexSelectedId))}
                isActive={Boolean(codexProvider(codexForm.providerId.trim())?.isActive)}
              />
            </>
          )
        ) : view === "settings" ? <SettingsScreen state={state} saving={saving} error={error} conflict={conflict} demoMode={demoMode} onSave={saveSettings} onBack={() => guardLeave(() => setView("wizard"))} onDirtyChange={setScreenDirty} /> : view === "success" && saveResult ? <SuccessScreen result={saveResult} onCopy={copyCommand} onReturn={returnToSavedProvider} onAdd={startNew} /> : <><Stepper step={step} onStep={goToStep} allowJump={state.providers.some((provider) => provider.id === form.providerId.trim())} />{step === 1 ? <ProtocolStep form={form} setForm={setForm} onNext={() => setStep(2)} /> : step === 2 ? <CredentialsStep form={form} setForm={setForm} state={state} error={error} overwrites={selectedId !== form.providerId.trim() && state.providers.some((provider) => provider.id === form.providerId.trim())} apiFocusRequest={apiFocusRequest} credentialFocus={credentialFocus} onBack={() => setStep(1)} onNext={goToModels} /> : <ModelsStep form={form} setForm={setForm} error={error} conflict={conflict} saving={saving} onBack={() => setStep(2)} onSave={save} onNotify={showToast} onDuplicate={duplicateProvider} onDeleteProvider={openDeleteProvider} onDiscover={discoverModels} onEditProtocol={() => goToStep(1)} onEditGateway={editGatewayAddress} canDeleteProvider={state.providers.some((provider) => provider.id === selectedId)} isExistingProvider={state.providers.some((provider) => provider.id === form.providerId.trim())} isCurrentDefault={state.settings.defaultProvider === form.providerId.trim()} hasProviders={state.providers.length > 0} dirty={piDirty} liveDefaultModelId={form.providerId.trim() && state.settings.defaultProvider === form.providerId.trim() ? state.settings.defaultModel || "" : ""} userAgentFocusRequest={userAgentFocusRequest} betaFocusRequest={betaFocusRequest} />}</>}
      </section>
      {codexDeleteTargetId && codexProvider(codexDeleteTargetId) && (
        <CodexDeleteDialog
          provider={codexProvider(codexDeleteTargetId)}
          codex={codex}
          deleting={deletingProvider}
          requestError={deleteProviderError}
          conflict={conflict}
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
          conflict={conflict}
          onClose={closeDeleteProvider}
          onConfirm={deleteProvider}
        />
      )}
      {bulkDeleteIds.length > 0 && (
        <ProviderBulkDeleteDialog
          providerIds={bulkDeleteIds}
          state={state}
          deleting={deletingProvider}
          requestError={deleteProviderError}
          conflict={conflict}
          onClose={() => { setBulkDeleteIds([]); setDeleteProviderError(""); }}
          onConfirm={deleteProvidersBulk}
        />
      )}
      {codexBulkDeleteIds.length > 0 && (
        <CodexProviderBulkDeleteDialog
          providerIds={codexBulkDeleteIds}
          codex={codex}
          deleting={deletingProvider}
          requestError={deleteProviderError}
          conflict={conflict}
          onClose={() => { setCodexBulkDeleteIds([]); setDeleteProviderError(""); }}
          onConfirm={deleteCodexProvidersBulk}
        />
      )}
      <div className="toast-region">
        {toasts.map((toast) => (
          <div
            key={toast.id}
            className={`toast is-${toast.tone}`}
            role={toast.tone === "error" ? "alert" : "status"}
            aria-live={toast.tone === "error" ? "assertive" : "polite"}
            onMouseEnter={() => pauseToast(toast.id)}
            onMouseLeave={() => resumeToast(toast.id)}
            onFocusCapture={() => pauseToast(toast.id)}
            onBlurCapture={() => resumeToast(toast.id)}
          >
            {toast.tone === "error" ? <WarningCircle size={21} weight="fill" /> : <CheckCircle size={21} weight="fill" />}
            <span>{toast.message}</span>
            {toast.action && (
              <button
                type="button"
                className="toast-action"
                onClick={() => { toast.action.onAction(); dismissToast(toast.id); }}
              >
                {toast.action.label}
              </button>
            )}
            <button type="button" className="toast-close" onClick={() => dismissToast(toast.id)} aria-label="关闭提示"><X size={16} weight="bold" /></button>
          </div>
        ))}
      </div>
    </main>
  );
}
