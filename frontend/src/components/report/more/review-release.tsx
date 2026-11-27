"use client";

import { RefreshCcw } from "lucide-react";
import { useState } from "react";
import type { ReleaseInfo, Result } from "@/lib/types";
import { ConsistencyCheckCard, VersionHistoryCard } from "../controls";
import { btnSecondary } from "../dialog";
import { fmtISTDate } from "../format";
import { SectionCard } from "../primitives";
import { RegradeDialog, VersionSelect } from "../report-header";
import { ReleaseGateCard } from "../release-gate";
import { rubricLabel } from "../use-rubric";

/** "Not reviewed yet · approve, re-grade, check consistency" / "Reviewed by X on date". */
export function reviewTeaser(release: ReleaseInfo): string {
  if (release.status === "RELEASED") {
    return `Reviewed by ${release.reviewed_by ?? "faculty"}${release.reviewed_at ? ` on ${fmtISTDate(release.reviewed_at)}` : ""}`;
  }
  return "Not reviewed yet · approve for release, re-grade, consistency check";
}

/**
 * F6 "Review and release" (faculty): what "provisional" means, the release gate, re-grading (with
 * the same key or one drafted from the right paper, which also reads chapters), the consistency
 * check (one live AI call) and the version history.
 */
export function ReviewRelease({
  result,
  release,
  archived,
  version,
  onRelease,
  onRegraded,
}: {
  result: Result;
  release: ReleaseInfo;
  archived: boolean;
  version?: number;
  onRelease: (r: ReleaseInfo) => void;
  onRegraded: () => void;
}) {
  const [regrade, setRegrade] = useState(false);
  const draft = result.rubric.status === "AUTHOR_DRAFT";
  const chapters = result.focus_topics?.level === "chapter";
  return (
    <div className="space-y-4">
      <div className="space-y-1.5 text-[13px] leading-relaxed text-slate-700">
        <p>
          <span className="font-semibold text-slate-900">What provisional means.</span> These marks come from an AI first
          pass against the answer key{draft ? ", which was drafted from the uploaded paper and has not been approved by a teacher" : ""}.
          They can change when a teacher checks the hard-to-read answers and the key, then releases the result. Nothing here
          is official NEET scoring.
        </p>
        <p className="text-slate-600">
          Answer key: {rubricLabel(result.rubric)} · {draft ? "drafted from the paper" : "approved by faculty"}.
        </p>
      </div>
      {archived ? null : (
        <ReleaseGateCard
          submissionId={result.submission.id}
          release={release}
          rubric={result.rubric}
          isDemo={result.submission.is_demo}
          onChange={onRelease}
        />
      )}
      {archived ? null : (
        <SectionCard
          id="regrade"
          title="Re-grade this sheet"
          description="Reuses the stored reading of the sheet; no new scan."
          action={
            <button type="button" className={btnSecondary} onClick={() => setRegrade(true)}>
              <RefreshCcw className="h-4 w-4" aria-hidden />
              Re-grade…
            </button>
          }
        >
          <p className="text-[13px] text-slate-700">
            Re-grade with the same key, or with a key drafted from the right question paper (and its answer key file).
            {chapters ? "" : " Re-grading from the printed paper also reads each question's NEET chapter, so the focus list can name chapters instead of subjects."}{" "}
            The current result is kept as an archived version.
          </p>
          <RegradeDialog open={regrade} onClose={() => setRegrade(false)} result={result} onQueued={onRegraded} />
        </SectionCard>
      )}
      <ConsistencyCheckCard result={result} />
      <div className="flex flex-wrap items-end gap-3">
        <dl>
          <VersionSelect submissionId={result.submission.id} viewing={version} />
        </dl>
      </div>
      {result.versions.length ? <VersionHistoryCard result={result} /> : null}
    </div>
  );
}
