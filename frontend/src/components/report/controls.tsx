"use client";

import {
  BadgeCheck,
  CheckCircle2,
  CircleSlash,
  Cpu,
  Download,
  FileLock2,
  GitCompareArrows,
  History,
  Loader2,
  MessageCircle,
  Scale,
  ShieldQuestion,
  XCircle,
} from "lucide-react";
import { useEffect, useState, type ReactNode } from "react";
import { errorCode, errorMessage, errorStatus, getInvocations, reportPdfUrl, runConsistencyCheck } from "@/lib/api";
import type { ConsistencyCheck, Delivery, ModelInvocation, Result } from "@/lib/types";
import { cn, formatConfidence } from "@/lib/utils";
import { Notice, btnSecondary } from "./dialog";
import { fmtBytes, fmtIST, fmtInr, fmtNumber, fmtSeconds, fraction, shortHash } from "./format";
import { Eyebrow, Pill, SectionCard } from "./primitives";
import { rubricLabel } from "./use-rubric";
import { CopyButton, DeliveryResult } from "./whatsapp-dialog";

function Fact({ label, children }: { label: string; children: ReactNode }) {
  return (
    <div className="min-w-0">
      <dt className="text-xs text-slate-500">{label}</dt>
      <dd className="mt-0.5 break-words text-sm text-slate-800">{children}</dd>
    </div>
  );
}

/** Original-document custody: SHA-256 taken while the upload streamed, size, pages, sniffed type. */
export function DocumentCustodyCard({ result }: { result: Result }) {
  const c = result.custody;
  const isDemo = result.submission.is_demo;
  return (
    <SectionCard id="custody" title="Document custody" description="Fingerprint of the original upload." icon={FileLock2}>
      {c ? (
        <>
          <div className="flex flex-wrap items-center gap-2 rounded-lg bg-slate-50 px-3 py-2 [print-color-adjust:exact]">
            <code className="min-w-0 flex-1 truncate font-mono text-xs text-slate-700" title={c.sha256}>
              sha256 {shortHash(c.sha256, 16, 8)}
            </code>
            <CopyButton text={c.sha256} label="Copy hash" className="print:hidden" />
          </div>
          <dl className="mt-3 grid grid-cols-2 gap-3">
            <Fact label="Size">{fmtBytes(c.size_bytes)}</Fact>
            <Fact label="Pages">{c.page_count ?? "—"}</Fact>
            <Fact label="Type">
              {c.mime_type} <span className="text-xs text-slate-500">(detected by {c.detected_by || "magic bytes"})</span>
            </Fact>
            <Fact label="Integrity">
              {c.verified ? (
                <span className="inline-flex items-center gap-1 font-medium text-lime-700">
                  <CheckCircle2 className="h-4 w-4" aria-hidden /> Verified
                  {c.verified_at ? <span className="font-normal text-slate-500"> {fmtIST(c.verified_at)}</span> : null}
                </span>
              ) : (
                <span className="inline-flex items-center gap-1 font-medium text-amber-700">
                  <ShieldQuestion className="h-4 w-4" aria-hidden /> Not re-verified
                </span>
              )}
            </Fact>
          </dl>
          <p className="mt-3 text-xs text-slate-500">
            File: <span className="font-mono">{result.submission.original_filename}</span>
          </p>
        </>
      ) : (
        <p className="rounded-xl border border-dashed border-slate-200 p-4 text-sm text-slate-500">
          {isDemo
            ? "Synthetic record - no source scan, so there is no file to fingerprint."
            : "No custody hash: this sheet was uploaded before SHA-256 hashing was recorded."}
        </p>
      )}
    </SectionCard>
  );
}

