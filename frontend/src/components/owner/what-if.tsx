"use client";

import Link from "next/link";
import { useCallback, useRef, useState } from "react";
import { Loader2, Plus, Trash2 } from "lucide-react";
import { btnPrimary, btnSecondary, fieldClass } from "@/components/cohort/dialog";
import { IllustrativePill } from "@/components/shared/illustrative-pill";
import { getWhatIfOptions, runWhatIf } from "@/lib/api";
import type {
  InterventionSummary,
  WhatIfImpact,
  WhatIfResult,
  WhatIfScenarioResult,
  WhatIfTopicOption,
} from "@/lib/types";
import { cn } from "@/lib/utils";
import { fmt, pct, signed } from "./format";
import { Disclosure, linkCls } from "./owner-ui";
import { EmptyNote, ErrorNote, focusRing, Panel, SamplePill, theadCls, thCls } from "./states";
import { useAsync } from "./use-async";

const MAX_SCENARIOS = 5;
const DEFAULT_HOURS = 5;
const MIN_STUDENTS = 3;
const MAX_CHIPS = 3;

interface Row {
  id: number;
  topic: string;
  hours: number;
}

function clampHours(v: number, max = 40): number {
  if (!Number.isFinite(v)) return 0.5;
  return Math.min(max, Math.max(0.5, Math.round(v * 2) / 2));
}

/** Suggested extra hours for a topic: its median hours-to-target, 0.5-20 h. */
function suggestedHours(t: WhatIfTopicOption): number {
  return t.hours_to_target === null || t.hours_to_target === undefined ? DEFAULT_HOURS : clampHours(t.hours_to_target, 20);
}

function topicLabel(t: WhatIfTopicOption): string {
  return `${t.topic} - mean mastery ${pct(t.mean_mastery)} · ${t.students} student${t.students === 1 ? "" : "s"}`;
}

/** NEET marks per student on the 0-720 exam scale: expected value with the low-high range. */
function ImpactTile({ impact, title, who }: { impact: WhatIfImpact; title: string; who: string }) {
  const scaleMax = impact.exam_scale_max || 720;
  const lo = Math.min(impact.exam_marks_low, impact.exam_marks_avg);
  const hi = Math.max(impact.exam_marks_high, impact.exam_marks_avg);
  // The gains are small next to 720, so the bar zooms to a readable axis and says so.
  const axisMax = Math.max(5, Math.ceil((Math.max(hi, 1) * 1.25) / 5) * 5);
  const axisMin = Math.min(0, Math.floor(lo / 5) * 5);
  const pos = (v: number) => ((v - axisMin) / (axisMax - axisMin)) * 100;
  return (
    <div className="min-w-0">
      <p className="text-xs text-slate-500">{title}</p>
      <p className="mt-0.5 text-xl font-semibold tabular-nums text-brand-navy">
        {signed(impact.exam_marks_avg)}{" "}
        <span className="text-sm font-normal text-slate-600">NEET marks {who}</span>
      </p>
      <p className="text-xs tabular-nums text-slate-600">
        Range {signed(impact.exam_marks_low)} to {signed(impact.exam_marks_high)} of {scaleMax} marks ·{" "}
        {signed(impact.test_pct_points_avg)} test % points
      </p>
      <div
        className="mt-3"
        role="img"
        aria-label={`Expected ${fmt(impact.exam_marks_avg)} marks, range ${fmt(impact.exam_marks_low)} to ${fmt(impact.exam_marks_high)}`}
      >
        <div className="relative h-2 bg-slate-100">
          <span
            className="absolute inset-y-0 bg-slate-300"
            style={{
              left: `${pos(impact.exam_marks_low)}%`,
              width: `${Math.max(1, pos(impact.exam_marks_high) - pos(impact.exam_marks_low))}%`,
            }}
          />
          <span
            className="absolute -inset-y-1 w-0.5 -translate-x-1/2 bg-brand-navy"
            style={{ left: `${pos(impact.exam_marks_avg)}%` }}
            title="Expected"
          />
        </div>
        <div className="mt-1 flex justify-between text-xs tabular-nums text-slate-500">
          <span>{fmt(axisMin, 0)}</span>
          <span>axis zoomed to {axisMax} of {scaleMax} marks</span>
          <span>{fmt(axisMax, 0)}</span>
        </div>
      </div>
    </div>
  );
}

