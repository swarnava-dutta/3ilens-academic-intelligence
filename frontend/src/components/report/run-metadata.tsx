import type { ReactNode } from "react";
import type { Result } from "@/lib/types";
import { formatConfidence } from "@/lib/utils";
import { fmtIST, isoDateIST, shortHash } from "./format";
import { LlmRouteChips } from "./llm-route";
import { rubricLabel } from "./use-rubric";

function Row({ label, children }: { label: string; children: ReactNode }) {
  return (
    <tr>
      <th scope="row" className="w-[38%] border-t border-slate-200 px-4 py-2 text-left align-top font-normal text-slate-500">
        {label}
      </th>
      <td className="min-w-0 break-words border-t border-slate-200 px-4 py-2 align-top text-slate-800">{children}</td>
    </tr>
  );
}

/** "Source period": the dated assessments in this student's history, else this sheet's date. */
function sourcePeriod(result: Result): string {
  const dates = result.history.map((h) => isoDateIST(h.date)).filter(Boolean).sort();
  if (dates.length >= 2) return `${dates[0]} to ${dates[dates.length - 1]} (${dates.length} assessments)`;
  return `${isoDateIST(result.submission.created_at)} (single assessment)`;
}

/** SAIR page-1 style "Run metadata | Verified value" table. */
export function RunMetadataTable({ result }: { result: Result }) {
  const { report_meta: meta, rubric, extraction, release, submission } = result;
  const batch = meta.batch;
  return (
    <div className="overflow-hidden rounded-md border border-slate-200 bg-white text-sm print:break-inside-avoid">
      <table className="w-full table-fixed border-collapse">
        <caption className="sr-only">Run metadata for this report</caption>
        <thead>
          <tr className="text-left">
            <th scope="col" className="w-[38%] px-4 py-3 text-[15px] font-semibold text-brand-navy">
              Run metadata
            </th>
            <th scope="col" className="px-4 py-3 text-xs font-normal text-slate-500">
              Recorded value
            </th>
          </tr>
        </thead>
        <tbody>
          <Row label={meta.is_demo ? "Student (synthetic)" : "Student"}>{submission.student_name || "Unnamed student"}</Row>
          <Row label="Student ref">
            <span className="font-mono text-xs">{meta.student_ref || "—"}</span>
          </Row>
          <Row label="Source file">
            <span className="break-all font-mono text-xs">{submission.original_filename || "—"}</span>
          </Row>
          <Row label="Institution / batch">
            {meta.institution.name} / {batch.name}
            {batch.exam_type ? ` · ${batch.exam_type}` : ""}
          </Row>
          <Row label="Processing run">
            <span className="break-all font-mono text-xs">{meta.run_id}</span>
          </Row>
          <Row label="Source period">{sourcePeriod(result)}</Row>
          <Row label="Execution date">{fmtIST(meta.executed_at)}</Row>
          <Row label="Rubric">
            {rubricLabel(rubric)} · {rubric.status}
            {rubric.rubric_hash ? (
              <span className="block font-mono text-[11px] text-slate-500" title={rubric.rubric_hash}>
                sha256 {shortHash(rubric.rubric_hash)}
              </span>
            ) : null}
          </Row>
          <Row label="Transcription">
            {result.voice ? (
              result.voice.synthetic || meta.is_demo ? (
                "Synthetic voice transcript, no transcription call"
              ) : (
                <>
                  Voice answer · OpenAI {result.voice.transcription_model || "gpt-transcribe"} (stand-in for Whisper
                  large-v3 / Sarvam; not residency-approved)
                </>
              )
            ) : meta.is_demo ? (
              "Synthetic record, no OCR was run"
            ) : (
              <>
                Mean OCR {formatConfidence(extraction.mean_confidence)} · {extraction.ocr_adapter}
                {extraction.ocr_cache_hit ? " · OCR cache hit, no vision call (Rs 0.00)" : ""}
              </>
            )}
          </Row>
          <Row label="AI route">
            <LlmRouteChips routes={result.llm_routes} isDemo={meta.is_demo} />
          </Row>
          <Row label="Academic release">
            {release.status === "RELEASED" ? (
              <span className="font-medium text-lime-800">
                RELEASED - {release.reviewed_by ?? "faculty"}
                {release.reviewed_at ? `, ${fmtIST(release.reviewed_at)}` : ""}
              </span>
            ) : (
              <span className="font-medium text-amber-800">
                {/* V5 wording; zero-width spaces let the code wrap at underscores, not mid-word. */}
                PROVISIONAL —{" "}
                {(rubric.status === "AUTHOR_DRAFT" ? "AUTHOR_DRAFT_TEACHER_REVIEW_PENDING" : "TEACHER_REVIEW_PENDING").replaceAll(
                  "_",
                  "_\u200b",
                )}
              </span>
            )}
          </Row>
        </tbody>
      </table>
    </div>
  );
}
