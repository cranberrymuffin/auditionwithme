import { createContext, useContext } from "react";

export type ToastKind = "error" | "info";

/** Fire-and-forget notice; rendered by ToastProvider at the app root. */
export const ToastContext = createContext<(message: string, kind?: ToastKind) => void>(() => {});

export function useToast() {
  return useContext(ToastContext);
}