function ScenarioResult({ s, considered, index }: { s: WhatIfScenarioResult; considered: number; index: number }) {
  const [open, setOpen] = useState(false);
  const rows = s.students ?? [];
  const id = `whatif-students-${index}`;
  return (
    <section className="border-t border-slate-200 pt-4" aria-label={`Scenario: ${s.topic}`}>
      <h3 className="text-sm font-semibold text-brand-navy">
        +{fmt(s.extra_hours)} h on {s.topic}
        {s.subject ? <span className="ml-1 font-normal text-slate-500">({s.subject})</span> : null}
      </h3>
      <div className="mt-3 grid grid-cols-1 gap-4 lg:grid-cols-2">
        <ImpactTile
          impact={s.impact}
          title="Projected gain"
          who={`per student who sat the topic (${s.students_assessed} of ${considered})`}
        />
        <dl className="grid grid-cols-2 gap-x-4 gap-y-2 text-sm">
          <div className="border-b border-slate-200 pb-2">
            <dt className="text-xs text-slate-500">Mastery (mean)</dt>
            <dd className="font-medium tabular-nums text-slate-900">
              {pct(s.mean_mastery_before)} &rarr; {pct(s.mean_mastery_after)}
            </dd>
          </div>
          <div className="border-b border-slate-200 pb-2">
            {typeof s.students_at_target_after === "number" ? (
              <>
                <dt className="text-xs text-slate-500">At the 85% target</dt>
                <dd
                  className="font-medium tabular-nums text-slate-900"
                  title={`${s.students_at_target} already at 85% mastery; ${s.students_at_target_after} after +${fmt(s.extra_hours)} h`}
                >
                  {s.students_at_target} &rarr; {s.students_at_target_after}
                  <span className="font-normal text-slate-600"> of {s.students_assessed} students</span>
                </dd>
              </>
            ) : (
              <>
                <dt className="text-xs text-slate-500">Already at the 85% target</dt>
                <dd className="font-medium tabular-nums text-slate-900">
                  {s.students_at_target} of {s.students_assessed} students
                </dd>
              </>
            )}
          </div>
          <div className="border-b border-slate-200 pb-2">
            <dt className="text-xs text-slate-500">Test % points</dt>
            <dd className="font-medium tabular-nums text-slate-900">{signed(s.impact.test_pct_points_avg)} pts</dd>
          </div>
          <div className="border-b border-slate-200 pb-2">
            <dt className="text-xs text-slate-500">Hours to target (median)</dt>
            <dd className="font-medium tabular-nums text-slate-900">
              {s.hours_to_target === null ? "—" : `${fmt(s.hours_to_target)} h`}
            </dd>
          </div>
        </dl>
      </div>
      {rows.length ? (
        <div className="mt-2">
          <Disclosure open={open} onToggle={() => setOpen((v) => !v)} controls={id}>
            {open ? "Hide students" : `Show students (${rows.length})`}
          </Disclosure>
          <div id={id} hidden={!open} className="relative mt-2 max-h-80 overflow-auto rounded-md border border-slate-200">
            {open ? (
              <table className="w-full border-collapse text-sm">
                <caption className="sr-only">Students by projected gain for {s.topic}</caption>
                <thead className={cn(theadCls, "sticky top-0")}>
                  <tr>
                    <th scope="col" className={thCls}>Student</th>
                    <th scope="col" className={cn(thCls, "text-right")}>Mastery</th>
                    <th scope="col" className={cn(thCls, "text-right")}>NEET marks</th>
                  </tr>
                </thead>
                <tbody className="divide-y divide-slate-100">
                  {rows.map((st) => (
                    <tr key={st.submission_id}>
                      <td className="px-3 py-1.5">
                        <Link href={`/report/${st.submission_id}`} className={linkCls}>
                          {st.student_name}
                        </Link>
                      </td>
                      <td className="px-3 py-1.5 text-right tabular-nums text-slate-700">
                        {pct(st.mastery_before)} &rarr; {pct(st.mastery_after)}
                      </td>
                      <td className="px-3 py-1.5 text-right tabular-nums text-slate-900">{signed(st.exam_marks_gain)}</td>
                    </tr>
                  ))}
                </tbody>
              </table>
            ) : null}
          </div>
        </div>
      ) : null}
    </section>
  );
}

