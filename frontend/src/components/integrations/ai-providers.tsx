"use client";

import Link from "next/link";
import { useCallback, useState } from "react";
import { AlertTriangle, ArrowRight, CheckCircle2, Cpu, Loader2, Play, XCircle } from "lucide-react";
import { Card, CardHeader } from "@/components/cohort/card";
import { btnPrimary } from "@/components/cohort/dialog";
import { fmtDateTime, inr } from "@/components/owner/format";
import { CardSkeleton, ErrorNote } from "@/components/owner/states";
import { useAsync } from "@/components/owner/use-async";
import { getLlmChain, runLlmDrill } from "@/lib/api";
import type { LlmDrillResult, LlmRoute, ModelInvocation } from "@/lib/types";
import { cn } from "@/lib/utils";

/** "anthropic" + "claude-sonnet-5-5" -> "Claude"; "openai" + "gpt-4o" -> "GPT-4o". */
function providerLabel(provider: string | null, model: string | null): string {
  const p = (provider ?? "").toLowerCase();
  const m = model ?? "";
  if (p.includes("anthropic") || /^claude/i.test(m)) return "Claude";
  if (/^gpt-4o/i.test(m)) return `GPT-4o${m.length > 6 ? ` (${m})` : ""}`;
  if (p.includes("openai")) return m || "OpenAI";
  if (p.includes("gemini") || p.includes("google")) return "Gemini";
  return m || provider || "unknown";
}

/** Route chip, e.g. "Claude -> GPT-4o (simulated_outage)". */
export function RouteChip({ route }: { route: LlmRoute }) {
  const primary = providerLabel(route.primary_provider, route.primary_model);
  const served = route.served_provider ? providerLabel(route.served_provider, route.served_model) : "no answer";
  return (
    <span
      className={cn(
        "inline-flex flex-wrap items-center gap-1.5 rounded-full px-3 py-1 text-sm font-semibold ring-1 ring-inset",
        route.fell_back ? "bg-amber-50 text-amber-900 ring-amber-300" : "bg-brand-lime-50 text-lime-800 ring-brand-lime/40",
      )}
      title={`${route.attempts} attempt(s)${route.cross_vendor ? " · cross-vendor fallback (not residency-approved)" : ""}`}
    >
      {primary}
      {route.fell_back ? (
        <>
          <ArrowRight className="h-3.5 w-3.5" aria-label="fell back to" />
          {served}
          {route.reason ? <span className="font-normal">({route.reason})</span> : null}
        </>
      ) : (
        <span className="font-normal">(served directly)</span>
      )}
    </span>
  );
}