function GateTile({ ok, title, value, text }: { ok: boolean | null; title: string; value: string; text: string }) {
  return (
    <div
      className={cn(
        "rounded-xl border p-3 [print-color-adjust:exact] print:break-inside-avoid",
        ok === true ? "border-lime-300 bg-brand-lime-50" : ok === false ? "border-amber-300 bg-amber-50" : "border-slate-200 bg-slate-50",
      )}
    >
      <p className="text-xs font-semibold uppercase tracking-wider text-slate-600">{title}</p>
      <p className="mt-1 text-xl font-semibold text-brand-navy">{value}</p>
      <p className="mt-0.5 text-xs leading-snug text-slate-600">{text}</p>
    </div>
  );
}

/** "What is established - and what is not": custody, extraction coverage, faculty certification. */
export function ProvenanceGatesCard({ result }: { result: Result }) {
  const { custody, extraction: ex, release, rubric, history } = result;
  const isDemo = result.submission.is_demo;
  const released = release.status === "RELEASED";
  const notEstablished = [
    "Causes of errors are the evaluator's reading, not educator-validated.",
    history.length >= 2
      ? "Different papers are not equated for difficulty, so the dated assessments show no reliable trend."
      : "A single assessment shows no trend.",
    `ROI and score projections are illustrative (${result.roi_basis.forecast_status || "UNAVAILABLE"}: ${result.roi_basis.reason}).`,
    ...(rubric.status === "AUTHOR_DRAFT" ? [`The rubric ${rubricLabel(rubric)} is AUTHOR_DRAFT: the answer key is not faculty-approved.`] : []),
    isDemo
      ? "Synthetic demo record: no scan, no OCR and no AI grading took place."
      : `OCR is vision-LLM transcription by ${ex.ocr_adapter}, not certified OCR.`,
    ...(released ? [] : ["Marks are provisional: no faculty reviewer has released them."]),
  ];
  return (
    <SectionCard
      id="provenance"
      title="What is established - and what is not"
      description="Provenance and quality gates for this report."
      icon={BadgeCheck}
    >
      <div className="grid gap-3 md:grid-cols-3 print:grid-cols-3">
        <GateTile
          ok={custody ? custody.verified : null}
          title="Original document custody"
          value={custody ? (custody.verified ? "Verified" : "Recorded") : "None"}
          text={
            custody
              ? `SHA-256 ${shortHash(custody.sha256, 8, 4)} · ${custody.page_count ?? "?"} page(s) · ${custody.mime_type}.`
              : isDemo
                ? "Synthetic record: no source scan."
                : "Uploaded before hashing was recorded."
          }
        />
        <GateTile
          ok={isDemo ? null : ex.mapped >= ex.total_questions && ex.below_threshold === 0}
          title="Extraction coverage"
          value={`${ex.mapped} / ${ex.total_questions}`}
          text={
            isDemo
              ? "Synthetic answers mapped to rubric questions; no OCR was run."
              : `Mapped to rubric questions; mean OCR ${formatConfidence(ex.mean_confidence)}, ${ex.below_threshold} below ${Math.round(ex.threshold * 100)}%. Mapping is not approval.${ex.corrected_by_faculty ? " Faculty corrected the transcript." : ""}`
          }
        />
        <GateTile
          ok={released}
          title="Faculty certification"
          value={released ? "Released" : "Not approved"}
          text={
            released
              ? `Released by ${release.reviewed_by ?? "faculty"}${release.reviewed_at ? ` on ${fmtIST(release.reviewed_at)}` : ""}.`
              : "Teacher review pending; model-rubric agreement is not certification."
          }
        />
      </div>
      <div className="mt-4">
        <Eyebrow icon={CircleSlash} className="mb-2">
          Not established
        </Eyebrow>
        <ul className="space-y-1.5 text-sm text-slate-700">
          {notEstablished.map((t) => (
            <li key={t} className="flex gap-2">
              <XCircle className="mt-0.5 h-4 w-4 shrink-0 text-slate-400" aria-hidden />
              {t}
            </li>
          ))}
        </ul>
      </div>
    </SectionCard>
  );
}

