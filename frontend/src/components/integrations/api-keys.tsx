"use client";

import { useCallback, useState, type FormEvent } from "react";
import { Loader2, Plus } from "lucide-react";
import { useHealth } from "@/components/app-shell";
import { btnPrimary, btnSecondary, Dialog, fieldClass } from "@/components/cohort/dialog";
import { fmtDateTime } from "@/components/owner/format";
import {
  CardSkeleton,
  EmptyNote,
  ErrorNote,
  focusRing,
  Panel,
  tagCls,
  theadCls,
  thCls,
} from "@/components/owner/states";
import { useAsync } from "@/components/owner/use-async";
import { createApiKey, getApiKeys, getInstitutions, lmsPreview, revokeApiKey } from "@/lib/api";
import type { ApiKey, ApiKeyCreated, Institution, LmsResultRow } from "@/lib/types";
import { cn } from "@/lib/utils";
import { CopyButton } from "./copy-button";
import { LmsPreviewTable } from "./preview-table";

const PREVIEW_QUERY = { include_provisional: true, limit: 20 } as const;

/** Institutions for the key scope (GET /api/institutions), else the health institution. */
function useInstitutions(): Institution[] {
  const { health } = useHealth();
  const { data } = useAsync(getInstitutions);
  if (data?.length) return data;
  return health?.institution ? [health.institution] : [];
}

/** Runs lmsPreview with a secret held only in the caller's state (never stored or logged). */
function usePreview() {
  const [rows, setRows] = useState<LmsResultRow[] | null>(null);
  const [error, setError] = useState<unknown>(null);
  const [running, setRunning] = useState(false);
  const run = useCallback(async (secret: string) => {
    setRunning(true);
    setError(null);
    setRows(null);
    try {
      setRows(await lmsPreview(secret, PREVIEW_QUERY));
    } catch (err) {
      setError(err);
    } finally {
      setRunning(false);
    }
  }, []);
  const reset = useCallback(() => {
    setRows(null);
    setError(null);
  }, []);
  return { rows, error, running, run, reset };
}

function CreateKeyDialog({
  open,
  onClose,
  institutions,
  onCreated,
}: {
  open: boolean;
  onClose: () => void;
  institutions: Institution[];
  onCreated: () => void;
}) {
  const [name, setName] = useState("");
  const [institution, setInstitution] = useState("");
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<unknown>(null);
  // The secret lives only here and is cleared on close.
  const [created, setCreated] = useState<ApiKeyCreated | null>(null);
  const preview = usePreview();

  function close() {
    setCreated(null);
    setName("");
    setInstitution("");
    setError(null);
    preview.reset();
    onClose();
  }

  async function submit(e: FormEvent) {
    e.preventDefault();
    if (!name.trim()) return;
    setSaving(true);
    setError(null);
    try {
      const res = await createApiKey({ name: name.trim(), institution_id: institution ? Number(institution) : null });
      setCreated(res);
      onCreated();
    } catch (err) {
      setError(err);
    } finally {
      setSaving(false);
    }
  }

  return (
    <Dialog
      open={open}
      onClose={close}
      eyebrow="LMS export"
      title={created ? "Key created" : "Create API key"}
      description={created ? undefined : "For one LMS or ERP integration. You can revoke it at any time."}
      size="lg"
      footer={
        created ? (
          <div className="flex justify-end">
            <button type="button" className={btnPrimary} onClick={close}>
              Done - I copied it
            </button>
          </div>
        ) : (
          <div className="flex justify-end gap-2">
            <button type="button" className={btnSecondary} onClick={close}>
              Cancel
            </button>
            <button type="submit" form="create-key-form" className={btnPrimary} disabled={saving || !name.trim()}>
              {saving ? <Loader2 className="h-4 w-4 animate-spin" aria-hidden /> : null}
              Create key
            </button>
          </div>
        )
      }
    >
      {created ? (
        <div className="space-y-4">
          <p role="status" className="rounded-md border border-amber-300 bg-amber-50 px-3 py-2 text-sm font-medium text-amber-900">
            Copy it now. It is stored hashed and cannot be shown again.
          </p>
          <div>
            <label htmlFor="new-key-secret" className="mb-1 block text-xs font-medium text-slate-600">
              Secret for &ldquo;{created.key.name}&rdquo;
            </label>
            <div className="flex items-center gap-2">
              <input
                id="new-key-secret"
                readOnly
                value={created.secret}
                onFocus={(e) => e.currentTarget.select()}
                autoComplete="off"
                spellCheck={false}
                className={cn(fieldClass, "font-mono text-xs")}
              />
              <CopyButton text={created.secret} />
            </div>
          </div>
          <div>
            <button
              type="button"
              className={btnSecondary}
              onClick={() => void preview.run(created.secret)}
              disabled={preview.running}
            >
              {preview.running ? <Loader2 className="h-4 w-4 animate-spin" aria-hidden /> : null}
              Preview first 20 rows
            </button>
            <div className="mt-3" aria-live="polite">
              {preview.error ? <ErrorNote error={preview.error} prefix="Preview failed" /> : null}
              {preview.rows ? <LmsPreviewTable rows={preview.rows} /> : null}
            </div>
          </div>
        </div>
      ) : (
        <form id="create-key-form" onSubmit={(e) => void submit(e)} className="space-y-4">
          <label className="block text-sm">
            <span className="mb-1 block text-xs font-medium text-slate-600">Name</span>
            <input
              className={fieldClass}
              value={name}
              onChange={(e) => setName(e.target.value)}
              maxLength={120}
              required
              placeholder="e.g. Moodle sync"
              autoFocus
            />
          </label>
          <label className="block text-sm">
            <span className="mb-1 block text-xs font-medium text-slate-600">Institution scope</span>
            <select className={fieldClass} value={institution} onChange={(e) => setInstitution(e.target.value)}>
              <option value="">All institutions</option>
              {institutions.map((i) => (
                <option key={i.id} value={i.id}>
                  {i.name}
                </option>
              ))}
            </select>
          </label>
          {error ? <ErrorNote error={error} prefix="Could not create the key" /> : null}
        </form>
      )}
    </Dialog>
  );
}

