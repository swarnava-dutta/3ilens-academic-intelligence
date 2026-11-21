"use client";

import { History, ShieldCheck } from "lucide-react";
import { useMemo, useState } from "react";
import type { Delivery, ReleaseInfo, Result } from "@/lib/types";
import { ActionPlanTable, ConfusionsCard, InterventionChooser } from "./action-plan";
import { AuditTrailCard } from "./audit-trail";
import {
  ConsistencyCheckCard,
  DeliveriesCard,
  DocumentCustodyCard,
  InvocationsCard,
  ProvenanceGatesCard,
  ScoringControlsNote,
  VersionHistoryCard,
} from "./controls";
import { Notice } from "./dialog";
import { EvidenceTraceCard } from "./evidence-trace";
import { ExecutiveSummaryCard } from "./executive-summary";
import { ImmediateReadingCard } from "./immediate-reading";
import { InsightsCard } from "./insights";
import { InterventionsPanel } from "./interventions-panel";
import { normalizeResult } from "./normalize";
import { ExamBehaviour } from "./patterns/exam-behaviour";
import { PrintFooter, ProvisionalBanner, releaseText } from "./provisional-banner";
import { QuestionEvaluationsCard } from "./question-evaluations";
import { ReleaseGateCard } from "./release-gate";
import { SairHeader } from "./report-header";
import { RoiLab } from "./roi-lab";
import { RunMetadataTable } from "./run-metadata";
import { ReportSection, SectionNav } from "./section-nav";
import { SourcePagesViewer } from "./source-pages";
import { VoiceAnswerCard } from "./voice-answer";
import { StatCards } from "./stat-cards";
import { SubjectRollupCard } from "./subject-rollup";
import { TopicScreeningCard } from "./topic-mastery";
import { rubricPrompts, useRubric } from "./use-rubric";
import { WhatsAppDialog } from "./whatsapp-dialog";
import { WorksheetCard } from "./worksheet";

export { normalizeResult } from "./normalize";

/**
 * Completed Student Academic Intelligence Report: five numbered sections on one long scroll
 * (so print includes everything) with a sticky section nav. Release and delivery changes made
 * on the page update the banner, chips and print footer without a reload.
 */
