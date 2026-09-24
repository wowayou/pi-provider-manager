// The manager-level card shared by the Pi and Codex settings screens: the
// manager's own version/Node/port, the online update check and apply, and the
// local-service restart. None of it is agent-specific, so both settings screens
// render one of these rather than the Pi screen alone owning the only path to
// "check for updates" and "restart".
//
// It owns its own update/restart state. `edited` is the host screen's
// unsaved-edit flag: a restart discards the draft on the screen it is triggered
// from, so it confirms first only when there is something to lose.

import { useEffect, useState } from "react";
import { ArrowsClockwise, Check, CheckCircle, CloudArrowDown, WarningCircle, X } from "@phosphor-icons/react";

import { readApiResponse, Spinner } from "./ui-kit.jsx";

export function ManagerCard({ state, demoMode, edited }) {
  const [updateInfo, setUpdateInfo] = useState(state.update || {});
  const [updateBusy, setUpdateBusy] = useState("");
  const [updateError, setUpdateError] = useState("");
  const [pendingOverride, setPendingOverride] = useState("");
  const [bundleOverride, setBundleOverride] = useState(null);
  const pendingApp = pendingOverride || state.compatibility?.pendingAppVersion || "";
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
  // idle | confirm | working | done | failed.
  const [restartPhase, setRestartPhase] = useState("idle");
  const [restartMessage, setRestartMessage] = useState("");
  const [restartStage, setRestartStage] = useState("");
  const [restartElapsed, setRestartElapsed] = useState(0);
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
  return (
    <section className="settings-card manager-card">
      <h2>管理器与更新</h2>
      <dl>
        <div><dt>管理器版本</dt><dd className="mono">{state.compatibility?.appVersion || "unknown"}</dd></div>
        <div><dt>Node</dt><dd className="mono">{state.compatibility?.nodeVersion || "unknown"}</dd></div>
        <div><dt>本地服务</dt><dd className="mono">{state.compatibility?.serviceHost || "127.0.0.1"}:{state.compatibility?.servicePort || 43127}</dd></div>
      </dl>
      {pendingApp && (
        <p className="compat-note is-warning">
          <WarningCircle size={20} weight="fill" />
          磁盘上的管理器已是 {pendingApp}，当前运行的仍是 {state.compatibility?.appVersion || "unknown"}。上面这些数值来自正在运行的进程，重启本地服务后才会更新。
        </p>
      )}
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
              disabled={restartPhase === "working" || restartPhase === "done" || demoMode || Boolean(bundleProblem)}
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
  );
}
