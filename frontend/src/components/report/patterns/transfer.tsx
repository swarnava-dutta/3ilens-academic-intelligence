import { AlertOctagon, AlertTriangle, CheckCircle2, CircleDot, Shuffle, Waypoints } from "lucide-react";
import type { LucideIcon } from "lucide-react";
import type { ConceptTransfer, TransferClass, TransferProfile } from "@/lib/types";
import { cn } from "@/lib/utils";
import { fmtNumber } from "../format";
import { MeterBar, SectionCard } from "../primitives";
import { NullProfile } from "./shared";

export const TRANSFER_LOOK: Record<TransferClass, { label: string; Icon: LucideIcon; chip: string; fill: string }> = {
  memorisation: {
    label: "Memorisation",
    Icon: AlertTriangle,
    chip: "bg-amber-50 text-amber-900 ring-amber-300",
    fill: "bg-amber-400",
  },
  transferable: {
    label: "Transferable",
    Icon: CheckCircle2,
    chip: "bg-brand-lime-50 text-lime-800 ring-brand-lime/50",
    fill: "bg-brand-lime",
  },
  foundational_gap: {
    label: "Foundational gap",
    Icon: AlertOctagon,
    chip: "bg-rose-50 text-rose-700 ring-rose-200",
    fill: "bg-rose-500",
  },
  inconsistent: {
    label: "Inconsistent",
    Icon: Shuffle,
    chip: "bg-violet-50 text-violet-800 ring-violet-200",
    fill: "bg-violet-500",
  },
  developing: {
    label: "Developing",
    Icon: CircleDot,
    chip: "bg-slate-100 text-slate-700 ring-slate-300",
    fill: "bg-slate-400",
  },
};

export function TransferChip({ value, className }: { value: TransferClass; className?: string }) {
  const look = TRANSFER_LOOK[value] ?? TRANSFER_LOOK.developing;
  return (
    <span
      className={cn(
        "inline-flex items-center gap-1 whitespace-nowrap rounded-full px-2 py-0.5 text-[11px] font-semibold ring-1 ring-inset",
        look.chip,
        className,
      )}
    >
      <look.Icon className="h-3 w-3" aria-hidden />
      {look.label}
    </span>
  );
}

function SideBar({ label, questions, value }: { label: string; questions: number[]; value: number }) {
  return (
    <div>
      <div className="flex items-baseline justify-between gap-2 text-xs">
        <span className="font-medium text-slate-700">
          {label} <span className="font-normal text-slate-500">{questions.length ? `Q${questions.join(", Q")}` : "—"}</span>
        </span>
        <span className="font-semibold tabular-nums text-brand-navy">{fmtNumber(value)}%</span>
      </div>
      <MeterBar
        className="mt-1"
        size="sm"
        percent={value}
        label={`${label} accuracy`}
        valueText={`${fmtNumber(value)}% on ${questions.length} question${questions.length === 1 ? "" : "s"}`}
        fillClass="bg-brand-navy"
        trackClass="bg-slate-100"
      />
    </div>
  );
}

function ConceptRow({ c }: { c: ConceptTransfer }) {
  return (
    <li className="rounded-xl border border-slate-200 p-3">
      <div className="flex flex-wrap items-center justify-between gap-2">
        <p className="font-semibold text-brand-navy">{c.concept}</p>
        <TransferChip value={c.classification} />
      </div>
      <div className="mt-2 space-y-2">
        <SideBar label="Recall (K1-K2)" questions={c.recall_questions} value={c.recall_accuracy} />
        <SideBar label="Application (K3-K5)" questions={c.transfer_questions} value={c.transfer_accuracy} />
      </div>
      <p className="mt-2 text-xs text-slate-600">
        Gap {fmtNumber(c.gap_pts)} pts (recall minus application). {c.advice}
      </p>
    </li>
  );
}

/** FR-4.11: per concept, recall (K1-K2) vs application (K3-K5) accuracy. */
export function TransferCard({ profile, note, className }: { profile: TransferProfile | null; note: string; className?: string }) {
  return (
    <SectionCard
      id="pattern-transfer"
      title="Memorisation vs transfer"
      description="Does recall of a concept carry over to applying it?"
      icon={Waypoints}
      className={className}
    >
      {!profile || profile.concepts.length === 0 ? (
        <NullProfile text={note} />
      ) : (
        <div className="space-y-3">
          <p className="text-sm text-slate-700">{profile.summary}</p>
          <ul className="space-y-2">
            {profile.concepts.map((c) => (
              <ConceptRow key={c.concept} c={c} />
            ))}
          </ul>
        </div>
      )}
    </SectionCard>
  );
}
