"use client";

import Link from "next/link";
import { useEffect, useRef } from "react";
import { RubricVersionsPanel } from "@/components/rubrics/rubric-versions";
import type { Cohort } from "@/lib/types";
import { cn } from "@/lib/utils";
import type { ToastMessage } from "./dialog";
import { CHAPTER_TONES, COHORT_URGENCY_RULE, FOCUS_RING, LINK_TEXT, plural, RETEACH_LINE, RETEACH_RULE, TONES, type ChapterTone, type Tone } from "./format";

const H3 = "text-[13px] font-semibold text-slate-800";

function duration(seconds: number | null | undefined): string {
  if (seconds === null || seconds === undefined) return "—";
  if (seconds < 60) return `${Math.round(seconds)} s`;
  const m = Math.floor(seconds / 60);
  const s = Math.round(seconds % 60);
  return s ? `${m} min ${s} s` : `${m} min`;
}

/**
 * Everything about where the numbers come from, closed by default: demo provenance, sheets not
 * counted, the answer key (fix it and re-grade), reading quality and AI cost of live sheets, and
 * the rules behind urgency, mastery bands and the re-teach line.
 */
export function AboutData({
  cohort,
  open,
  onToggle,
  focusKey,
  onRerunQueued,
  onToast,
}: {
  cohort: Cohort;
  open: boolean;
  onToggle: (open: boolean) => void;
  /** Bumped to scroll to the answer key (Check the key, ?key=open). */
  focusKey: number;
  onRerunQueued: () => Promise<void> | void;
  onToast: (toast: ToastMessage) => void;
}) {
  const keyRef = useRef<HTMLElement>(null);
  const scope = cohort.scope;
  // Every sheet in scope (any status, before the one-per-student rule); older APIs: the v1 counts.
  const demo = scope?.demo_sheets ?? cohort.demo_count ?? 0;
  const total = scope?.sheets_in_scope ?? demo + (cohort.real_count ?? 0);
  const live = total - demo;
  const superseded = scope?.mode === "sitting" ? scope.superseded ?? [] : [];
  const held = cohort.excluded?.review ?? [];
  const failed = cohort.excluded?.failed ?? [];
  const reading = cohort.excluded?.processing ?? [];
  const r = cohort.reading ?? null;
  const versions = scope?.key_versions ?? [];
  const latest = versions.find((v) => v.latest);

  useEffect(() => {
    if (focusKey > 0) keyRef.current?.scrollIntoView({ behavior: "smooth", block: "start" });
  }, [focusKey]);

  return (
    <details
      id="about-data"
      open={open}
      onToggle={(e) => onToggle((e.currentTarget as HTMLDetailsElement).open)}
      className="rounded-md border border-slate-200 bg-white"
    >
      <summary className={cn("cursor-pointer rounded-md px-4 py-3 text-[15px] font-semibold text-brand-navy hover:bg-slate-50", FOCUS_RING)}>
        About this data
        <span className="ml-2 text-[13px] font-normal text-slate-600">
          sample data, sheets not counted, answer key, reading quality, rules
        </span>
      </summary>
      <div className="space-y-5 border-t border-slate-200 px-4 py-4 text-sm text-slate-700">
        {demo > 0 ? (
          <section className="space-y-1">
            <h3 className={H3}>Sample data</h3>
            <p>
              {demo === total
                ? `Every sheet in this view (${total}) is`
                : `${demo} of the ${total} sheets in this view are`}{" "}
              synthetic demo data, added by the demo seed rather than read from uploaded sheets
              {live > 0 ? `; ${live === 1 ? "1 sheet was" : `${live} sheets were`} uploaded and read for real` : ""}. Uploaded
              sheets are always read and graded for real and never fall back to sample grades.
            </p>
          </section>
        ) : null}

        <section className="space-y-1">
          <h3 className={H3}>Not counted in the class numbers</h3>
          {held.length || failed.length || reading.length ? (
            <ul className="space-y-0.5">
              {held.length ? <li>Held for your check: {held.join(", ")}</li> : null}
              {failed.length ? <li>Could not be read: {failed.join(", ")}</li> : null}
              {reading.length ? <li>Still being read: {reading.join(", ")}</li> : null}
            </ul>
          ) : (
            <p>Every sheet in this view is counted.</p>
          )}
          {scope && scope.sheets > scope.students ? (
            <p className="text-slate-700">
              {plural(scope.sheets, "graded sheet")} from {plural(scope.students, "student")}: each student counts once, with
              their latest sheet{scope.mode === "all" ? " (their latest test)" : ""}.
              {superseded.length ? (
                <span className="mt-1 block text-slate-600">
                  An older sheet was replaced for: {superseded.join(", ")}. Two different students with the same name and no
                  roll number would also show here - check before relying on the count.
                </span>
              ) : null}
            </p>
          ) : null}
        </section>

        <section ref={keyRef} className="scroll-mt-4 space-y-2" aria-labelledby="about-key">
          <h3 id="about-key" className={H3}>
            Answer key {scope?.mode === "sitting" ? "for this test" : "used"}
          </h3>
          {versions.length ? (
            <p className="text-slate-600">
              {latest ? `Key ${latest.version}` : "Key"} ·{" "}
              {versions.map((v) => `${plural(v.sheets, "sheet")} on ${v.version}`).join(", ")}
            </p>
          ) : null}
          <RubricVersionsPanel
            preferredRubricId={scope?.latest_rubric_id ?? null}
            defaultOpen={focusKey > 0}
            onRerunQueued={onRerunQueued}
            onToast={onToast}
          />
        </section>

        <section className="space-y-1">
          <h3 className={H3}>Reading and cost</h3>
          <dl className="grid grid-cols-1 gap-x-6 gap-y-1 sm:grid-cols-3">
            <div>
              <dt className="text-xs text-slate-600">Reading confidence</dt>
              <dd className="font-medium tabular-nums">
                {live === 0 ? (
                  <>
                    —<span className="ml-1 text-xs font-normal text-slate-600">(demo sheets are not read)</span>
                  </>
                ) : r?.mean_confidence != null ? (
                  `${Math.round(r.mean_confidence * 100)}%`
                ) : (
                  "—"
                )}
              </dd>
            </div>
            <div>
              <dt className="text-xs text-slate-600">Average time per sheet</dt>
              <dd className="font-medium tabular-nums">
                {duration(r?.avg_seconds_per_sheet)}
                {r && r.live_sheets === 0 ? <span className="ml-1 text-xs font-normal text-slate-600">(no uploaded sheets)</span> : null}
              </dd>
            </div>
            <div>
              <dt className="text-xs text-slate-600">AI cost per uploaded sheet</dt>
              <dd className="font-medium tabular-nums">
                {r?.cost_per_live_sheet_inr != null ? `Rs ${r.cost_per_live_sheet_inr.toFixed(2)}` : "—"}
                {r && r.costed_sheets > 0 ? (
                  <span className="ml-1 text-xs font-normal text-slate-600">({plural(r.costed_sheets, "sheet")})</span>
                ) : null}
              </dd>
            </div>
          </dl>
          <p className="text-xs text-slate-600">
            Demo sheets are never costed.{" "}
            <Link href="/owner" className={cn("rounded-sm font-medium hover:underline", LINK_TEXT, FOCUS_RING)}>
              Full cost breakdown on the Owner page
            </Link>
          </p>
        </section>

        <section className="space-y-1.5">
          <h3 className={H3}>Rules</h3>
          <p>
            <span className="font-medium">Urgency:</span> {COHORT_URGENCY_RULE}.
          </p>
          <p className="flex flex-wrap items-center gap-x-4 gap-y-1">
            <span className="font-medium">Chapter colours on this page:</span>
            {(["low", "under", "ok"] as ChapterTone[]).map((t) => (
              <span key={t} className="inline-flex items-center gap-1.5">
                <span className={cn("h-2 w-2 rounded-sm", CHAPTER_TONES[t].bar)} aria-hidden />
                {CHAPTER_TONES[t].label}
              </span>
            ))}
          </p>
          <p className="flex flex-wrap items-center gap-x-4 gap-y-1 text-slate-600">
            <span className="font-medium text-slate-700">Mastery bands on student reports:</span>
            {(["weak", "ok", "good"] as Tone[]).map((t) => (
              <span key={t} className="inline-flex items-center gap-1.5">
                <span className={cn("h-2 w-2 rounded-sm", TONES[t].dot)} aria-hidden />
                {TONES[t].label} {TONES[t].range}
              </span>
            ))}
          </p>
          <p>
            <span className="font-medium">Re-teach:</span> a chapter is offered for a class re-teach with {RETEACH_RULE},
            measured on two or more questions. On a short paper where every chapter has one question, a chapter with three
            or more students below {RETEACH_LINE}% is offered as a hint. Whole-subject rows are never offered.
          </p>
          <p>
            <span className="font-medium">Change since the last test:</span> the class averages are compared only when both
            papers cover the same subjects and at least half the class sat both; otherwise the change of the students who
            sat both is shown. Bonus questions (full marks to everyone) are left out of attempts and question figures.
          </p>
        </section>
      </div>
    </details>
  );
}
