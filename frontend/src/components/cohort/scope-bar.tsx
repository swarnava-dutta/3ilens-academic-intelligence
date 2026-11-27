"use client";

import type { RefObject } from "react";
import { ChevronDown, FileArchive, FileDown, MessageCircle, Share2 } from "lucide-react";
import { useHealth } from "@/components/app-shell";
import { Popover } from "@/components/shared/popover";
import { cohortViewBundleUrl, cohortViewPdfUrl, type CohortViewQuery } from "@/lib/api";
import { plural } from "@/lib/format";
import type { Cohort, CohortSitting } from "@/lib/types";
import { cn } from "@/lib/utils";
import { ExamChip } from "./exam-date-card";
import { dayMonth, POPOVER_PANEL } from "./format";
import type { CohortParams, ParamPatch } from "./url";

const selectClass =
  "h-9 w-full min-w-0 rounded-md border border-slate-300 bg-white px-2 text-sm text-slate-800 focus-visible:border-brand-cyan sm:w-auto sm:max-w-[30rem]";

interface TestOption {
  test_id: number;
  test_name: string;
  date: string;
  students: number;
  is_class: boolean;
}

/** One option per test: the batch's sittings, or (all batches) each test's sittings added up. */
function testOptions(sittings: CohortSitting[], batchId: number | null): TestOption[] {
  if (batchId !== null) return sittings.filter((s) => s.batch_id === batchId);
  const byTest = new Map<number, TestOption>();
  for (const s of sittings) {
    const row = byTest.get(s.test_id);
    if (!row) byTest.set(s.test_id, { ...s });
    else {
      row.students += s.students;
      if (s.date > row.date) row.date = s.date;
    }
  }
  return [...byTest.values()]
    .map((t) => ({ ...t, is_class: t.students >= 3 }))
    .sort((a, b) => (a.date < b.date ? 1 : -1));
}

function optionLabel(t: TestOption): string {
  return t.is_class
    ? `${t.test_name} · ${dayMonth(t.date)} · ${plural(t.students, "student")}`
    : `${t.test_name} · ${dayMonth(t.date)} (${plural(t.students, "student")})`;
}

const shareItem =
  "flex w-full items-center gap-2 rounded-sm px-2 py-2 text-left text-sm text-slate-700 hover:bg-slate-50 focus-visible:outline-2 focus-visible:outline-cyan-700";

