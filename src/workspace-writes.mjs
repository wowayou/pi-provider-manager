import { useCallback, useEffect, useRef, useState } from "react";

export function useWorkspaceWrites(showToast) {
  // Set alongside a 409 request error and cleared at the entry of every save:
  // it is what lets the persistent banner carry the 重新读取 action after the
  // toast that also offers it has expired.
  const [conflict, setConflict] = useState(false);
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

  // The provider write lock: while a save or a default/active switch is in
  // flight, nothing may edit the draft it will replace, leave it, or start a
  // second write. The ref is what refuses a re-entry synchronously — `writing`
  // only takes effect on the next render, too late for a second call in the
  // same tick; the state drives the disabled workspace, the sidebar and the
  // busy note. Blocked input is dropped, never queued: nothing replays after.
  // The ref is held from entry; the visible lock starts with the request
  // (`beginWrite`), so a validation refusal that
  // focuses its field never meets a disabled workspace.
  const writeLockRef = useRef(false);
  const [writing, setWriting] = useState(false);
  const beginWrite = useCallback(() => setWriting(true), []);
  const runWrite = useCallback((work) => async (...args) => {
    if (writeLockRef.current) return undefined;
    writeLockRef.current = true;
    setConflict(false);
    try {
      return await work(...args);
    } finally {
      writeLockRef.current = false;
      setWriting(false);
    }
  }, []);
  // An entry the lock simply refuses while a write is pending.
  const unlessWriting = useCallback((action) => (...args) => (writeLockRef.current ? undefined : action(...args)), []);
  // Said only once a write is slow enough to see; a local write usually lands
  // well before this, so the note does not flash on every save.
  const [writingNotice, setWritingNotice] = useState(false);
  useEffect(() => {
    if (!writing) { setWritingNotice(false); return undefined; }
    const timer = setTimeout(() => setWritingNotice(true), 300);
    return () => clearTimeout(timer);
  }, [writing]);

  return { saving: writing, conflict, reportRequestError, writeLockRef,
    writing, writingNotice, beginWrite, runWrite, unlessWriting };
}
