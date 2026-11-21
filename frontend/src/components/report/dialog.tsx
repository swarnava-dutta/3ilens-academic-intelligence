"use client";

import { X } from "lucide-react";
import { useEffect, useId, useRef, type ReactNode } from "react";
import { cn } from "@/lib/utils";

/**
 * Native <dialog> (showModal): Esc, focus trapping and the backdrop come from the browser.
 * "center" is a modal card; "drawer" is a side sheet on the right.
 * Clicking the backdrop closes it. Never printed.
 */
export function Modal({
  open,
  onClose,
  title,
  eyebrow,
  description,
  variant = "center",
  size = "md",
  className,
  children,
  footer,
}: {
  open: boolean;
  onClose: () => void;
  title: ReactNode;
  eyebrow?: ReactNode;
  description?: ReactNode;
  variant?: "center" | "drawer";
  size?: "md" | "lg" | "xl";
  className?: string;
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
        "p-0 text-slate-800 shadow-xl backdrop:bg-slate-900/50 print:hidden",
        variant === "center"
          ? cn(
              "m-auto max-h-[calc(100dvh-2rem)] w-[calc(100%-2rem)] rounded-md border border-slate-200 bg-white",
              size === "md" ? "max-w-lg" : size === "lg" ? "max-w-2xl" : "max-w-5xl",
            )
          : "fixed inset-y-0 right-0 left-auto m-0 h-dvh max-h-none w-full max-w-xl rounded-none border-l border-slate-200 bg-white",
        className,
      )}
    >
      {open ? (
        <div className={cn("flex flex-col", variant === "drawer" ? "h-full" : "max-h-[calc(100dvh-2rem)]")}>
          <div className="flex items-start justify-between gap-3 border-b border-slate-200 px-5 py-3">
            <div className="min-w-0">
              {eyebrow ? (
                <p className="text-[13px] text-slate-500">{eyebrow}</p>
              ) : null}
              <h2 id={titleId} className="text-base font-semibold leading-snug text-brand-navy">
                {title}
              </h2>
              {description ? <p className="mt-0.5 text-sm text-slate-500">{description}</p> : null}
            </div>
            <button
              type="button"
              onClick={onClose}
              className="grid h-9 w-9 shrink-0 place-items-center rounded-md text-slate-500 transition-colors duration-150 hover:bg-slate-100 hover:text-slate-800 focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-brand-cyan"
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
  "inline-flex h-9 items-center justify-center gap-2 rounded-md px-3.5 text-sm font-medium transition-colors duration-150 disabled:cursor-not-allowed disabled:opacity-50 focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-brand-cyan bg-brand-navy text-white hover:bg-brand-navy-700";
export const btnSecondary =
  "inline-flex h-9 items-center justify-center gap-2 rounded-md px-3.5 text-sm font-medium transition-colors duration-150 disabled:cursor-not-allowed disabled:opacity-50 focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-brand-cyan border border-slate-300 bg-white text-slate-700 hover:bg-slate-50";
export const btnAmber =
  "inline-flex h-9 items-center justify-center gap-2 rounded-md px-3.5 text-sm font-medium transition-colors duration-150 disabled:cursor-not-allowed disabled:opacity-50 focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-amber-600 bg-amber-500 text-amber-950 hover:bg-amber-400";
export const inputClass =
  "w-full rounded-md border border-slate-300 bg-white px-3 py-2 text-sm text-slate-800 placeholder:text-slate-400 focus:border-brand-cyan focus:outline-none focus:ring-2 focus:ring-brand-cyan/30 disabled:bg-slate-50";

/** Inline error/notice box used by the action panels. */
export function Notice({
  tone = "error",
  children,
  className,
}: {
  tone?: "error" | "warn" | "info" | "ok";
  children: ReactNode;
  className?: string;
}) {
  return (
    <p
      role={tone === "error" ? "alert" : "status"}
      className={cn(
        "rounded-md border px-3 py-2 text-sm",
        tone === "error" && "border-rose-200 bg-rose-50 text-rose-800",
        tone === "warn" && "border-amber-200 bg-amber-50 text-amber-900",
        tone === "info" && "border-slate-200 bg-slate-50 text-slate-600",
        tone === "ok" && "border-lime-200 bg-brand-lime-50 text-lime-900",
        className,
      )}
    >
      {children}
    </p>
  );
}
