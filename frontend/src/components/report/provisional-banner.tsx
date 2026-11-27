"use client";

import { CircleCheck, TriangleAlert } from "lucide-react";
import { useId, useState } from "react";
import type { ReleaseInfo, RubricRef } from "@/lib/types";
import { cn } from "@/lib/utils";
import { fmtISTDate } from "./format";
import { FOLD, openFoldAndScroll } from "./report-events";
import { useReportView } from "./report-view-mode";
import { linkButton } from "./summary/tokens";

/** Plain-language release status (raw codes such as AUTHOR_DRAFT stay in the faculty audit fold). */
export function releaseText(release: ReleaseInfo, rubric: RubricRef): string {
  if (release.status === "RELEASED") {
    const who = release.reviewed_by ?? "your teacher";
    return `Reviewed by ${who}${release.reviewed_at ? ` on ${fmtISTDate(release.reviewed_at)}` : ""}.`;
  }
  return rubric.status === "AUTHOR_DRAFT"
    ? "Provisional result — your teacher has not reviewed these marks yet and the answer key was drafted from the paper, so marks may change."
    : "Provisional result — your teacher has not reviewed these marks yet, so marks may change.";
}

/** What "provisional" means for this sheet, in one or two plain sentences. */
function explanation(rubric: RubricRef, hardToRead: number): string {
  const checks = [
    rubric.status === "AUTHOR_DRAFT" ? "the answer key (it was drafted from the paper)" : null,
    hardToRead > 0 ? `the ${hardToRead} ${hardToRead === 1 ? "tick that was" : "ticks that were"} hard to read` : null,
  ].filter(Boolean);
  const what = checks.length ? `Your teacher will check ${checks.join(" and ")}` : "Your teacher will check these marks";
  return `${what}; marks may move a little. This page updates when the result is released.`;
}

/**
 * One-line release notice under the header (the release state is not repeated as a chip): provisional
 * with "What this means" or who reviewed it. In the student view "What this means" opens a short plain
 * explanation in place; in the teacher view it goes to "Review and release". Phones get a short line.
 */
export function ProvisionalNotice({
  release,
  rubric,
  isDemo,
  hardToRead = 0,
}: {
  release: ReleaseInfo;
  rubric: RubricRef;
  isDemo: boolean;
  /** Answers read below the confidence line (they may change at review). */
  hardToRead?: number;
}) {
  const released = release.status === "RELEASED";
  const { teacher } = useReportView();
  const [open, setOpen] = useState(false);
  const panelId = useId();
  const Icon = released ? CircleCheck : TriangleAlert;
  return (
    <div
      role="note"
      className={cn(
        "rounded-md border-l-[3px] px-3 py-2 text-[13px] leading-snug [print-color-adjust:exact]",
        released ? "border-emerald-600 bg-white text-slate-700" : "border-[#D97706] bg-amber-50/70 text-slate-800",
      )}
    >
      <div className="flex flex-wrap items-baseline gap-x-2 gap-y-1">
        <Icon
          className={cn("h-3.5 w-3.5 shrink-0 translate-y-0.5", released ? "text-emerald-700" : "text-[#B45309]")}
          aria-hidden
        />
        <span className="min-w-0 flex-1">
          {released ? (
            releaseText(release, rubric)
          ) : (
            <>
              <span className="hidden sm:inline">{releaseText(release, rubric)}</span>
              <span className="sm:hidden">
                <span className="font-semibold">Provisional:</span> teacher check pending, marks may change.
              </span>
            </>
          )}
          {released && release.note ? <span className="text-slate-600"> Note: {release.note}</span> : null}
          {isDemo ? <span className="text-slate-600"> Sample record: generated marks, no scanned sheet.</span> : null}
        </span>
        {released ? null : teacher ? (
          <button type="button" onClick={() => openFoldAndScroll(FOLD.review)} className={cn(linkButton, "print:hidden")}>
            Review and release
          </button>
        ) : (
          <button
            type="button"
            aria-expanded={open}
            aria-controls={panelId}
            onClick={() => setOpen((v) => !v)}
            className={cn(linkButton, "print:hidden")}
          >
            What this means
          </button>
        )}
      </div>
      {!released && !teacher ? (
        <p id={panelId} hidden={!open} className="mt-1.5 pl-5 text-[13px] text-slate-700">
          {explanation(rubric, hardToRead)}
        </p>
      ) : null}
    </div>
  );
}

/** Quoted CSS string for `content:` (escapes backslashes, quotes and line breaks). */
function cssString(text: string): string {
  return `"${text.replace(/\\/g, "\\\\").replace(/"/g, '\\"').replace(/[\r\n]+/g, " ")}"`;
}

/**
 * Print-only running footer with the release line. It is drawn in the bottom page-margin box
 * (`@page { @bottom-center }`), so it repeats on every printed page without covering body text; the
 * page counter sits in @bottom-right (globals.css). A plain footer line closes the report too, for
 * browsers without page-margin boxes.
 */
export function PrintFooter({ text }: { text: string }) {
  const line = `3iLens · ${text} · Full details: download the PDF`;
  const rule =
    `@page { @bottom-center { content: ${cssString(line)}; font-family: ui-sans-serif, system-ui, sans-serif; ` +
    "font-size: 7pt; line-height: 1.3; color: #475569; vertical-align: middle; } }";
  return (
    <>
      <style>{rule}</style>
      <p className="sair-print-only border-t border-slate-300 pt-2 text-center text-[10px] leading-snug text-slate-500">
        {line}
      </p>
    </>
  );
}
