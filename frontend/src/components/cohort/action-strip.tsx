import Link from "next/link";
import { Loader2 } from "lucide-react";
import type { Cohort } from "@/lib/types";
import { cn } from "@/lib/utils";
import { FOCUS_RING, LINK_TEXT, plural } from "./format";
import type { CohortTab } from "./url";

const LINK = cn("rounded-sm font-medium underline-offset-2 hover:underline", LINK_TEXT, FOCUS_RING);

function names(list: string[], max = 2): string {
  if (!list.length) return "";
  const shown = list.slice(0, max).join(", ");
  return list.length > max ? `${shown} +${list.length - max}` : shown;
}

/**
 * What needs doing before the class numbers are complete. Each item hides at 0; the strip hides
 * when nothing needs doing. Replaces the review / failed tiles, pipeline health and release card.
 */
export function ActionStrip({
  cohort,
  notReleasedHref,
  onReveal,
}: {
  cohort: Cohort;
  notReleasedHref: string;
  onReveal: (tab: CohortTab) => void;
}) {
  const held = cohort.excluded?.review ?? [];
  const failed = cohort.excluded?.failed ?? [];
  const reading = cohort.processing ?? 0;
  const provisional = cohort.release_counts?.provisional ?? 0;
  if (!held.length && !failed.length && !reading && !provisional) return null;

  return (
    <ul
      aria-label="Needs doing"
      className="flex flex-col gap-x-6 gap-y-1.5 rounded-md border border-slate-200 bg-white px-4 py-2.5 text-[13px] text-slate-700 sm:flex-row sm:flex-wrap"
    >
      {held.length ? (
        <li className="flex items-start gap-2">
          <Dot className="bg-amber-500" />
          <span>
            {plural(held.length, "sheet")} held for your check ({names(held)}) ·{" "}
            <Link href="/" className={LINK}>
              Open in Intake
            </Link>
          </span>
        </li>
      ) : null}
      {failed.length ? (
        <li className="flex items-start gap-2">
          <Dot className="bg-red-600" />
          <span className="text-red-700">
            {plural(failed.length, "sheet")} could not be read ({names(failed)}) ·{" "}
            <Link href="/" className={LINK}>
              Retry in Intake
            </Link>
          </span>
        </li>
      ) : null}
      {reading ? (
        <li className="flex items-start gap-2">
          <Loader2 className="mt-0.5 h-3.5 w-3.5 shrink-0 animate-spin text-cyan-700 motion-reduce:animate-none" aria-hidden />
          <span>{plural(reading, "sheet")} still being read - this page updates on its own</span>
        </li>
      ) : null}
      {provisional ? (
        <li className="flex items-start gap-2">
          <Dot className="bg-slate-500" />
          <span>
            {provisional === 1 ? "1 report" : `${provisional} reports`} not released yet ·{" "}
            <Link href={notReleasedHref} scroll={false} onClick={() => onReveal("students")} className={LINK}>
              Review &amp; release
            </Link>
          </span>
        </li>
      ) : null}
    </ul>
  );
}

function Dot({ className }: { className: string }) {
  return <span className={cn("mt-1.5 h-2 w-2 shrink-0 rounded-full", className)} aria-hidden />;
}
