"use client";

import Link from "next/link";
import { Fragment, useMemo, useState, type ReactNode } from "react";
import { ArrowDown, ArrowUp, BadgeCheck, MessageCircle, Search } from "lucide-react";
import { ChartFrame, Histogram } from "@/components/charts";
import { UrgencyBadge, URGENCY_LABELS } from "@/components/shared/urgency-badge";
import type { Cohort, CohortStudentRow, Urgency } from "@/lib/types";
import { cn } from "@/lib/utils";
import { TD, TH } from "./card";
import { BINS, binOf, FOCUS_RING, formatNumber, LINK_TEXT, lost, pct1, plural, RETEACH_LINE, signed1 } from "./format";
import { MIN_SPREAD_N } from "./headline";
import { ReleaseDialog, type ReleaseTarget } from "./release-dialog";
import type { CohortParams, ParamPatch } from "./url";

const EDGE = 5;
const SPLIT_OVER = 15;
const CHIP = cn(
  "inline-flex h-8 items-center gap-1.5 whitespace-nowrap rounded-md border px-2.5 text-[13px] transition-colors",
  FOCUS_RING,
);
const LINK = cn("rounded-sm font-medium text-slate-800 hover:text-cyan-700 hover:underline", FOCUS_RING);
const TEXT_BTN = cn("rounded-sm text-[13px] font-medium hover:underline", LINK_TEXT, FOCUS_RING);

type SortKey = "pct" | "name" | "change" | "attempted" | "wrong";

function Chip({
  pressed,
  onClick,
  children,
  dot,
}: {
  pressed: boolean;
  onClick: () => void;
  children: ReactNode;
  dot?: string;
}) {
  return (
    <button
      type="button"
      aria-pressed={pressed}
      onClick={onClick}
      className={cn(
        CHIP,
        pressed
          ? "border-brand-navy bg-brand-navy text-white"
          : "border-slate-300 bg-white text-slate-700 hover:bg-slate-50",
      )}
    >
      {dot ? <span className={cn("h-2 w-2 rounded-full", dot)} aria-hidden /> : null}
      {children}
    </button>
  );
}

const URGENCY_DOTS: Record<Urgency, string> = {
  at_risk: "bg-red-600",
  needs_attention: "bg-amber-500",
  on_track: "bg-brand-lime-600",
};

function ChangeText({ row, prevName }: { row: CohortStudentRow; prevName: string | null }) {
  if (!prevName) return null;
  if (row.change_pts === null) {
    return <span className="text-slate-600">{row.prev_pct === null ? "not sat" : "not comparable"}</span>;
  }
  const v = row.change_pts;
  return (
    <span className={cn("tabular-nums", v > 0 ? "text-lime-700" : v < 0 ? "text-red-700" : "text-slate-600")}>
      {signed1(v)}
    </span>
  );
}

function Distribution({ cohort }: { cohort: Cohort }) {
  const scope = cohort.scope;
  const head = cohort.headline;
  const counts = (cohort.score_distribution ?? []).map((b) => b.count);
  // Under 5 students a histogram says nothing the table does not (the tiles show top and lowest).
  if (!scope || counts.length !== BINS.length || scope.students < MIN_SPREAD_N) return null;
  const bins = BINS.map((b, i) => ({ label: b.label, count: counts[i] ?? 0 }));
  const max = Math.max(...bins.map((b) => b.count));
  const modal = bins.filter((b) => b.count === max).map((b) => b.label);
  const median = head?.median_pct ?? null;
  const total = scope.mode === "sitting" ? head?.total_marks ?? null : null;
  const marks = (pct: number) => formatNumber((pct / 100) * (total ?? 0));
  return (
    <ChartFrame
      title="Score distribution"
      takeaway={`Most students scored ${modal.join(" or ")}${median !== null ? ` · median ${pct1(median)}` : ""}`}
      table={{
        columns: total ? ["Score band", "Marks", "Students"] : ["Score band", "Students"],
        rows: bins.map((b, i) =>
          total
            ? [
                b.label,
                i === BINS.length - 1 ? `${marks(BINS[i].lo)} to ${formatNumber(total)}` : `${marks(BINS[i].lo)} to under ${marks(BINS[i].hi)}`,
                b.count,
              ]
            : [b.label, b.count],
        ),
      }}
    >
      <Histogram
        bins={bins}
        markerIndex={median !== null ? binOf(median) : undefined}
        markerLabel={median !== null ? `median ${pct1(median)}` : undefined}
      />
    </ChartFrame>
  );
}