function Results({ result }: { result: WhatIfResult }) {
  const [assumptionsOpen, setAssumptionsOpen] = useState(false);
  const n = result.students_considered;
  const single = result.scenarios.length === 1;
  return (
    <div className="space-y-4 border-t border-slate-200 pt-4" aria-live="polite">
      <div className="flex flex-wrap items-center gap-2">
        <IllustrativePill label={result.label || "Illustrative - not a calibrated forecast"} className="max-w-full whitespace-normal" />
        {result.is_demo ? <SamplePill /> : null}
      </div>
      <div className="grid grid-cols-1 gap-4 lg:grid-cols-2">
        {single ? (
          <div className="min-w-0">
            <p className="text-xs text-slate-500">Scope</p>
            <p className="mt-0.5 text-sm text-slate-800">
              {result.batch_name ?? "All batches"} · {n} student{n === 1 ? "" : "s"}, each on their latest test ·{" "}
              {result.calibrated ? `scaled ×${fmt(result.calibration_factor, 2)}` : "no calibration applied"}
            </p>
          </div>
        ) : (
          <ImpactTile
            impact={result.combined}
            title={`Combined impact (${result.scenarios.length} topics)`}
            who="per student who sat at least one of the topics"
          />
        )}
        <div>
          <p className="text-xs text-slate-500">Projected average</p>
          <p className="mt-0.5 text-xl font-semibold tabular-nums text-brand-navy">
            {pct(result.baseline_avg_pct, 1)} &rarr; {pct(result.projected_avg_pct, 1)}
            <span className="ml-1 text-sm font-normal text-slate-600">across all {n}</span>
          </p>
          <p className="text-xs text-slate-500">
            % of max marks on each student&apos;s latest test; students who did not sit a topic gain nothing from it
          </p>
        </div>
      </div>
      {result.scenarios.map((s, i) => (
        <ScenarioResult key={`${s.topic}-${i}`} s={s} considered={n} index={i} />
      ))}
      {result.assumptions?.length ? (
        <div className="border-t border-slate-200 pt-3">
          <Disclosure open={assumptionsOpen} onToggle={() => setAssumptionsOpen((v) => !v)} controls="whatif-assumptions">
            {assumptionsOpen ? "Hide assumptions" : `Assumptions (${result.assumptions.length})`}
          </Disclosure>
          <ul id="whatif-assumptions" hidden={!assumptionsOpen} className="mt-1.5 list-disc space-y-1 pl-5 text-xs text-slate-600">
            {result.assumptions.map((a, i) => (
              <li key={i}>{a}</li>
            ))}
          </ul>
        </div>
      ) : null}
    </div>
  );
}

/**
 * What-if simulator (FR-4.14): extra study hours on up to 5 topics -> projected NEET marks.
 * Illustrative. Starts on `defaultBatchId` with suggestions from that batch's weakest topics.
 */
