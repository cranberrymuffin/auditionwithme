import { useCallback, useRef, useState, type ReactNode } from "react";
import { ToastContext, type ToastKind } from "../lib/toast";

type Toast = { id: number; kind: ToastKind; message: string; leaving?: boolean };

const AUTO_DISMISS_MS = 6000;
const LEAVE_MS = 220;
const MAX_VISIBLE = 3;

/** App-level host for transient error/info notices. Wrap once, fire via useToast(). */
export default function ToastProvider({ children }: { children: ReactNode }) {
  const [toasts, setToasts] = useState<Toast[]>([]);
  const nextId = useRef(0);

  const dismiss = useCallback((id: number) => {
    setToasts((current) =>
      current.map((toast) => (toast.id === id ? { ...toast, leaving: true } : toast))
    );
    setTimeout(() => {
      setToasts((current) => current.filter((toast) => toast.id !== id));
    }, LEAVE_MS);
  }, []);

  const push = useCallback((message: string, kind: ToastKind = "error") => {
    setToasts((current) => {
      // Don't stack duplicates of the same message (e.g. a retried fetch failing again).
      if (current.some((toast) => toast.message === message && !toast.leaving)) return current;
      const id = nextId.current++;
      setTimeout(() => dismiss(id), AUTO_DISMISS_MS);
      return [...current.slice(-(MAX_VISIBLE - 1)), { id, kind, message }];
    });
  }, [dismiss]);

  return (
    <ToastContext.Provider value={push}>
      {children}
      <div className="toast-stack" aria-live="polite">
        {toasts.map((toast) => (
          <div
            key={toast.id}
            className={`toast toast-${toast.kind}${toast.leaving ? " is-leaving" : ""}`}
            role={toast.kind === "error" ? "alert" : "status"}
          >
            <span className="toast-icon" aria-hidden="true">!</span>
            <p>{toast.message}</p>
            <button type="button" onClick={() => dismiss(toast.id)} aria-label="Dismiss notification">
              ×
            </button>
          </div>
        ))}
      </div>
    </ToastContext.Provider>
  );
}
