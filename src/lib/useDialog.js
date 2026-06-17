import { useEffect, useRef } from "react";

const FOCUSABLE =
  'a[href], button:not([disabled]), input:not([disabled]), textarea:not([disabled]), select:not([disabled]), [tabindex]:not([tabindex="-1"])';

// Accessibility plumbing shared by the modals: returns a ref to attach to the
// dialog panel. While `open`, it traps Tab focus inside the panel, closes on
// Escape, locks body scroll, moves focus into the dialog, and restores focus
// to the previously-focused element on close.
export function useDialog(open, onClose) {
  const ref = useRef(null);
  // Keep the latest onClose without re-running the effect (and re-stealing
  // focus) every time the parent re-renders.
  const onCloseRef = useRef(onClose);
  useEffect(() => {
    onCloseRef.current = onClose;
  });

  useEffect(() => {
    if (!open) return;
    const node = ref.current;
    const prevActive = document.activeElement;
    const prevOverflow = document.body.style.overflow;
    document.body.style.overflow = "hidden";

    const focusables = () =>
      node ? Array.from(node.querySelectorAll(FOCUSABLE)) : [];

    // Move focus into the dialog (first focusable, else the panel itself).
    (focusables()[0] || node)?.focus?.();

    const onKey = (e) => {
      if (e.key === "Escape") {
        e.stopPropagation();
        onCloseRef.current?.();
        return;
      }
      if (e.key !== "Tab") return;
      const f = focusables();
      if (f.length === 0) {
        e.preventDefault();
        return;
      }
      const first = f[0];
      const last = f[f.length - 1];
      if (e.shiftKey && document.activeElement === first) {
        e.preventDefault();
        last.focus();
      } else if (!e.shiftKey && document.activeElement === last) {
        e.preventDefault();
        first.focus();
      }
    };

    document.addEventListener("keydown", onKey);
    return () => {
      document.removeEventListener("keydown", onKey);
      document.body.style.overflow = prevOverflow;
      prevActive?.focus?.();
    };
  }, [open]);

  return ref;
}
