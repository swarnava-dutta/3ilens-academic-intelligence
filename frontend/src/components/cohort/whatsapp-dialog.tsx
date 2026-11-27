"use client";

import { useState } from "react";
import { Ban, ExternalLink, Loader2, MessageCircle, ShieldAlert } from "lucide-react";
import { createDeliveries, downloadUrl, errorCode, errorMessage, errorStatus } from "@/lib/api";
import { plural } from "@/lib/format";
import type { Delivery, DeliveryStatus } from "@/lib/types";
import { cn } from "@/lib/utils";
import { btnPrimary, btnSecondary, Dialog, fieldClass } from "./dialog";

/** The API accepts at most this many submission ids per POST /api/deliveries. */
export const MAX_DELIVERY_IDS = 200;

const STATUS_LOOK: Record<DeliveryStatus, { label: string; className: string }> = {
  BLOCKED_TEMPLATE_PENDING: {
    label: "BLOCKED - template pending",
    className: "bg-red-50 text-red-700",
  },
  SIMULATED_NOT_SENT: {
    label: "Simulated - NOT sent",
    className: "bg-amber-50 text-amber-800",
  },
};

function statusLook(status: string) {
  return STATUS_LOOK[status as DeliveryStatus] ?? { label: status, className: "bg-slate-100 text-slate-600" };
}

function formatExpiry(iso: string | null): string | null {
  if (!iso) return null;
  const d = new Date(/(?:[zZ]|[+-]\d{2}:?\d{2})$/.test(iso) ? iso : `${iso}Z`);
  return Number.isNaN(d.getTime())
    ? iso
    : d.toLocaleString(undefined, { day: "2-digit", month: "short", hour: "2-digit", minute: "2-digit" });
}

/**
 * "Send batch via WhatsApp" - SIMULATED. Calls POST /api/deliveries for the completed students;
 * the API never sends a message (no approved WhatsApp Business template) and answers with
 * BLOCKED / NOT sent rows plus signed, time-limited PDF links.
 */
