"use client";

import type { LucideIcon } from "lucide-react";
import { useEffect, useId, useRef, useState, type KeyboardEvent as ReactKeyboardEvent, type ReactNode } from "react";
import { cn } from "@/lib/utils";
import { focusRing } from "./tokens";

export type MenuItem = { key: string; label: ReactNode; Icon?: LucideIcon; onSelect: () => void };

/**
 * Small action menu: a button (aria-haspopup / aria-expanded) over a list of menuitems. Closes on
 * Escape, outside click or a choice; arrow keys move between items. Items are 44px tall on phones.
 */
export function Menu({
  label,
  button,
  items,
  align = "end",
  placement = "below",
  buttonClassName,
}: {
  /** Accessible name of the menu button. */
  label: string;
  button: ReactNode;
  items: MenuItem[];
  align?: "start" | "end";
  placement?: "below" | "above";
  buttonClassName?: string;
}) {
  const [open, setOpen] = useState(false);
  const root = useRef<HTMLDivElement>(null);
  const trigger = useRef<HTMLButtonElement>(null);
  const listRef = useRef<HTMLUListElement>(null);
  const menuId = useId();

  useEffect(() => {
    if (!open) return;
    const onDown = (e: MouseEvent) => {
      if (root.current && !root.current.contains(e.target as Node)) setOpen(false);
    };
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") {
        setOpen(false);
        trigger.current?.focus();
      }
    };
    document.addEventListener("mousedown", onDown);
    document.addEventListener("keydown", onKey);
    // Focus the first item once the list is shown.
    const timer = window.setTimeout(() => listRef.current?.querySelector<HTMLElement>("[role=menuitem]")?.focus(), 0);
    return () => {
      document.removeEventListener("mousedown", onDown);
      document.removeEventListener("keydown", onKey);
      window.clearTimeout(timer);
    };
  }, [open]);

  const onListKey = (e: ReactKeyboardEvent<HTMLUListElement>) => {
    const nodes = [...(listRef.current?.querySelectorAll<HTMLElement>("[role=menuitem]") ?? [])];
    const i = nodes.indexOf(document.activeElement as HTMLElement);
    if (e.key === "ArrowDown" || e.key === "ArrowUp") {
      e.preventDefault();
      const next = e.key === "ArrowDown" ? (i + 1) % nodes.length : (i - 1 + nodes.length) % nodes.length;
      nodes[next]?.focus();
    } else if (e.key === "Home" || e.key === "End") {
      e.preventDefault();
      nodes[e.key === "Home" ? 0 : nodes.length - 1]?.focus();
    } else if (e.key === "Tab") {
      setOpen(false);
    }
  };

  return (
    <div ref={root} className="relative">
      <button
        ref={trigger}
        type="button"
        aria-label={label}
        aria-haspopup="menu"
        aria-expanded={open}
        aria-controls={open ? menuId : undefined}
        onClick={() => setOpen((v) => !v)}
        className={cn(
          "inline-flex min-h-11 cursor-pointer items-center justify-center gap-1.5 rounded-md border border-slate-300 bg-white px-3 text-sm font-medium text-slate-700 transition-colors duration-150 hover:bg-slate-50 sm:min-h-9",
          focusRing,
          buttonClassName,
        )}
      >
        {button}
      </button>
      {open ? (
        <ul
          ref={listRef}
          id={menuId}
          role="menu"
          aria-label={label}
          onKeyDown={onListKey}
          className={cn(
            "absolute z-50 min-w-[14rem] rounded-md border border-slate-200 bg-white py-1 shadow-lg",
            align === "end" ? "right-0" : "left-0",
            placement === "below" ? "top-full mt-1" : "bottom-full mb-1",
          )}
        >
          {items.map((it) => (
            <li key={it.key} role="none">
              <button
                type="button"
                role="menuitem"
                tabIndex={-1}
                onClick={() => {
                  setOpen(false);
                  it.onSelect();
                }}
                className="flex min-h-11 w-full cursor-pointer items-center gap-2 px-3 text-left text-sm text-slate-800 transition-colors duration-150 hover:bg-slate-50 focus:bg-slate-100 focus:outline-none sm:min-h-9"
              >
                {it.Icon ? <it.Icon className="h-4 w-4 shrink-0 text-slate-500" aria-hidden /> : null}
                {it.label}
              </button>
            </li>
          ))}
        </ul>
      ) : null}
    </div>
  );
}