/** Scoring controls: marking rule, rubric version/hash and the item-sum = total parity check. */
export function ScoringControlsNote({ result }: { result: Result }) {
  const sc = result.scoring_controls;
  const penalty = result.question_evaluations.reduce((sum, q) => sum + Math.max(0, q.penalty || 0), 0);
  return (
    <SectionCard id="scoring-controls" title="Scoring controls" description="How the total was computed." icon={Scale}>
      <dl className="grid gap-3 sm:grid-cols-2">
        <Fact label="Marking rule">
          {sc.marking_rule}
          {penalty > 0 ? (
            <span className="mt-1 block text-xs font-medium text-rose-700">
              {fmtNumber(-penalty)} marks from negative marking (MCQ penalties); the total is net.
            </span>
          ) : null}
        </Fact>
        <Fact label="Rubric">
          {sc.rubric_version || "—"} · {sc.rubric_status}
          {sc.rubric_hash ? (
            <span className="block font-mono text-[11px] text-slate-500" title={sc.rubric_hash}>
              sha256 {shortHash(sc.rubric_hash)}
            </span>
          ) : null}
        </Fact>
        <Fact label="Parity check">
          {sc.parity ? (
            <span className="inline-flex items-center gap-1 font-medium text-lime-700">
              <CheckCircle2 className="h-4 w-4" aria-hidden /> Item sum {fmtNumber(sc.item_sum)} = reported total{" "}
              {fmtNumber(sc.reported_total)}
            </span>
          ) : (
            <span className="inline-flex items-center gap-1 font-medium text-rose-700">
              <XCircle className="h-4 w-4" aria-hidden /> Item sum {fmtNumber(sc.item_sum)} ≠ reported total{" "}
              {fmtNumber(sc.reported_total)}
            </span>
          )}
        </Fact>
        <Fact label="Model total">
          {sc.llm_total_used ? "The model's own total was used" : "Ignored: totals are recomputed server-side from validated item marks"}
        </Fact>
      </dl>
    </SectionCard>
  );
}

type InvState = { kind: "loading" } | { kind: "ready"; rows: ModelInvocation[] } | { kind: "error"; message: string };

