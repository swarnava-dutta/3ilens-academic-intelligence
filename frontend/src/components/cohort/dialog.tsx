"use client";

import { useEffect, useId, useRef, useState, type ReactNode } from "react";
import { CheckCircle2, X, XCircle } from "lucide-react";
import { cn } from "@/lib/utils";

/**
 * Modal built on the native <dialog> (showModal): Esc, focus trapping and the backdrop come from
 * the browser. Clicking the backdrop closes it.
 */
export function Dialog({
  open,
  onClose,
  title,
  eyebrow,
  description,
  size = "md",
  children,
  footer,
}: {
  open: boolean;
  onClose: () => void;
  title: ReactNode;
  eyebrow?: ReactNode;
  description?: ReactNode;
  size?: "md" | "lg";
  children: ReactNode;
  footer?: ReactNode;
}) {
  const ref = useRef<HTMLDialogElement>(null);
  const titleId = useId();

  useEffect(() => {
    const dialog = ref.current;
    if (!dialog) return;
    if (open && !dialog.open) dialog.showModal();
    if (!open && dialog.open) dialog.close();
  }, [open]);

  return (
    <dialog
      ref={ref}
      aria-labelledby={titleId}
      onClose={onClose}
      onClick={(e) => {
        if (e.target === e.currentTarget) onClose();
      }}
      className={cn(
        "m-auto max-h-[calc(100dvh-2rem)] w-[calc(100%-2rem)] rounded-md border border-slate-200 bg-white p-0 text-slate-800 shadow-xl backdrop:bg-slate-900/50 print:hidden",
        size === "md" ? "max-w-lg" : "max-w-2xl",
      )}
    >
      {open ? (
        <div className="flex max-h-[calc(100dvh-2rem)] flex-col">
          <div className="flex items-start justify-between gap-3 border-b border-slate-200 px-5 py-4">
            <div className="min-w-0">
              {eyebrow ? (
                <p className="text-xs text-slate-500">{eyebrow}</p>
              ) : null}
              <h2 id={titleId} className="text-base font-semibold leading-snug text-brand-navy">
                {title}
              </h2>
              {description ? <p className="mt-0.5 text-sm text-slate-500">{description}</p> : null}
            </div>
            <button
              type="button"
              onClick={onClose}
              className="grid h-9 w-9 shrink-0 place-items-center rounded-md text-slate-500 transition-colors hover:bg-slate-100 hover:text-slate-800 focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-brand-cyan"
              aria-label="Close"
            >
              <X className="h-4 w-4" aria-hidden />
            </button>
          </div>
          <div className="min-h-0 flex-1 overflow-y-auto px-5 py-4">{children}</div>
          {footer ? <div className="border-t border-slate-200 px-5 py-3">{footer}</div> : null}
        </div>
      ) : null}
    </dialog>
  );
}

export const btnPrimary =
  "inline-flex h-9 items-center justify-center gap-2 rounded-md bg-brand-navy px-3.5 text-sm font-medium text-white transition-colors hover:bg-brand-navy-700 disabled:cursor-not-allowed disabled:opacity-50 focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-brand-cyan";
export const btnSecondary =
  "inline-flex h-9 items-center justify-center gap-2 rounded-md border border-slate-300 bg-white px-3.5 text-sm font-medium text-slate-700 transition-colors hover:bg-slate-50 disabled:cursor-not-allowed disabled:opacity-50 focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-brand-cyan";
export const fieldClass =
  "h-9 w-full rounded-md border border-slate-300 bg-white px-3 text-sm text-slate-800 placeholder:text-slate-400 focus:border-brand-cyan focus:outline-none focus:ring-2 focus:ring-brand-cyan/30 disabled:bg-slate-50";

export type ToastMessage = { kind: "success" | "error"; message: string };

/** Bottom-right toast that hides itself after a few seconds (or on close). */
export function Toast({ toast, onClose }: { toast: ToastMessage | null; onClose: () => void }) {
  const [hovered, setHovered] = useState(false);
  useEffect(() => {
    if (!toast || hovered) return;
    const timer = window.setTimeout(onClose, 7_000);
    return () => window.clearTimeout(timer);
  }, [toast, hovered, onClose]);

  if (!toast) return null;
  return (
    <div
      role={toast.kind === "error" ? "alert" : "status"}
      onMouseEnter={() => setHovered(true)}
      onMouseLeave={() => setHovered(false)}
      className={cn(
        "fixed inset-x-4 bottom-4 z-50 flex items-start gap-3 rounded-md border px-4 py-3 text-sm shadow-lg sm:inset-x-auto sm:right-6 sm:max-w-md print:hidden",
        toast.kind === "success" ? "border-brand-navy-700 bg-brand-navy text-white" : "border-red-200 bg-red-50 text-red-900",
      )}
    >
      {toast.kind === "success" ? (
        <CheckCircle2 className="mt-0.5 h-4 w-4 shrink-0 text-brand-lime" aria-hidden />
      ) : (
        <XCircle className="mt-0.5 h-4 w-4 shrink-0 text-red-600" aria-hidden />
      )}
      <p className="min-w-0 flex-1">{toast.message}</p>
      <button
        type="button"
        onClick={onClose}
        className={cn(
          "rounded-sm p-1 transition-colors focus-visible:outline-2 focus-visible:outline-brand-cyan",
          toast.kind === "success" ? "text-white/70 hover:bg-white/10 hover:text-white" : "text-red-600 hover:bg-red-100",
        )}
        aria-label="Dismiss"
      >
        <X className="h-4 w-4" aria-hidden />
      </button>
    </div>
  );
}