export function ReadyReport({ result: raw, onReload }: { result: Result; onReload?: () => void }) {
  const base = useMemo(() => normalizeResult(raw), [raw]);
  const prompts = rubricPrompts(useRubric(base.rubric.id));
  const [release, setRelease] = useState<ReleaseInfo>(base.release);
  const [sent, setSent] = useState<Delivery[]>([]);
  const [whatsAppOpen, setWhatsAppOpen] = useState(false);

  const sentIds = new Set(sent.map((d) => d.id));
  const deliveries = [...sent, ...base.deliveries.filter((d) => !sentIds.has(d.id))];
  const result: Result = { ...base, release, deliveries };
  const isDemo = result.submission.is_demo;
  const superseded = result.versions.filter((v) => !v.current).length;
  const currentVersion = result.versions.find((v) => v.current)?.version;

  return (
    <div className="space-y-6 print:space-y-4">
      <SairHeader
        result={result}
        release={release}
        onWhatsApp={() => setWhatsAppOpen(true)}
        onReevaluated={() => onReload?.()}
      />
      <ProvisionalBanner release={release} rubric={result.rubric} isDemo={isDemo} />
      {superseded > 0 ? (
        <Notice tone="info" className="flex items-center gap-2">
          <History className="h-4 w-4 shrink-0" aria-hidden />
          <span>
            Re-evaluated: this is version {currentVersion ?? superseded + 1}; {superseded} earlier{" "}
            {superseded === 1 ? "version was" : "versions were"} superseded (see Version history under Question evidence &amp; controls).
          </span>
        </Notice>
      ) : null}

      <SectionNav />

      <ReportSection id="overview" description="Run metadata, KPIs and the teacher's immediate reading.">
        <div className="grid grid-cols-1 gap-6 lg:grid-cols-5 print:grid-cols-5">
          <div className="min-w-0 lg:col-span-2 print:col-span-2">
            <RunMetadataTable result={result} />
          </div>
          <ExecutiveSummaryCard result={result} className="lg:col-span-3 print:col-span-3" />
        </div>
        <StatCards result={result} />
        <ImmediateReadingCard result={result} />
      </ReportSection>

      <ReportSection id="diagnostics" description="Screening results, not certified competencies.">
        <SubjectRollupCard rows={result.subject_rollup} />
        <div className="grid grid-cols-1 gap-6 lg:grid-cols-5 print:grid-cols-5">
          <TopicScreeningCard topics={result.topic_mastery} className="lg:col-span-3 print:col-span-3" />
          <InsightsCard
            strengths={result.strengths_gaps.strengths}
            gaps={result.strengths_gaps.gaps}
            className="lg:col-span-2 print:col-span-2"
          />
        </div>
        <WorksheetCard result={result} />
      </ReportSection>

      <ReportSection id="action-plan" description="Provisional prescriptions, pending teacher review.">
        <InterventionChooser result={result} />
        <ActionPlanTable result={result} />
        <ConfusionsCard result={result} />
        <RoiLab result={result} />
      </ReportSection>

      <ReportSection
        id="behaviour"
        description="Negative marking, fatigue, memorisation vs transfer and the Bloom profile."
      >
        <ExamBehaviour result={result} />
      </ReportSection>

      <ReportSection id="interventions" description="Recorded teaching actions and what happened next (observational).">
        <InterventionsPanel result={result} />
      </ReportSection>

      <ReportSection id="evidence" description="Every mark traced to the answer, the rubric and the run.">
        <EvidenceTraceCard result={result} prompts={prompts} />
        <QuestionEvaluationsCard
          questions={result.question_evaluations}
          prompts={prompts}
          threshold={result.extraction.threshold}
          isDemo={isDemo}
        />
        <div className="grid grid-cols-1 gap-6 lg:grid-cols-2 print:grid-cols-2">
          <DocumentCustodyCard result={result} />
          <ScoringControlsNote result={result} />
        </div>
        <ProvenanceGatesCard result={result} />
        <ReleaseGateCard
          submissionId={result.submission.id}
          release={release}
          rubric={result.rubric}
          isDemo={isDemo}
          onChange={setRelease}
        />
        <InvocationsCard result={result} />
        <div className="grid grid-cols-1 gap-6 lg:grid-cols-2 print:grid-cols-2">
          <ConsistencyCheckCard result={result} />
          <VersionHistoryCard result={result} />
        </div>
        <div className="grid grid-cols-1 gap-6 lg:grid-cols-5 print:grid-cols-5">
          <AuditTrailCard log={result.processing_log} className="lg:col-span-3 print:col-span-3" />
          <div className="min-w-0 lg:col-span-2 print:col-span-2">
            <DeliveriesCard deliveries={deliveries} />
          </div>
        </div>
      </ReportSection>

      <ReportSection
        id="pages"
        description={
          result.voice
            ? "Voice answer: the recording and its transcript."
            : isDemo
              ? "Synthetic record: no source scan."
              : "As uploaded and as processed."
        }
      >
        {result.voice ? (
          <VoiceAnswerCard
            submissionId={result.submission.id}
            voice={result.voice}
            mappedQuestions={result.question_evaluations
              .filter((q) => (q.student_answer ?? "").trim())
              .map((q) => q.question)
              .sort((a, b) => a - b)}
            isDemo={isDemo}
          />
        ) : (
          <SourcePagesViewer result={result} />
        )}
      </ReportSection>

      <p className="flex items-start justify-center gap-2 px-2 text-center text-xs leading-relaxed text-slate-400">
        <ShieldCheck className="mt-0.5 h-3.5 w-3.5 shrink-0" aria-hidden />
        AI-assisted evaluation. Marks are validated against rubric bounds and totals; mastery, urgency and ROI are
        computed deterministically by the 3iLens insights engine. Nothing here is official NEET scoring.
      </p>

      <PrintFooter text={releaseText(release, result.rubric)} runId={result.report_meta.run_id} />

      <WhatsAppDialog
        open={whatsAppOpen}
        onClose={() => setWhatsAppOpen(false)}
        submissionIds={[result.submission.id]}
        studentName={result.submission.student_name}
        testName={`${result.rubric.name} ${result.rubric.version}`.trim()}
        onDelivered={(rows) => setSent((prev) => [...rows, ...prev])}
      />
    </div>
  );
}