/**
 * The rows to show when a long list is cut to its top and bottom: each block is extended to every
 * row tied with its edge, so equal ranks are never split. null = show everything.
 */
function topAndBottom<T>(rows: T[], value: (row: T) => number | null): { top: T[]; bottom: T[] } | null {
  if (rows.length <= SPLIT_OVER) return null;
  let end = EDGE;
  while (end < rows.length && value(rows[end]) === value(rows[end - 1])) end += 1;
  let start = rows.length - EDGE;
  while (start > 0 && value(rows[start - 1]) === value(rows[start])) start -= 1;
  if (start - end < 2) return null; // hiding one row saves nothing
  return { top: rows.slice(0, end), bottom: rows.slice(start) };
}

/** Students tab: urgency / release / chapter chips, a name search, the distribution and the table. */
export function StudentsTab({
  cohort,
  params,
  update,
  onWhatsApp,
  onReleased,
}: {
  cohort: Cohort;
  params: CohortParams;
  update: (patch: ParamPatch) => void;
  onWhatsApp: (ids: number[], names: Map<number, string>) => void;
  onReleased: (count: number) => void;
}) {
  const rows = useMemo(() => cohort.students_view ?? [], [cohort.students_view]);
  const sitting = cohort.scope?.mode === "sitting";
  const prevName = sitting ? cohort.previous?.short_name ?? null : null;
  const hasPrev = prevName !== null;
  const hasMcq = rows.some((r) => r.mcq_count > 0);
  const counts = cohort.urgency_counts;
  const provisional = cohort.release_counts?.provisional ?? rows.filter((r) => r.release_status !== "RELEASED").length;
  const [query, setQuery] = useState("");
  const [sort, setSort] = useState<{ key: SortKey; dir: 1 | -1 }>({ key: "pct", dir: -1 });
  const [showAll, setShowAll] = useState(false);
  const [releasing, setReleasing] = useState<ReleaseTarget[] | null>(null);

  const chapterOptions = (cohort.chapters ?? [])
    .filter((c) => !c.subject_level && c.below_60 > 0)
    .sort((a, b) => a.topic.localeCompare(b.topic));

  const filtered = useMemo(() => {
    const q = query.trim().toLowerCase();
    const chapter = params.chapter?.toLowerCase() ?? null;
    return rows.filter((r) => {
      if (params.urgency && r.urgency !== params.urgency) return false;
      if (params.notReleased && r.release_status === "RELEASED") return false;
      if (q && !r.student_name.toLowerCase().includes(q)) return false;
      if (chapter && !r.topics.some((t) => t.topic.toLowerCase() === chapter && t.mastery < RETEACH_LINE)) return false;
      return true;
    });
  }, [rows, query, params.urgency, params.notReleased, params.chapter]);

  const sorted = useMemo(() => {
    const value = (r: CohortStudentRow): number | string => {
      switch (sort.key) {
        case "name":
          return r.student_name.toLowerCase();
        case "change":
          return r.change_pts ?? -Infinity;
        case "attempted":
          return r.attempted;
        case "wrong":
          return r.negative_marks;
        default:
          return r.pct;
      }
    };
    return [...filtered].sort((a, b) => {
      const va = value(a);
      const vb = value(b);
      const cmp = va < vb ? -1 : va > vb ? 1 : 0;
      return cmp * sort.dir || a.rank - b.rank;
    });
  }, [filtered, sort]);

  const anyFilter = Boolean(params.urgency || params.notReleased || params.chapter || query.trim());
  // Top and bottom only make sense on a ranked order (by % or by change), never A-Z.
  const ranked = sort.key === "pct" || sort.key === "change";
  const cut =
    !anyFilter && !showAll && ranked
      ? topAndBottom(sorted, (r) => (sort.key === "change" ? r.change_pts : r.pct))
      : null;
  const shown = cut ? [...cut.top, ...cut.bottom] : sorted;
  const gapAt = cut ? cut.top.length : -1;
  const hidden = sorted.length - shown.length;
  const toRelease = filtered.filter((r) => r.release_status !== "RELEASED");

  function header(key: SortKey, label: string, align: "left" | "right" = "right") {
    const active = sort.key === key;
    return (
      <th scope="col" aria-sort={active ? (sort.dir === 1 ? "ascending" : "descending") : "none"} className={cn(TH, align === "right" && "text-right")}>
        <button
          type="button"
          onClick={() => setSort((s) => ({ key, dir: s.key === key ? (s.dir === 1 ? -1 : 1) : key === "name" ? 1 : -1 }))}
          className={cn(
            "inline-flex items-center gap-0.5 rounded-sm hover:text-brand-navy focus-visible:outline-2 focus-visible:outline-cyan-700",
            active && "text-brand-navy",
          )}
        >
          {label}
          {active ? (
            sort.dir === 1 ? <ArrowUp className="h-3 w-3" aria-hidden /> : <ArrowDown className="h-3 w-3" aria-hidden />
          ) : null}
        </button>
      </th>
    );
  }

  const names = new Map(filtered.map((r) => [r.submission_id, r.student_name]));
  const levels: Urgency[] = ["at_risk", "needs_attention", "on_track"];
  const colSpan = 6 + (sitting ? 1 : 0) + (hasPrev ? 1 : 0) + (hasMcq ? 2 : 0);
  const gapButton = (
    <button type="button" onClick={() => setShowAll(true)} className={cn(TEXT_BTN, "text-xs")}>
      Show {hidden} more
    </button>
  );

  return (
    <div className="space-y-5">
      <div className="space-y-2">
        <div role="group" aria-label="Filter students" className="flex flex-wrap items-center gap-1.5">
          <Chip pressed={!params.urgency} onClick={() => update({ urgency: null })}>
            All <span className="tabular-nums">{rows.length}</span>
          </Chip>
          {levels
            .filter((u) => counts[u] > 0 || params.urgency === u)
            .map((u) => (
              <Chip key={u} pressed={params.urgency === u} dot={URGENCY_DOTS[u]} onClick={() => update({ urgency: params.urgency === u ? null : u })}>
                {URGENCY_LABELS[u]} <span className="tabular-nums">{counts[u]}</span>
              </Chip>
            ))}
          {provisional > 0 || params.notReleased ? (
            <Chip pressed={params.notReleased} onClick={() => update({ release: params.notReleased ? null : "provisional" })}>
              Not released <span className="tabular-nums">{provisional}</span>
            </Chip>
          ) : null}
        </div>
        <div className="flex flex-col gap-2 sm:flex-row sm:flex-wrap sm:items-center">
          {chapterOptions.length ? (
            <label className="flex min-w-0 items-center gap-2 text-[13px] text-slate-700">
              <span className="whitespace-nowrap">Below {RETEACH_LINE}% in</span>
              <select
                value={params.chapter ?? ""}
                onChange={(e) => update({ topic: e.target.value || null })}
                className="h-8 min-w-0 flex-1 rounded-md border border-slate-300 bg-white px-2 text-[13px] text-slate-800 sm:max-w-64 sm:flex-none"
              >
                <option value="">any chapter</option>
                {chapterOptions.map((c) => (
                  <option key={c.topic} value={c.topic}>
                    {c.topic} ({c.below_60})
                  </option>
                ))}
              </select>
            </label>
          ) : null}
          <label className="relative min-w-0 sm:w-56">
            <span className="sr-only">Search students by name</span>
            <Search className="pointer-events-none absolute top-1/2 left-2.5 h-3.5 w-3.5 -translate-y-1/2 text-slate-500" aria-hidden />
            <input
              type="search"
              value={query}
              onChange={(e) => setQuery(e.target.value)}
              placeholder="Search name"
              className="h-8 w-full rounded-md border border-slate-300 bg-white pr-2 pl-8 text-[13px] text-slate-800 placeholder:text-slate-500 focus:border-brand-cyan focus:outline-none focus:ring-2 focus:ring-brand-cyan/30"
            />
          </label>
          <div className="flex flex-wrap items-center gap-2 sm:ml-auto">
            {params.notReleased && toRelease.length ? (
              <button
                type="button"
                onClick={() =>
                  setReleasing(toRelease.map((r) => ({ submission_id: r.submission_id, student_name: r.student_name, pct: r.pct })))
                }
                className={cn(
                  "inline-flex h-8 items-center gap-1.5 rounded-md border border-brand-navy bg-brand-navy px-2.5 text-[13px] font-medium text-white transition-colors hover:bg-brand-navy-700",
                  FOCUS_RING,
                )}
              >
                <BadgeCheck className="h-3.5 w-3.5" aria-hidden />
                Release {plural(toRelease.length, "report")}
              </button>
            ) : null}
            <button
              type="button"
              disabled={filtered.length === 0}
              onClick={() => onWhatsApp(filtered.map((r) => r.submission_id), names)}
              className={cn(
                "inline-flex h-8 items-center gap-1.5 rounded-md border border-slate-300 bg-white px-2.5 text-[13px] text-slate-700 transition-colors hover:bg-slate-50 disabled:opacity-50",
                FOCUS_RING,
              )}
            >
              <MessageCircle className="h-3.5 w-3.5" aria-hidden />
              Send {anyFilter ? "these" : "all"} {plural(filtered.length, "report")}
              <span className="text-xs text-slate-600">WhatsApp, simulated</span>
            </button>
          </div>
        </div>
      </div>

      {!anyFilter ? <Distribution cohort={cohort} /> : null}

      {filtered.length === 0 ? (
        <p className="rounded-md border border-dashed border-slate-300 px-4 py-6 text-center text-sm text-slate-600">
          No students match.{" "}
          <button
            type="button"
            onClick={() => {
              setQuery("");
              update({ urgency: null, release: null, topic: null });
            }}
            className={TEXT_BTN}
          >
            Clear
          </button>
        </p>
      ) : (
        <div className="min-w-0">
          <div className="mb-2 flex items-baseline justify-between gap-3">
            <h3 className="text-sm font-semibold text-slate-900">
              {anyFilter ? `${plural(filtered.length, "student")} of ${rows.length}` : `All ${plural(rows.length, "student")}`}
              <span className="ml-1.5 text-xs font-normal text-slate-600">
                {sitting ? "one sheet each" : "each student's latest test, compared by %"}
              </span>
            </h3>
            {!anyFilter && ranked && sorted.length > SPLIT_OVER && (showAll || cut) ? (
              <button type="button" onClick={() => setShowAll((v) => !v)} className={TEXT_BTN}>
                {showAll ? "Top and bottom only" : `Show all ${sorted.length}`}
              </button>
            ) : null}
          </div>

          {/* Desktop table */}
          <table className="hidden w-full border-collapse sm:table">
            <caption className="sr-only">Students in this view, one row each</caption>
            <thead className="border-b border-slate-200">
              <tr>
                <th scope="col" className={cn(TH, "w-10 text-right")}>
                  #
                </th>
                {header("name", "Student", "left")}
                {sitting ? (
                  <th scope="col" className={cn(TH, "text-right")}>
                    Marks
                  </th>
                ) : null}
                {header("pct", "%")}
                {hasPrev ? header("change", `vs ${prevName}`) : null}
                {hasMcq ? header("attempted", "Attempted") : null}
                {hasMcq ? header("wrong", "Neg. marks") : null}
                <th scope="col" className={TH}>
                  Weakest chapter
                </th>
                <th scope="col" className={TH}>
                  Urgency
                </th>
                <th scope="col" className={TH}>
                  Report
                </th>
              </tr>
            </thead>
            <tbody className="divide-y divide-slate-100">
              {shown.map((r, i) => (
                <Fragment key={r.submission_id}>
                  {i === gapAt ? (
                    <tr>
                      <td colSpan={colSpan} className="bg-slate-50 px-3 py-1 text-center">
                        {gapButton}
                      </td>
                    </tr>
                  ) : null}
                  <tr>
                    <td className={cn(TD, "text-right text-slate-600")}>{r.rank}</td>
                    <th scope="row" className={cn(TD, "max-w-56 truncate text-left font-normal")}>
                      <Link href={`/report/${r.submission_id}`} className={LINK}>
                        {r.student_name}
                      </Link>
                    </th>
                    {sitting ? (
                      <td className={cn(TD, "text-right whitespace-nowrap text-slate-600")}>
                        {formatNumber(r.score)} / {formatNumber(r.total_marks)}
                      </td>
                    ) : null}
                    <td className={cn(TD, "text-right font-semibold text-brand-navy")}>{pct1(r.pct)}</td>
                    {hasPrev ? (
                      <td className={cn(TD, "text-right")}>
                        <ChangeText row={r} prevName={prevName} />
                      </td>
                    ) : null}
                    {hasMcq ? (
                      <td className={cn(TD, "text-right whitespace-nowrap")}>
                        {r.mcq_count ? `${r.attempted}/${r.mcq_count}` : "—"}
                      </td>
                    ) : null}
                    {hasMcq ? (
                      <td
                        className={cn(TD, "text-right", r.negative_marks > 0 && "text-red-700")}
                        title={r.mcq_count ? `${plural(r.wrong, "wrong answer")}, ${lost(r.negative_marks)} marks` : undefined}
                      >
                        {r.mcq_count ? lost(r.negative_marks) : "—"}
                      </td>
                    ) : null}
                    <td className={cn(TD, "max-w-48 truncate text-slate-700")} title={r.weakest_topic ?? undefined}>
                      {r.weakest_topic ?? "—"}
                    </td>
                    <td className={TD}>
                      <UrgencyBadge urgency={r.urgency} reasons={r.reasons} size="sm" />
                    </td>
                    <td className={cn(TD, "text-xs whitespace-nowrap")}>
                      {r.release_status === "RELEASED" ? (
                        <span className="text-lime-700">Released</span>
                      ) : (
                        <Link
                          href={`/report/${r.submission_id}#release-gate`}
                          className={cn("rounded-sm text-slate-700 hover:text-cyan-700 hover:underline", FOCUS_RING)}
                        >
                          Provisional →<span className="sr-only"> review and release {r.student_name}&apos;s report</span>
                        </Link>
                      )}
                    </td>
                  </tr>
                </Fragment>
              ))}
            </tbody>
          </table>

          {/* Phone list: two lines per student */}
          <ul className="divide-y divide-slate-100 border-y border-slate-100 sm:hidden">
            {shown.map((r, i) => (
              <li key={r.submission_id}>
                {i === gapAt ? <p className="bg-slate-50 py-1 text-center">{gapButton}</p> : null}
                <div className="py-2">
                  <div className="flex items-baseline gap-2">
                    <span className="w-6 shrink-0 text-right text-xs tabular-nums text-slate-600">{r.rank}</span>
                    <Link href={`/report/${r.submission_id}`} className={cn(LINK, "min-w-0 flex-1 truncate text-sm")}>
                      {r.student_name}
                    </Link>
                    <span className="text-sm font-semibold tabular-nums text-brand-navy">{pct1(r.pct)}</span>
                    <UrgencyBadge urgency={r.urgency} reasons={r.reasons} size="sm" />
                  </div>
                  <p className="mt-0.5 flex flex-wrap gap-x-3 pl-8 text-xs tabular-nums text-slate-600">
                    {hasPrev ? (
                      <span>
                        {r.change_pts === null ? (
                          r.prev_pct === null ? `did not sit ${prevName}` : `not comparable with ${prevName}`
                        ) : (
                          <>
                            vs {prevName} <ChangeText row={r} prevName={prevName} />
                          </>
                        )}
                      </span>
                    ) : null}
                    {r.mcq_count ? (
                      <span>
                        {r.attempted}/{r.mcq_count} attempted
                      </span>
                    ) : null}
                    {r.weakest_topic ? <span className="min-w-0 truncate">Weakest: {r.weakest_topic}</span> : null}
                    {r.release_status !== "RELEASED" && params.notReleased ? (
                      <Link href={`/report/${r.submission_id}#release-gate`} className={cn(TEXT_BTN, "text-xs")}>
                        Review →
                      </Link>
                    ) : null}
                  </p>
                </div>
              </li>
            ))}
          </ul>
        </div>
      )}
      <ReleaseDialog
        rows={releasing}
        isDemo={(cohort.scope?.demo_sheets ?? cohort.demo_count ?? 0) > 0}
        onClose={() => setReleasing(null)}
        onReleased={(count) => {
          if (count > 0) setReleasing(null);
          onReleased(count);
        }}
      />
    </div>
  );
}
