"use client";

import { ChevronDown } from "lucide-react";
import { useEffect, useState, type ReactNode } from "react";
import { cn } from "@/lib/utils";
import { FacultyBadge } from "./faculty-badge";
import { OPEN_FOLD_EVENT, currentHash, foldForHash } from "./report-events";
import { focusRing } from "./summary/tokens";

const STORE_KEY = "sair:fold:";

/** Open state kept per viewer; storage can be missing or blocked, so every access is guarded. */
function readStored(id: string): boolean {
  try {
    return window.localStorage.getItem(STORE_KEY + id) === "1";
  } catch {
    return false;
  }
}

function writeStored(id: string, open: boolean): void {
  try {
    if (open) window.localStorage.setItem(STORE_KEY + id, "1");
    else window.localStorage.removeItem(STORE_KEY + id);
  } catch {
    /* private mode or blocked storage: the fold still works, it just is not remembered */
  }
}

function initiallyOpen(id: string): boolean {
  if (typeof window === "undefined") return false;
  return foldForHash(currentHash()) === id || readStored(id);
}

/**
 * Disclosure for "More details": a button (aria-expanded / aria-controls) over a region that
 * expands in 200 ms (no motion under prefers-reduced-motion). The content mounts on first open and
 * stays mounted. Opens on OPEN_FOLD_EVENT with its id and on a matching URL hash (#more-questions,
 * #q-51, #page-3). A closed fold is skipped when printing; an open one prints.
 */
export function Fold({
  id,
  title,
  teaser,
  faculty = false,
  children,
  className,
}: {
  id: string;
  title: string;
  /** One line under the title: what is inside, with counts. */
  teaser?: ReactNode;
  /** Teacher-only content: shows the "For faculty" badge. */
  faculty?: boolean;
  children: ReactNode;
  className?: string;
}) {
  const [open, setOpen] = useState(() => initiallyOpen(id));
  const [mounted, setMounted] = useState(open);
  const contentId = `${id}-content`;
  const titleId = `${id}-title`;

  useEffect(() => {
    const onOpen = (e: Event) => {
      if ((e as CustomEvent<string>).detail !== id) return;
      setMounted(true);
      setOpen(true);
    };
    window.addEventListener(OPEN_FOLD_EVENT, onOpen);
    return () => window.removeEventListener(OPEN_FOLD_EVENT, onOpen);
  }, [id]);

  const toggle = () => {
    const next = !open;
    if (next) setMounted(true);
    setOpen(next);
    writeStored(id, next);
  };

  return (
    <section
      id={id}
      aria-labelledby={titleId}
      className={cn(
        "min-w-0 scroll-mt-28 rounded-md border border-slate-200 bg-white md:scroll-mt-36",
        !open && "print:hidden",
        className,
      )}
    >
      <h3 className="m-0">
        <button
          type="button"
          aria-expanded={open}
          aria-controls={contentId}
          onClick={toggle}
          className={cn(
            "flex min-h-11 w-full cursor-pointer items-center gap-3 rounded-md px-3 py-2.5 text-left transition-colors duration-150 hover:bg-slate-50 sm:px-4 print:hidden",
            focusRing,
          )}
        >
          <span className="min-w-0 flex-1">
            <span id={titleId} className="block text-[15px] font-semibold leading-snug text-[#1E3A8A]">
              {title}
            </span>
            {teaser ? <span className="mt-0.5 block text-[13px] leading-snug text-slate-600">{teaser}</span> : null}
          </span>
          {faculty ? <FacultyBadge className="hidden sm:inline-flex" /> : null}
          <ChevronDown
            className={cn(
              "h-4 w-4 shrink-0 text-slate-500 transition-transform duration-150 ease-out motion-reduce:transition-none",
              open && "rotate-180",
            )}
            aria-hidden
          />
        </button>
        <span className="sair-print-only px-4 pt-3 text-[15px] font-semibold text-[#1E3A8A]">{title}</span>
      </h3>
      <div
        id={contentId}
        role="region"
        aria-labelledby={titleId}
        inert={!open}
        className={cn(
          "grid transition-[grid-template-rows] duration-200 ease-out motion-reduce:transition-none",
          open ? "grid-rows-[1fr]" : "grid-rows-[0fr]",
        )}
      >
        <div className="min-h-0 overflow-hidden">
          {mounted ? (
            <div className="space-y-4 border-t border-slate-200 p-3 sm:p-4">
              {faculty ? <FacultyBadge className="sm:hidden" /> : null}
              {children}
            </div>
          ) : null}
        </div>
      </div>
    </section>
  );
}

/** Heading over a group of folds ("Teacher tools — for faculty"). */
export function FoldGroup({ title, faculty = false, children }: { title?: string; faculty?: boolean; children: ReactNode }) {
  return (
    <div role="group" aria-label={title} className="space-y-2">
      {title ? (
        <p className="flex items-center gap-2 pt-1 text-[13px] font-semibold text-slate-700 print:hidden" aria-hidden>
          {title}
          {faculty ? <FacultyBadge /> : null}
        </p>
      ) : null}
      <div className="space-y-2">{children}</div>
    </div>
  );
}