export function ScopeBar({
  cohort,
  params,
  update,
  switching,
  testRef,
  onExamSaved,
  onWhatsApp,
  onOpenKey,
}: {
  cohort: Cohort;
  params: CohortParams;
  update: (patch: ParamPatch) => void;
  switching: boolean;
  /** The Test select ("Pick a test" links focus it). */
  testRef: RefObject<HTMLSelectElement | null>;
  onExamSaved: () => Promise<void> | void;
  onWhatsApp: () => void;
  onOpenKey: () => void;
}) {
  const { batches } = useHealth();
  const scope = cohort.scope;
  const sittings = cohort.sittings ?? [];
  const options = testOptions(sittings, params.batchId);
  // The URL may name any key version; the options are tests (family roots).
  const sameTest =
    scope !== null &&
    scope !== undefined &&
    params.rubricId !== null &&
    (scope.test_id === params.rubricId || scope.latest_rubric_id === params.rubricId || scope.rubric_ids.includes(params.rubricId));
  const current =
    params.view === "all" ? "all" : params.rubricId === null ? "" : String(sameTest ? scope.test_id : params.rubricId);
  const listed = options.some((o) => String(o.test_id) === current);
  const latestClass = options.find((o) => o.is_class);
  const isLatest = scope?.mode === "sitting" && latestClass !== undefined && latestClass.test_id === scope.test_id;
  const n = scope?.students ?? 0;
  const query: CohortViewQuery = { batch_id: params.batchId, test_id: params.view === "all" ? null : scope?.test_id };
  const oldKeys = (scope?.key_versions ?? []).filter((v) => !v.latest && v.sheets > 0);
  const oldSheets = oldKeys.reduce((sum, v) => sum + v.sheets, 0);
  const batchName = batches?.find((b) => b.id === params.batchId)?.name ?? scope?.batch_name ?? "this batch";

  return (
    <div className="space-y-2">
      <section
        aria-label="Scope"
        className="relative rounded-md border border-slate-200 bg-white px-3 py-3 sm:px-4"
      >
        <div className="flex flex-col gap-2 lg:flex-row lg:items-center lg:justify-between">
          <div className="flex min-w-0 flex-col gap-2 sm:flex-row sm:flex-wrap sm:items-center">
            <label className="min-w-0">
              <span className="sr-only">Batch</span>
              <select
                className={selectClass}
                value={params.batchId ?? ""}
                onChange={(e) =>
                  update(
                    e.target.value
                      ? { batch_id: e.target.value, rubric_id: null, view: null }
                      : { batch_id: null, rubric_id: null, view: "all" },
                  )
                }
              >
                <option value="">All batches</option>
                {(batches ?? []).map((b) => (
                  <option key={b.id} value={b.id}>
                    {b.name}
                  </option>
                ))}
                {params.batchId !== null && batches && !batches.some((b) => b.id === params.batchId) ? (
                  <option value={params.batchId}>{scope?.batch_name ?? `Batch ${params.batchId}`}</option>
                ) : null}
              </select>
            </label>
            <label className="min-w-0">
              <span className="sr-only">Test</span>
              <select
                ref={testRef}
                className={selectClass}
                value={current}
                onChange={(e) =>
                  update(
                    e.target.value === "all"
                      ? { rubric_id: null, view: "all" }
                      : { rubric_id: e.target.value, view: null },
                  )
                }
              >
                {options.map((t) => (
                  <option key={t.test_id} value={t.test_id}>
                    {optionLabel(t)}
                  </option>
                ))}
                {!listed && current !== "all" && current !== "" ? (
                  <option value={current}>
                    {scope?.short_name ?? scope?.test_name ?? `Test ${current}`}
                    {params.batchId !== null ? ` (not sat by ${batchName})` : ""}
                  </option>
                ) : null}
                {current === "" ? <option value="">Choose a test</option> : null}
                <option value="all">All tests · latest per student</option>
              </select>
            </label>
            {isLatest ? (
              <span className="w-fit rounded-sm bg-brand-cyan-50 px-1.5 py-0.5 text-xs font-medium text-cyan-700">
                Latest test
              </span>
            ) : null}
          </div>

          <div className="flex items-center gap-2">
            {scope?.batch_id != null && cohort.batch ? (
              <div className="min-w-0 flex-1 lg:flex-none">
                <ExamChip key={`${cohort.batch.id}-${cohort.batch.exam_date ?? ""}`} batch={cohort.batch} onSaved={onExamSaved} />
              </div>
            ) : null}
            <Popover
              align="right"
              chevron={false}
              panelClassName={POPOVER_PANEL}
              disabled={n === 0}
              title={n === 0 ? "No graded sheets in this view" : undefined}
              buttonClassName="inline-flex h-9 shrink-0 items-center gap-1.5 rounded-md border border-brand-navy bg-brand-navy px-3 text-sm font-medium text-white transition-colors hover:bg-brand-navy-700 disabled:cursor-not-allowed disabled:opacity-50 focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-cyan-700"
              label={
                <>
                  <Share2 className="h-4 w-4" aria-hidden />
                  Share
                  <ChevronDown className="h-3.5 w-3.5" aria-hidden />
                </>
              }
            >
              {(close) => (
                <ul className="-m-1 space-y-0.5" aria-label="Share">
                  <li>
                    <a href={cohortViewPdfUrl(query)} download onClick={close} className={shareItem}>
                      <FileDown className="h-4 w-4 text-slate-500" aria-hidden />
                      Cohort PDF ({scope?.mode === "sitting" ? "this test" : "this view"})
                    </a>
                  </li>
                  <li>
                    <a href={cohortViewBundleUrl(query)} download onClick={close} className={shareItem}>
                      <FileArchive className="h-4 w-4 text-slate-500" aria-hidden />
                      All {plural(n, "student report")} (ZIP)
                    </a>
                  </li>
                  <li>
                    <button
                      type="button"
                      className={shareItem}
                      onClick={() => {
                        close();
                        onWhatsApp();
                      }}
                    >
                      <MessageCircle className="h-4 w-4 text-slate-500" aria-hidden />
                      <span>
                        Send reports on WhatsApp{" "}
                        <span className="text-xs text-slate-500">(simulated, not sent)</span>
                      </span>
                    </button>
                  </li>
                </ul>
              )}
            </Popover>
          </div>
        </div>
        <div
          aria-hidden
          className={cn(
            "absolute inset-x-0 -bottom-px h-0.5 overflow-hidden rounded-b-md transition-opacity",
            switching ? "opacity-100" : "opacity-0",
          )}
        >
          <div className="h-full w-full animate-pulse bg-brand-cyan motion-reduce:animate-none" />
        </div>
      </section>

      {scope?.mode === "all" && n > 0 ? (
        <p className="text-[13px] text-slate-700">
          {(scope.tests ?? 2) > 1
            ? `Students' latest tests differ (${scope.tests ?? "several"} tests), so they are compared by percentage.`
            : "Each student's latest sheet."}{" "}
          <button
            type="button"
            onClick={() => testRef.current?.focus()}
            className="rounded-sm font-medium text-cyan-700 underline-offset-2 hover:underline focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-cyan-700"
          >
            Pick a test
          </button>{" "}
          for marks, question analysis and change since last test.
        </p>
      ) : null}
      {oldSheets > 0 ? (
        <p className="text-[13px] text-amber-800">
          {plural(oldSheets, "sheet is", "sheets are")} still graded with key{" "}
          {oldKeys.map((v) => v.version).join(", ")} -{" "}
          <button
            type="button"
            onClick={onOpenKey}
            className="rounded-sm font-medium underline underline-offset-2 hover:text-amber-900 focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-cyan-700"
          >
            re-grade them
          </button>
          .
        </p>
      ) : null}
    </div>
  );
}
