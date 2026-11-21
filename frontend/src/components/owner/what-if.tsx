"use client";

import Link from "next/link";
import { useCallback, useRef, useState } from "react";
import { Calculator, Loader2, Play, Plus, Sparkles, Trash2 } from "lucide-react";
import { Card, CardHeader } from "@/components/cohort/card";
import { btnPrimary, btnSecondary, fieldClass } from "@/components/cohort/dialog";
import { IllustrativePill } from "@/components/shared/illustrative-pill";
import { getWhatIfOptions, runWhatIf } from "@/lib/api";
import type { WhatIfImpact, WhatIfResult, WhatIfScenarioResult, WhatIfTopicOption } from "@/lib/types";
import { cn } from "@/lib/utils";
import { fmt, pct, signed } from "./format";
import { ErrorNote, SamplePill } from "./states";
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
    <div className="rounded-xl bg-brand-cyan-50/60 px-4 py-3 ring-1 ring-inset ring-brand-cyan/30">
      <p className="text-xs font-medium text-slate-700">{title}</p>
      <p className="mt-0.5 text-2xl font-bold tabular-nums text-brand-navy">
        {signed(impact.exam_marks_avg)}{" "}
        <span className="text-sm font-semibold text-slate-600">NEET marks per student (of {scaleMax})</span>
      </p>
      <p className="text-xs text-slate-700">
        Range {signed(impact.exam_marks_low)} to {signed(impact.exam_marks_high)} marks ·{" "}
        {signed(impact.test_pct_points_avg)} test % points
      </p>
      <div className="mt-3" role="img" aria-label={`Expected ${fmt(impact.exam_marks_avg)} marks, range ${fmt(impact.exam_marks_low)} to ${fmt(impact.exam_marks_high)}`}>
        <div className="relative h-3 rounded-full bg-white ring-1 ring-inset ring-slate-200">
          <span
            className="absolute inset-y-0 rounded-full bg-brand-cyan/40"
            style={{ left: `${pos(impact.exam_marks_low)}%`, width: `${Math.max(1, pos(impact.exam_marks_high) - pos(impact.exam_marks_low))}%` }}
          />
          <span
            className="absolute -inset-y-1 w-1 -translate-x-1/2 rounded-full bg-brand-navy"
            style={{ left: `${pos(impact.exam_marks_avg)}%` }}
            title="Expected"
          />
        </div>
        <div className="mt-1 flex justify-between text-[11px] tabular-nums text-slate-600">
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
    <section className="rounded-2xl border border-slate-200 p-4" aria-label={`Scenario: ${s.topic}`}>
      <p className="text-sm font-semibold text-brand-navy">
        +{fmt(s.extra_hours)} h on {s.topic}
        {s.subject ? <span className="ml-1 font-normal text-slate-600">({s.subject})</span> : null}
      </p>
      <p className="mt-1 text-sm text-slate-800">{s.headline}</p>
      <div className="mt-3 grid grid-cols-1 gap-3 lg:grid-cols-2">
        <ImpactTile impact={s.impact} title="Projected gain" />
        <dl className="grid grid-cols-2 gap-2 text-sm">
          <div className="rounded-xl px-3 py-2 ring-1 ring-inset ring-slate-200">
            <dt className="text-xs text-slate-600">Mastery (mean)</dt>
            <dd className="font-semibold tabular-nums text-brand-navy">
              {pct(s.mean_mastery_before)} &rarr; {pct(s.mean_mastery_after)}
            </dd>
          </div>
          <div className="rounded-xl px-3 py-2 ring-1 ring-inset ring-slate-200">
            <dt className="text-xs text-slate-600">At target after</dt>
            <dd className="font-semibold tabular-nums text-brand-navy">
              {s.students_at_target} of {s.students_assessed} students
            </dd>
          </div>
          <div className="rounded-xl px-3 py-2 ring-1 ring-inset ring-slate-200">
            <dt className="text-xs text-slate-600">Test % points</dt>
            <dd className="font-semibold tabular-nums text-brand-navy">{signed(s.impact.test_pct_points_avg)} pts</dd>
          </div>
          <div className="rounded-xl px-3 py-2 ring-1 ring-inset ring-slate-200">
            <dt className="text-xs text-slate-600">Hours to target</dt>
            <dd className="font-semibold tabular-nums text-brand-navy">
              {s.hours_to_target === null ? "—" : `${fmt(s.hours_to_target)} h`}
            </dd>
          </div>
        </dl>
      </div>
      {top.length ? (
        <div className="relative mt-3 overflow-x-auto rounded-xl ring-1 ring-slate-200">
          <table className="w-full min-w-[420px] border-collapse text-sm">
            <caption className="sr-only">Top {top.length} students by projected gain for {s.topic}</caption>
            <thead className="bg-slate-50">
              <tr className="text-left text-xs font-semibold uppercase tracking-wide text-slate-600">
                <th scope="col" className="px-3 py-1.5">Student (top {top.length})</th>
                <th scope="col" className="px-3 py-1.5 text-right">Mastery</th>
                <th scope="col" className="px-3 py-1.5 text-right">NEET marks</th>
              </tr>
            </thead>
            <tbody className="divide-y divide-slate-100">
              {top.map((st) => (
                <tr key={st.submission_id}>
                  <td className="px-3 py-1.5">
                    <Link href={`/report/${st.submission_id}`} className="font-medium text-brand-navy hover:underline">
                      {st.student_name}
                    </Link>
                  </td>
                  <td className="px-3 py-1.5 text-right tabular-nums text-slate-700">
                    {pct(st.mastery_before)} &rarr; {pct(st.mastery_after)}
                  </td>
                  <td className="px-3 py-1.5 text-right font-medium tabular-nums text-slate-800">{signed(st.exam_marks_gain)}</td>
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
    <div className="mt-5 space-y-4 border-t border-slate-100 pt-5" aria-live="polite">
      <div className="flex flex-wrap items-center gap-2">
        <IllustrativePill label={result.label || "Illustrative - not a calibrated forecast"} className="max-w-full whitespace-normal" />
        {result.is_demo ? <SamplePill /> : null}
        <span className="text-xs text-slate-600">
          {result.batch_name ?? "All batches"} · {result.students_considered} students considered · calibration ×
          {fmt(result.calibration_factor, 2)} {result.calibrated ? "(from intervention outcomes)" : "(not applied)"}
        </span>
      </div>
      <div className="grid grid-cols-1 gap-3 lg:grid-cols-2">
        <ImpactTile impact={result.combined} title={`Combined impact (${result.scenarios.length} scenario${result.scenarios.length === 1 ? "" : "s"})`} />
        <div className="rounded-xl px-4 py-3 ring-1 ring-inset ring-slate-200">
          <p className="text-xs font-medium text-slate-700">Projected batch average</p>
          <p className="mt-0.5 text-2xl font-bold tabular-nums text-brand-navy">
            {pct(result.baseline_avg_pct, 1)} &rarr; {pct(result.projected_avg_pct, 1)}
          </p>
          <p className="text-xs text-slate-600">% of max marks on the latest test, before and after the extra hours</p>
        </div>
      </div>
      {result.scenarios.map((s, i) => (
        <ScenarioResult key={`${s.topic}-${i}`} s={s} />
      ))}
      {result.assumptions?.length ? (
        <div className="rounded-xl bg-slate-50 px-4 py-3">
          <h3 className="text-xs font-semibold uppercase tracking-wide text-slate-600">Assumptions</h3>
          <ul className="mt-1.5 list-disc space-y-1 pl-5 text-xs text-slate-700">
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
    <Card aria-labelledby="whatif-title">
      <CardHeader
        id="whatif-title"
        icon={Calculator}
        title="What-if simulator"
        subtitle="Extra study hours on a topic -> projected NEET marks per student. An effort-response model, not a forecast."
        action={<IllustrativePill />}
      />

      {base.error && !base.data ? (
        <ErrorNote error={base.error} onRetry={() => void base.reload()} retrying={base.loading} className="mt-4" />
      ) : null}

      <div className="mt-4 flex flex-wrap items-end gap-3">
        <label className="block min-w-0 text-sm">
          <span className="mb-1 block text-xs font-medium text-slate-700">Batch</span>
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
            className="inline-flex items-center gap-1.5 rounded-full bg-violet-50 px-3 py-1.5 text-xs font-semibold text-violet-800 ring-1 ring-inset ring-violet-200 hover:bg-violet-100 focus-visible:outline-2 focus-visible:outline-brand-cyan"
          >
            <Sparkles className="h-3.5 w-3.5" aria-hidden />
            Example: +{PRESET_HOURS} h {PRESET_TOPIC}
          </button>
        ) : null}
      </div>

      {topicsState.error && !topicsState.data ? (
        <ErrorNote
          error={topicsState.error}
          onRetry={() => void topicsState.reload()}
          retrying={topicsState.loading}
          className="mt-3"
          prefix="Could not load topics"
        />
      ) : null}
      {topicsState.data && topics.length === 0 ? (
        <p className="mt-3 rounded-xl bg-slate-50 px-4 py-3 text-sm text-slate-600">
          No topics with completed results in this selection. Load the sample data or pick another batch.
        </p>
      ) : null}

      <ol className="mt-4 space-y-3">
        {rows.map((r, i) => (
          <li key={r.id} className="grid grid-cols-1 gap-3 rounded-xl bg-slate-50/70 p-3 ring-1 ring-inset ring-slate-200 md:grid-cols-[minmax(0,1fr)_minmax(0,18rem)_auto] md:items-end">
            <label className="block min-w-0 text-sm">
              <span className="mb-1 block text-xs font-medium text-slate-700">Topic {i + 1}</span>
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
              <span className="mb-1 block text-xs font-medium text-slate-700" id={`hours-label-${r.id}`}>
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
                <span className="text-xs text-slate-600">h</span>
              </div>
            </div>
            <button
              type="button"
              onClick={() => setRows((prev) => prev.filter((x) => x.id !== r.id))}
              disabled={rows.length === 1}
              className="inline-flex h-9 items-center justify-center gap-1 rounded-lg px-2 text-xs font-medium text-slate-600 hover:bg-white hover:text-rose-700 disabled:opacity-40 focus-visible:outline-2 focus-visible:outline-brand-cyan"
              aria-label={`Remove topic ${i + 1}`}
            >
              <Trash2 className="h-4 w-4" aria-hidden />
              <span className="md:sr-only">Remove</span>
            </button>
          </li>
        ))}
      </ol>

      <div className="mt-4 flex flex-wrap items-center gap-3">
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
            <span className="text-xs text-slate-600">(×{fmt(calibration, 2)})</span>
          ) : (
            <span className="text-xs text-slate-600">(needs &ge; 5 measured interventions)</span>
          )}
        </label>
        <button type="button" className={cn(btnPrimary, "ml-auto")} onClick={() => void run()} disabled={!ready || running}>
          {running ? <Loader2 className="h-4 w-4 animate-spin" aria-hidden /> : <Play className="h-4 w-4" aria-hidden />}
          {running ? "Running…" : "Run"}
        </button>
      </div>

      {runError ? <ErrorNote error={runError} className="mt-4" prefix="Simulation failed" /> : null}
      {result ? <Results result={result} /> : null}
    </Card>
  );
}
