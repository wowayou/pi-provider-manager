import { useCallback, useEffect, useRef, useState } from "react";
import { ArrowLeft, ArrowRight, Asterisk, CaretDown, CheckCircle, Copy, Info, Plus, Trash } from "@phosphor-icons/react";
import { CLAUDE_ALIASES, CLAUDE_EFFORTS, claudeFollowCommand, claudeLaunchCommand, validateClaudeConnection, validateClaudeProvider, validateClaudeCredential } from "../lib/claude-shared.mjs";
import { draftSignature, providerDraftIdentity } from "./model-draft.mjs";
import { ErrorBanner, KeyValueList, PasswordInput, ProviderSummary, Spinner, WizardFooter, readApiResponse, useDialog } from "./ui-kit.jsx";
import { ManagerCard } from "./manager-card.jsx";

export const blankClaudeForm = () => ({ providerId: "", name: "", baseUrl: "", authType: "token", model: "sonnet", aliases: {}, credentialMode: "new", apiKey: "" });
export const claudeProviderToForm = (provider) => ({ ...blankClaudeForm(), providerId: provider.id, name: provider.name, baseUrl: provider.baseUrl, authType: provider.authType, model: provider.model, aliases: { ...provider.aliases }, credentialMode: provider.credentialConfigured ? "keep" : "new" });

