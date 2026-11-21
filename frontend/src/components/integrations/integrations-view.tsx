"use client";

import { Plug } from "lucide-react";
import { AiProvidersCard } from "./ai-providers";
import { ApiKeysCard } from "./api-keys";
import { LmsCard } from "./lms-card";

/** /integrations: LMS export (FR-5.10) and the AI provider chain with its fallback drill (FR-3.10). */
export function IntegrationsView() {
  return (
    <div className="space-y-6">
      <header>
        <p className="text-xs font-semibold uppercase tracking-[0.16em] text-brand-cyan-600">Admin</p>
        <h1 className="mt-1 flex items-center gap-2 text-2xl font-bold tracking-tight text-brand-navy sm:text-3xl">
          <Plug className="h-7 w-7 text-brand-navy/70" aria-hidden />
          Integrations
        </h1>
        <p className="mt-1 max-w-3xl text-sm text-slate-600">
          LMS export keys and endpoints, and the AI provider chain. OpenAI routes (GPT-4o fallback, voice transcription)
          are not residency-approved - PoC only. No login in this PoC: anyone who opens this page can manage keys.
        </p>
      </header>
      <LmsCard />
      <ApiKeysCard />
      <AiProvidersCard />
    </div>
  );
}
