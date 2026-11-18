import { useCallback, useMemo, useState } from "react";
import { normalizeUrl } from "../lib/validation.mjs";
import { demoActivateCodex, draftSignature, duplicateCodexForm, providerDraftIdentity } from "./model-draft.mjs";
import { readApiResponse, titleFromId } from "./ui-kit.jsx";
import { blankCodexForm, codexProviderToForm } from "./codex-draft.mjs";

// Mounted across target switches so the user can return to a pending Codex draft.
export function useCodexFlow({ state, setState, setView, setError, setConflict, reportRequestError, showToast,
  demoMode, runWrite, beginWrite, writeLockRef, setDeletingProvider, setDeleteProviderError, exitSelectMode }) {
  const [codexForm, setCodexForm] = useState(blankCodexForm);
  const [codexBaseline, setCodexBaseline] = useState(() => draftSignature(blankCodexForm()));
  const [codexStep, setCodexStep] = useState(1);
  const [codexSelectedId, setCodexSelectedId] = useState("");
  const [codexSaveResult, setCodexSaveResult] = useState(null);
  const [codexDeleteTargetId, setCodexDeleteTargetId] = useState("");
  const [codexBulkDeleteIds, setCodexBulkDeleteIds] = useState([]);
  const loadCodexForm = useCallback((next) => { setCodexForm(next); setCodexBaseline(draftSignature(next)); }, []);
  const editCodexForm = useCallback((update) => { if (!writeLockRef.current) setCodexForm(update); }, [writeLockRef]);
  const codexDirty = useMemo(() => draftSignature(codexForm) !== codexBaseline, [codexForm, codexBaseline]);

  const codex = state.codex || { providers: [], settings: {}, revision: "" };
  const codexProvider = (id) => codex.providers.find((provider) => provider.id === id);
  const codexIdentity = providerDraftIdentity(codexSelectedId, codexForm.providerId, codex.providers.map((provider) => provider.id));

  const duplicate = (sourceForm) => {
    if (!codexProvider(sourceForm.providerId.trim())) return;
    loadCodexForm(duplicateCodexForm(sourceForm, codex.providers.map((item) => item.id)));
    setCodexSelectedId("");
    setCodexStep(2);
    setView("wizard");
    setError("");
    showToast("已复制模型与推理强度；改好 ID 和网关地址，填入新 key 后保存");
  };
  const duplicateById = (id) => {
    const provider = codexProvider(id);
    if (provider) duplicate(codexProviderToForm(provider, codex));
  };

  const enter = () => {
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
    if (codexIdentity.conflict) return codexIdentity.conflict;
    if (!codexForm.name.trim()) return "请填写供应商名称。";
    if (codexForm.upstream === "bridge") {
      if (!codexForm.bridgeUpstreamUrl.trim()) return "请输入上游 API 地址。";
      try { normalizeUrl(codexForm.bridgeUpstreamUrl); } catch (problem) { return problem.message; }
      const savedBridge = codexProvider(codexIdentity.ownerId)?.bridge;
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
    const providerId = codexIdentity.ownerId;
    if (demoMode) {
      await new Promise((resolve) => setTimeout(resolve, 400));
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
      body: JSON.stringify({ providerId }),
    });
    const data = await readApiResponse(response, action === "start" ? "启动桥失败" : "停止桥失败");
    // The bridge is runtime state, not configuration, so refresh it without
    // disturbing a draft: only the codex.bridge slice changes.
    setState((current) => ({ ...current, codex: { ...current.codex, bridge: data.bridge } }));
    showToast(action === "start"
      ? "已启动本地桥；几秒后再看状态，首次启动 LiteLLM 会慢一些"
      : "已停止本地桥");
  };

  const finishSave = (nextState, providerId) => {
    setState(nextState);
    const saved = (nextState.codex?.providers || []).find((provider) => provider.id === providerId);
    if (saved) { setCodexSelectedId(saved.id); loadCodexForm(codexProviderToForm(saved, nextState.codex)); }
    setCodexSaveResult({
      providerId,
      name: saved?.name || titleFromId(providerId),
      modelCount: saved?.models.length || 0,
      defaultModelId: saved?.defaultModelId || "",
      activated: Boolean(saved?.isActive),
      requiresAuth: saved?.requiresAuth !== false,
      bridged: Boolean(saved?.bridge),
      command: "codex",
      otherModels: (saved?.models || []).map((model) => model.id).filter((id) => id !== saved?.defaultModelId),
    });
    setView("success");
  };

  // Switches Codex to a stored provider without resubmitting its form, through
  // /api/codex/activate: the stored entry is applied exactly as saved. Shared by
  // an unedited step-3 save and the sidebar row menu.
  const activateCodexNow = async (providerId) => {
    setConflict(false);
    beginWrite();
    setError("");
    try {
      let nextState;
      if (demoMode) {
        await new Promise((resolve) => setTimeout(resolve, 350));
        nextState = { ...state, codex: demoActivateCodex(codex, providerId) };
      } else {
        const response = await fetch("/api/codex/activate", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ providerId, revision: codex.revision }) });
        nextState = (await readApiResponse(response, "切换失败")).state;
      }
      finishSave(nextState, providerId);
    } catch (requestError) {
      reportRequestError(requestError, setError);
    }
  };

  const activateCodex = runWrite(activateCodexNow);

  const saveCodexNow = async (setActive) => {
    // Nothing to write but the switch: apply the stored provider as it is,
    // rather than rebuilding it from the form.
    if (setActive && codexIdentity.sourceId && !codexIdentity.renameFrom && !codexDirty) {
      await activateCodexNow(codexIdentity.sourceId);
      return;
    }
    setConflict(false);
    const message = validateCodexCredentials();
    if (message) { setError(message); setCodexStep(2); return; }
    const named = codexForm.models.filter((model) => model.id.trim());
    // Step-3 checks: a save started on step 1 or 2 moves to the step that owns them.
    if (named.length === 0) { setError("至少填写一个模型 ID。"); setCodexStep(3); return; }
    const selected = codexForm.models.find((model) => model.rowId === codexForm.defaultRowId && model.id.trim());
    if (!selected) { setError("请选择一个已命名模型作为该供应商的默认模型。"); setCodexStep(3); return; }
    // A draft opened from a stored Codex provider whose ID now differs is a
    // rename of that provider, not a fork. The server moves its stored config
    // and active marker together, then relabels any matching bridge runtime
    // record separately; the client only names the source.
    const codexRenameFrom = codexIdentity.renameFrom;
    beginWrite();
    setError("");
    try {
      if (demoMode) {
        // Demo has no server behind the codex endpoints: the Pi save path has
        // faked its happy path since V1.1, and without this mirror the Codex
        // workspace could never leave the wizard — the posted draft revision
        // is the fixture's "", which the real API refuses with 409.
        await new Promise((resolve) => setTimeout(resolve, 500));
        const requiresAuth = codexForm.upstream !== "bridge" && codexForm.requiresAuth;
        const existing = codexProvider(codexIdentity.ownerId);
        const bridge = codexForm.upstream === "bridge" ? {
          ...existing?.bridge,
          upstreamBaseUrl: codexForm.bridgeUpstreamUrl.trim(),
          port: existing?.bridge?.port || 4000,
          credentialConfigured: Boolean(codexForm.bridgeApiKey.trim() || existing?.bridge?.credentialConfigured),
        } : null;
        const saved = {
          id: codexForm.providerId.trim(),
          name: codexForm.name.trim() || titleFromId(codexForm.providerId.trim()),
          baseUrl: bridge ? `http://127.0.0.1:${bridge.port}/v1` : codexForm.baseUrl.trim(),
          bridge,
          requiresAuth,
          models: named.map((model) => ({ id: model.id.trim(), reasoningEffort: model.reasoningEffort })),
          defaultModelId: selected.id.trim(),
          credentialConfigured: !requiresAuth || codexForm.credentialMode !== "new" || Boolean(codexForm.apiKey.trim()),
          adopted: false,
          isActive: Boolean(setActive || codex.activeProviderId === codexForm.providerId.trim() || (codexRenameFrom && codex.activeProviderId === codexRenameFrom)),
        };
        const savedCodex = {
          ...codex,
          bridge: codexRenameFrom && codex.bridge?.providerId === codexRenameFrom
            ? { ...codex.bridge, providerId: saved.id }
            : codex.bridge,
          activeProviderId: setActive
            ? saved.id
            : codexRenameFrom && codex.activeProviderId === codexRenameFrom
              ? saved.id
              : codex.activeProviderId,
          providers: [
            ...codex.providers
              .filter((provider) => provider.id !== saved.id && provider.id !== codexRenameFrom)
              .map((provider) => (setActive ? { ...provider, isActive: false } : provider)),
            saved,
          ],
        };
        // A save that takes the switch moves the settings exactly as a switch does.
        const demoCodex = saved.isActive ? demoActivateCodex(savedCodex, saved.id) : savedCodex;
        finishSave({ ...state, codex: demoCodex }, saved.id);
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
          ...(codexRenameFrom ? { renameFrom: codexRenameFrom } : {}),
        }),
      });
      const data = await readApiResponse(response, "保存失败");
      finishSave(data.state, codexForm.providerId.trim());
    } catch (requestError) {
      reportRequestError(requestError, setError);
    }
  };
  const saveCodex = runWrite(saveCodexNow);

  const deleteCodexProvider = async (payload) => {
    setConflict(false);
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

  const saveCodexSettings = runWrite(async (draft) => {
    setConflict(false);
    beginWrite();
    setError("");
    try {
      let nextState;
      if (demoMode) {
        await new Promise((resolve) => setTimeout(resolve, 400));
        const { activeProviderId, ownedProviderId, ...preferences } = draft;
        let next = { ...codex, ownedProviderId };
        if (activeProviderId) next = demoActivateCodex(next, activeProviderId);
        nextState = { ...state, codex: { ...next, settings: { ...next.settings, ...preferences },
          providers: next.providers.map(p => p.id !== activeProviderId ? p : { ...p, models: p.models.map(m =>
            m.id === p.defaultModelId ? { ...m, reasoningEffort: preferences.reasoningEffort } : m) }),
        } };
      } else {
        const response = await fetch("/api/codex/settings", {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ ...draft, revision: codex.revision }),
        });
        nextState = (await readApiResponse(response, "保存设置失败")).state;
      }
      setState(nextState);
      const selected = nextState.codex.providers.find(p => p.id === codexSelectedId);
      if (selected && !codexDirty) loadCodexForm(codexProviderToForm(selected, nextState.codex));
      showToast(demoMode ? "演示设置已更新，未写入本地文件" : "Codex 设置已写入 config.toml；对新开的会话生效");
    } catch (requestError) {
      reportRequestError(requestError, setError);
    }
  });

  const returnToSavedCodexProvider = () => {
    const provider = codexProvider(codexSaveResult?.providerId);
    if (provider) selectCodexProvider(provider);
    else setView("wizard");
  };

  return {
    codex, enter,
    form: codexForm,
    editForm: editCodexForm,
    step: codexStep,
    setStep: setCodexStep,
    dirty: codexDirty,
    selectedId: codexSelectedId,
    result: codexSaveResult,
    setResult: setCodexSaveResult,
    deleteId: codexDeleteTargetId,
    setDeleteId: setCodexDeleteTargetId,
    bulkDeleteIds: codexBulkDeleteIds,
    setBulkDeleteIds: setCodexBulkDeleteIds,
    identity: codexIdentity,
    provider: codexProvider,
    select: selectCodexProvider,
    startNew: startNewCodex,
    duplicateDraft: () => duplicate(codexForm),
    duplicateById,
    activate: activateCodex,
    save: saveCodex,
    saveSettings: saveCodexSettings,
    returnToSaved: returnToSavedCodexProvider,
    remove: deleteCodexProvider,
    removeBulk: deleteCodexProvidersBulk,
    bridgeAction,
    goStep: goToCodexStep,
    goToModels: goToCodexModels,
  };
}
