import { SectionCard } from "./primitives";

function List({ items, empty }: { items: string[]; empty: string }) {
  if (items.length === 0) return <p className="text-sm text-slate-500">{empty}</p>;
  return (
    <ul className="list-disc space-y-2 pl-5 text-sm leading-relaxed text-slate-700 marker:text-slate-400">
      {items.map((s, i) => (
        <li key={i} className="print:break-inside-avoid">
          {s}
        </li>
      ))}
    </ul>
  );
}

export function InsightsCard({
  strengths,
  gaps,
  className,
}: {
  strengths: string[];
  gaps: string[];
  className?: string;
}) {
  return (
    <SectionCard
      id="insights"
      title="Strengths and gaps"
      description="AI evaluator's reading across the whole answer sheet."
      className={className}
    >
      <div className="grid gap-6 md:grid-cols-2 lg:grid-cols-1">
        <div>
          <h3 className="mb-2 text-sm font-semibold text-brand-navy">Strengths</h3>
          <List items={strengths} empty="No specific strengths were recorded." />
        </div>
        <div>
          <h3 className="mb-2 text-sm font-semibold text-brand-navy">Gaps to close</h3>
          <List items={gaps} empty="No gaps were flagged." />
        </div>
      </div>
    </SectionCard>
  );
}
