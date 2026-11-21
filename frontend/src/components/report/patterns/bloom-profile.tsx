import { Layers3 } from "lucide-react";
import { BLOOM_LABELS, BloomBadge } from "@/components/shared/bloom-badge";
import type { BloomBucket } from "@/lib/types";
import { fmtNumber } from "../format";
import { MeterBar, SectionCard } from "../primitives";
import { NullProfile, pct } from "./shared";

/** FR-3.9: accuracy per Bloom level (K1 Remember ... K5 Evaluate) with question counts. */
export function BloomProfileCard({ buckets, className }: { buckets: BloomBucket[]; className?: string }) {
  const rows = [...buckets].sort((a, b) => a.level.localeCompare(b.level));
  return (
    <SectionCard
      id="pattern-bloom"
      title="Bloom profile"
      description="Marks earned at each cognitive level of the paper."
      icon={Layers3}
      className={className}
    >
      {rows.length === 0 ? (
        <NullProfile text="No Bloom levels could be resolved for this paper." />
      ) : (
        <ul className="space-y-3">
          {rows.map((b) => (
            <li key={b.level}>
              <div className="flex flex-wrap items-center justify-between gap-2 text-sm">
                <BloomBadge level={b.level} size="sm" />
                <span className="text-xs text-slate-600">
                  <span className="font-semibold tabular-nums text-brand-navy">{pct(b.accuracy)}</span> ·{" "}
                  {b.questions} question{b.questions === 1 ? "" : "s"} · {fmtNumber(b.marks)} / {fmtNumber(b.max_marks)} marks
                </span>
              </div>
              <MeterBar
                className="mt-1"
                size="sm"
                percent={(b.accuracy ?? 0) * 100}
                label={`${b.level} ${BLOOM_LABELS[b.level]} accuracy`}
                valueText={`${pct(b.accuracy)} of the marks at ${b.level}`}
                fillClass="bg-brand-cyan"
                trackClass="bg-brand-cyan-50"
              />
            </li>
          ))}
        </ul>
      )}
    </SectionCard>
  );
}
