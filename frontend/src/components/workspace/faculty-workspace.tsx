"use client";

import { Suspense, useState } from "react";
import { useHealth } from "@/components/app-shell";
import type { Submission } from "@/lib/types";
import { AiReadinessBanner } from "./ai-readiness-banner";
import { countByFilter } from "./format";
import { activeIntakeId } from "./intake-banner";
import { PipelineStrip } from "./pipeline-strip";
import { ProcessingQueue, QueueSkeletonCard } from "./processing-queue";
import { UploadCard } from "./upload-card";
import { useSubmissions } from "./use-submissions";
import { WorkspaceHero } from "./workspace-hero";

export function FacultyWorkspace() {
  const healthState = useHealth();
  const queue = useSubmissions();
  const { refresh, addOptimistic } = queue;
  const [startedIntake, setStartedIntake] = useState<string | null>(null);
  const [dismissedIntakes, setDismissedIntakes] = useState<string[]>([]);

  // SHA-256 -> first submission with those bytes (the "seen before / OCR cache" hint at intake).
  const knownHashes = new Map<string, Submission>();
  for (const s of queue.submissions ?? []) {
    if (s.file_sha256 && !knownHashes.has(s.file_sha256)) knownHashes.set(s.file_sha256, s);
  }

  const candidate = activeIntakeId(startedIntake, queue.submissions);
  const intakeBatchId = candidate && !dismissedIntakes.includes(candidate) ? candidate : null;

  function handleUploaded(submission: Submission) {
    addOptimistic(submission);
    void refresh();
  }

  function handleIntakeStarted(id: string) {
    setStartedIntake(id);
    setDismissedIntakes((prev) => prev.filter((x) => x !== id));
  }

  function dismissIntake() {
    if (!intakeBatchId) return;
    setDismissedIntakes((prev) => [...prev, intakeBatchId]);
    if (startedIntake === intakeBatchId) setStartedIntake(null);
  }

  return (
    <div className="space-y-6">
      <WorkspaceHero
        health={healthState.health}
        counts={queue.submissions ? countByFilter(queue.submissions) : null}
      />
      <AiReadinessBanner {...healthState} />
      <UploadCard
        health={healthState.health}
        knownHashes={knownHashes}
        submissions={queue.submissions}
        onUploaded={handleUploaded}
        onIntakeStarted={handleIntakeStarted}
        onQueueChanged={() => void refresh()}
      />
      <PipelineStrip
        ocrAdapter={healthState.health?.ocr_adapter ?? null}
        voiceModel={healthState.health?.voice_enabled ? healthState.health.transcription_model || "gpt-transcribe" : null}
      />
      {/* The queue reads batch/test/urgency filters from the URL (useSearchParams). */}
      <Suspense fallback={<QueueSkeletonCard />}>
        <ProcessingQueue
          queue={queue}
          intakeBatchId={intakeBatchId}
          onDismissIntake={dismissIntake}
          batchTargetSeconds={healthState.health?.batch_target_seconds}
        />
      </Suspense>
    </div>
  );
}
