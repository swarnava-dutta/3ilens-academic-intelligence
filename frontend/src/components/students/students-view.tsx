"use client";

import { Download, FileArchive, FileSpreadsheet, RefreshCw } from "lucide-react";
import Link from "next/link";
import { usePathname, useRouter, useSearchParams } from "next/navigation";
import { useCallback, useEffect, useMemo, useRef, useState, type KeyboardEvent } from "react";
import { FilterBar, useDashboardFilters } from "@/components/shared/filter-bar";
import { Notice, btnPrimary, btnSecondary } from "@/components/report/dialog";
import { menuItem, Popover } from "@/components/shared/popover";
import { bundleZipUrl, errorMessage, errorStatus, getStudentRoster } from "@/lib/api";
import type { RosterRow, StudentRoster } from "@/lib/types";
import { cn } from "@/lib/utils";
import { ActFirst } from "./act-first";
import { demoTagFor } from "./bits";
import { downloadCsv } from "./export-csv";
import { isoDay, studentParam, versionedNames } from "./format";
import { LogActionDialog, type LogTarget } from "./log-action-dialog";
import { normalizeRoster } from "./normalize-roster";
import {
  actFirstRows,
  describeNarrowing,
  filterRows,
  isNarrowed,
  readRosterParams,
  readTab,
  segmentCounts,
  sortRows,
} from "./roster-logic";
import { RosterTable, type RosterDetail } from "./roster-table";
import { RosterToolbar, type ParamUpdate } from "./roster-toolbar";
import { SharedGaps } from "./shared-gaps";
import { StudentDrawer } from "./student-drawer";
import { StudentsSkeletonBody } from "./students-skeleton";
import { SummaryTiles, type TileKey } from "./summary-tiles";
import { TopicsView } from "./topics-view";

/** Rows shown before "Show all" (a short first screen; the summary above carries the totals). */
const PAGE = 15;
const TABS = [
  ["students", "Students"],
  ["topics", "Topics"],
] as const;
const LINK =
  "rounded-sm font-medium text-brand-cyan-600 hover:text-brand-navy hover:underline focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-brand-cyan";

type Loaded = { key: string; roster: StudentRoster } | { key: string; error: string; status: number | null };

function scrollToRoster() {
  const el = document.getElementById("roster");
  if (!el) return;
  const reduce = window.matchMedia("(prefers-reduced-motion: reduce)").matches;
  el.scrollIntoView({ behavior: reduce ? "auto" : "smooth", block: "start" });
}

