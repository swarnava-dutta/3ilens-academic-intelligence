"use client";

import Link from "next/link";
import { useCallback, useRef, useState } from "react";
import { Loader2, Plus, Trash2 } from "lucide-react";
import { btnPrimary, btnSecondary, fieldClass } from "@/components/cohort/dialog";
import { IllustrativePill } from "@/components/shared/illustrative-pill";
import { getWhatIfOptions, runWhatIf } from "@/lib/api";
import type { WhatIfImpact, WhatIfResult, WhatIfScenarioResult, WhatIfTopicOption } from "@/lib/types";
import { cn } from "@/lib/utils";
import { fmt, pct, signed } from "./format";
import { EmptyNote, ErrorNote, focusRing, Panel, SamplePill, theadCls, thCls } from "./states";
import { useAsync } from "./use-async";

const MAX_SCENARIOS = 5;
const PRESET_TOPIC = "Organic Chemistry";
const PRESET_HOURS = 5;

interface Row {
  id: number;
  topic: string;
  hours: number;
}

function clampHours(v: number): number {
  if (!Number.isFinite(v)) return 0.5;
  return Math.min(40, Math.max(0.5, Math.round(v * 2) / 2));
}

function topicLabel(t: WhatIfTopicOption): string {
  return `${t.topic} - mean mastery ${pct(t.mean_mastery)} · ${t.students} students`;
}

