import { useEffect, useRef } from "react";
import { createPortal } from "react-dom";

type Props = {
  onClose: () => void;
  labelledBy: string;
  children: React.ReactNode;
  className?: string;
};

const FOCUSABLE =
  'a[href], button:not([disabled]), input:not([disabled]), select:not([disabled]), textarea:not([disabled]), video[controls], [tabindex]:not([tabindex="-1"])';

export default function Modal({ onClose, labelledBy, children, className }: Props) {
  const contentRef = useRef<HTMLDivElement>(null);
  const onCloseRef = useRef(onClose);
  onCloseRef.current = onClose;

  // Focus moves into the dialog when it opens, Tab cycles within it, and
  // focus goes back to whatever opened it once it closes.
  useEffect(() => {
    const opener = document.activeElement as HTMLElement | null;
    const content = contentRef.current;
    const first = content?.querySelector<HTMLElement>("[data-autofocus]") ??
      content?.querySelector<HTMLElement>(FOCUSABLE);
    (first ?? content)?.focus();

    function onKeyDown(event: KeyboardEvent) {
      if (event.key === "Escape") {
        onCloseRef.current();
        return;
      }
      if (event.key !== "Tab" || !content) return;
      const focusable = [...content.querySelectorAll<HTMLElement>(FOCUSABLE)];
      if (!focusable.length) return;
      const firstEl = focusable[0];
      const lastEl = focusable[focusable.length - 1];
      if (event.shiftKey && document.activeElement === firstEl) {
        event.preventDefault();
        lastEl.focus();
      } else if (!event.shiftKey && document.activeElement === lastEl) {
        event.preventDefault();
        firstEl.focus();
      }
    }
    document.addEventListener("keydown", onKeyDown);
    const previousOverflow = document.body.style.overflow;
    document.body.style.overflow = "hidden";
    return () => {
      document.removeEventListener("keydown", onKeyDown);
      document.body.style.overflow = previousOverflow;
      opener?.focus?.();
    };
  }, []);

  return createPortal(
    <div className="modal-overlay" onClick={onClose}>
      <div
        ref={contentRef}
        className={`modal-content ${className ?? ""}`}
        role="dialog"
        aria-modal="true"
        aria-labelledby={labelledBy}
        tabIndex={-1}
        onClick={(event) => event.stopPropagation()}
      >
        {children}
      </div>
    </div>,
    document.body,
  );
}
