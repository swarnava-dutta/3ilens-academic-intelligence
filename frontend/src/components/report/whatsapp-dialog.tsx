"use client";

import { Check, Copy, Link2, MessageCircle, ShieldAlert } from "lucide-react";
import { useState } from "react";
import { createDeliveries, downloadUrl, errorMessage } from "@/lib/api";
import type { Delivery } from "@/lib/types";
import { cn } from "@/lib/utils";
import { Modal, Notice, btnPrimary, btnSecondary, inputClass } from "./dialog";
import { fmtIST } from "./format";
import { normalizeDelivery } from "./normalize";

export const WHATSAPP_TEMPLATE = "Namaste {{1}}, {{2}}'s 3iLens report for {{3}} is ready. Download (valid 24 h): {{4}}";
export const SIMULATED_CAPTION = "Simulated channel - Gupshup/Twilio integration out of PoC scope";

/** "+91 98765 43210" -> "+91 98••••••10" (only the country code and the last two digits stay visible). */
export function maskRecipient(raw: string): string {
  const digits = raw.replace(/\D/g, "");
  if (!digits) return "";
  const hasPlus = raw.trim().startsWith("+");
  const cc = hasPlus && digits.length > 10 ? digits.slice(0, digits.length - 10) : "";
  const local = cc ? digits.slice(cc.length) : digits;
  const visibleHead = local.slice(0, Math.min(2, Math.max(0, local.length - 4)));
  const visibleTail = local.length > 4 ? local.slice(-2) : "";
  const hidden = Math.max(0, local.length - visibleHead.length - visibleTail.length);
  return `${cc ? `+${cc} ` : ""}${visibleHead}${"•".repeat(hidden)}${visibleTail}`;
}

/** Never "sent": the PoC only records a blocked / simulated delivery and issues a signed link. */
export function deliveryHeadline(d: Pick<Delivery, "status">): string {
  return d.status === "BLOCKED_TEMPLATE_PENDING"
    ? "Blocked - template awaiting Meta approval · NOT sent"
    : "Simulated only · NOT sent";
}

export async function copyText(text: string): Promise<boolean> {
  try {
    await navigator.clipboard.writeText(text);
    return true;
  } catch {
    try {
      const area = document.createElement("textarea");
      area.value = text;
      area.setAttribute("readonly", "");
      area.style.position = "fixed";
      area.style.opacity = "0";
      document.body.appendChild(area);
      area.select();
      const ok = document.execCommand("copy");
      area.remove();
      return ok;
    } catch {
      return false;
    }
  }
}

/** Copy-to-clipboard button with a short "Copied" confirmation. */
export function CopyButton({ text, label = "Copy link", className }: { text: string; label?: string; className?: string }) {
  const [state, setState] = useState<"idle" | "copied" | "failed">("idle");
  return (
    <button
      type="button"
      onClick={async () => {
        const ok = await copyText(text);
        setState(ok ? "copied" : "failed");
        window.setTimeout(() => setState("idle"), 1800);
      }}
      className={cn(
        "inline-flex items-center gap-1.5 rounded-full bg-white px-3 py-1.5 text-xs font-medium text-slate-700 ring-1 ring-inset ring-slate-300 transition hover:bg-slate-50 focus-visible:outline-2 focus-visible:outline-brand-cyan",
        className,
      )}
    >
      {state === "copied" ? <Check className="h-3.5 w-3.5 text-lime-700" aria-hidden /> : <Copy className="h-3.5 w-3.5" aria-hidden />}
      {state === "copied" ? "Copied" : state === "failed" ? "Copy failed" : label}
    </button>
  );
}

/** One delivery row: amber "Blocked ... NOT sent" plus the signed download link (never "sent"). */
export function DeliveryResult({ delivery }: { delivery: Delivery }) {
  const link = delivery.download_url ? downloadUrl(delivery.download_url) : null;
  return (
    <div className="rounded-xl border border-amber-300 bg-amber-50 p-3 text-sm text-amber-950 [print-color-adjust:exact]">
      <p className="flex items-start gap-2 font-semibold">
        <ShieldAlert className="mt-0.5 h-4 w-4 shrink-0 text-amber-700" aria-hidden />
        <span>
          {deliveryHeadline(delivery)}
          {link ? (
            <span className="font-normal">
              {" "}
              · secure download link issued
              {delivery.link_expires_at ? ` (expires ${fmtIST(delivery.link_expires_at)})` : ""}
            </span>
          ) : null}
        </span>
      </p>
      <p className="mt-1 text-xs text-amber-900/80">
        {delivery.recipient_masked ? `Recipient ${delivery.recipient_masked} · ` : ""}
        Template {delivery.template_name || "—"} · {delivery.detail}
      </p>
      {link ? (
        <div className="mt-2 flex flex-wrap items-center gap-2">
          <code className="min-w-0 flex-1 truncate rounded-md bg-white/80 px-2 py-1 font-mono text-[11px] text-slate-600 ring-1 ring-inset ring-amber-200">
            {link}
          </code>
          <CopyButton text={link} />
        </div>
      ) : null}
    </div>
  );
}