/** NEET marks per student on the 0-720 exam scale: expected value with the low-high range. */
function ImpactTile({ impact, title }: { impact: WhatIfImpact; title: string }) {
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
        <span className="text-sm font-normal text-slate-500">NEET marks per student (of {scaleMax})</span>
      </p>
      <p className="text-xs tabular-nums text-slate-600">
        Range {signed(impact.exam_marks_low)} to {signed(impact.exam_marks_high)} marks ·{" "}
        {signed(impact.test_pct_points_avg)} test % points
      </p>
      <div className="mt-3" role="img" aria-label={`Expected ${fmt(impact.exam_marks_avg)} marks, range ${fmt(impact.exam_marks_low)} to ${fmt(impact.exam_marks_high)}`}>
        <div className="relative h-2 bg-slate-100">
          <span
            className="absolute inset-y-0 bg-slate-300"
            style={{ left: `${pos(impact.exam_marks_low)}%`, width: `${Math.max(1, pos(impact.exam_marks_high) - pos(impact.exam_marks_low))}%` }}
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

function ScenarioResult({ s }: { s: WhatIfScenarioResult }) {
  const top = (s.students ?? []).slice(0, 10);
  return (
    <section className="border-t border-slate-200 pt-4" aria-label={`Scenario: ${s.topic}`}>
      <h3 className="text-sm font-semibold text-brand-navy">
        +{fmt(s.extra_hours)} h on {s.topic}
        {s.subject ? <span className="ml-1 font-normal text-slate-500">({s.subject})</span> : null}
      </h3>
      <p className="mt-1 text-sm text-slate-700">{s.headline}</p>
      <div className="mt-3 grid grid-cols-1 gap-4 lg:grid-cols-2">
        <ImpactTile impact={s.impact} title="Projected gain" />
        <dl className="grid grid-cols-2 gap-x-4 gap-y-2 text-sm">
          <div className="border-b border-slate-200 pb-2">
            <dt className="text-xs text-slate-500">Mastery (mean)</dt>
            <dd className="font-medium tabular-nums text-slate-900">
              {pct(s.mean_mastery_before)} &rarr; {pct(s.mean_mastery_after)}
            </dd>
          </div>
          <div className="border-b border-slate-200 pb-2">
            <dt className="text-xs text-slate-500">At target after</dt>
            <dd className="font-medium tabular-nums text-slate-900">
              {s.students_at_target} of {s.students_assessed} students
            </dd>
          </div>
          <div className="border-b border-slate-200 pb-2">
            <dt className="text-xs text-slate-500">Test % points</dt>
            <dd className="font-medium tabular-nums text-slate-900">{signed(s.impact.test_pct_points_avg)} pts</dd>
          </div>
          <div className="border-b border-slate-200 pb-2">
            <dt className="text-xs text-slate-500">Hours to target</dt>
            <dd className="font-medium tabular-nums text-slate-900">
              {s.hours_to_target === null ? "—" : `${fmt(s.hours_to_target)} h`}
            </dd>
          </div>
        </dl>
      </div>
      {top.length ? (
        <div className="relative mt-3 overflow-x-auto rounded-md border border-slate-200">
          <table className="w-full min-w-[420px] border-collapse text-sm">
            <caption className="sr-only">Top {top.length} students by projected gain for {s.topic}</caption>
            <thead className={theadCls}>
              <tr>
                <th scope="col" className={thCls}>Student (top {top.length})</th>
                <th scope="col" className={cn(thCls, "text-right")}>Mastery</th>
                <th scope="col" className={cn(thCls, "text-right")}>NEET marks</th>
              </tr>
            </thead>
            <tbody className="divide-y divide-slate-100">
              {top.map((st) => (
                <tr key={st.submission_id}>
                  <td className="px-3 py-1.5">
                    <Link href={`/report/${st.submission_id}`} className={cn("text-brand-cyan-600 hover:underline", focusRing)}>
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
        </div>
      ) : null}
    </section>
  );
}

function Results({ result }: { result: WhatIfResult }) {
  return (
    <div className="space-y-4 border-t border-slate-200 pt-4" aria-live="polite">
      <div className="flex flex-wrap items-center gap-2">
        <IllustrativePill label={result.label || "Illustrative - not a calibrated forecast"} className="max-w-full whitespace-normal" />
        {result.is_demo ? <SamplePill /> : null}
        <span className="text-xs tabular-nums text-slate-500">
          {result.batch_name ?? "All batches"} · {result.students_considered} students considered · calibration ×
          {fmt(result.calibration_factor, 2)} {result.calibrated ? "(from intervention outcomes)" : "(not applied)"}
        </span>
      </div>
      <div className="grid grid-cols-1 gap-4 lg:grid-cols-2">
        <ImpactTile impact={result.combined} title={`Combined impact (${result.scenarios.length} scenario${result.scenarios.length === 1 ? "" : "s"})`} />
        <div>
          <p className="text-xs text-slate-500">Projected batch average</p>
          <p className="mt-0.5 text-xl font-semibold tabular-nums text-brand-navy">
            {pct(result.baseline_avg_pct, 1)} &rarr; {pct(result.projected_avg_pct, 1)}
          </p>
          <p className="text-xs text-slate-500">% of max marks on the latest test, before and after the extra hours</p>
        </div>
      </div>
      {result.scenarios.map((s, i) => (
        <ScenarioResult key={`${s.topic}-${i}`} s={s} />
      ))}
      {result.assumptions?.length ? (
        <div className="border-t border-slate-200 pt-4">
          <h3 className="text-[13px] font-semibold text-slate-700">Assumptions</h3>
          <ul className="mt-1.5 list-disc space-y-1 pl-5 text-xs text-slate-600">
            {result.assumptions.map((a, i) => (
              <li key={i}>{a}</li>
            ))}
          </ul>
        </div>
      ) : null}
    </div>
  );
}

/** What-if simulator (FR-4.14): extra study hours on up to 5 topics -> projected NEET marks. Illustrative. */
export function WhatIfSimulator({ institutionId }: { institutionId: number | null }) {
  const nextId = useRef(2);
  const [batchId, setBatchId] = useState<number | null>(null);
  const [rows, setRows] = useState<Row[]>([{ id: 1, topic: "", hours: PRESET_HOURS }]);
  const [useCalibration, setUseCalibration] = useState(false);
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
  const topics = topicsState.data?.topics ?? [];
  const calibration = topicsState.data?.calibration_factor ?? base.data?.calibration_factor ?? null;
  const hasPreset = topics.some((t) => t.topic === PRESET_TOPIC);

  function changeBatch(value: string) {
    setBatchId(value ? Number(value) : null);
    setRows([{ id: nextId.current++, topic: "", hours: PRESET_HOURS }]);
    setResult(null);
    setRunError(null);
  }

  function update(id: number, patch: Partial<Row>) {
    setRows((prev) => prev.map((r) => (r.id === id ? { ...r, ...patch } : r)));
  }

  function applyPreset() {
    setRows([{ id: nextId.current++, topic: PRESET_TOPIC, hours: PRESET_HOURS }]);
    setResult(null);
    setRunError(null);
  }

  async function run() {
    setRunning(true);
    setRunError(null);
    try {
      const res = await runWhatIf({
        batch_id: batchId,
        rubric_id: null,
        institution_id: institutionId,
        scenarios: rows.map((r) => ({ topic: r.topic, extra_hours: clampHours(r.hours) })),
        use_calibration: useCalibration && calibration !== null,
      });
      setResult(res);
    } catch (err) {
      setRunError(err);
      setResult(null);
    } finally {
      setRunning(false);
    }
  }

  const ready = rows.length > 0 && rows.every((r) => r.topic);
  const batches = base.data?.batches ?? [];

  return (
    <Panel
      id="whatif-title"
      title="What-if simulator"
      subtitle="Extra study hours on a topic, projected as NEET marks per student. An effort-response model, not a forecast."
      action={<IllustrativePill />}
    >
      {base.error && !base.data ? (
        <ErrorNote error={base.error} onRetry={() => void base.reload()} retrying={base.loading} />
      ) : null}

      <div className="flex flex-wrap items-end gap-x-4 gap-y-2">
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
        {hasPreset ? (
          <button
            type="button"
            onClick={applyPreset}
            className={cn("inline-flex h-10 items-center text-sm text-brand-cyan-600 hover:underline", focusRing)}
          >
            Example: +{PRESET_HOURS} h {PRESET_TOPIC}
          </button>
        ) : null}
      </div>

      {topicsState.error && !topicsState.data ? (
        <ErrorNote
          error={topicsState.error}
          onRetry={() => void topicsState.reload()}
          retrying={topicsState.loading}
          prefix="Could not load topics"
        />
      ) : null}
      {topicsState.data && topics.length === 0 ? (
        <EmptyNote>No topics with completed results in this selection. Load the sample data or pick another batch.</EmptyNote>
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
                {topics.map((t) => (
                  <option key={t.topic} value={t.topic}>
                    {topicLabel(t)}
                  </option>
                ))}
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
              className={cn("inline-flex h-10 items-center justify-center gap-1 rounded-md px-2 text-xs text-slate-500 hover:bg-slate-100 hover:text-rose-700 disabled:opacity-40", focusRing)}
              aria-label={`Remove topic ${i + 1}`}
            >
              <Trash2 className="h-4 w-4" aria-hidden />
              <span className="md:sr-only">Remove</span>
            </button>
          </li>
        ))}
      </ol>

      <div className="flex flex-wrap items-center gap-3">
        <button
          type="button"
          className={btnSecondary}
          onClick={() => setRows((prev) => [...prev, { id: nextId.current++, topic: "", hours: PRESET_HOURS }])}
          disabled={rows.length >= MAX_SCENARIOS}
        >
          <Plus className="h-4 w-4" aria-hidden />
          Add topic ({rows.length}/{MAX_SCENARIOS})
        </button>
        <label
          className={cn("inline-flex items-center gap-2 text-sm", calibration === null ? "text-slate-500" : "text-slate-800")}
          title={
            calibration === null
              ? "Needs at least 5 measured interventions before a calibration factor exists"
              : `Scale the effort-response model by ×${fmt(calibration, 2)} (measured / predicted gain from logged interventions)`
          }
        >
          <input
            type="checkbox"
            checked={useCalibration && calibration !== null}
            disabled={calibration === null}
            onChange={(e) => setUseCalibration(e.target.checked)}
            className="h-4 w-4 accent-brand-cyan"
          />
          Use calibration from intervention outcomes
          {calibration !== null ? (
            <span className="text-xs tabular-nums text-slate-500">(×{fmt(calibration, 2)})</span>
          ) : (
            <span className="text-xs text-slate-500">(needs &ge; 5 measured interventions)</span>
          )}
        </label>
        <button type="button" className={cn(btnPrimary, "ml-auto")} onClick={() => void run()} disabled={!ready || running}>
          {running ? <Loader2 className="h-4 w-4 animate-spin" aria-hidden /> : null}
          {running ? "Running…" : "Run simulation"}
        </button>
      </div>

      {runError ? <ErrorNote error={runError} prefix="Simulation failed" /> : null}
      {result ? <Results result={result} /> : null}
    </Panel>
  );
}
