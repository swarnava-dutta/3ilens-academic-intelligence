"use client";

import { EffectivenessCard } from "@/components/owner/effectiveness-card";

/**
 * Compact intervention-effectiveness card (FR-4.13) for the batch in the cohort filters
 * (the whole institution when no batch is selected). Fetches only when the batch changes.
 */
export function InterventionEffect({ batchId }: { batchId: number | null | undefined }) {
  return <EffectivenessCard batchId={batchId ?? null} compact className="self-start" />;
}
