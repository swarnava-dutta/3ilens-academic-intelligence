"use client";

import { forwardRef, useEffect, useImperativeHandle, useRef, useState, type KeyboardEvent } from "react";
import type { OwnerDashboard } from "@/lib/types";
import { cn } from "@/lib/utils";
import { CostPanel } from "./cost-panel";
import { EffectivenessCard } from "./effectiveness-card";
import { ExamBehaviourPanel } from "./exam-behaviour-panel";
import { FacultyTable } from "./faculty-table";
import { ProgressPanel } from "./progress-panel";
import { focusRing } from "./states";
import { TopicsPanel } from "./topics-panel";
import { WhatIfSimulator } from "./what-if";

export type OwnerTab = "progress" | "topics" | "behaviour" | "faculty" | "interventions" | "whatif" | "cost";

const OWNER_TABS: { id: OwnerTab; label: string }[] = [
  { id: "progress", label: "Progress" },
  { id: "topics", label: "Topics" },
  { id: "behaviour", label: "Exam behaviour" },
  { id: "faculty", label: "Faculty" },
  { id: "interventions", label: "Interventions" },
  { id: "whatif", label: "What-if" },
  { id: "cost", label: "Cost & operations" },
];

export function parseOwnerTab(value: string | null | undefined): OwnerTab {
  return OWNER_TABS.some((t) => t.id === value) ? (value as OwnerTab) : "progress";
}

/** Tabs that fetch their own endpoint: kept mounted (hidden) once opened, so they load once. */
const KEEP_ALIVE: OwnerTab[] = ["interventions", "whatif"];

export interface OwnerTabsHandle {
  /** Scroll the tab list into view and focus a tab (the selected one by default). */
  focus: (target?: OwnerTab) => void;
}

/**
 * Detail tabs under the batches (APG tab pattern: arrows, Home / End, roving tabindex). Only the
 * active panel renders; Interventions and What-if load on first open and then stay mounted.
 */
export const OwnerTabs = forwardRef<
  OwnerTabsHandle,
  { data: OwnerDashboard; institutionId: number | null; tab: OwnerTab; onTab: (tab: OwnerTab) => void }