/** Per-call model invocations (GET /api/submissions/{id}/invocations) and the pipeline stage durations. */
export function InvocationsCard({ result }: { result: Result }) {
  const id = result.submission.id;
  const isDemo = result.submission.is_demo;
  const [state, setState] = useState<InvState>(() => (isDemo ? { kind: "ready", rows: [] } : { kind: "loading" }));

  useEffect(() => {
    if (isDemo) return;
    let cancelled = false;
    getInvocations(id)
      .then((rows) => {
        if (!cancelled) setState({ kind: "ready", rows: Array.isArray(rows) ? rows : [] });
      })
      .catch((err) => {
        if (cancelled) return;
        setState({
          kind: "error",
          message:
            errorStatus(err) === 404
              ? "The per-call log endpoint is not available on this backend yet."
              : errorMessage(err),
        });
      });
    return () => {
      cancelled = true;
    };
  }, [id, isDemo]);

  const stages = result.latency.stages;
  const maxStage = stages.reduce((m, s) => Math.max(m, s.seconds), 0);
  const cost = result.cost;

  return (
    <SectionCard
      id="invocations"
      title="Model calls and timings"
      description="Every provider call for this sheet: model, request id, tokens (incl. cache), latency and cost."
      icon={Cpu}
      action={
        cost.synthetic || isDemo ? (
          <Pill className="bg-slate-50 text-slate-500 ring-slate-200">Synthetic - no AI call</Pill>
        ) : cost.llm_cost_inr !== null ? (
          <Pill className="bg-slate-50 text-slate-700 ring-slate-200">
            {fmtInr(cost.llm_cost_inr)} · {cost.calls} {cost.calls === 1 ? "call" : "calls"}
          </Pill>
        ) : null
      }
    >
      {result.extraction.ocr_cache_hit ? (
        <Notice tone="ok" className="mb-3">
          OCR cache hit - no vision call (Rs 0.00)
        </Notice>
      ) : null}

      {state.kind === "loading" ? (
        <p className="flex items-center gap-2 text-sm text-slate-500">
          <Loader2 className="h-4 w-4 animate-spin" aria-hidden /> Loading the call log…
        </p>
      ) : state.kind === "error" ? (
        <Notice tone="info">{state.message}</Notice>
      ) : state.rows.length === 0 ? (
        <p className="rounded-xl border border-dashed border-slate-200 p-4 text-sm text-slate-500">
          {isDemo ? "Synthetic record - no model was called." : "No model calls were recorded for this sheet."}
        </p>
      ) : (
        <div className="relative overflow-x-auto print:overflow-visible">
          <table className="w-full min-w-[50rem] print:min-w-0 border-collapse text-xs">
            <caption className="sr-only">Model invocations</caption>
            <thead>
              <tr className="bg-brand-navy text-left text-white [print-color-adjust:exact]">
                <th scope="col" className="px-2 py-2 font-semibold">Purpose</th>
                <th scope="col" className="px-2 py-2 font-semibold">Model</th>
                <th scope="col" className="px-2 py-2 font-semibold">Request id</th>
                <th scope="col" className="px-2 py-2 text-right font-semibold">In / out tokens</th>
                <th scope="col" className="px-2 py-2 text-right font-semibold">Cache read / write</th>
                <th scope="col" className="px-2 py-2 text-right font-semibold">Latency</th>
                <th scope="col" className="px-2 py-2 font-semibold">Status</th>
                <th scope="col" className="px-2 py-2 text-right font-semibold">Rs</th>
              </tr>
            </thead>
            <tbody>
              {state.rows.map((r) => (
                <tr key={r.id} className="border-b border-slate-100 even:bg-slate-50">
                  <td className="px-2 py-1.5 font-medium text-slate-800">
                    {r.purpose}
                    {r.image_count ? <span className="text-slate-400"> · {r.image_count} img</span> : null}
                  </td>
                  <td className="px-2 py-1.5 font-mono">
                    {r.model_served ?? r.model_requested}
                    {r.fell_back ? <span className="ml-1 text-amber-700">(fallback)</span> : null}
                  </td>
                  <td className="max-w-[9rem] truncate px-2 py-1.5 font-mono text-slate-500" title={r.request_id ?? undefined}>
                    {r.request_id ?? "—"}
                  </td>
                  <td className="px-2 py-1.5 text-right tabular-nums">
                    {r.input_tokens.toLocaleString()} / {r.output_tokens.toLocaleString()}
                  </td>
                  <td className="px-2 py-1.5 text-right tabular-nums">
                    {r.cache_read_input_tokens.toLocaleString()} / {r.cache_creation_input_tokens.toLocaleString()}
                  </td>
                  <td className="px-2 py-1.5 text-right tabular-nums">{fmtSeconds(r.latency_ms / 1000)}</td>
                  <td className="px-2 py-1.5">
                    <span
                      className={cn(
                        "rounded px-1.5 py-0.5 font-medium",
                        r.status === "ok" || r.status === "cache_hit" ? "bg-brand-lime-50 text-lime-800" : "bg-rose-50 text-rose-700",
                      )}
                    >
                      {r.status === "cache_hit" ? "cache hit (Rs 0.00)" : r.status}
                    </span>
                    {r.error_code ? <span className="ml-1 text-rose-700">{r.error_code}</span> : null}
                  </td>
                  <td className="px-2 py-1.5 text-right tabular-nums">{r.cost_inr === null ? "—" : r.cost_inr.toFixed(2)}</td>
                </tr>
              ))}
            </tbody>
          </table>
          <p className="mt-1.5 text-[11px] text-slate-500">
            Cost uses the configured per-model prices at USD/INR {fmtNumber(cost.usd_inr)}. No prompt or answer text is
            stored in this log.
          </p>
        </div>
      )}

      <div className="mt-5">
        <Eyebrow className="mb-2">Stage durations</Eyebrow>
        {stages.length === 0 ? (
          <p className="text-sm text-slate-500">No stage timings were recorded.</p>
        ) : (
          <ul className="space-y-1.5">
            {stages.map((s, i) => (
              <li key={`${s.step}-${i}`} className="grid grid-cols-[8rem_1fr_4rem] items-center gap-2 text-xs sm:grid-cols-[11rem_1fr_4.5rem]">
                <span className="truncate text-slate-700">{s.step}</span>
                <span className="h-2 rounded-full bg-slate-100 [print-color-adjust:exact]">
                  <span
                    className="block h-full rounded-full bg-brand-cyan"
                    style={{ width: `${maxStage > 0 ? Math.max(2, (s.seconds / maxStage) * 100) : 0}%` }}
                  />
                </span>
                <span className="text-right tabular-nums text-slate-600">{fmtSeconds(s.seconds)}</span>
              </li>
            ))}
          </ul>
        )}
        <p className="mt-1.5 text-xs text-slate-500">
          End to end {fmtSeconds(result.latency.seconds)} against the {fmtSeconds(result.latency.target_seconds)} target
          {isDemo ? " (synthetic timestamps)" : ""}.
        </p>
      </div>
    </SectionCard>
  );
}