// The controller stays mounted across target switches, just like the Pi and
// Codex drafts. Storage state comes only from the server's credential-free view.
// `runWrite` / `isWriting` are App's provider write lock: a Claude save or
// switch holds it like Pi's and Codex's, and the draft refuses edits meanwhile.
export function useClaude({ state, setState, setView, setError, setConflict, setSaving, reportRequestError, showToast, demoMode, runWrite, beginWrite, isWriting }) {
  const claude = state.claude || { providers: [], settings: {}, credentialProviders: [], revision: "" };
  const [form, setFormState] = useState(blankClaudeForm);
  const setForm = useCallback((update) => { if (!isWriting()) setFormState(update); }, [isWriting]);
  const [baseline, setBaseline] = useState(() => draftSignature(blankClaudeForm()));
  const [selectedId, setSelectedId] = useState("");
  const [step, setStep] = useState(1);
  const [result, setResult] = useState(null);
  const [deleteId, setDeleteId] = useState("");
  const [deleteError, setDeleteError] = useState("");
  const [focus, setFocus] = useState({ field: "", serial: 0 });
  const dirty = draftSignature(form) !== baseline;
  const identity = providerDraftIdentity(selectedId, form.providerId, claude.providers.map((item) => item.id), claude.credentialProviders);
  const provider = (id) => claude.providers.find((item) => item.id === id);
  const load = (next) => { setFormState(next); setBaseline(draftSignature(next)); setFocus({ field: "", serial: 0 }); };
  const select = (item) => { load(claudeProviderToForm(item)); setSelectedId(item.id); setStep(3); setView("wizard"); setError(""); };
  const startNew = () => { load(blankClaudeForm()); setSelectedId(""); setStep(1); setView("wizard"); setError(""); };
  const enter = () => {
    setResult(null);
    if (dirty) return;
    const item = provider(selectedId) || claude.providers.find((entry) => entry.isActive) || claude.providers[0];
    if (item) { load(claudeProviderToForm(item)); setSelectedId(item.id); setStep(3); }
  };
  const duplicate = (id) => {
    const item = provider(id);
    if (!item) return;
    const used = new Set([...claude.providers.map((entry) => entry.id), ...(claude.credentialProviders || [])]);
    const prefix = id.slice(0, 88) + "-copy";
    let copyId = prefix;
    for (let n = 2; used.has(copyId); n += 1) copyId = prefix + "-" + n;
    load({ ...claudeProviderToForm(item), providerId: copyId, name: item.name + " 副本", credentialMode: "new", apiKey: "" });
    setSelectedId(""); setStep(2); setView("wizard"); setError("");
    showToast("已复制网关与模型设置，请填写新凭据后保存");
  };
  const validateConnection = () => {
    validateClaudeConnection(form);
    if (identity.conflict) throw Object.assign(new Error(identity.conflict), { field: "providerId" });
    if (form.credentialMode === "new") validateClaudeCredential(form.apiKey);
    else if (!(claude.credentialProviders || []).includes(identity.ownerId)) throw Object.assign(new Error("请填写新凭据。"), { field: "apiKey" });
  };
  const failValidation = (problem) => {
    setError(problem.message);
    setStep(["model", ...CLAUDE_ALIASES].includes(problem.field) ? 3 : 2);
    setFocus((current) => ({ field: problem.field, serial: current.serial + 1 }));
  };
  const goStep = (next) => {
    if (isWriting()) return;
    if (next === 3) { try { validateConnection(); } catch (problem) { failValidation(problem); return; } }
    setError(""); setStep(next);
  };
  const request = async (route, payload, simulate) => {
    if (demoMode) return simulate();
    const response = await fetch("/api/claude/" + route, { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ ...payload, revision: claude.revision }) });
    return readApiResponse(response, "Claude Code 配置操作失败");
  };
  const save = runWrite(async (setActive) => {
    setConflict(false);
    let config;
    try { validateConnection(); config = validateClaudeProvider(form); } catch (problem) { failValidation(problem); return; }
    beginWrite(); setError("");
    try {
      const data = await request("providers", { ...form, apiKey: undefined, renameFrom: identity.renameFrom, setActive, credential: { mode: form.credentialMode, value: form.credentialMode === "new" ? form.apiKey : undefined } }, () => {
        const activated = setActive || provider(identity.ownerId)?.isActive || false;
        const item = { ...config, credentialConfigured: true, adopted: false, isActive: activated };
        const providers = claude.providers.filter((entry) => entry.id !== config.id && entry.id !== identity.renameFrom).map((entry) => activated ? { ...entry, isActive: false } : entry).concat(item);
        return { result: { providerId: config.id, activated }, state: { ...state, claude: { ...claude, providers, credentialProviders: [...new Set(providers.filter((entry) => entry.credentialConfigured).map((entry) => entry.id))], activeProviderId: activated ? config.id : claude.activeProviderId } } };
      });
      setState(data.state);
      const item = data.state.claude.providers.find((entry) => entry.id === config.id);
      load(claudeProviderToForm(item)); setSelectedId(item.id); setResult(data.result); setView("success");
    } catch (problem) { reportRequestError(problem, setError); }
  });
  const activate = runWrite(async (id) => {
    setConflict(false); beginWrite(); setError("");
    try {
      const data = await request("activate", { providerId: id }, () => ({ state: { ...state, claude: { ...claude, activeProviderId: id, providers: claude.providers.map((entry) => ({ ...entry, isActive: entry.id === id })) } } }));
      setState(data.state); setResult({ providerId: id, activated: true }); setView("success");
    } catch (problem) { reportRequestError(problem, setError); }
  });
  const openDelete = (id) => { setDeleteId(id); setDeleteError(""); };
  const closeDelete = useCallback(() => { setDeleteId(""); setDeleteError(""); }, []);
  const remove = async (options) => {
    setConflict(false); setSaving(true); setDeleteError("");
    try {
      const data = await request("providers/delete", { providerId: deleteId, ...options }, () => {
        const activeId = claude.activeProviderId === deleteId ? options.replacementProviderId : claude.activeProviderId;
        return { state: { ...state, claude: { ...claude, activeProviderId: activeId, providers: claude.providers.filter((entry) => entry.id !== deleteId).map((entry) => ({ ...entry, isActive: entry.id === activeId })), credentialProviders: (claude.credentialProviders || []).filter((id) => options.keepCredential || id !== deleteId) } } };
      });
      setState(data.state); closeDelete();
      const next = data.state.claude.providers.find((entry) => entry.id === selectedId) || data.state.claude.providers.find((entry) => entry.isActive) || data.state.claude.providers[0];
      if (next) select(next); else startNew();
      showToast("Claude Code 供应商已删除");
    } catch (problem) { reportRequestError(problem, setDeleteError); }
    finally { setSaving(false); }
  };
  const saveSettings = async (draft) => {
    setConflict(false); setSaving(true); setError("");
    try {
      const data = await request("settings", draft, () => ({ state: { ...state, claude: { ...claude, settings: Object.fromEntries(Object.entries(draft).filter(([, value]) => value !== null)) } } }));
      setState(data.state); showToast("Claude Code 用户设置已保存");
    } catch (problem) { reportRequestError(problem, setError); }
    finally { setSaving(false); }
  };
  return { claude, form, setForm, selectedId, step, dirty, focus, identity, result, deleteId, deleteError, provider, select, startNew, enter, duplicate, goStep, save, activate, openDelete, closeDelete, remove, saveSettings };
}