function RevokeDialog({ apiKey, onClose, onRevoked }: { apiKey: ApiKey | null; onClose: () => void; onRevoked: () => void }) {
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<unknown>(null);

  async function revoke() {
    if (!apiKey) return;
    setBusy(true);
    setError(null);
    try {
      await revokeApiKey(apiKey.id);
      onRevoked();
      onClose();
    } catch (err) {
      setError(err);
    } finally {
      setBusy(false);
    }
  }

  return (
    <Dialog
      open={apiKey !== null}
      onClose={() => {
        setError(null);
        onClose();
      }}
      title={`Revoke "${apiKey?.name ?? ""}"?`}
      description="Integrations using this key stop working immediately (HTTP 403). This cannot be undone."
      footer={
        <div className="flex justify-end gap-2">
          <button type="button" className={btnSecondary} onClick={onClose}>
            Keep key
          </button>
          <button
            type="button"
            onClick={() => void revoke()}
            disabled={busy}
            className={cn(btnPrimary, "bg-rose-700 hover:bg-rose-800")}
          >
            {busy ? <Loader2 className="h-4 w-4 animate-spin" aria-hidden /> : null}
            Revoke key
          </button>
        </div>
      }
    >
      <p className="text-sm text-slate-700">
        Key <span className="font-mono">{apiKey?.prefix}…</span> has been used {apiKey?.use_count ?? 0} times.
      </p>
      {error ? <ErrorNote error={error} className="mt-3" prefix="Could not revoke" /> : null}
    </Dialog>
  );
}

/** Pasted-key preview: a password field kept only in component state (never persisted). */
function PastePreview() {
  const [secret, setSecret] = useState("");
  const preview = usePreview();
  return (
    <div className="border-t border-slate-200 pt-4">
      <h3 className="text-sm font-semibold text-brand-navy">Preview first 20 rows</h3>
      <p className="mt-0.5 text-[13px] text-slate-500">
        Paste a key to see what the LMS receives (released and provisional results). The key is not saved anywhere.
      </p>
      <form
        className="mt-3 flex flex-col gap-2 sm:flex-row sm:items-end"
        onSubmit={(e) => {
          e.preventDefault();
          if (secret.trim()) void preview.run(secret.trim());
        }}
      >
        <label className="block min-w-0 flex-1 text-sm">
          <span className="mb-1 block text-xs font-medium text-slate-600">API key</span>
          <input
            type="password"
            autoComplete="off"
            value={secret}
            onChange={(e) => setSecret(e.target.value)}
            className={cn(fieldClass, "font-mono")}
            placeholder="Paste the key"
          />
        </label>
        <button type="submit" className={btnSecondary} disabled={!secret.trim() || preview.running}>
          {preview.running ? <Loader2 className="h-4 w-4 animate-spin" aria-hidden /> : null}
          Preview
        </button>
        {secret ? (
          <button
            type="button"
            className={cn("self-start px-1 py-2.5 text-xs text-brand-cyan-600 underline-offset-2 hover:underline sm:self-auto", focusRing)}
            onClick={() => {
              setSecret("");
              preview.reset();
            }}
          >
            Clear key
          </button>
        ) : null}
      </form>
      <div className="mt-3" aria-live="polite">
        {preview.error ? <ErrorNote error={preview.error} prefix="Preview failed" /> : null}
        {preview.rows ? <LmsPreviewTable rows={preview.rows} /> : null}
      </div>
    </div>
  );
}

