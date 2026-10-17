"use client";

import { useEffect, useState } from "react";
import { createPortal } from "react-dom";

type PersonRow = {
  person: { id: string; email: string | null; linkedinUrl: string | null; phone?: string | null; fullName: string | null; title: string | null };
  company: { name: string | null; domain: string } | null;
};

type LiveResult = {
  linkedinUrl: string;
  name: string | null;
  headline: string | null;
  location: string | null;
  profilePictureUrl: string | null;
  networkDistance: string | null;
};

function networkBadge(d: string | null): string | null {
  if (!d) return null;
  const n = d.replace("DISTANCE_", "");
  if (n === "1") return "1st · connection";
  if (n === "2") return "2nd";
  if (n === "3") return "3rd";
  return n === "OUT_OF_NETWORK" ? "Out of network" : null;
}

const isProfileUrl = (value: string) => /^https?:\/\//i.test(value) || /linkedin\.com\//i.test(value);

export default function AddPeopleToCampaignModal({
  campaignId,
  channel,
  onClose,
  onAdded,
}: {
  campaignId: string;
  channel: "email" | "linkedin" | "whatsapp";
  onClose: () => void;
  /** The WhatsApp route reports skippedMissingPhone instead of the identity/suppressed counts. */
  onAdded: (result: { requested: number; added: number; skippedMissingIdentity: number; skippedDuplicate: number; skippedSuppressed: number }) => void;
}) {
  const [rows, setRows] = useState<PersonRow[]>([]);
  const [selected, setSelected] = useState<Set<string>>(new Set());
  const [query, setQuery] = useState("");
  const [loading, setLoading] = useState(true);
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);

  // LinkedIn-only: fetch someone AgentSDR hasn't seen before — the same box takes
  // either a pasted profile URL (resolved and added directly) or a name/keywords
  // (a live LinkedIn search), instead of only picking from the People database.
  const [liveBusy, setLiveBusy] = useState(false);
  const [liveResults, setLiveResults] = useState<LiveResult[] | null>(null);
  const [liveSelected, setLiveSelected] = useState<Set<string>>(new Set());
  const [liveError, setLiveError] = useState<string | null>(null);

  useEffect(() => {
    const controller = new AbortController();
    const timeout = setTimeout(async () => {
      setLoading(true);
      try {
        const params = new URLSearchParams({ limit: "100" });
        if (query.trim()) params.set("q", query.trim());
        const response = await fetch(`/api/leads/people?${params}`, { signal: controller.signal });
        const body = await response.json();
        if (!response.ok) throw new Error(body.error ?? "Could not load people");
        setRows(body.people ?? []);
      } catch (cause) {
        if (!controller.signal.aborted) setError(cause instanceof Error ? cause.message : "Could not load people");
      } finally {
        if (!controller.signal.aborted) setLoading(false);
      }
    }, 250);
    return () => {
      clearTimeout(timeout);
      controller.abort();
    };
  }, [query]);

  async function submit() {
    setSaving(true);
    setError(null);
    try {
      const url = channel === "whatsapp" ? `/api/whatsapp/campaigns/${campaignId}/leads` : `/api/${channel === "email" ? "outreach" : "linkedin"}/campaigns/${campaignId}/people`;
      const response = await fetch(url, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        // Sequence templates belong to the campaign editor. Including blank
        // template fields here would clear an existing LinkedIn sequence.
        body: JSON.stringify({ personIds: [...selected] }),
      });
      const body = await response.json();
      if (!response.ok) throw new Error(body.error ?? "Could not add people");
      onAdded(
        channel === "whatsapp"
          ? {
              requested: selected.size,
              added: Number(body.added ?? 0),
              skippedMissingIdentity: Number(body.skippedMissingPhone ?? 0),
              skippedDuplicate: Number(body.skippedDuplicate ?? 0),
              skippedSuppressed: 0,
            }
          : body,
      );
      onClose();
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : "Could not add people");
    } finally {
      setSaving(false);
    }
  }

  async function fetchByUrl(url: string) {
    setLiveBusy(true);
    setLiveError(null);
    try {
      const response = await fetch(`/api/linkedin/campaigns/${campaignId}/from-lookup`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ url }),
      });
      const body = await response.json();
      if (!response.ok || !body.ok) throw new Error(body.error ?? "Could not fetch that profile");
      const added = Number(body.created ?? 0) + Number(body.attached ?? 0);
      onAdded({ requested: 1, added, skippedMissingIdentity: 0, skippedDuplicate: Number(body.skipped ?? 0), skippedSuppressed: 0 });
      onClose();
    } catch (cause) {
      setLiveError(cause instanceof Error ? cause.message : "Could not fetch that profile");
    } finally {
      setLiveBusy(false);
    }
  }

  async function searchLive(keywords: string) {
    setLiveBusy(true);
    setLiveError(null);
    try {
      const response = await fetch("/api/linkedin/search/live", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ query: keywords }),
      });
      const body = await response.json();
      if (!response.ok || !body.ok) throw new Error(body.error ?? "LinkedIn search failed");
      setLiveResults(body.results ?? []);
      setLiveSelected(new Set());
    } catch (cause) {
      setLiveError(cause instanceof Error ? cause.message : "LinkedIn search failed");
    } finally {
      setLiveBusy(false);
    }
  }

  function runLinkedinLookup() {
    const value = query.trim();
    if (!value) return;
    void (isProfileUrl(value) ? fetchByUrl(value) : searchLive(value));
  }

  async function addLiveSelected() {
    const rows = (liveResults ?? []).filter((r) => liveSelected.has(r.linkedinUrl));
    if (rows.length === 0) return;
    setSaving(true);
    setLiveError(null);
    try {
      const response = await fetch(`/api/linkedin/campaigns/${campaignId}/from-lookup`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ rows }),
      });
      const body = await response.json();
      if (!response.ok || !body.ok) throw new Error(body.error ?? "Could not add selected leads");
      const added = Number(body.created ?? 0) + Number(body.attached ?? 0);
      onAdded({ requested: rows.length, added, skippedMissingIdentity: 0, skippedDuplicate: Number(body.skipped ?? 0), skippedSuppressed: 0 });
      onClose();
    } catch (cause) {
      setLiveError(cause instanceof Error ? cause.message : "Could not add selected leads");
    } finally {
      setSaving(false);
    }
  }

  const identity = (person: PersonRow["person"]) => (channel === "email" ? person.email : channel === "whatsapp" ? person.phone : person.linkedinUrl);
  const eligible = rows.filter(({ person }) => identity(person));
  return createPortal(
    <div className="fixed inset-0 z-[100] flex items-center justify-center p-4">
      <button className="absolute inset-0 bg-slate-950/50" aria-label="Close" onClick={onClose} />
      <div className="relative flex max-h-[80vh] w-full max-w-2xl flex-col rounded-2xl bg-white shadow-2xl">
        <div className="border-b border-slate-200 p-5">
          <h2 className="text-base font-semibold text-slate-900">Add from People</h2>
          <p className="mt-1 text-sm text-slate-500">Only people with a {channel === "email" ? "valid email" : channel === "whatsapp" ? "phone number" : "LinkedIn profile"} can be selected.</p>
          <div className="mt-4 flex gap-2">
            <input
              className="h-10 min-w-0 flex-1 rounded-lg border border-slate-200 px-3 text-sm outline-none focus:border-indigo-400"
              placeholder={channel === "linkedin" ? "Search name, email, company — or paste a LinkedIn profile URL" : "Search name, email, company, domain, or LinkedIn…"}
              value={query}
              onChange={(event) => { setQuery(event.target.value); setLiveResults(null); }}
              onKeyDown={(event) => { if (event.key === "Enter" && channel === "linkedin") runLinkedinLookup(); }}
            />
            {channel === "linkedin" && (
              <button
                type="button"
                className="shrink-0 rounded-lg bg-indigo-600 px-3 text-sm font-medium text-white hover:bg-indigo-700 disabled:opacity-50"
                disabled={!query.trim() || liveBusy}
                onClick={runLinkedinLookup}
              >
                {liveBusy ? "Working…" : isProfileUrl(query.trim()) ? "Fetch & add" : "Search LinkedIn live"}
              </button>
            )}
          </div>
          {liveError && <p className="mt-2 text-sm text-red-600">{liveError}</p>}
        </div>
        {liveResults && (
          <div className="border-b border-slate-200 bg-slate-50 p-3">
            <p className="px-2 pb-1 text-xs font-medium text-slate-500">
              {liveResults.length === 0 ? "No results on LinkedIn for that search." : `${liveResults.length} found on LinkedIn — pick who to add`}
            </p>
            <div className="max-h-56 overflow-y-auto">
              {liveResults.map((r) => (
                <label key={r.linkedinUrl} className="flex cursor-pointer items-center gap-3 rounded-lg px-3 py-2 hover:bg-white">
                  <input
                    type="checkbox"
                    checked={liveSelected.has(r.linkedinUrl)}
                    onChange={() => setLiveSelected((current) => {
                      const next = new Set(current);
                      if (next.has(r.linkedinUrl)) next.delete(r.linkedinUrl); else next.add(r.linkedinUrl);
                      return next;
                    })}
                  />
                  <span className="min-w-0 flex-1">
                    <span className="block truncate text-sm font-medium text-slate-900">{r.name || r.linkedinUrl}</span>
                    <span className="block truncate text-xs text-slate-500">{r.headline}{r.location ? ` · ${r.location}` : ""}</span>
                  </span>
                  {networkBadge(r.networkDistance) && (
                    <span className="shrink-0 rounded-full bg-emerald-100 px-2 py-0.5 text-xs font-medium text-emerald-700">{networkBadge(r.networkDistance)}</span>
                  )}
                </label>
              ))}
            </div>
            {liveResults.length > 0 && (
              <div className="flex justify-end pt-2">
                <button
                  type="button"
                  className="rounded-lg bg-indigo-600 px-3 py-1.5 text-sm font-medium text-white disabled:opacity-50"
                  disabled={!liveSelected.size || saving}
                  onClick={() => void addLiveSelected()}
                >
                  {saving ? "Adding…" : `Add ${liveSelected.size || ""} selected`}
                </button>
              </div>
            )}
          </div>
        )}
        <div className="min-h-48 flex-1 overflow-y-auto p-3">
          {loading ? <p className="p-4 text-sm text-slate-500">Loading…</p> : eligible.length === 0 ? <p className="p-4 text-sm text-slate-500">No eligible people found.</p> : eligible.map(({ person, company }) => (
            <label key={person.id} className="flex cursor-pointer items-center gap-3 rounded-lg px-3 py-2 hover:bg-slate-50">
              <input
                type="checkbox"
                checked={selected.has(person.id)}
                onChange={() => setSelected((current) => {
                  const next = new Set(current);
                  if (next.has(person.id)) next.delete(person.id); else next.add(person.id);
                  return next;
                })}
              />
              <span className="min-w-0 flex-1">
                <span className="block truncate text-sm font-medium text-slate-900">{person.fullName || person.email || person.phone || person.linkedinUrl}</span>
                <span className="block truncate text-xs text-slate-500">{identity(person)}{company?.name ? ` · ${company.name}` : ""}</span>
              </span>
            </label>
          ))}
        </div>
        {error && <p className="px-5 pb-2 text-sm text-red-600">{error}</p>}
        <div className="flex justify-end gap-2 border-t border-slate-200 p-4">
          <button className="rounded-lg border border-slate-200 px-4 py-2 text-sm" onClick={onClose}>Cancel</button>
          <button className="rounded-lg bg-indigo-600 px-4 py-2 text-sm font-medium text-white disabled:opacity-50" disabled={!selected.size || saving} onClick={submit}>
            {saving ? "Adding…" : `Add ${selected.size || ""} ${selected.size === 1 ? "person" : "people"}`}
          </button>
        </div>
      </div>
    </div>,
    document.body,
  );
}