const STEP_LABELS = [["接入方式", "确认协议与认证方式"], ["填写凭据", "填写地址与访问凭据"], ["确认模型", "默认模型与别名映射"]];
const AUTH_LABELS = { token: "Bearer Token · 令牌认证", "api-key": "API Key · 密钥认证" };

export function ClaudeWizard({ flow, saving, error, conflict, onCopy }) {
  const { claude, form, setForm, step, focus, identity } = flow;
  const inputs = useRef({});
  const aliasesRef = useRef(null);
  useEffect(() => {
    if (CLAUDE_ALIASES.includes(focus.field) && aliasesRef.current) aliasesRef.current.open = true;
    inputs.current[focus.field]?.focus();
  }, [focus.serial, step]);
  const set = (key, value) => setForm((current) => ({ ...current, [key]: value }));
  let validationField = "";
  try { validateClaudeProvider(form); } catch (problem) { validationField = problem.field; }
  const input = (key, label, placeholder, mono = true) => <label><span>{label}</span><input name={key} ref={(node) => { inputs.current[key] = node; }} className={mono ? "mono" : undefined} value={form[key]} onChange={(event) => set(key, event.target.value)} placeholder={placeholder} spellCheck={false} autoComplete="off" aria-invalid={Boolean((form[key] && validationField === key) || (error && focus.field === key) || (key === "providerId" && identity.conflict)) || undefined} /></label>;
  const owner = flow.provider(identity.ownerId);
  const active = owner?.isActive;
  const existing = Boolean(flow.provider(form.providerId.trim()));
  return <>
    <nav className="stepper" aria-label="配置步骤">{STEP_LABELS.map(([title, subtitle], index) => <div className="step-wrap" key={title}><button type="button" className={"step " + (step === index + 1 ? "is-active" : step > index + 1 ? "is-complete" : "")} aria-current={step === index + 1 ? "step" : undefined} disabled={saving || (!owner && index + 1 > step)} onClick={() => flow.goStep(index + 1)}><span className="step-number">{step > index + 1 ? <CheckCircle size={24} weight="fill" /> : index + 1}</span><span><strong>{title}</strong><small>{subtitle}</small></span></button>{index < 2 && <span className="step-line" />}</div>)}</nav>
    <section className="step-content claude-wizard"><div className="step-scroll">
      <div className="section-heading"><div><h1>{step === 1 ? "连接 Claude Code 网关" : step === 2 ? "填写网关与凭据" : "确认 Claude Code 模型"}</h1><p>{step === 1 ? "使用提供 Anthropic Messages 接口的网关。" : step === 2 ? "已有凭据只显示配置状态，不会返回浏览器。" : "填写网关支持的模型 ID，或使用已经映射的别名。"}</p></div></div>
      <ErrorBanner message={error} conflict={conflict} />
      {claude.blockers?.length > 0 && <p className="compat-note is-warning">用户设置含 <code>{claude.blockers.join("、")}</code>，请先在原文件处理这些接入设置，再启用网关。备用供应商仍可保存。</p>}
      {step === 1 ? <>
        <p className="hint-panel"><Asterisk size={20} /> <strong>Anthropic Messages</strong> · Claude Code 原生消息协议</p>
        <div className="credential-box"><h2>网关要求哪种认证？</h2><p className="field-hint">查看网关说明；没有注明时先选令牌认证。</p><div className="credential-options">{Object.entries(AUTH_LABELS).map(([value, label]) => <label className="radio-card" key={value}><input type="radio" name="claude-auth" value={value} checked={form.authType === value} onChange={() => set("authType", value)} /><span>{label}<small><code>{value === "token" ? "Authorization: Bearer" : "x-api-key"}</code></small></span></label>)}</div></div>
      </> : step === 2 ? <>
        <div className="form-grid">{input("providerId", "供应商 ID", "my-gateway")}{input("name", "供应商名称", "我的网关", false)}<div className="form-grid-wide">{input("baseUrl", "API 地址", "https://gateway.example.com")}</div></div>
        {identity.conflict && <p className="field-error">{identity.conflict}</p>}
        {!flow.selectedId && existing && <p className="compat-note is-warning">此 ID 已存在，保存将覆盖该供应商。</p>}
        <div className="credential-box"><div className="credential-options">{(claude.credentialProviders || []).includes(identity.ownerId) && <label className="radio-card"><input type="radio" name="claude-credential" checked={form.credentialMode === "keep"} onChange={() => set("credentialMode", "keep")} /><span>保留已配置凭据</span></label>}<label className="radio-card"><input type="radio" name="claude-credential" checked={form.credentialMode === "new"} onChange={() => set("credentialMode", "new")} /><span>输入新凭据</span></label></div>
          {form.credentialMode === "new" && <label><span>{AUTH_LABELS[form.authType]}</span><PasswordInput value={form.apiKey} inputRef={(node) => { inputs.current.apiKey = node; }} onChange={(event) => set("apiKey", event.target.value)} placeholder="输入后不会回显" ariaInvalid={Boolean(error && focus.field === "apiKey") || undefined} /></label>}
        </div>
      </> : <>
        <ProviderSummary icon={<Asterisk size={34} />} name={form.name || form.providerId} badge={owner ? <button type="button" className="protocol-badge protocol-badge-button" onClick={() => flow.goStep(1)} title="回到第一步改认证方式">{AUTH_LABELS[form.authType]}</button> : <span className="protocol-badge">{AUTH_LABELS[form.authType]}</span>} address={owner ? <p>API 地址　<button type="button" className="gateway-address-button mono" onClick={() => flow.goStep(2)} title={form.baseUrl || undefined}>{form.baseUrl || "尚未填写"}</button></p> : <p title={form.baseUrl || undefined}>API 地址　<code>{form.baseUrl || "尚未填写"}</code></p>} credential={form.credentialMode === "keep" ? { title: "凭据已安全保存", detail: "浏览器无法读取旧 key" } : { title: "凭据将在保存时写入", detail: "当前草稿尚未保存" }} onDuplicate={existing ? () => flow.duplicate(form.providerId.trim()) : undefined} duplicateTitle="以当前配置为模板新建：模型与别名照搬，凭据需要另填" onDelete={owner ? () => flow.openDelete(owner.id) : undefined} />
        <div className="form-grid">{input("model", "默认模型 ID 或别名", "sonnet")}</div>
        <details className="advanced-panel" ref={aliasesRef}><summary><span>模型别名映射（按网关需要填写）</span><CaretDown size={18} /></summary><p className="field-hint">例如把 <code>sonnet</code> 指向网关的模型 ID；留空使用 Claude Code 自身映射。</p><div className="form-grid">{CLAUDE_ALIASES.map((alias) => <label key={alias}><span><code>{alias}</code> 对应的模型 ID</span><input className="mono" name={alias} ref={(node) => { inputs.current[alias] = node; }} value={form.aliases[alias] || ""} onChange={(event) => set("aliases", { ...form.aliases, [alias]: event.target.value })} aria-invalid={validationField === alias || undefined} spellCheck={false} /></label>)}</div></details>
        {owner && !flow.dirty && <ClaudeLaunchCard claude={claude} providerId={owner.id} onCopy={onCopy} />}
        {owner?.adopted && <p className="compat-note"><Info size={18} />已读取原有网关；保存前不会修改文件。</p>}
        <p className="compat-note"><Info size={18} />写入用户级配置。项目设置、组织策略、环境变量或启动参数可能覆盖它；启动后用 <code>/status</code> 确认网关。</p>
      </>}
    </div><WizardFooter onBack={step > 1 ? () => flow.goStep(step - 1) : undefined} backDisabled={saving} note={owner ? (flow.dirty ? "有未保存的修改" : "没有改动") : undefined}><div className="footer-actions">{step < 3 ? <>{identity.sourceId && <button type="button" className="outline-button" disabled={saving || !flow.dirty} onClick={() => flow.save(false)}>{saving ? <><Spinner />正在保存…</> : "保存更改"}</button>}<button type="button" className="primary-button" disabled={saving} onClick={() => flow.goStep(step + 1)}>下一步<ArrowRight size={19} /></button></> : <>{!active && <button type="button" className="secondary-button" disabled={saving} onClick={() => flow.save(true)}>保存并设为全局默认</button>}<button type="button" className="primary-button" disabled={saving || (existing && !flow.dirty)} onClick={() => flow.save(false)}>{saving ? <Spinner /> : null}{active ? "保存更改" : "保存供应商"}</button></>}</div></WizardFooter></section>
  </>;
}