/** API keys for the LMS export: list, create (secret shown once), revoke, and preview. */
export function ApiKeysCard() {
  const fetcher = useCallback(() => getApiKeys(), []);
  const { data, error, loading, reload } = useAsync(fetcher);
  const institutions = useInstitutions();
  const [creating, setCreating] = useState(false);
  const [revoking, setRevoking] = useState<ApiKey | null>(null);

  const instName = (id: number | null) =>
    id === null ? "All institutions" : (institutions.find((i) => i.id === id)?.name ?? `Institution ${id}`);

  if (!data && loading) return <CardSkeleton rows={3} label="Loading API keys…" />;

  return (
    <Panel
      id="keys-title"
      title="API keys"
      subtitle="Only a SHA-256 hash of each key is stored; the secret is shown once at creation."
      action={
        <button type="button" className={btnPrimary} onClick={() => setCreating(true)}>
          <Plus className="h-4 w-4" aria-hidden />
          Create key
        </button>
      }
    >
      {error ? <ErrorNote error={error} onRetry={() => void reload()} retrying={loading} /> : null}
      {data ? (
        data.length === 0 ? (
          <EmptyNote>No keys yet. Create one for each LMS or ERP that should read results.</EmptyNote>
        ) : (
          <div className="relative -mx-4 -mt-4 overflow-x-auto sm:-mx-5">
            <table className="w-full min-w-[820px] border-collapse text-sm">
              <caption className="sr-only">API keys</caption>
              <thead className={theadCls}>
                <tr>
                  <th scope="col" className={cn(thCls, "pl-4 sm:pl-5")}>Name</th>
                  <th scope="col" className={thCls}>Key</th>
                  <th scope="col" className={thCls}>Institution</th>
                  <th scope="col" className={thCls}>Created</th>
                  <th scope="col" className={thCls}>Last used</th>
                  <th scope="col" className={cn(thCls, "text-right")}>Uses</th>
                  <th scope="col" className={thCls}>Status</th>
                  <th scope="col" className={cn(thCls, "pr-4 sm:pr-5")}>
                    <span className="sr-only">Actions</span>
                  </th>
                </tr>
              </thead>
              <tbody className="divide-y divide-slate-200 border-b border-slate-200">
                {data.map((k) => (
                  <tr key={k.id} className={cn(!k.active && "text-slate-500")}>
                    <th scope="row" className="px-3 py-2 pl-4 text-left font-medium text-slate-800 sm:pl-5">{k.name}</th>
                    <td className="px-3 py-2 font-mono text-xs text-slate-700">{k.prefix}…</td>
                    <td className="px-3 py-2 text-slate-700">{instName(k.institution_id)}</td>
                    <td className="px-3 py-2 whitespace-nowrap text-slate-700">{fmtDateTime(k.created_at)}</td>
                    <td className="px-3 py-2 whitespace-nowrap text-slate-700">{k.last_used_at ? fmtDateTime(k.last_used_at) : "Never"}</td>
                    <td className="px-3 py-2 text-right tabular-nums text-slate-700">{k.use_count}</td>
                    <td className="px-3 py-2">
                      {k.active ? (
                        <span className={cn(tagCls, "bg-brand-lime-50 text-lime-800")}>Active</span>
                      ) : (
                        <span
                          className={cn(tagCls, "bg-rose-50 text-rose-700")}
                          title={k.revoked_at ? `Revoked ${fmtDateTime(k.revoked_at)}` : "Revoked"}
                        >
                          Revoked
                        </span>
                      )}
                    </td>
                    <td className="px-3 py-2 pr-4 text-right sm:pr-5">
                      {k.active ? (
                        <button
                          type="button"
                          onClick={() => setRevoking(k)}
                          className={cn("inline-flex h-8 items-center rounded-md px-2 text-xs font-medium text-rose-700 hover:bg-rose-50", focusRing)}
                          aria-label={`Revoke key ${k.name}`}
                        >
                          Revoke
                        </button>
                      ) : null}
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )
      ) : null}

      <PastePreview />

      <CreateKeyDialog
        open={creating}
        onClose={() => setCreating(false)}
        institutions={institutions}
        onCreated={() => void reload()}
      />
      <RevokeDialog apiKey={revoking} onClose={() => setRevoking(null)} onRevoked={() => void reload()} />
    </Panel>
  );
}