function CallsTable({ calls }: { calls: ModelInvocation[] }) {
  if (!calls.length) return null;
  return (
    <div className="relative overflow-x-auto rounded-xl ring-1 ring-slate-200">
      <table className="w-full min-w-[720px] border-collapse text-sm">
        <caption className="sr-only">Provider calls made by the drill</caption>
        <thead className="bg-slate-50">
          <tr className="text-left text-xs font-semibold uppercase tracking-wide text-slate-600">
            <th scope="col" className="px-3 py-2">Provider</th>
            <th scope="col" className="px-3 py-2">Model</th>
            <th scope="col" className="px-3 py-2">Status</th>
            <th scope="col" className="px-3 py-2">Error code</th>
            <th scope="col" className="px-3 py-2 text-right">Latency</th>
            <th scope="col" className="px-3 py-2 text-right">Tokens in / out</th>
            <th scope="col" className="px-3 py-2 text-right">Cost</th>
          </tr>
        </thead>
        <tbody className="divide-y divide-slate-100">
          {calls.map((c) => (
            <tr key={c.id}>
              <td className="px-3 py-1.5 text-slate-800">{c.provider}</td>
              <td className="px-3 py-1.5 font-mono text-xs text-slate-700">{c.model_served ?? c.model_requested}</td>
              <td className="px-3 py-1.5">
                <span className={cn("inline-flex items-center gap-1 text-xs font-medium", c.status === "ok" || c.status === "cache_hit" ? "text-lime-800" : "text-rose-700")}>
                  {c.status === "ok" || c.status === "cache_hit" ? (
                    <CheckCircle2 className="h-3.5 w-3.5" aria-hidden />
                  ) : (
                    <XCircle className="h-3.5 w-3.5" aria-hidden />
                  )}
                  {c.status}
                </span>
              </td>
              <td className="px-3 py-1.5 font-mono text-xs text-slate-700">{c.error_code ?? "—"}</td>
              <td className="px-3 py-1.5 text-right tabular-nums text-slate-700">{c.latency_ms} ms</td>
              <td className="px-3 py-1.5 text-right tabular-nums text-slate-700">
                {c.input_tokens} / {c.output_tokens}
              </td>
              <td className="px-3 py-1.5 text-right tabular-nums text-slate-700">{c.cost_inr === null ? "unknown" : inr(c.cost_inr, 3)}</td>
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}

function Drill({ onDone }: { onDone: () => void }) {
  const [simulate, setSimulate] = useState(true);
  const [running, setRunning] = useState(false);
  const [result, setResult] = useState<LlmDrillResult | null>(null);
  const [error, setError] = useState<unknown>(null);

  async function run() {
    setRunning(true);
    setError(null);
    setResult(null);
    try {
      setResult(await runLlmDrill({ simulate_outage: simulate }));
      onDone();
    } catch (err) {
      setError(err);
    } finally {
      setRunning(false);
    }
  }

  return (
    <div className="rounded-xl bg-slate-50 p-4 ring-1 ring-inset ring-slate-200">
      <h3 className="text-sm font-semibold text-brand-navy">Fallback drill</h3>
      <p className="mt-0.5 text-xs text-slate-600">
        Grades one built-in sample answer through the chain. Makes real provider calls (about Rs 0.5).
      </p>
      <div className="mt-3 flex flex-wrap items-center gap-3">
        <label className="inline-flex items-center gap-2 text-sm text-slate-800">
          <input
            type="checkbox"
            checked={simulate}
            onChange={(e) => setSimulate(e.target.checked)}
            className="h-4 w-4 accent-brand-cyan"
          />
          Simulate Claude outage
        </label>
        <button type="button" className={btnPrimary} onClick={() => void run()} disabled={running}>
          {running ? <Loader2 className="h-4 w-4 animate-spin" aria-hidden /> : <Play className="h-4 w-4" aria-hidden />}
          {running ? "Running drill…" : "Run fallback drill"}
        </button>
      </div>
      <div className="mt-3 space-y-3" aria-live="polite">
        {error ? <ErrorNote error={error} prefix="Drill failed" /> : null}
        {result ? (
          <>
            <div className="flex flex-wrap items-center gap-2">
              <RouteChip route={result.route} />
              <span className={cn("inline-flex items-center gap-1 text-sm font-medium", result.ok ? "text-lime-800" : "text-rose-700")}>
                {result.ok ? <CheckCircle2 className="h-4 w-4" aria-hidden /> : <XCircle className="h-4 w-4" aria-hidden />}
                {result.ok ? "Answer graded" : "No answer"}
              </span>
              <span className="text-xs text-slate-600">
                {result.sample_marks === null ? "—" : result.sample_marks} / {result.sample_max_marks} marks ·{" "}
                {(result.latency_ms / 1000).toFixed(1)} s total
              </span>
            </div>
            <p className="text-sm text-slate-800">{result.message}</p>
            <CallsTable calls={result.calls ?? []} />
          </>
        ) : null}
      </div>
    </div>
  );
}

/** AI provider chain (FR-3.10): providers, fallback switches, trigger codes, drill and recent fallbacks. */
export function AiProvidersCard() {
  const fetcher = useCallback(() => getLlmChain(), []);
  const { data, error, loading, reload } = useAsync(fetcher);

  if (!data && loading) return <CardSkeleton rows={4} label="Loading the AI provider chain…" />;

  return (
    <Card aria-labelledby="ai-chain-title">
      <CardHeader
        id="ai-chain-title"
        icon={Cpu}
        title="AI providers & fallback"
        subtitle="Claude is primary. When it fails with a trigger code, OCR / grading / voice mapping retry on the fallback model."
      />
      {error ? <ErrorNote error={error} onRetry={() => void reload()} retrying={loading} className="mt-4" /> : null}
      {data ? (
        <div className="mt-4 space-y-4">
          <div className="relative -mx-5 overflow-x-auto sm:-mx-6">
            <table className="w-full min-w-[880px] border-collapse text-sm">
              <caption className="sr-only">AI providers</caption>
              <thead className="border-y border-slate-200 bg-slate-50">
                <tr className="text-left text-xs font-semibold uppercase tracking-wide text-slate-600">
                  <th scope="col" className="px-3 py-2 pl-5 sm:pl-6">Role</th>
                  <th scope="col" className="px-3 py-2">Provider · model</th>
                  <th scope="col" className="px-3 py-2">Configured</th>
                  <th scope="col" className="px-3 py-2">Stages</th>
                  <th scope="col" className="px-3 py-2 pr-5 sm:pr-6">Notes</th>
                </tr>
              </thead>
              <tbody className="divide-y divide-slate-100">
                {data.providers.map((p) => (
                  <tr key={`${p.role}-${p.provider}-${p.model}`} className="align-top">
                    <td className="px-3 py-2 pl-5 font-semibold capitalize text-brand-navy sm:pl-6">{p.role}</td>
                    <td className="px-3 py-2">
                      <span className="text-slate-800">{p.provider}</span>
                      <span className="block font-mono text-xs text-slate-700">{p.model}</span>
                    </td>
                    <td className="px-3 py-2">
                      {p.configured ? (
                        <span className="inline-flex items-center gap-1 text-xs font-medium text-lime-800">
                          <CheckCircle2 className="h-3.5 w-3.5" aria-hidden /> Configured
                        </span>
                      ) : (
                        <span className="inline-flex items-center gap-1 text-xs font-medium text-slate-600">
                          <XCircle className="h-3.5 w-3.5" aria-hidden /> Not configured
                        </span>
                      )}
                    </td>
                    <td className="px-3 py-2 text-xs text-slate-700">{p.stages.length ? p.stages.join(", ") : "—"}</td>
                    <td className="px-3 py-2 pr-5 text-xs sm:pr-6">
                      {p.deprecation ? (
                        <p className="mb-1 flex items-start gap-1 rounded-lg bg-amber-50 px-2 py-1 font-medium text-amber-900 ring-1 ring-inset ring-amber-300">
                          <AlertTriangle className="mt-0.5 h-3.5 w-3.5 shrink-0" aria-hidden />
                          {p.deprecation}
                        </p>
                      ) : null}
                      <p className="text-slate-700">{p.residency_note}</p>
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>

          <dl className="grid grid-cols-1 gap-2 text-sm sm:grid-cols-3">
            <div className="rounded-xl px-3 py-2 ring-1 ring-inset ring-slate-200">
              <dt className="text-xs text-slate-600">Fallback (LLM_FALLBACK)</dt>
              <dd className={cn("inline-flex items-center gap-1 font-semibold", data.fallback_enabled ? "text-lime-800" : "text-slate-700")}>
                {data.fallback_enabled ? <CheckCircle2 className="h-4 w-4" aria-hidden /> : <XCircle className="h-4 w-4" aria-hidden />}
                {data.fallback_enabled ? "Enabled" : "Disabled"}
              </dd>
            </div>
            <div className="rounded-xl px-3 py-2 ring-1 ring-inset ring-slate-200">
              <dt className="text-xs text-slate-600">Simulated outage (LLM_SIMULATE_PRIMARY_OUTAGE, read-only)</dt>
              <dd className={cn("font-semibold", data.simulate_outage ? "text-amber-800" : "text-slate-700")}>
                {data.simulate_outage ? "On - every Claude call is skipped" : "Off"}
              </dd>
            </div>
            <div className="rounded-xl px-3 py-2 ring-1 ring-inset ring-slate-200">
              <dt className="text-xs text-slate-600">Trigger codes</dt>
              <dd className="mt-1 flex flex-wrap gap-1">
                {data.trigger_codes.length
                  ? data.trigger_codes.map((c) => (
                      <code key={c} className="rounded bg-slate-100 px-1.5 py-0.5 font-mono text-[11px] text-slate-800">
                        {c}
                      </code>
                    ))
                  : "—"}
              </dd>
            </div>
          </dl>
          {data.note ? <p className="text-xs text-slate-600">{data.note}</p> : null}

          <Drill onDone={() => void reload()} />

          <div>
            <h3 className="text-sm font-semibold text-brand-navy">Recent fallbacks</h3>
            {data.recent_fallbacks.length === 0 ? (
              <p className="mt-1 text-sm text-slate-600">No call has fallen back yet.</p>
            ) : (
              <ul className="mt-2 divide-y divide-slate-100 rounded-xl ring-1 ring-slate-200">
                {data.recent_fallbacks.map((c) => (
                  <li key={c.id} className="flex flex-wrap items-center gap-x-3 gap-y-1 px-3 py-2 text-sm">
                    <span className="whitespace-nowrap text-xs text-slate-600">{fmtDateTime(c.created_at)}</span>
                    <span className="font-medium text-slate-800">{c.purpose}</span>
                    <span className="font-mono text-xs text-slate-700">
                      {c.provider} · {c.model_served ?? c.model_requested}
                    </span>
                    {c.error_code ? <code className="font-mono text-xs text-rose-700">{c.error_code}</code> : null}
                    {c.submission_id ? (
                      <Link href={`/report/${c.submission_id}`} className="text-xs font-medium text-brand-navy hover:underline">
                        Submission #{c.submission_id}
                      </Link>
                    ) : null}
                  </li>
                ))}
              </ul>
            )}
          </div>
        </div>
      ) : null}
    </Card>
  );
}
