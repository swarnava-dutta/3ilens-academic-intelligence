"use client";

import { useCallback } from "react";
import { BookOpenCheck, CircleCheck, CircleSlash, ExternalLink, Info } from "lucide-react";
import { Card, CardHeader } from "@/components/cohort/card";
import { CardSkeleton, ErrorNote } from "@/components/owner/states";
import { useAsync } from "@/components/owner/use-async";
import { API_BASE_URL, getLmsInfo, lmsUrl } from "@/lib/api";
import type { LmsEndpoint } from "@/lib/types";
import { cn } from "@/lib/utils";
import { CopyButton } from "./copy-button";

/** Endpoints whose rows are results (they accept include_provisional). */
function takesResultFilters(path: string): boolean {
  return /results|topic-mastery/.test(path);
}

/** curl example for an endpoint, e.g. curl -H "X-API-Key: $KEY" "<url>" -o results.csv */
export function curlFor(endpoint: LmsEndpoint, headerName: string): string {
  const url = lmsUrl(endpoint.path, takesResultFilters(endpoint.path) ? { include_provisional: true } : undefined);
  const file = endpoint.path.split("/").pop() || "export";
  const isCsv = /csv/i.test(endpoint.format) || file.endsWith(".csv");
  return `curl -H "${headerName}: $KEY" "${url}"${isCsv ? ` -o ${file}` : ""}`;
}

/** LMS export overview (FR-5.10): on/off state, header, docs link and the endpoint list with curl examples. */
export function LmsCard() {
  const fetcher = useCallback(() => getLmsInfo(), []);
  const { data, error, loading, reload } = useAsync(fetcher);

  if (!data && loading) return <CardSkeleton rows={4} label="Loading LMS export settings…" />;

  const docsHref = data ? `${API_BASE_URL.replace(/\/+$/, "")}${data.docs_path}` : null;
  const header = data?.header_name || "X-API-Key";

  return (
    <Card aria-labelledby="lms-title">
      <CardHeader
        id="lms-title"
        icon={BookOpenCheck}
        title="LMS export API"
        subtitle="Read-only JSON / CSV export of results for an LMS or school ERP, authenticated with an API key."
        action={
          data ? (
            data.enabled ? (
              <span className="inline-flex items-center gap-1.5 rounded-full bg-brand-lime-50 px-2.5 py-1 text-xs font-semibold text-lime-800 ring-1 ring-inset ring-brand-lime/40">
                <CircleCheck className="h-3.5 w-3.5" aria-hidden /> Enabled
              </span>
            ) : (
              <span className="inline-flex items-center gap-1.5 rounded-full bg-slate-100 px-2.5 py-1 text-xs font-semibold text-slate-700 ring-1 ring-inset ring-slate-300">
                <CircleSlash className="h-3.5 w-3.5" aria-hidden /> Disabled
              </span>
            )
          ) : null
        }
      />
      {error ? <ErrorNote error={error} onRetry={() => void reload()} retrying={loading} className="mt-4" /> : null}
      {data ? (
        <div className="mt-4 space-y-4">
          {!data.enabled ? (
            <p className="rounded-xl bg-amber-50 px-4 py-3 text-sm text-amber-900 ring-1 ring-inset ring-amber-200">
              LMS export is switched off (<code className="font-mono break-all">LMS_API=0</code> in .env). Every{" "}
              <code className="font-mono break-all">/api/lms/v1/*</code> call answers 503 <code className="font-mono break-all">lms_disabled</code>{" "}
              until you set <code className="font-mono break-all">LMS_API=1</code> and restart the API. Keys can still be managed.
            </p>
          ) : null}
          <dl className="grid grid-cols-1 gap-2 text-sm sm:grid-cols-3">
            <div className="rounded-xl px-3 py-2 ring-1 ring-inset ring-slate-200">
              <dt className="text-xs text-slate-600">Header</dt>
              <dd className="font-mono text-slate-800">{header}: &lt;key&gt;</dd>
            </div>
            <div className="rounded-xl px-3 py-2 ring-1 ring-inset ring-slate-200">
              <dt className="text-xs text-slate-600">Active keys</dt>
              <dd className="text-slate-800">
                {data.active_keys} created here
                {data.env_key_configured ? " + 1 from LMS_API_KEY in .env" : ""}
              </dd>
            </div>
            <div className="rounded-xl px-3 py-2 ring-1 ring-inset ring-slate-200">
              <dt className="text-xs text-slate-600">Docs</dt>
              <dd>
                {docsHref ? (
                  <a
                    href={docsHref}
                    target="_blank"
                    rel="noreferrer"
                    className="inline-flex items-center gap-1 font-medium text-brand-navy underline-offset-2 hover:underline"
                  >
                    Open API docs - Authorize with your key
                    <ExternalLink className="h-3.5 w-3.5" aria-hidden />
                  </a>
                ) : (
                  "—"
                )}
              </dd>
            </div>
          </dl>

          <p className="flex items-start gap-2 text-sm text-slate-700">
            <Info className="mt-0.5 h-4 w-4 shrink-0 text-brand-cyan-600" aria-hidden />
            <span className="min-w-0">
              Released results only by default; add <code className="font-mono text-xs break-all">include_provisional=true</code>{" "}
              for provisional ones. Sample (demo) rows are included unless{" "}
              <code className="font-mono text-xs break-all">include_demo=false</code>.
            </span>
          </p>

          <div className="relative -mx-5 overflow-x-auto sm:-mx-6">
            <table className="w-full min-w-[1000px] border-collapse text-sm">
              <caption className="sr-only">LMS export endpoints</caption>
              <thead className="border-y border-slate-200 bg-slate-50">
                <tr className="text-left text-xs font-semibold uppercase tracking-wide text-slate-600">
                  <th scope="col" className="px-3 py-2 pl-5 sm:pl-6">Method</th>
                  <th scope="col" className="px-3 py-2">Path</th>
                  <th scope="col" className="px-3 py-2">Format</th>
                  <th scope="col" className="px-3 py-2">Description</th>
                  <th scope="col" className="px-3 py-2 pr-5 sm:pr-6">curl</th>
                </tr>
              </thead>
              <tbody className="divide-y divide-slate-100">
                {data.endpoints.map((e) => {
                  const curl = curlFor(e, header);
                  return (
                    <tr key={`${e.method}-${e.path}`} className="align-top">
                      <td className="px-3 py-2 pl-5 font-mono text-xs font-semibold text-brand-navy sm:pl-6">{e.method}</td>
                      <td className="px-3 py-2 font-mono text-xs text-slate-800">{e.path}</td>
                      <td className="px-3 py-2 text-slate-700">{e.format}</td>
                      <td className="px-3 py-2 text-slate-700">{e.description}</td>
                      <td className="px-3 py-2 pr-5 sm:pr-6">
                        <div className="flex items-start gap-2">
                          <code className={cn("block w-[22rem] max-w-md min-w-0 break-all rounded-lg bg-slate-900 px-2 py-1.5 font-mono text-[11px] leading-relaxed text-slate-100")}>
                            {curl}
                          </code>
                          <CopyButton text={curl} />
                        </div>
                      </td>
                    </tr>
                  );
                })}
              </tbody>
            </table>
          </div>
          <p className="text-xs text-slate-600">
            Replace <code className="font-mono break-all">$KEY</code> with a key from the list below (set it as an environment
            variable, never paste it into a shared document).
          </p>
        </div>
      ) : null}
    </Card>
  );
}