/**
 * Simulated WhatsApp delivery (FR-5.4 mock). Records BLOCKED / SIMULATED_NOT_SENT rows through
 * POST /api/deliveries and shows the signed 24 h download link. Nothing is ever sent.
 */
export function WhatsAppDialog({
  open,
  onClose,
  submissionIds,
  studentName,
  testName,
  onDelivered,
}: {
  open: boolean;
  onClose: () => void;
  submissionIds: number[];
  /** Shown in the template preview; omitted for multi-student sends. */
  studentName?: string;
  testName?: string;
  onDelivered?: (rows: Delivery[]) => void;
}) {
  const [recipient, setRecipient] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [results, setResults] = useState<Delivery[] | null>(null);

  const close = () => {
    setRecipient("");
    setError(null);
    setResults(null);
    setBusy(false);
    onClose();
  };

  const masked = maskRecipient(recipient);
  const preview = WHATSAPP_TEMPLATE.replace("{{1}}", "Parent/guardian")
    .replace("{{2}}", studentName || "<student>")
    .replace("{{3}}", testName || "<test>")
    .replace("{{4}}", "<signed link>");
  const count = submissionIds.length;

  async function submit() {
    setBusy(true);
    setError(null);
    try {
      const rows = await createDeliveries({
        submission_ids: submissionIds,
        channel: "whatsapp",
        recipient: recipient.trim() ? recipient.trim() : null,
      });
      const list = (Array.isArray(rows) ? rows : []).filter((d) => typeof d?.id === "number").map(normalizeDelivery);
      setResults(list);
      onDelivered?.(list);
    } catch (err) {
      setError(errorMessage(err));
    } finally {
      setBusy(false);
    }
  }

  return (
    <Modal
      open={open}
      onClose={close}
      eyebrow="Simulated channel"
      title="Send via WhatsApp"
      description={count > 1 ? `${count} reports` : studentName ? `${studentName}'s report` : undefined}
      footer={
        <div className="flex flex-col gap-2 sm:flex-row sm:items-center sm:justify-between">
          <p className="text-xs text-slate-500">{SIMULATED_CAPTION}</p>
          <div className="flex justify-end gap-2">
            <button type="button" className={btnSecondary} onClick={close}>
              {results ? "Done" : "Cancel"}
            </button>
            {results ? null : (
              <button type="button" className={btnPrimary} onClick={submit} disabled={busy || count === 0}>
                <MessageCircle className="h-4 w-4" aria-hidden />
                {busy ? "Recording…" : "Simulate delivery"}
              </button>
            )}
          </div>
        </div>
      }
    >
      <div className="space-y-4">
        <div>
          <p className="mb-1.5 text-xs font-semibold uppercase tracking-wider text-slate-500">
            Template preview · 3ilens_report_ready_v1 (assumed)
          </p>
          <div className="rounded-2xl rounded-tl-sm bg-[#e7fbe6] p-3 text-sm leading-relaxed text-slate-800 shadow-sm ring-1 ring-inset ring-emerald-200">
            {preview}
          </div>
          <p className="mt-1 font-mono text-[11px] text-slate-400">{WHATSAPP_TEMPLATE}</p>
        </div>

        {results ? (
          <div className="space-y-2" aria-live="polite">
            {results.length === 0 ? (
              <Notice tone="warn">No delivery rows were returned. Nothing was sent.</Notice>
            ) : (
              results.map((d) => <DeliveryResult key={d.id} delivery={d} />)
            )}
          </div>
        ) : (
          <label className="block">
            <span className="mb-1 block text-sm font-medium text-slate-700">Parent / guardian WhatsApp number</span>
            <input
              type="tel"
              inputMode="tel"
              autoComplete="off"
              className={inputClass}
              placeholder="+91 98765 43210 (optional)"
              value={recipient}
              onChange={(e) => setRecipient(e.target.value)}
            />
            <span className="mt-1 flex items-center gap-1.5 text-xs text-slate-500">
              <Link2 className="h-3.5 w-3.5" aria-hidden />
              {masked ? (
                <>
                  Stored masked as <span className="font-mono text-slate-700">{masked}</span>
                </>
              ) : (
                "Only a masked number is stored. Leave empty to issue the download link only."
              )}
            </span>
          </label>
        )}

        {error ? <Notice tone="error">{error}</Notice> : null}

        <Notice tone="warn">
          The WhatsApp template is awaiting Meta approval, so no message leaves this PoC. A signed download link
          (valid 24 h) is issued instead.
        </Notice>
      </div>
    </Modal>
  );
}