export function WhatsAppDialog({
  open,
  onClose,
  submissionIds,
  names,
  whatsappMode,
}: {
  open: boolean;
  onClose: () => void;
  /** COMPLETED submissions in the current (filtered) view. */
  submissionIds: number[];
  names: Map<number, string>;
  whatsappMode: string | null;
}) {
  const [recipient, setRecipient] = useState("");
  const [sending, setSending] = useState(false);
  const [results, setResults] = useState<Delivery[] | null>(null);
  const [error, setError] = useState<string | null>(null);

  const ids = submissionIds.slice(0, MAX_DELIVERY_IDS);
  const truncated = submissionIds.length > ids.length;

  function close() {
    onClose();
    setResults(null);
    setError(null);
  }

  async function simulate() {
    setSending(true);
    setError(null);
    try {
      const rows = await createDeliveries({
        submission_ids: ids,
        channel: "whatsapp",
        recipient: recipient.trim() || null,
      });
      setResults(rows);
    } catch (err) {
      const status = errorStatus(err);
      setError(
        !errorCode(err) && (status === 404 || status === 405)
          ? "Simulated delivery is not available on this API build yet."
          : errorMessage(err),
      );
    } finally {
      setSending(false);
    }
  }

  const counts = new Map<string, number>();
  for (const r of results ?? []) counts.set(r.status, (counts.get(r.status) ?? 0) + 1);

  return (
    <Dialog
      open={open}
      onClose={close}
      size="lg"
      eyebrow="Simulated delivery"
      title="Send batch via WhatsApp (simulated)"
      description="No WhatsApp message is ever sent from this PoC."
      footer={
        <div className="flex flex-col-reverse gap-2 sm:flex-row sm:justify-end">
          <button type="button" onClick={close} className={btnSecondary}>
            {results ? "Close" : "Cancel"}
          </button>
          {!results ? (
            <button type="button" onClick={() => void simulate()} disabled={sending || ids.length === 0} className={btnPrimary}>
              {sending ? <Loader2 className="h-4 w-4 animate-spin" aria-hidden /> : <MessageCircle className="h-4 w-4" aria-hidden />}
              Simulate for {plural(ids.length, "student")}
            </button>
          ) : null}
        </div>
      }
    >
      {!results ? (
        <div className="space-y-4 text-sm">
          <p className="flex items-start gap-2 rounded-md border border-amber-200 bg-amber-50 px-3 py-2 text-amber-900">
            <ShieldAlert className="mt-0.5 h-4 w-4 shrink-0 text-amber-600" aria-hidden />
            <span>
              WhatsApp Business delivery needs an approved message template, guardian consent and a data-residency
              decision - none is approved yet (mode: <span className="font-mono">{whatsappMode || "blocked"}</span>).
              This records a delivery attempt per student and creates a signed, time-limited PDF link instead.
            </span>
          </p>
          <p className="text-slate-600">
            {ids.length > 0
              ? `${plural(ids.length, "completed report")} in the current view will be included.`
              : "No completed reports in the current view."}
            {truncated ? ` Only the first ${MAX_DELIVERY_IDS} are sent per request.` : ""}
          </p>
          <div className="space-y-1.5">
            <label htmlFor="wa-recipient" className="block text-[13px] font-medium text-slate-700">
              Test recipient <span className="font-normal text-slate-500">(optional, stored masked)</span>
            </label>
            <input
              id="wa-recipient"
              value={recipient}
              onChange={(e) => setRecipient(e.target.value)}
              maxLength={20}
              inputMode="tel"
              placeholder="+91 98xxxxxx10"
              className={fieldClass}
            />
          </div>
          {error ? (
            <p role="alert" className="rounded-md border border-red-200 bg-red-50 px-3 py-2 text-red-800">
              {error}
            </p>
          ) : null}
        </div>
      ) : (
        <div className="space-y-4 text-sm">
          <p className="flex flex-wrap items-center gap-2 font-medium text-brand-navy">
            <Ban className="h-4 w-4 text-red-600" aria-hidden />
            {plural(results.length, "delivery", "deliveries")} recorded - none sent.
            {[...counts.entries()].map(([status, n]) => (
              <span
                key={status}
                className={cn("rounded-sm px-1.5 py-0.5 text-xs font-medium", statusLook(status).className)}
              >
                {n} {statusLook(status).label}
              </span>
            ))}
          </p>
          <ul className="divide-y divide-slate-100 rounded-md border border-slate-200">
            {results.map((d) => {
              const look = statusLook(d.status);
              const expires = formatExpiry(d.link_expires_at);
              return (
                <li key={d.id} className="space-y-1 px-3 py-2.5">
                  <div className="flex flex-wrap items-center justify-between gap-2">
                    <span className="font-medium text-slate-800">
                      {names.get(d.submission_id) ?? `Submission #${d.submission_id}`}
                    </span>
                    <span className={cn("rounded-sm px-1.5 py-0.5 text-xs font-medium", look.className)}>
                      {look.label}
                    </span>
                  </div>
                  <p className="text-xs text-slate-500">
                    {d.detail}
                    {d.recipient_masked ? ` · to ${d.recipient_masked}` : ""}
                    {d.template_name ? ` · template ${d.template_name}` : ""}
                  </p>
                  {d.download_url ? (
                    <a
                      href={downloadUrl(d.download_url)}
                      target="_blank"
                      rel="noreferrer"
                      className="inline-flex items-center gap-1 rounded-sm text-xs font-medium text-cyan-700 hover:underline focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-cyan-700"
                    >
                      Signed PDF link{expires ? ` (expires ${expires})` : ""}
                      <ExternalLink className="h-3 w-3" aria-hidden />
                    </a>
                  ) : null}
                </li>
              );
            })}
          </ul>
        </div>
      )}
    </Dialog>
  );
}
