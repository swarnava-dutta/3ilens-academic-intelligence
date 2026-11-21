import { MinusCircle } from "lucide-react";
import { RiskBadge } from "@/components/shared/risk-badge";
import type { NegativeMarkingProfile, RiskLevel, TopicRisk } from "@/lib/types";
import { fmtNumber } from "../format";
import { SectionCard } from "../primitives";
import { NullProfile, Recommendation, Stat, pct, realMinus } from "./shared";

const RISK_ORDER: Record<RiskLevel, number> = { high: 2, medium: 1, low: 0 };

/** "Attempt only if >= 50% sure (eliminate 2 options)". */
export function attemptRule(t: Pick<TopicRisk, "skip_threshold" | "eliminate_options">): string {
  const eliminate =
    t.eliminate_options > 0 ? ` (eliminate ${t.eliminate_options} option${t.eliminate_options === 1 ? "" : "s"})` : "";
  return `Attempt only if ≥ ${pct(t.skip_threshold)} sure${eliminate}`;
}

/** FR-4.8: marks lost to negative marking, the break-even and per-topic over-attempting risk. */
export function NegativeMarkingCard({
  profile,
  note,
  className,
}: {
  profile: NegativeMarkingProfile | null;
  note: string;
  className?: string;
}) {
  const topics = [...(profile?.topics ?? [])].sort(
    (a, b) => RISK_ORDER[b.risk] - RISK_ORDER[a.risk] || b.marks_lost - a.marks_lost || a.topic.localeCompare(b.topic),
  );
  return (
    <SectionCard
      id="pattern-negative-marking"
      title="Negative marking"
      description="MCQ attempts, wrong answers and the marks they cost."
      icon={MinusCircle}
      action={profile ? <RiskBadge risk={profile.risk} /> : null}
      className={className}
    >
      {!profile ? (
        <NullProfile text={note} />
      ) : (
        <div className="space-y-4">
          <dl className="grid grid-cols-2 gap-2 sm:grid-cols-3 lg:grid-cols-6">
            <Stat label="Attempted" value={profile.attempted} sub={`accuracy ${pct(profile.accuracy)}`} />
            <Stat label="Correct" value={profile.correct} />
            <Stat label="Wrong" value={profile.wrong} />
            <Stat label="Blank" value={profile.blank} />
            <Stat
              label="Marks lost"
              value={<span className="text-rose-700">{fmtNumber(-profile.marks_lost)}</span>}
              sub="to negative marking"
            />
            <Stat label="Net MCQ marks" value={fmtNumber(profile.net_marks)} sub="after penalties" />
          </dl>
          <p className="text-sm text-slate-700">
            Scheme <span className="font-semibold tabular-nums">{realMinus(profile.scheme)}</span> · break-even{" "}
            <span className="font-semibold tabular-nums">{pct(profile.break_even)}</span>:{" "}
            <span className="font-medium">guess only above {pct(profile.break_even)} sure</span> (below it a guess loses
            marks on average).
          </p>

          {topics.length ? (
            <div className="overflow-x-auto rounded-xl ring-1 ring-inset ring-slate-200">
              <table className="w-full min-w-[46rem] text-left text-sm">
                <caption className="sr-only">Negative-marking risk per topic, highest risk first</caption>
                <thead className="bg-slate-50 text-[11px] uppercase tracking-wide text-slate-500">
                  <tr>
                    <th scope="col" className="px-3 py-2 font-semibold">Topic</th>
                    <th scope="col" className="px-2 py-2 text-right font-semibold">Att.</th>
                    <th scope="col" className="px-2 py-2 text-right font-semibold">Correct</th>
                    <th scope="col" className="px-2 py-2 text-right font-semibold">Wrong</th>
                    <th scope="col" className="px-2 py-2 text-right font-semibold">Accuracy</th>
                    <th scope="col" className="px-2 py-2 text-right font-semibold">Marks lost</th>
                    <th scope="col" className="px-3 py-2 font-semibold">Risk</th>
                    <th scope="col" className="px-3 py-2 font-semibold">Rule &amp; advice</th>
                  </tr>
                </thead>
                <tbody>
                  {topics.map((t) => (
                    <tr key={t.topic} className="border-t border-slate-100 align-top">
                      <th scope="row" className="px-3 py-2 font-medium text-slate-800">
                        {t.topic}
                      </th>
                      <td className="px-2 py-2 text-right tabular-nums">{t.attempted}</td>
                      <td className="px-2 py-2 text-right tabular-nums">{t.correct}</td>
                      <td className="px-2 py-2 text-right tabular-nums">{t.wrong}</td>
                      <td className="px-2 py-2 text-right tabular-nums">{pct(t.accuracy)}</td>
                      <td className="px-2 py-2 text-right tabular-nums text-rose-700">
                        {t.marks_lost > 0 ? fmtNumber(-t.marks_lost) : "0"}
                      </td>
                      <td className="px-3 py-2">
                        <RiskBadge risk={t.risk} size="sm" label={t.over_attempting ? "Over-attempting" : undefined} />
                      </td>
                      <td className="px-3 py-2 text-xs text-slate-700">
                        <span className="block font-semibold text-slate-800">{attemptRule(t)}</span>
                        {t.advice}
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          ) : null}

          <Recommendation>{profile.recommendation}</Recommendation>
        </div>
      )}
    </SectionCard>
  );
}
