"use client";

import { BadgeCheck, Hourglass, ShieldCheck, Undo2 } from "lucide-react";
import { useState } from "react";
import { errorMessage, releaseResult, revokeResult } from "@/lib/api";
import type { ReleaseInfo, RubricRef } from "@/lib/types";
import { cn } from "@/lib/utils";
import { Notice, btnAmber, btnPrimary, btnSecondary, inputClass } from "./dialog";
import { fmtIST } from "./format";
import { SectionCard } from "./primitives";
import { rubricLabel } from "./use-rubric";

/** Small header chip: "Provisional" (amber) or "Released" (lime). */
export function ReleaseChip({ release, className }: { release: ReleaseInfo; className?: string }) {
  const released = release.status === "RELEASED";
  return (
    <span
      title={
        released
          ? `Released by ${release.reviewed_by ?? "faculty"}${release.reviewed_at ? ` on ${fmtIST(release.reviewed_at)}` : ""}`
          : "AI first-pass marks; teacher review pending"
      }
      className={cn(
        "inline-flex items-center gap-1.5 whitespace-nowrap rounded-full px-2.5 py-1 text-xs font-semibold ring-1 ring-inset",
        released ? "bg-brand-lime-50 text-lime-800 ring-brand-lime/60" : "bg-amber-50 text-amber-900 ring-amber-300",
        className,
      )}
    >
      {released ? <BadgeCheck className="h-3.5 w-3.5" aria-hidden /> : <Hourglass className="h-3.5 w-3.5" aria-hidden />}
      {released ? "Released" : "Provisional"}
    </span>
  );
}

type Step = "idle" | "confirm-release" | "confirm-revoke";

/**
 * Academic release gate (V5 "faculty certification"): marks stay PROVISIONAL until a named
 * reviewer approves them. Approve and revoke both need the reviewer's name and a confirm step.
 */
export function ReleaseGateCard({
  submissionId,
  release,
  rubric,
  isDemo,
  onChange,
}: {
  submissionId: number;
  release: ReleaseInfo;
  rubric: RubricRef;
  isDemo: boolean;
  onChange: (release: ReleaseInfo) => void;
}) {
  const [step, setStep] = useState<Step>("idle");
  const [reviewer, setReviewer] = useState("");
  const [note, setNote] = useState("");
  const [checked, setChecked] = useState(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const released = release.status === "RELEASED";

  const reset = () => {
    setStep("idle");
    setChecked(false);
    setError(null);
    setNote("");
  };

  async function submit(kind: "release" | "revoke") {
    const name = reviewer.trim();
    if (!name) {
      setError("Enter the reviewer's name.");
      return;
    }
    setBusy(true);
    setError(null);
    try {
      const input = { reviewer_name: name, note: note.trim() ? note.trim() : null };
      const next = kind === "release" ? await releaseResult(submissionId, input) : await revokeResult(submissionId, input);
      onChange({
        status: next?.status === "RELEASED" ? "RELEASED" : "PROVISIONAL",
        reviewed_by: next?.reviewed_by ?? (kind === "release" ? name : null),
        reviewed_at: next?.reviewed_at ?? null,
        note: next?.note ?? null,
      });
      reset();
    } catch (err) {
      setError(errorMessage(err));
    } finally {
      setBusy(false);
    }
  }

  return (
    <SectionCard
      id="release-gate"
      title="Academic release gate"
      description="AI marks are provisional until a named faculty reviewer approves them."
      icon={ShieldCheck}
      action={<ReleaseChip release={release} />}
      className="print:break-inside-avoid"
    >
      <div
        className={cn(
          "rounded-xl border p-4 [print-color-adjust:exact]",
          released ? "border-lime-300 bg-brand-lime-50" : "border-amber-300 bg-amber-50",
        )}
      >
        {released ? (
          <p className="text-sm text-lime-950">
            <span className="font-semibold">Released by {release.reviewed_by ?? "faculty"}</span>
            {release.reviewed_at ? ` on ${fmtIST(release.reviewed_at)}` : ""}. Marks against rubric{" "}
            {rubricLabel(rubric)} ({rubric.status}).
            {release.note ? <span className="mt-1 block text-xs">Reviewer note: {release.note}</span> : null}
          </p>
        ) : (
          <p className="text-sm text-amber-950">
            <span className="font-semibold">Pending.</span>{" "}
            {rubric.status === "AUTHOR_DRAFT"
              ? "Author-draft rubric: a teacher must review the marks and the answer key before academic release."
              : "A teacher must review the marks before academic release."}{" "}
            Model-rubric agreement is not faculty certification.
            {release.note ? <span className="mt-1 block text-xs">Last note: {release.note}</span> : null}
          </p>
        )}
        {isDemo ? (
          <p className="mt-1 text-xs text-slate-600">Synthetic demo record: release here only demonstrates the gate.</p>
        ) : null}
      </div>

      <div className="mt-4 print:hidden">
        {step === "idle" ? (
          released ? (
            <button type="button" className={btnSecondary} onClick={() => setStep("confirm-revoke")}>
              <Undo2 className="h-4 w-4" aria-hidden />
              Revoke release
            </button>
          ) : (
            <button type="button" className={btnPrimary} onClick={() => setStep("confirm-release")}>
              <BadgeCheck className="h-4 w-4" aria-hidden />
              Approve for release
            </button>
          )
        ) : (
          <form
            className="space-y-3 rounded-xl border border-slate-200 bg-slate-50 p-4"
            onSubmit={(e) => {
              e.preventDefault();
              void submit(step === "confirm-release" ? "release" : "revoke");
            }}
          >
            <p className="text-sm font-semibold text-brand-navy">
              {step === "confirm-release" ? "Confirm academic release" : "Revoke the release"}
            </p>
            <div className="grid gap-3 sm:grid-cols-2">
              <label className="block">
                <span className="mb-1 block text-xs font-medium text-slate-600">Reviewer name</span>
                <input
                  className={inputClass}
                  value={reviewer}
                  onChange={(e) => setReviewer(e.target.value)}
                  placeholder="e.g. Dr. S. Rao"
                  maxLength={120}
                  required
                  autoFocus
                />
              </label>
              <label className="block">
                <span className="mb-1 block text-xs font-medium text-slate-600">Note (optional)</span>
                <input
                  className={inputClass}
                  value={note}
                  onChange={(e) => setNote(e.target.value)}
                  placeholder={step === "confirm-release" ? "Checked against the key" : "Reason for revoking"}
                  maxLength={500}
                />
              </label>
            </div>
            {step === "confirm-release" ? (
              <label className="flex items-start gap-2 text-sm text-slate-700">
                <input
                  type="checkbox"
                  className="mt-0.5 h-4 w-4 accent-brand-navy"
                  checked={checked}
                  onChange={(e) => setChecked(e.target.checked)}
                />
                I have reviewed the question-level marks and evidence against the rubric.
              </label>
            ) : null}
            {error ? <Notice tone="error">{error}</Notice> : null}
            <div className="flex flex-wrap gap-2">
              <button
                type="submit"
                className={step === "confirm-release" ? btnPrimary : btnAmber}
                disabled={busy || !reviewer.trim() || (step === "confirm-release" && !checked)}
              >
                {busy ? "Saving…" : step === "confirm-release" ? "Confirm release" : "Confirm revoke"}
              </button>
              <button type="button" className={btnSecondary} onClick={reset} disabled={busy}>
                Cancel
              </button>
            </div>
          </form>
        )}
      </div>
    </SectionCard>
  );
}
