"use client";

import { useEffect, useId, useRef, useState, type ReactNode } from "react";
import { cn } from "@/lib/utils";

/**
 * A button that opens a small panel below it (exam date, share menu). Closes on Escape (focus goes
 * back to the button) and on a click outside. Flat: a border, no shadow.
 */
export function PopoverButton({
  label,
  children,
  buttonClassName,
  panelClassName,
  align = "left",
  disabled,
  title,
}: {
  label: ReactNode;
  children: (close: () => void) => ReactNode;
  buttonClassName?: string;
  panelClassName?: string;
  align?: "left" | "right";
  disabled?: boolean;
  title?: string;
}) {
  const [open, setOpen] = useState(false);
  const wrap = useRef<HTMLDivElement>(null);
  const button = useRef<HTMLButtonElement>(null);
  const panelId = useId();

  useEffect(() => {
    if (!open) return;
    const onDown = (e: PointerEvent) => {
      if (wrap.current && !wrap.current.contains(e.target as Node)) setOpen(false);
    };
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") {
        setOpen(false);
        button.current?.focus();
      }
    };
    document.addEventListener("pointerdown", onDown);
    document.addEventListener("keydown", onKey);
    return () => {
      document.removeEventListener("pointerdown", onDown);
      document.removeEventListener("keydown", onKey);
    };
  }, [open]);

  const close = () => setOpen(false);

  return (
    <div ref={wrap} className="relative min-w-0">
      <button
        ref={button}
        type="button"
        aria-expanded={open}
        aria-controls={panelId}
        disabled={disabled}
        title={title}
        onClick={() => setOpen((v) => !v)}
        className={buttonClassName}
      >
        {label}
      </button>
      {open ? (
        <div
          id={panelId}
          className={cn(
            "absolute top-full z-30 mt-1 w-[min(22rem,calc(100vw-2rem))] rounded-md border border-slate-300 bg-white p-3 text-sm text-slate-700",
            align === "right" ? "right-0" : "left-0",
            panelClassName,
          )}
        >
          {children(close)}
        </div>
      ) : null}
    </div>
  );
}
