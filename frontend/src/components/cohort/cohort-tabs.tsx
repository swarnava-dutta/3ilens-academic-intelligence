"use client";

import { useEffect, useId, useRef, useState, type KeyboardEvent, type ReactNode } from "react";
import { ChevronRight } from "lucide-react";
import { cn } from "@/lib/utils";
import type { CohortTab } from "./url";

/** A request from a link elsewhere on the page to show `tab` (n increases with every request). */
export interface RevealRequest {
  tab: CohortTab;
  n: number;
}

export interface TabDef {
  id: CohortTab;
  label: string;
  count?: number | null;
}

function reducedMotion(): boolean {
  return typeof window !== "undefined" && window.matchMedia?.("(prefers-reduced-motion: reduce)").matches;
}

/**
 * ARIA tabs (tablist / tab / tabpanel, roving tabindex, Arrow keys, Home / End). The selected tab
 * lives in the URL (?tab=), so a view can be shared. Only the selected panel is rendered. On
 * phones the tab row scrolls inside itself (a fade and a chevron show there is more); the page
 * never scrolls sideways.
 *
 * `reveal` is bumped by links elsewhere on the page (tiles, card footers, the action strip) that
 * open a tab: the section scrolls into view and the panel takes focus, so the click visibly does
 * something. A click on the tab list itself never scrolls.
 */
export function CohortTabs({
  tabs,
  selected,
  onSelect,
  reveal,
  children,
}: {
  tabs: TabDef[];
  selected: CohortTab;
  onSelect: (tab: CohortTab) => void;
  reveal?: RevealRequest | null;
  children: ReactNode;
}) {
  const base = useId();
  const refs = useRef<Map<CohortTab, HTMLButtonElement>>(new Map());
  const section = useRef<HTMLElement>(null);
  const scroller = useRef<HTMLDivElement>(null);
  const panels = useRef<Map<CohortTab, HTMLDivElement>>(new Map());
  const [more, setMore] = useState(false);
  const index = Math.max(0, tabs.findIndex((t) => t.id === selected));
  const active = tabs[index]?.id ?? tabs[0]?.id;

  const revealN = reveal?.n ?? 0;
  const revealTab = reveal?.tab ?? null;
  const focused = useRef(0);

  // A tab opened from elsewhere on the page: bring the tabs into view (once per request)...
  useEffect(() => {
    if (revealN <= 0) return;
    section.current?.scrollIntoView({ block: "start", behavior: reducedMotion() ? "auto" : "smooth" });
  }, [revealN]);

  // ...and focus its panel once the URL has switched to it (a tab click itself never moves focus).
  useEffect(() => {
    if (revealN <= 0 || focused.current === revealN || revealTab !== active) return;
    focused.current = revealN;
    panels.current.get(active)?.focus({ preventScroll: true });
  }, [revealN, revealTab, active]);

  // Keep the active tab visible inside the scrolling row (phones), and show the "more" cue.
  useEffect(() => {
    const row = scroller.current;
    const tab = refs.current.get(active);
    if (!row) return;
    if (tab && (tab.offsetLeft < row.scrollLeft || tab.offsetLeft + tab.offsetWidth > row.scrollLeft + row.clientWidth)) {
      row.scrollTo({ left: Math.max(0, tab.offsetLeft - 16), behavior: "auto" });
    }
    const update = () => setMore(row.scrollLeft + row.clientWidth < row.scrollWidth - 4);
    update();
    row.addEventListener("scroll", update, { passive: true });
    window.addEventListener("resize", update);
    return () => {
      row.removeEventListener("scroll", update);
      window.removeEventListener("resize", update);
    };
  }, [active, tabs.length]);

  function go(i: number) {
    const tab = tabs[(i + tabs.length) % tabs.length];
    onSelect(tab.id);
    refs.current.get(tab.id)?.focus();
  }

  function onKeyDown(e: KeyboardEvent<HTMLDivElement>) {
    if (e.key === "ArrowRight") go(index + 1);
    else if (e.key === "ArrowLeft") go(index - 1);
    else if (e.key === "Home") go(0);
    else if (e.key === "End") go(tabs.length - 1);
    else return;
    e.preventDefault();
  }

  return (
    <section
      ref={section}
      id="cohort-details"
      aria-label="Details"
      className="min-w-0 scroll-mt-4 rounded-md border border-slate-200 bg-white"
    >
      <div className="relative border-b border-slate-200">
        <div ref={scroller} className="overflow-x-auto [scrollbar-width:none] [&::-webkit-scrollbar]:hidden">
          <div role="tablist" aria-label="Cohort details" onKeyDown={onKeyDown} className="flex min-w-max gap-1 px-2 sm:px-3">
            {tabs.map((t) => {
              const isActive = t.id === active;
              return (
                <button
                  key={t.id}
                  ref={(el) => {
                    if (el) refs.current.set(t.id, el);
                    else refs.current.delete(t.id);
                  }}
                  type="button"
                  role="tab"
                  id={`${base}-tab-${t.id}`}
                  aria-selected={isActive}
                  aria-controls={`${base}-panel-${t.id}`}
                  tabIndex={isActive ? 0 : -1}
                  onClick={() => onSelect(t.id)}
                  className={cn(
                    "relative -mb-px inline-flex h-11 items-center gap-1.5 whitespace-nowrap border-b-2 px-2.5 text-sm transition-colors focus-visible:outline-2 focus-visible:-outline-offset-2 focus-visible:outline-cyan-700",
                    isActive
                      ? "border-brand-cyan-600 font-semibold text-brand-navy"
                      : "border-transparent text-slate-600 hover:text-brand-navy",
                  )}
                >
                  {t.label}
                  {typeof t.count === "number" ? (
                    <span
                      className={cn(
                        "rounded-sm px-1 text-xs tabular-nums",
                        isActive ? "bg-brand-cyan-50 text-cyan-800" : "bg-slate-100 text-slate-600",
                      )}
                    >
                      {t.count}
                    </span>
                  ) : null}
                </button>
              );
            })}
          </div>
        </div>
        {more ? (
          <button
            type="button"
            tabIndex={-1}
            aria-hidden
            onClick={() => scroller.current?.scrollBy({ left: 160, behavior: reducedMotion() ? "auto" : "smooth" })}
            className="absolute inset-y-0 right-0 flex w-12 items-center justify-end bg-gradient-to-l from-white via-white/90 to-transparent pr-1 text-slate-500"
          >
            <ChevronRight className="h-4 w-4" />
          </button>
        ) : null}
      </div>
      {tabs.map((t) => (
        <div
          key={t.id}
          ref={(el) => {
            if (el) panels.current.set(t.id, el);
            else panels.current.delete(t.id);
          }}
          role="tabpanel"
          id={`${base}-panel-${t.id}`}
          aria-labelledby={`${base}-tab-${t.id}`}
          hidden={t.id !== active}
          tabIndex={0}
          className="min-w-0 p-4 focus-visible:outline-2 focus-visible:-outline-offset-2 focus-visible:outline-cyan-700 sm:p-5"
        >
          {t.id === active ? children : null}
        </div>
      ))}
    </section>
  );
}