>(function OwnerTabs({ data, institutionId, tab, onTab }, ref) {
  const buttons = useRef<Record<string, HTMLButtonElement | null>>({});
  const sectionRef = useRef<HTMLElement>(null);
  const scroller = useRef<HTMLDivElement>(null);
  const [opened, setOpened] = useState<OwnerTab[]>([tab]);
  if (!opened.includes(tab)) setOpened([...opened, tab]);

  // Keep the selected tab visible inside the horizontally scrolling tab list (mobile), without
  // scrolling the page.
  useEffect(() => {
    const box = scroller.current;
    const button = buttons.current[tab];
    if (!box || !button) return;
    const left = button.offsetLeft - 8;
    const right = button.offsetLeft + button.offsetWidth + 8;
    if (left < box.scrollLeft) box.scrollLeft = left;
    else if (right > box.scrollLeft + box.clientWidth) box.scrollLeft = right - box.clientWidth;
  }, [tab]);

  useImperativeHandle(ref, () => ({
    focus(target?: OwnerTab) {
      window.requestAnimationFrame(() => {
        const reduce = window.matchMedia?.("(prefers-reduced-motion: reduce)").matches;
        sectionRef.current?.scrollIntoView({ behavior: reduce ? "auto" : "smooth", block: "start" });
        buttons.current[target ?? tab]?.focus({ preventScroll: true });
      });
    },
  }));

  function onKey(e: KeyboardEvent<HTMLDivElement>) {
    const i = OWNER_TABS.findIndex((t) => t.id === tab);
    let next = -1;
    if (e.key === "ArrowRight") next = (i + 1) % OWNER_TABS.length;
    else if (e.key === "ArrowLeft") next = (i - 1 + OWNER_TABS.length) % OWNER_TABS.length;
    else if (e.key === "Home") next = 0;
    else if (e.key === "End") next = OWNER_TABS.length - 1;
    if (next < 0) return;
    e.preventDefault();
    const id = OWNER_TABS[next].id;
    onTab(id);
    buttons.current[id]?.focus();
  }

  const instId = data.institution?.id ?? institutionId;
  const atRisk = data.at_risk_students ?? [];
  // What-if starts on the batch with the most at-risk students nobody has acted on.
  const defaultBatch = [...(data.batches ?? [])]
    .filter((b) => (b.students_graded ?? 1) > 0)
    .sort((a, b) => (b.at_risk_unactioned ?? 0) - (a.at_risk_unactioned ?? 0) || a.batch.id - b.batch.id)[0];

  function panel(id: OwnerTab) {
    switch (id) {
      case "progress":
        return <ProgressPanel data={data} />;
      case "topics":
        return <TopicsPanel gaps={data.topic_gaps ?? null} hidden={data.topic_gaps_hidden ?? []} fallback={data.weakest_topics ?? []} />;
      case "behaviour":
        return <ExamBehaviourPanel behaviour={data.exam_behaviour ?? null} signals={data.signals ?? []} />;
      case "faculty":
        return <FacultyTable faculty={data.faculty ?? []} />;
      case "interventions":
        return (
          <EffectivenessCard
            institutionId={instId}
            variant="owner"
            hideCalibration
            className="border-0"
            atRiskFollowThrough={
              data.at_risk_students ? { actioned: atRisk.filter((s) => s.actioned).length, total: atRisk.length } : null
            }
          />
        );
      case "whatif":
        return (
          <WhatIfSimulator
            key={instId ?? "all"}
            institutionId={instId}
            defaultBatchId={defaultBatch?.batch.id ?? null}
            calibration={data.interventions ?? null}
            className="border-0"
          />
        );
      case "cost":
        return <CostPanel data={data} />;
    }
  }

  return (
    <section ref={sectionRef} aria-label="Details" className="scroll-mt-20 min-w-0 rounded-md border border-slate-200 bg-white">
      <div ref={scroller} className="relative overflow-x-auto border-b border-slate-200">
        <div role="tablist" aria-label="Owner details" onKeyDown={onKey} className="flex min-w-max gap-1 px-2 sm:px-3">
          {OWNER_TABS.map((t) => {
            const selected = t.id === tab;
            // aria-controls only points at panels that are in the DOM (the active one, or a kept-alive one).
            const mounted = selected || (KEEP_ALIVE.includes(t.id) && opened.includes(t.id));
            return (
              <button
                key={t.id}
                ref={(el) => {
                  buttons.current[t.id] = el;
                }}
                type="button"
                role="tab"
                id={`owner-tab-${t.id}`}
                aria-selected={selected}
                aria-controls={mounted ? `owner-panel-${t.id}` : undefined}
                tabIndex={selected ? 0 : -1}
                onClick={() => onTab(t.id)}
                className={cn(
                  "relative h-10 whitespace-nowrap px-3 text-sm transition-colors duration-150",
                  focusRing,
                  "focus-visible:-outline-offset-2",
                  selected
                    ? "font-semibold text-brand-navy after:absolute after:inset-x-2 after:bottom-0 after:h-0.5 after:bg-brand-navy"
                    : "text-slate-600 hover:text-slate-900",
                )}
              >
                {t.label}
              </button>
            );
          })}
        </div>
      </div>
      {OWNER_TABS.map((t) => {
        const active = t.id === tab;
        const mounted = active || (KEEP_ALIVE.includes(t.id) && opened.includes(t.id));
        if (!mounted) return null;
        return (
          <div
            key={t.id}
            role="tabpanel"
            id={`owner-panel-${t.id}`}
            aria-labelledby={`owner-tab-${t.id}`}
            hidden={!active}
            tabIndex={0}
            className={cn(
              "min-w-0 rounded-b-md",
              focusRing,
              "focus-visible:-outline-offset-2",
              t.id === "interventions" || t.id === "whatif" ? "" : "px-4 py-4 sm:px-5",
            )}
          >
            {panel(t.id)}
          </div>
        );
      })}
    </section>
  );
});
