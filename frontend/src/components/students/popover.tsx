"use client";

import { ChevronDown } from "lucide-react";
import { useEffect, useId, useRef, useState, type ReactNode } from "react";
import { cn } from "@/lib/utils";

/** Menu item classes (links and buttons inside a Popover). */
export const menuItem =
  "flex min-h-10 w-full items-center gap-2 rounded-sm px-3 py-2 text-left text-sm text-slate-700 transition-colors duration-150 hover:bg-slate-50 hover:text-brand-navy focus-visible:outline-2 focus-visible:-outline-offset-2 focus-visible:outline-brand-cyan";

/**
 * A button that toggles a small panel (Export menu, More filters, the drawer's More menu).
 * Closes on outside click and Esc (focus returns to the button). `children` may be a function of
 * close() so an item can dismiss the panel.
 */
export function Popover({
  label,
  icon,
  srLabel,
  align = "right",
  buttonClassName,
  panelClassName,
  children,
}: {
  label: ReactNode;
  icon?: ReactNode;
  /** Accessible name when `label` is visually hidden on small screens. */
  srLabel?: string;
  align?: "left" | "right";
  buttonClassName?: string;
  panelClassName?: string;
  children: ReactNode | ((close: () => void) => ReactNode);
}) {
  const [open, setOpen] = useState(false);
  const root = useRef<HTMLDivElement>(null);
  const panelId = useId();
  const buttonId = `${panelId}-button`;
  // By id, not a ref: close() is handed to render-time children.
  const focusButton = () => document.getElementById(buttonId)?.focus();

  useEffect(() => {
    if (!open) return;
    const onDown = (e: PointerEvent) => {
      if (root.current && !root.current.contains(e.target as Node)) setOpen(false);
    };
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") {
        e.preventDefault(); // inside the drawer, Esc closes this menu, not the whole dialog
        setOpen(false);
        document.getElementById(buttonId)?.focus();
      }
    };
    document.addEventListener("pointerdown", onDown);
    document.addEventListener("keydown", onKey);
    return () => {
      document.removeEventListener("pointerdown", onDown);
      document.removeEventListener("keydown", onKey);
    };
  }, [open, buttonId]);

  const close = () => {
    setOpen(false);
    focusButton();
  };

  return (
    <div ref={root} className="relative">
      <button
        id={buttonId}
        type="button"
        aria-expanded={open}
        aria-controls={panelId}
        aria-label={srLabel}
        onClick={() => setOpen((v) => !v)}
        className={buttonClassName}
      >
        {icon}
        {label}
        <ChevronDown className={cn("h-4 w-4 transition-transform motion-reduce:transition-none", open && "rotate-180")} aria-hidden />
      </button>
      {open ? (
        <div
          id={panelId}
          className={cn(
            "absolute top-full z-30 mt-1 min-w-56 rounded-md border border-slate-200 bg-white p-1 shadow-lg print:hidden",
            align === "right" ? "right-0" : "left-0",
            panelClassName,
          )}
        >
          {typeof children === "function" ? children(close) : children}
        </div>
      ) : null}
    </div>
  );
}
