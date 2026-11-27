"use client";

import { useCallback } from "react";
import { ExternalLink } from "lucide-react";
import { CardSkeleton, ErrorNote, focusRing, Panel, tagCls, theadCls, thCls } from "@/components/owner/states";
import { API_BASE_URL, getLmsInfo, lmsUrl } from "@/lib/api";
import type { LmsEndpoint } from "@/lib/types";
import { useAsync } from "@/lib/use-async";
import { cn } from "@/lib/utils";
import { CopyButton } from "./copy-button";

/** Endpoints whose rows are results (they accept include_provisional). */
function takesResultFilters(path: string): boolean {
  return /results|topic-mastery/.test(path);
}

/** curl example for an endpoint, e.g. curl -H "X-API-Key: $KEY" "<url>" -o results.csv */
function curlFor(endpoint: LmsEndpoint, headerName: string): string {
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
    <Panel
      id="lms-title"
      title="LMS export API"
      subtitle="Read-only JSON / CSV export of results for an LMS or school ERP, authenticated with an API key."
      action={
        data ? (
          data.enabled ? (
            <span className={cn(tagCls, "bg-brand-lime-50 text-lime-800")}>Enabled</span>
          ) : (
            <span className={cn(tagCls, "bg-slate-100 text-slate-700")}>Disabled</span>
          )
        ) : null
      }
    >
      {error ? <ErrorNote error={error} onRetry={() => void reload()} retrying={loading} /> : null}
      {data ? (
        <div className="space-y-4">
          {!data.enabled ? (
            <p className="rounded-md border border-amber-200 bg-amber-50 px-3 py-2 text-sm text-amber-900">
              LMS export is switched off (<code className="font-mono break-all">LMS_API=0</code> in .env). Every{" "}
              <code className="font-mono break-all">/api/lms/v1/*</code> call answers 503 <code className="font-mono break-all">lms_disabled</code>{" "}
              until you set <code className="font-mono break-all">LMS_API=1</code> and restart the API. Keys can still be managed.
            </p>
          ) : null}
          <dl className="grid grid-cols-1 gap-x-6 text-sm sm:grid-cols-[10rem_minmax(0,1fr)]">
            <dt className="pt-2 text-[13px] text-slate-500 sm:border-b sm:border-slate-200 sm:pb-2">Header</dt>
            <dd className="border-b border-slate-200 pb-2 font-mono text-slate-800 sm:pt-2">{header}: &lt;key&gt;</dd>
            <dt className="pt-2 text-[13px] text-slate-500 sm:border-b sm:border-slate-200 sm:pb-2">Active keys</dt>
            <dd className="border-b border-slate-200 pb-2 tabular-nums text-slate-800 sm:pt-2">
                {data.active_keys} created here
                {data.env_key_configured ? " + 1 from LMS_API_KEY in .env" : ""}
            </dd>
            <dt className="pt-2 text-[13px] text-slate-500 sm:border-b sm:border-slate-200 sm:pb-2">Docs</dt>
            <dd className="border-b border-slate-200 pb-2 sm:pt-2">
              {docsHref ? (
                <a
                  href={docsHref}
                  target="_blank"
                  rel="noreferrer"
                  className={cn("inline-flex items-center gap-1 text-brand-cyan-600 underline-offset-2 hover:underline", focusRing)}
                >
                  Open API docs (Authorize with your key)
                  <ExternalLink className="h-3.5 w-3.5" aria-hidden />
                </a>
              ) : (
                "—"
              )}
            </dd>
            <dt className="pt-2 text-[13px] text-slate-500">Filters</dt>
            <dd className="pt-2 text-slate-700 sm:pb-0">
              Released results only by default; add <code className="font-mono text-xs break-all">include_provisional=true</code>{" "}
              for provisional ones. Sample (demo) rows are included unless{" "}
              <code className="font-mono text-xs break-all">include_demo=false</code>.
            </dd>
          </dl>

          <div className="relative -mx-4 overflow-x-auto border-t border-slate-200 sm:-mx-5">
            <table className="w-full min-w-[1000px] border-collapse text-sm">
              <caption className="sr-only">LMS export endpoints</caption>
              <thead className={theadCls}>
                <tr>
                  <th scope="col" className={cn(thCls, "pl-4 sm:pl-5")}>Method</th>
                  <th scope="col" className={thCls}>Path</th>
                  <th scope="col" className={thCls}>Format</th>
                  <th scope="col" className={thCls}>Description</th>
                  <th scope="col" className={cn(thCls, "pr-4 sm:pr-5")}>curl</th>
                </tr>
              </thead>
              <tbody className="divide-y divide-slate-200">
                {data.endpoints.map((e) => {
                  const curl = curlFor(e, header);
                  return (
                    <tr key={`${e.method}-${e.path}`} className="align-top">
                      <td className="px-3 py-2 pl-4 font-mono text-xs font-medium text-slate-900 sm:pl-5">{e.method}</td>
                      <td className="px-3 py-2 font-mono text-xs text-slate-800">{e.path}</td>
                      <td className="px-3 py-2 text-slate-700">{e.format}</td>
                      <td className="px-3 py-2 text-slate-700">{e.description}</td>
                      <td className="px-3 py-2 pr-4 sm:pr-5">
                        <div className="flex items-start gap-2">
                          <code className="block w-[22rem] max-w-md min-w-0 break-all rounded-sm border border-slate-200 bg-slate-50 px-2 py-1.5 font-mono text-xs leading-relaxed text-slate-800">
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
          <p className="text-xs text-slate-500">
            Replace <code className="font-mono break-all">$KEY</code> with a key from the list below (set it as an environment
            variable, never paste it into a shared document).
          </p>
        </div>
      ) : null}
    </Panel>
  );
}