export function WhatIfSimulator({
  institutionId,
  defaultBatchId = null,
  calibration = null,
  className,
}: {
  institutionId: number | null;
  defaultBatchId?: number | null;
  /** The owner payload's intervention summary: calibration factor, sample size and measured actions. */
  calibration?: InterventionSummary | null;
  className?: string;
}) {
  const nextId = useRef(2);
  const [batchId, setBatchId] = useState<number | null>(defaultBatchId);
  const [rows, setRows] = useState<Row[]>([{ id: 1, topic: "", hours: DEFAULT_HOURS }]);
  const [useCalibration, setUseCalibration] = useState(false);
  const [includeSmall, setIncludeSmall] = useState(false);
  const [result, setResult] = useState<WhatIfResult | null>(null);
  const [running, setRunning] = useState(false);
  const [runError, setRunError] = useState<unknown>(null);

  const baseFetcher = useCallback(() => getWhatIfOptions({ institution_id: institutionId }), [institutionId]);
  const base = useAsync(baseFetcher);
  const topicFetcher = useCallback(
    () => getWhatIfOptions({ institution_id: institutionId, batch_id: batchId }),
    [institutionId, batchId],
  );
  const topicsState = useAsync(topicFetcher);
  const allTopics = topicsState.data?.topics ?? [];
  const common = allTopics.filter((t) => t.students >= MIN_STUDENTS);
  const rare = allTopics.filter((t) => t.students < MIN_STUDENTS);
  const chips = common.filter((t) => (t.mean_mastery ?? 100) < 70).slice(0, MAX_CHIPS);
  const factor = topicsState.data?.calibration_factor ?? base.data?.calibration_factor ?? null;
  const calN = calibration?.calibration_n ?? null;

  function reset() {
    setResult(null);
    setRunError(null);
  }

  function changeBatch(value: string) {
    setBatchId(value ? Number(value) : null);
    setRows([{ id: nextId.current++, topic: "", hours: DEFAULT_HOURS }]);
    reset();
  }

  function update(id: number, patch: Partial<Row>) {
    setRows((prev) => prev.map((r) => (r.id === id ? { ...r, ...patch } : r)));
  }

  async function run(scenarios: Row[] = rows) {
    setRunning(true);
    setRunError(null);
    try {
      const res = await runWhatIf({
        batch_id: batchId,
        rubric_id: null,
        institution_id: institutionId,
        scenarios: scenarios.map((r) => ({ topic: r.topic, extra_hours: clampHours(r.hours) })),
        use_calibration: useCalibration && factor !== null,
      });
      setResult(res);
    } catch (err) {
      setRunError(err);
      setResult(null);
    } finally {
      setRunning(false);
    }
  }

  function applyChip(t: WhatIfTopicOption) {
    const next = [{ id: nextId.current++, topic: t.topic, hours: suggestedHours(t) }];
    setRows(next);
    reset();
    void run(next);
  }

  const ready = rows.length > 0 && rows.every((r) => r.topic);
  const batches = base.data?.batches ?? [];
  const calibrationText =
    factor === null
      ? "needs at least 5 measured actions with a prediction"
      : `×${fmt(factor, 2)}${
          calN !== null && calibration ? ` from ${calN} of ${calibration.measured} measured actions that had a prediction` : ""
        }${calibration?.is_demo ? " · sample data" : ""}`;

  return (
    <Panel
      id="whatif-title"
      title="What-if simulator"
      subtitle="Extra study hours on a topic, projected as NEET marks. An effort-response model, not a forecast."
      action={<IllustrativePill />}
      className={className}
    >
      {base.error && !base.data ? (
        <ErrorNote error={base.error} onRetry={() => void base.reload()} retrying={base.loading} />
      ) : null}

      <label className="block min-w-0 text-sm">
        <span className="mb-1 block text-xs font-medium text-slate-600">Batch</span>
        <select
          className={cn(fieldClass, "w-64 max-w-full")}
          value={batchId ?? ""}
          onChange={(e) => changeBatch(e.target.value)}
          disabled={!base.data}
        >
          <option value="">All batches</option>
          {batches.map((b) => (
            <option key={b.id} value={b.id}>
              {b.name}
            </option>
          ))}
        </select>
      </label>

      {chips.length ? (
        <div>
          <p className="text-xs font-medium text-slate-600">Try a weak topic (3+ students)</p>
          <ul className="mt-1.5 flex flex-col gap-2 sm:flex-row sm:flex-wrap">
            {chips.map((t) => (
              <li key={t.topic}>
                <button
                  type="button"
                  onClick={() => applyChip(t)}
                  disabled={running}
                  className={cn(
                    "block w-full rounded-md border border-slate-300 bg-white px-3 py-2 text-left text-[13px] text-slate-800 hover:bg-slate-50 disabled:opacity-60 sm:inline-flex sm:min-h-8 sm:w-auto sm:items-center sm:py-0",
                    focusRing,
                  )}
                >
                  <span className="block sm:inline">
                    <span className="whitespace-nowrap font-medium text-brand-navy">+{fmt(suggestedHours(t))} h</span> {t.topic}
                  </span>
                  <span className="block text-xs tabular-nums text-slate-500 sm:ml-1.5 sm:inline">
                    <span className="hidden sm:inline">· </span>
                    {t.students} students · {pct(t.mean_mastery)}
                  </span>
                </button>
              </li>
            ))}
          </ul>
        </div>
      ) : null}

      {topicsState.error && !topicsState.data ? (
        <ErrorNote
          error={topicsState.error}
          onRetry={() => void topicsState.reload()}
          retrying={topicsState.loading}
          prefix="Could not load topics"
        />
      ) : null}
      {topicsState.data && allTopics.length === 0 ? (
        <EmptyNote>No graded sheets in this batch yet - grade sheets on the Intake page or pick another batch.</EmptyNote>
      ) : null}

      <ol className="divide-y divide-slate-200 border-y border-slate-200">
        {rows.map((r, i) => (
          <li key={r.id} className="grid grid-cols-1 gap-3 py-3 md:grid-cols-[minmax(0,1fr)_minmax(0,18rem)_auto] md:items-end">
            <label className="block min-w-0 text-sm">
              <span className="mb-1 block text-xs font-medium text-slate-600">Topic {i + 1}</span>
              <select
                className={fieldClass}
                value={r.topic}
                onChange={(e) => update(r.id, { topic: e.target.value })}
                disabled={topicsState.loading && !topicsState.data}
              >
                <option value="">{topicsState.loading && !topicsState.data ? "Loading topics…" : "Choose a topic…"}</option>
                {common.map((t) => (
                  <option key={t.topic} value={t.topic}>
                    {topicLabel(t)}
                  </option>
                ))}
                {includeSmall || rare.some((t) => t.topic === r.topic)
                  ? rare.map((t) => (
                      <option key={t.topic} value={t.topic}>
                        {topicLabel(t)} (small group)
                      </option>
                    ))
                  : null}
              </select>
            </label>
            <div className="min-w-0">
              <span className="mb-1 block text-xs font-medium text-slate-600" id={`hours-label-${r.id}`}>
                Extra hours (0.5-20 on the slider, up to 40 typed)
              </span>
              <div className="flex items-center gap-2">
                <input
                  type="range"
                  min={0.5}
                  max={20}
                  step={0.5}
                  value={Math.min(20, r.hours)}
                  onChange={(e) => update(r.id, { hours: Number(e.target.value) })}
                  aria-labelledby={`hours-label-${r.id}`}
                  className="min-w-0 flex-1 accent-brand-cyan"
                />
                <label className="sr-only" htmlFor={`hours-${r.id}`}>
                  Extra hours for topic {i + 1}
                </label>
                <input
                  id={`hours-${r.id}`}
                  type="number"
                  min={0.5}
                  max={40}
                  step={0.5}
                  value={r.hours}
                  onChange={(e) => {
                    const v = Number(e.target.value);
                    if (Number.isFinite(v)) update(r.id, { hours: v });
                  }}
                  onBlur={() => update(r.id, { hours: clampHours(r.hours) })}
                  className={cn(fieldClass, "w-20 tabular-nums")}
                />
                <span className="text-xs text-slate-500">h</span>
              </div>
            </div>
            <button
              type="button"
              onClick={() => setRows((prev) => prev.filter((x) => x.id !== r.id))}
              disabled={rows.length === 1}
              className={cn(
                "inline-flex h-10 items-center justify-center gap-1 rounded-md px-2 text-xs text-slate-500 hover:bg-slate-100 hover:text-rose-700 disabled:opacity-40",
                focusRing,
              )}
              aria-label={`Remove topic ${i + 1}`}
            >
              <Trash2 className="h-4 w-4" aria-hidden />
              <span className="md:sr-only">Remove</span>
            </button>
          </li>
        ))}
      </ol>

      <div className="flex flex-wrap items-center gap-x-5 gap-y-2">
        <button
          type="button"
          className={btnSecondary}
          onClick={() => setRows((prev) => [...prev, { id: nextId.current++, topic: "", hours: DEFAULT_HOURS }])}
          disabled={rows.length >= MAX_SCENARIOS}
        >
          <Plus className="h-4 w-4" aria-hidden />
          Add topic ({rows.length}/{MAX_SCENARIOS})
        </button>
        {rare.length ? (
          <label className="inline-flex min-h-10 items-center gap-2 text-sm text-slate-700">
            <input
              type="checkbox"
              checked={includeSmall}
              onChange={(e) => setIncludeSmall(e.target.checked)}
              className="h-4 w-4 accent-brand-cyan"
            />
            Include topics seen by fewer than 3 students ({rare.length})
          </label>
        ) : null}
      </div>

      <div className="flex flex-wrap items-center gap-3 border-t border-slate-200 pt-3">
        <label
          className={cn("flex min-h-10 min-w-0 items-start gap-2 py-2 text-sm sm:items-center sm:py-0", factor === null ? "text-slate-500" : "text-slate-800")}
          title="Scale the effort-response model by the ratio of measured to predicted mastery gains from logged interventions. Observational; not a validated forecast."
        >
          <input
            type="checkbox"
            checked={useCalibration && factor !== null}
            disabled={factor === null}
            onChange={(e) => setUseCalibration(e.target.checked)}
            className="mt-0.5 h-4 w-4 shrink-0 accent-brand-cyan sm:mt-0"
          />
          <span className="min-w-0">
            Use calibration from intervention outcomes{" "}
            <span className="block text-xs tabular-nums text-slate-500 sm:inline">({calibrationText})</span>
          </span>
        </label>
        <button type="button" className={cn(btnPrimary, "ml-auto")} onClick={() => void run()} disabled={!ready || running}>
          {running ? <Loader2 className="h-4 w-4 animate-spin motion-reduce:animate-none" aria-hidden /> : null}
          {running ? "Running…" : "Run simulation"}
        </button>
      </div>

      {runError ? <ErrorNote error={runError} prefix="Simulation failed" /> : null}
      {result ? <Results result={result} /> : null}
    </Panel>
  );
}