// Two ways to run a saved provider, chosen per copy rather than stored: a
// pinned per-run snapshot, or plain `claude`, which Claude Code itself
// hot-reloads from user settings.json when the global default changes.
export function ClaudeLaunchCard({ claude, providerId, onCopy }) {
  const commandRef = useRef(null);
  const [mode, setMode] = useState("pin");
  const isDefault = claude.activeProviderId === providerId;
  const command = mode === "pin" ? claudeLaunchCommand(claude.launcher, providerId) : claudeFollowCommand(claude.launcher, claude.dirSource);
  const copy = async () => {
    if (await onCopy(command)) return;
    const range = document.createRange(); range.selectNodeContents(commandRef.current);
    const selection = window.getSelection(); selection.removeAllRanges(); selection.addRange(range);
  };
  const modes = [["pin", "固定此供应商", "每个终端各用各的，切换全局默认不影响已启动的会话"], ["follow", "跟随全局默认", "运行中的会话随全局默认热切换，下一条请求起生效"]];
  return <section className="next-step-card claude-launch-card"><h2>在终端中启动</h2><fieldset className="launch-mode"><legend>启动方式</legend>{modes.map(([value, label, hint]) => <label className="radio-card" key={value}><input type="radio" name={"claude-launch-mode-" + providerId} value={value} checked={mode === value} onChange={() => setMode(value)} /><span>{label}<small>{hint}</small></span></label>)}</fieldset>{mode === "follow" && !isDefault && <p className="compat-note is-warning"><Info size={18} />此供应商不是全局默认，这条命令会使用当前全局默认{claude.activeProviderId ? <>（<code>{claude.activeProviderId}</code>）</> : null}。需要时先设为全局默认。</p>}{command && <div className="command-row"><code ref={commandRef}>{command}</code><button type="button" className="copy-button" onClick={copy} aria-label={mode === "pin" ? "复制固定供应商启动命令" : "复制跟随全局默认启动命令"}><Copy size={16} />复制</button></div>}<p>在项目目录的终端运行。启动后用 <code>/status</code> 确认网关，用 <code>/model</code> 选模型。组织策略仍然优先。</p>{claude.launcher?.shell === "powershell" && <p>此命令用于 PowerShell。</p>}</section>;
}

