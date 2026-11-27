import type { Delivery, Result } from "@/lib/types";
import { AuditTrailCard } from "../audit-trail";
import { DeliveriesCard, DocumentCustodyCard, InvocationsCard, ScoringControlsNote } from "../controls";
import { RunMetadataTable } from "../run-metadata";
import { StatCards } from "../stat-cards";

/** F9 "Processing and audit" (faculty): every operational and provenance detail of the run. */
export function ProcessingAudit({ result, deliveries }: { result: Result; deliveries: Delivery[] }) {
  return (
    <div className="space-y-4">
      <RunMetadataTable result={result} />
      <StatCards result={result} />
      <div className="grid grid-cols-1 gap-4 lg:grid-cols-2 print:grid-cols-2">
        <DocumentCustodyCard result={result} />
        <ScoringControlsNote result={result} />
      </div>
      <InvocationsCard result={result} />
      <AuditTrailCard log={result.processing_log} seconds={result.latency?.seconds ?? null} />
      {deliveries.length ? <DeliveriesCard deliveries={deliveries} /> : null}
      <p className="text-xs leading-relaxed text-slate-500">
        AI-assisted evaluation. Marks are validated against rubric bounds and totals; mastery, urgency and the study-plan
        figures are computed deterministically by the 3iLens insights engine. Nothing here is official NEET scoring.
      </p>
    </div>
  );
}
