"use client";

import { PageHeader } from "@/components/owner/states";
import { AiProvidersCard } from "./ai-providers";
import { ApiKeysCard } from "./api-keys";
import { LmsCard } from "./lms-card";

/** /integrations: LMS export (FR-5.10) and the AI provider chain with its fallback drill (FR-3.10). */
export function IntegrationsView() {
  return (
    <div className="space-y-6">
      <PageHeader
        title="Integrations"
        description={
          <>
            <p>LMS export keys and endpoints, and the AI provider chain.</p>
            <p className="mt-0.5 text-[13px] text-slate-500">
              OpenAI routes (GPT-4o fallback, voice transcription) are not residency-approved, PoC only. No login in this
              PoC: anyone who opens this page can manage keys.
            </p>
          </>
        }
      />
      <LmsCard />
      <ApiKeysCard />
      <AiProvidersCard />
    </div>
  );
}