export function ClaudeSuccess({ flow, saving, error, conflict, onCopy }) {
  const active = flow.result?.activated;
  return <section className="success-page"><div className="success-mark"><CheckCircle size={52} weight="fill" /></div><h1>{active ? "已设为 Claude Code 全局默认" : "供应商已保存"}</h1><p>{active ? "直接运行 claude 使用这个全局默认，并随全局默认热切换；需要每个终端固定供应商时选择「固定此供应商」。" : "已存入管理器。用下面的固定命令启动，无需切换全局默认。"}</p><ErrorBanner message={error} conflict={conflict} /><ClaudeLaunchCard claude={flow.claude} providerId={flow.result.providerId} onCopy={onCopy} />{!active && <button type="button" className="primary-button" disabled={saving} onClick={() => flow.activate(flow.result.providerId)}>{saving && <Spinner />}设为全局默认</button>}<div className="success-actions"><button type="button" className="secondary-button" onClick={() => flow.select(flow.provider(flow.result.providerId))}>返回配置</button><button type="button" className="secondary-button" onClick={flow.startNew}><Plus size={18} />添加另一个供应商</button></div></section>;
}

export function ClaudeDeleteDialog({ flow, saving, conflict }) {
  const ref = useRef(null), cancelRef = useRef(null);
  const item = flow.provider(flow.deleteId);
  const alternatives = flow.claude.providers.filter((entry) => entry.id !== item.id && entry.credentialConfigured);
  const [replacementProviderId, setReplacement] = useState(alternatives[0]?.id || "");
  const [keepCredential, setKeep] = useState(false);
  const [localError, setLocalError] = useState("");
  useDialog({ ref, initialFocusRef: cancelRef, onClose: flow.closeDelete, locked: saving });
  return <div className="modal-backdrop" role="presentation"><section className="bulk-modal provider-delete-dialog" role="dialog" aria-modal="true" aria-labelledby="claude-delete-title" ref={ref}><div className="modal-heading"><h2 id="claude-delete-title"><Trash size={22} />删除 Claude Code 供应商</h2></div><p>删除 <strong>{item.name}</strong>（<code>{item.id}</code>）及其模型配置。</p>{item.isActive && <>{alternatives.length ? <label><span>替代供应商</span><select value={replacementProviderId} onChange={(event) => setReplacement(event.target.value)}>{alternatives.map((entry) => <option key={entry.id} value={entry.id}>{entry.name}</option>)}</select></label> : <p className="compat-note is-warning">这是当前生效项，请先添加一个备用供应商。</p>}</>}<label className="checkbox-row"><input type="checkbox" checked={keepCredential} onChange={(event) => setKeep(event.target.checked)} />保留凭据，供同一 ID 再次使用</label><ErrorBanner message={flow.deleteError || localError} conflict={conflict} /><div className="modal-actions"><button type="button" className="secondary-button button-md" ref={cancelRef} disabled={saving} onClick={flow.closeDelete}>取消</button><button type="button" className="danger-button button-md" disabled={saving} onClick={() => { if (item.isActive && !replacementProviderId) { setLocalError("先取消删除并添加一个备用供应商，然后重试。"); return; } flow.remove({ replacementProviderId, keepCredential }); }}>{saving ? <Spinner /> : <Trash size={16} />}确认删除</button></div></section></div>;
}