type CheckState =
  | { kind: "idle" }
  | { kind: "running" }
  | { kind: "done"; check: ConsistencyCheck }
  | { kind: "error"; message: string };

/** FR-3.5 re-grade consistency check: grade once more and compare with the stored marks. */
export function ConsistencyCheckCard({ result }: { result: Result }) {
  const [state, setState] = useState<CheckState>({ kind: "idle" });
  const isDemo = result.submission.is_demo;

  async function run() {
    setState({ kind: "running" });
    try {
      const check = await runConsistencyCheck(result.submission.id);
      setState({ kind: "done", check });
    } catch (err) {
      const code = errorCode(err);
      const status = errorStatus(err);
      setState({
        kind: "error",
        message:
          code === "ai_not_configured" || status === 503
            ? "The re-grade needs a live Claude call, but AI is not configured on the server (ai_not_configured). Add the API key to .env to enable it."
            : status === 404
              ? "The consistency-check endpoint is not available on this backend yet."
              : errorMessage(err),
      });
    }
  }

  const check = state.kind === "done" ? state.check : null;
  return (
    <SectionCard
      id="consistency"
      title="Re-grade consistency check"
      description="Grades the stored transcript once more and compares the totals (tolerance ±2 marks)."
      icon={GitCompareArrows}
    >
      <div className="flex flex-wrap items-center gap-3 print:hidden">
        <button type="button" className={btnSecondary} onClick={run} disabled={state.kind === "running"}>
          {state.kind === "running" ? <Loader2 className="h-4 w-4 animate-spin" aria-hidden /> : <GitCompareArrows className="h-4 w-4" aria-hidden />}
          {state.kind === "running" ? "Re-grading…" : "Run consistency check"}
        </button>
        <span className="text-xs text-slate-500">
          {isDemo ? "Demo rows have no AI transcript to re-grade." : "Makes one live grading call (counted in the cost log)."}
        </span>
      </div>
      {state.kind === "error" ? <Notice tone="warn" className="mt-3">{state.message}</Notice> : null}
      {check ? (
        <div className="mt-3 space-y-3">
          <Notice tone={check.within_tolerance ? "ok" : "warn"}>
            Re-grade Δ{fmtNumber(check.max_abs_delta_total)} marks - {check.within_tolerance ? "within" : "outside"} ±
            {fmtNumber(check.tolerance)} ({fmtNumber(check.total_original)} → {fmtNumber(check.total_regrade)}, checked{" "}
            {fmtIST(check.checked_at)})
          </Notice>
          {check.deltas.length ? (
            <div className="relative overflow-x-auto print:overflow-visible">
              <table className="w-full min-w-[24rem] print:min-w-0 border-collapse text-xs">
                <thead>
                  <tr className="bg-slate-100 text-left text-slate-600">
                    <th className="px-2 py-1.5">Question</th>
                    <th className="px-2 py-1.5 text-right">Original</th>
                    <th className="px-2 py-1.5 text-right">Re-grade</th>
                    <th className="px-2 py-1.5 text-right">Δ</th>
                  </tr>
                </thead>
                <tbody>
                  {check.deltas.map((d) => (
                    <tr key={d.question} className="border-b border-slate-100">
                      <td className="px-2 py-1.5 font-mono">Q{d.question}</td>
                      <td className="px-2 py-1.5 text-right tabular-nums">{fmtNumber(d.original)}</td>
                      <td className="px-2 py-1.5 text-right tabular-nums">{fmtNumber(d.regrade)}</td>
                      <td className={cn("px-2 py-1.5 text-right tabular-nums", d.delta !== 0 && "font-semibold text-amber-700")}>
                        {d.delta > 0 ? "+" : ""}
                        {fmtNumber(d.delta)}
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          ) : null}
        </div>
      ) : null}
    </SectionCard>
  );
}

/** Evaluation versions (FR-5.7): archived results after a rubric re-run, each with its own PDF. */
export function VersionHistoryCard({ result }: { result: Result }) {
  const id = result.submission.id;
  const versions = [...result.versions].sort((a, b) => b.version - a.version);
  const superseded = versions.filter((v) => !v.current);
  return (
    <SectionCard id="versions" title="Version history" description="Each rubric re-run archives the previous result." icon={History}>
      {superseded.length ? (
        <Notice tone="warn" className="mb-3">
          Superseded: {superseded.length} earlier {superseded.length === 1 ? "version is" : "versions are"} archived. This page
          shows the current version; older PDFs are marked superseded.
        </Notice>
      ) : null}
      {versions.length === 0 ? (
        <p className="text-sm text-slate-500">Only the current evaluation exists (version 1).</p>
      ) : (
        <ul className="divide-y divide-slate-100">
          {versions.map((v) => (
            <li key={v.version} className="flex flex-wrap items-center gap-x-3 gap-y-1 py-2 text-sm">
              <span className="font-mono text-xs font-semibold text-slate-700">v{v.version}</span>
              <span className="text-slate-700">
                Rubric {v.rubric_version || `#${v.rubric_id}`} · {fraction(v.total_score, v.total_marks)}
              </span>
              <span className="text-xs text-slate-500">{fmtIST(v.created_at)}</span>
              {v.current ? (
                <Pill className="bg-brand-cyan-50 text-cyan-800 ring-brand-cyan/30">Current</Pill>
              ) : (
                <Pill className="bg-amber-50 text-amber-800 ring-amber-200">
                  Superseded{v.superseded_at ? ` ${fmtIST(v.superseded_at)}` : ""}
                </Pill>
              )}
              <a
                href={reportPdfUrl(id, v.current ? undefined : v.version)}
                className="ml-auto inline-flex items-center gap-1 text-xs font-medium text-brand-cyan-600 hover:text-brand-navy print:hidden"
              >
                <Download className="h-3.5 w-3.5" aria-hidden />
                PDF
              </a>
            </li>
          ))}
        </ul>
      )}
    </SectionCard>
  );
}

/** Simulated delivery history (never "sent"). */
export function DeliveriesCard({ deliveries }: { deliveries: Delivery[] }) {
  const rows = [...deliveries].sort((a, b) => Date.parse(b.created_at) - Date.parse(a.created_at));
  return (
    <SectionCard
      id="deliveries"
      title="Delivery history"
      description="Simulated WhatsApp channel - Gupshup/Twilio integration out of PoC scope."
      icon={MessageCircle}
    >
      {rows.length === 0 ? (
        <p className="text-sm text-slate-500">No delivery has been simulated for this report.</p>
      ) : (
        <ul className="space-y-2">
          {rows.map((d) => (
            <li key={d.id}>
              <p className="mb-1 text-xs text-slate-500">{fmtIST(d.created_at)} · {d.channel}</p>
              <DeliveryResult delivery={d} />
            </li>
          ))}
        </ul>
      )}
    </SectionCard>
  );
}
