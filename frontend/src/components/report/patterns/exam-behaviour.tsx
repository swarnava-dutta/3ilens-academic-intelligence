import { IllustrativePill } from "@/components/shared/illustrative-pill";
import type { Result, StudentPatterns } from "@/lib/types";
import { BloomProfileCard } from "./bloom-profile";
import { FatigueCard } from "./fatigue";
import { NegativeMarkingCard } from "./negative-marking";
import { noteFor } from "./shared";
import { TransferCard } from "./transfer";

const EMPTY: StudentPatterns = { negative_marking: null, fatigue: null, transfer: null, bloom_profile: [], notes: [] };

/**
 * "Exam behaviour" (FR-4.8 negative marking, FR-4.10 fatigue, FR-4.11 memorisation vs transfer,
 * plus the Bloom profile). A profile the backend could not compute shows its note instead.
 */
export function ExamBehaviour({ result }: { result: Result }) {
  const p = result.patterns ?? EMPTY;
  const notes = p.notes ?? [];
  const thresholdNote = notes.find((n) => /threshold/i.test(n)) ?? "Pattern thresholds: default - confirm with academic lead";
  return (
    <div className="space-y-4">
      <div className="flex flex-wrap items-center gap-2 text-xs text-slate-600">
        {result.submission.is_demo ? (
          <IllustrativePill label="Sample data" title="Synthetic sample record - the patterns run on generated marks." />
        ) : null}
        <span>{thresholdNote}.</span>
        <span>Deterministic, computed from the marks on this paper - no AI call.</span>
      </div>
      <div className="grid grid-cols-1 gap-6 lg:grid-cols-2 print:grid-cols-2">
        <NegativeMarkingCard
          profile={p.negative_marking ?? null}
          note={noteFor(notes, /negative/i, "No negatively-marked MCQs in this test")}
          className="lg:col-span-2 print:col-span-2"
        />
        <FatigueCard profile={p.fatigue ?? null} note={noteFor(notes, /at least|questions/i, "Not enough questions to measure fatigue")} />
        <TransferCard
          profile={p.transfer ?? null}
          note={noteFor(notes, /recall|application|concept/i, "No concept is tested at both recall and application levels")}
        />
        <BloomProfileCard buckets={p.bloom_profile ?? []} className="lg:col-span-2 print:col-span-2" />
      </div>
    </div>
  );
}