const settingsDraft = (settings) => ({ language: settings.language ?? "", effortLevel: settings.effortLevel ?? "", alwaysThinkingEnabled: settings.alwaysThinkingEnabled === undefined ? "" : String(settings.alwaysThinkingEnabled) });
export function ClaudeSettings({ flow, state, saving, error, conflict, demoMode, onBack, onDirtyChange }) {
  const [draft, setDraft] = useState(() => settingsDraft(flow.claude.settings));
  const baseline = JSON.stringify(settingsDraft(flow.claude.settings));
  useEffect(() => { setDraft(JSON.parse(baseline)); }, [baseline]);
  const dirty = JSON.stringify(draft) !== baseline;
  useEffect(() => { onDirtyChange(dirty); return () => onDirtyChange(false); }, [dirty, onDirtyChange]);
  const change = (key, value) => setDraft((current) => ({ ...current, [key]: value }));
  return <section className="settings-page claude-settings"><div className="settings-scroll"><div className="settings-title"><div><p>Claude Code 用户级配置</p><h1>设置与兼容性</h1></div><button type="button" className="secondary-button" onClick={onBack}><ArrowLeft size={18} />返回</button></div><ErrorBanner message={error} conflict={conflict} /><section className="settings-card"><h2>回复偏好</h2><div className="form-grid"><label><span>回复语言</span><input value={draft.language} onChange={(event) => change("language", event.target.value)} maxLength={100} placeholder="留空使用 Claude Code 默认值" /></label><label><span>默认思考强度</span><select className="mono" value={draft.effortLevel} onChange={(event) => change("effortLevel", event.target.value)}><option value="">未设置</option>{draft.effortLevel && !CLAUDE_EFFORTS.includes(draft.effortLevel) && <option value={draft.effortLevel}>{draft.effortLevel}（保留现值）</option>}{CLAUDE_EFFORTS.map((value) => <option value={value} key={value}>{value}</option>)}</select></label><label><span>扩展思考</span><select value={draft.alwaysThinkingEnabled} onChange={(event) => change("alwaysThinkingEnabled", event.target.value)}><option value="">未设置</option><option value="true">启用</option><option value="false">关闭（模型支持时）</option></select></label></div><p className="field-hint">默认强度写入 <code>effortLevel</code>。模型单独保存的强度会优先；部分新模型忽略用户级默认强度，请在 Claude Code 用 <code>/effort</code> 设置。</p></section><section className="settings-card compatibility-card"><h2>配置范围</h2><KeyValueList rows={[{ label: "配置目录", value: flow.claude.dir, mono: true, title: flow.claude.dir }, { label: "路径来源", value: flow.claude.dirSource === "default-home" ? "自动识别 · 用户主目录" : flow.claude.dirSource, mono: flow.claude.dirSource !== "default-home" }, { label: "全局默认", value: flow.claude.activeProviderId || "未启用管理器网关", mono: Boolean(flow.claude.activeProviderId) }]} /><p className="compat-note"><Info size={20} />只管理用户级网关与回复偏好，保留权限、钩子及其他字段。云平台接入和动态凭据需在原配置中管理；项目设置、组织策略和启动参数可能覆盖全局默认。</p></section><ManagerCard state={state} demoMode={demoMode} edited={dirty} /></div><footer className="settings-footer"><span className="dirty-note" aria-live="polite">{dirty ? "有未保存的修改" : "与已读取的设置一致"}</span><button type="button" className="primary-button" disabled={saving || !dirty} onClick={() => flow.saveSettings({ language: draft.language.trim() || null, effortLevel: draft.effortLevel || null, alwaysThinkingEnabled: draft.alwaysThinkingEnabled === "" ? null : draft.alwaysThinkingEnabled === "true" })}>{saving && <Spinner />}保存设置</button></footer></section>;
}