/** /students: one row per student. Reads its state from the URL, so the page renders it inside <Suspense>. */
export function StudentsView() {
  const router = useRouter();
  const pathname = usePathname();
  const searchParams = useSearchParams();
  const filters = useDashboardFilters();
  const query = searchParams.toString();
  const params = useMemo(() => readRosterParams(new URLSearchParams(query)), [query]);
  const tab = readTab(searchParams.get("tab"));
  const demoExcluded = searchParams.get("demo") === "exclude";
  const selected = searchParams.get("student");

  const batchId = filters.batch_id ?? null;
  const rubricId = filters.rubric_id ?? null;
  const [nonce, setNonce] = useState(0);
  const key = `${batchId}|${rubricId}|${demoExcluded}#${nonce}`;
  const [loaded, setLoaded] = useState<Loaded | null>(null);
  const [roster, setRoster] = useState<StudentRoster | null>(null);
  const [logTarget, setLogTarget] = useState<LogTarget | null>(null);
  const [actionsRefresh, setActionsRefresh] = useState(0);
  const [flash, setFlash] = useState<string | null>(null);
  const opener = useRef<HTMLElement | null>(null);
  // "Show all" belongs to one filter state: any filter / sort / scope change starts short again
  // (opening a student's drawer does not).
  const listKey = useMemo(() => {
    const q = new URLSearchParams(query);
    q.delete("student");
    q.delete("tab");
    return q.toString();
  }, [query]);
  const [showAllFor, setShowAllFor] = useState<string | null>(null);
  const showAll = showAllFor === listKey;

  useEffect(() => {
    let cancelled = false;
    getStudentRoster({ batch_id: batchId, rubric_id: rubricId, demo: demoExcluded ? false : null })
      .then((raw) => {
        if (cancelled) return;
        const data = normalizeRoster(raw);
        setRoster(data);
        setLoaded({ key, roster: data });
      })
      .catch((err) => {
        if (!cancelled) setLoaded({ key, error: errorMessage(err), status: errorStatus(err) });
      });
    return () => {
      cancelled = true;
    };
  }, [key, batchId, rubricId, demoExcluded]);

  const setParams = useCallback(
    (update: ParamUpdate) => {
      const next = new URLSearchParams(searchParams.toString());
      for (const [name, value] of Object.entries(update)) {
        if (value) next.set(name, value);
        else next.delete(name);
      }
      const qs = next.toString();
      router.replace(qs ? `${pathname}?${qs}` : pathname, { scroll: false });
    },
    [router, pathname, searchParams],
  );

  const loading = loaded?.key !== key;
  const failure = !loading && loaded && "error" in loaded ? loaded : null;
  const rows = useMemo(() => roster?.rows ?? [], [roster]);
  const visible = useMemo(() => sortRows(filterRows(rows, params), params.sort, params.view), [rows, params]);
  const flagged = useMemo(() => actFirstRows(rows), [rows]);
  const versioned = useMemo(() => versionedNames(rows), [rows]);
  const counts = useMemo(() => segmentCounts(rows, params), [rows, params]);
  const summary = roster?.summary ?? null;
  const mixed = !!summary && summary.demo_students > 0 && summary.real_students > 0;
  const tag = summary ? demoTagFor(summary.demo_students, summary.real_students) : null;
  const selectedRow = selected ? (rows.find((r) => studentParam(r) === selected) ?? null) : null;
  const narrowed = isNarrowed(params);

  const openStudent = (row: RosterRow, from: HTMLElement) => {
    opener.current = from;
    setParams({ student: studentParam(row) });
  };
  const closeStudent = () => {
    setParams({ student: null });
    const back = opener.current;
    if (back) requestAnimationFrame(() => back.isConnected && back.focus());
  };
  const clearNarrowing = () => setParams({ urgency: null, topic: null, view: null, q: null, release: null });

  const activeTile: TileKey | null =
    params.urgency === "at_risk" && !params.view
      ? "at_risk"
      : params.view === "trend"
        ? "moving"
        : params.view === "technique"
          ? "technique"
          : params.view === "waiting"
            ? "waiting"
            : null;
  const selectTile = (tile: TileKey) => {
    if (tile === activeTile) {
      setParams({ urgency: null, view: null, sort: null });
      return;
    }
    const base = { tab: null, topic: null, release: null };
    if (tile === "at_risk") setParams({ ...base, urgency: "at_risk", view: null, sort: null });
    if (tile === "moving") setParams({ ...base, urgency: null, view: "trend", sort: null });
    if (tile === "technique") setParams({ ...base, urgency: null, view: "technique", sort: "marks_lost" });
    if (tile === "waiting") setParams({ ...base, urgency: null, view: "waiting", sort: null });
  };
  const releaseActive = params.release === "unreleased" && !params.view && !params.urgency;
  const selectRelease = () =>
    setParams(
      releaseActive
        ? { release: null }
        : { release: "unreleased", view: null, urgency: null, topic: null, tab: null, sort: null },
    );

  const onTabKey = (e: KeyboardEvent<HTMLButtonElement>) => {
    const keys = ["ArrowLeft", "ArrowRight", "Home", "End"];
    if (!keys.includes(e.key)) return;
    e.preventDefault();
    const at = TABS.findIndex(([k]) => k === tab);
    const next =
      e.key === "Home"
        ? 0
        : e.key === "End"
          ? TABS.length - 1
          : (at + (e.key === "ArrowRight" ? 1 : TABS.length - 1)) % TABS.length;
    const k = TABS[next][0];
    setParams({ tab: k === "students" ? null : k });
    requestAnimationFrame(() => document.getElementById(`tab-${k}`)?.focus());
  };
  const detail: RosterDetail =
    params.view === "technique" || params.sort === "marks_lost"
      ? "technique"
      : params.view === "waiting"
        ? "waiting"
        : params.release
          ? "release"
          : null;

  const onRecorded = () => {
    const name = logTarget?.row.student_name;
    setLogTarget(null);
    setNonce((n) => n + 1);
    setActionsRefresh((n) => n + 1);
    setFlash(name ? `Action logged for ${name}.` : "Action logged.");
    setTimeout(() => setFlash(null), 4000);
  };

  const exportCsv = () => {
    const scope = [batchId ? `batch${batchId}` : "all-batches", rubricId ? `test${rubricId}` : null].filter(Boolean).join("_");
    downloadCsv(visible, `3iLens_students_${scope}_${isoDay(new Date().toISOString()).replace(/-/g, "")}.csv`);
  };

  const firstHeldId = rows.find((r) => r.pending)?.pending?.submission_id ?? null;
  const pageRows = showAll ? visible : visible.slice(0, PAGE);
  const scoped = batchId !== null || rubricId !== null || demoExcluded;

  return (
    <div className="space-y-6">
      <header className="flex flex-wrap items-start justify-between gap-3">
        <div className="min-w-0">
          <h1 className="text-[22px] font-semibold text-brand-navy sm:text-2xl">Students</h1>
          <p className="mt-1 text-sm tabular-nums text-slate-600">
            {summary
              ? `${summary.students} student${summary.students === 1 ? "" : "s"} · ${summary.graded} graded · ${summary.sheets} sheet${summary.sheets === 1 ? "" : "s"} · latest paper per student`
              : "Every student's latest paper, trend and next action."}
          </p>
        </div>
        <div className="flex items-center gap-2 print:hidden">
          <Popover
            label={<span className="hidden sm:inline">Export</span>}
            srLabel="Export"
            icon={<Download className="h-4 w-4" aria-hidden />}
            buttonClassName={cn(btnSecondary, "px-3")}
          >
            {(close) => (
              <>
                <button
                  type="button"
                  className={menuItem}
                  disabled={visible.length === 0}
                  onClick={() => {
                    exportCsv();
                    close();
                  }}
                >
                  <FileSpreadsheet className="h-4 w-4 text-slate-500" aria-hidden />
                  <span>
                    Roster CSV
                    <span className="block text-xs text-slate-500">
                      {visible.length} student{visible.length === 1 ? "" : "s"} as filtered and sorted
                      {visible.length > pageRows.length ? ` (${pageRows.length} shown)` : ""}
                    </span>
                  </span>
                </button>
                <a href={bundleZipUrl({ batch_id: batchId, rubric_id: rubricId })} className={menuItem} onClick={close}>
                  <FileArchive className="h-4 w-4 text-slate-500" aria-hidden />
                  <span>
                    Report PDFs (ZIP)
                    <span className="block text-xs text-slate-500">Every graded sheet in this batch / test + cohort.pdf</span>
                  </span>
                </a>
              </>
            )}
          </Popover>
          <button
            type="button"
            className={cn(btnSecondary, "px-3")}
            onClick={() => setNonce((n) => n + 1)}
            disabled={loading}
            aria-label="Refresh"
          >
            <RefreshCw className={cn("h-4 w-4", loading && "animate-spin motion-reduce:animate-none")} aria-hidden />
            <span className="hidden sm:inline">Refresh</span>
          </button>
        </div>
      </header>

      <div className="space-y-2">
        <div className="flex flex-col gap-3 rounded-md border border-slate-200 bg-white px-4 py-3 sm:flex-row sm:items-center sm:justify-between print:hidden">
          <FilterBar
            show={["batch", "test"]}
            className="flex-col items-stretch sm:flex-row sm:items-center [&_label]:w-full sm:[&_label]:w-auto [&_select]:w-full sm:[&_select]:w-auto"
          />
          {mixed || demoExcluded ? (
            <label className="inline-flex min-h-10 items-center gap-2 text-sm text-slate-700">
              <input
                type="checkbox"
                checked={!demoExcluded}
                onChange={(e) => setParams({ demo: e.target.checked ? null : "exclude", student: null })}
                className="h-4 w-4 rounded-sm border-slate-300 accent-brand-cyan-600 focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-brand-cyan"
              />
              Include demo data
            </label>
          ) : null}
        </div>
        {summary && summary.demo_students > 0 ? (
          <p className="text-[13px] text-slate-500">
            {summary.demo_students === summary.students
              ? summary.students === 1
                ? "The 1 student here is a synthetic demo record."
                : `All ${summary.students} students here are synthetic demo records.`
              : `${summary.demo_students} of ${summary.students} students here are synthetic demo records${
                  tag === "real"
                    ? summary.real_students === 1
                      ? "; the real one is tagged “real sheet”"
                      : "; the real ones are tagged “real sheet”"
                    : tag === "demo"
                      ? " (tagged “demo”)"
                      : ""
                }.`}
          </p>
        ) : null}
      </div>

      {failure ? (
        <Notice tone={failure.status === 404 ? "info" : "error"} className="flex flex-wrap items-center gap-x-3 gap-y-1">
          <span>
            {failure.status === 404 ? "The roster endpoint is not available on this backend yet." : failure.error}
          </span>
          <button type="button" className={LINK} onClick={() => setNonce((n) => n + 1)}>
            Retry
          </button>
        </Notice>
      ) : null}

      {!roster || !summary ? (
        failure ? null : <StudentsSkeletonBody />
      ) : summary.students === 0 ? (
        <div className="flex flex-col items-start gap-3 rounded-md border border-slate-200 bg-white p-5">
          <p className="font-semibold text-brand-navy">{scoped ? "No students in this batch or test" : "No students yet"}</p>
          <p className="max-w-xl text-sm text-slate-600">
            {scoped
              ? "Choose all batches and all tests to see every student."
              : "Upload printed answer sheets with their answer key on Intake; each student appears here once their sheet is marked."}
          </p>
          {scoped ? null : (
            <Link href="/" className={btnPrimary}>
              Go to Intake
            </Link>
          )}
        </div>
      ) : (
        <div className={cn("space-y-6 transition-opacity", loading && "opacity-70")} aria-busy={loading}>
          <SummaryTiles
            summary={summary}
            active={activeTile}
            onSelect={selectTile}
            releaseActive={releaseActive}
            onRelease={selectRelease}
          />

          <div className="grid gap-4 lg:grid-cols-12">
            <div className="min-w-0 lg:col-span-7">
              <ActFirst
                flagged={flagged}
                summary={summary}
                firstHeldId={firstHeldId}
                onOpen={openStudent}
                onLog={(row) => setLogTarget({ row })}
                onShowAll={() => {
                  setParams({ view: "flagged", urgency: null, topic: null, q: null, release: null, sort: null, tab: null });
                  scrollToRoster();
                }}
              />
            </div>
            <div className="min-w-0 lg:col-span-5">
              <SharedGaps
                topics={roster.topics}
                graded={summary.graded}
                activeTopic={params.topic}
                onTopic={(topic) => {
                  setParams({ topic, urgency: null, view: null, q: null, release: null, tab: null });
                  scrollToRoster();
                }}
                onAll={() => {
                  setParams({ tab: "topics" });
                  scrollToRoster();
                }}
              />
            </div>
          </div>

          <section id="roster" aria-label="Roster" className="scroll-mt-4 space-y-3">
            <div role="tablist" aria-label="Student views" className="flex gap-1 border-b border-slate-200 print:hidden">
              {TABS.map(([k, label]) => (
                <button
                  key={k}
                  type="button"
                  role="tab"
                  id={`tab-${k}`}
                  aria-selected={tab === k}
                  aria-controls={`panel-${k}`}
                  tabIndex={tab === k ? 0 : -1}
                  onKeyDown={onTabKey}
                  onClick={() => setParams({ tab: k === "students" ? null : k })}
                  className={cn(
                    "-mb-px inline-flex h-10 items-center gap-1.5 border-b-2 px-3 text-sm font-medium transition-colors duration-150 focus-visible:outline-2 focus-visible:-outline-offset-2 focus-visible:outline-brand-cyan",
                    tab === k ? "border-brand-cyan text-brand-navy" : "border-transparent text-slate-600 hover:text-brand-navy",
                  )}
                >
                  {label}
                  <span className="text-xs tabular-nums text-slate-500">
                    {k === "students" ? summary.students : roster.topics.length}
                  </span>
                </button>
              ))}
            </div>

            {tab === "topics" ? (
              <div role="tabpanel" id="panel-topics" aria-labelledby="tab-topics">
                <TopicsView
                  topics={roster.topics}
                  rows={rows}
                  batchId={batchId}
                  refreshKey={actionsRefresh}
                  onOpen={openStudent}
                  onLogged={() => {
                    setNonce((n) => n + 1);
                    setActionsRefresh((n) => n + 1);
                  }}
                />
              </div>
            ) : (
              <div role="tabpanel" id="panel-students" aria-labelledby="tab-students" className="space-y-3">
                <RosterToolbar summary={summary} counts={counts} params={params} topics={roster.topics} onChange={setParams} />
                {narrowed ? (
                  <p className="flex flex-wrap items-center gap-x-2 text-[13px] tabular-nums text-slate-600" role="status">
                    Showing {visible.length} of {summary.students} students · {describeNarrowing(params).join(" · ")}
                    <button type="button" onClick={clearNarrowing} className={LINK}>
                      Clear
                    </button>
                  </p>
                ) : null}
                {visible.length === 0 ? (
                  <div className="flex flex-col items-start gap-2 rounded-md border border-slate-200 bg-white p-5">
                    <p className="font-semibold text-brand-navy">No students match</p>
                    <button type="button" className={btnSecondary} onClick={clearNarrowing}>
                      Clear filters
                    </button>
                  </div>
                ) : (
                  <>
                    <RosterTable
                      rows={pageRows}
                      tag={tag}
                      versioned={versioned}
                      onOpen={openStudent}
                      onLog={(row) => setLogTarget({ row })}
                      detail={detail}
                    />
                    {visible.length > PAGE ? (
                      <button
                        type="button"
                        className={cn(btnSecondary, "w-full sm:w-auto print:hidden")}
                        onClick={() => setShowAllFor(showAll ? null : listKey)}
                      >
                        {showAll ? `Show the first ${PAGE}` : `Show all ${visible.length}`}
                      </button>
                    ) : null}
                  </>
                )}
              </div>
            )}
          </section>
        </div>
      )}

      {flash ? (
        <p
          role="status"
          className="fixed inset-x-4 bottom-4 z-40 mx-auto max-w-sm rounded-md border border-lime-200 bg-brand-lime-50 px-3 py-2 text-sm text-lime-900 shadow-lg sm:inset-x-auto sm:right-6"
        >
          {flash}
        </p>
      ) : null}

      <StudentDrawer
        row={selectedRow}
        scoped={batchId !== null || rubricId !== null}
        versioned={versioned}
        onClose={closeStudent}
        onLog={(target) => setLogTarget(target)}
        refreshKey={actionsRefresh}
      />
      <LogActionDialog target={logTarget} onClose={() => setLogTarget(null)} onRecorded={onRecorded} />
    </div>
  );
}
