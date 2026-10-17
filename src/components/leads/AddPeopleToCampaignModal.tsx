"use client";

import { linkedinProfileUrl } from "@/lib/leads/identity";
import { useEffect, useState } from "react";
import { createPortal } from "react-dom";
import { RiLoader4Line } from "@remixicon/react";
import * as Button from "@/components/alignui/button";
import * as Checkbox from "@/components/alignui/checkbox";
import * as Input from "@/components/alignui/input";

type PersonRow = {
  person: { id: string; email: string | null; linkedinUrl: string | null; phone?: string | null; fullName: string | null; title: string | null };
  company: { name: string | null; domain: string } | null;
};

type LiveResult = {
  linkedinUrl: string;
  providerId?: string | null;
  publicIdentifier?: string | null;
  sourceLinkedinApi: string | null;
  name: string | null;
  headline: string | null;
  company: string | null;
  location: string | null;
  profilePictureUrl: string | null;
  networkDistance: string | null;
};

type LiveCompany = { id: string; name: string; industry: string | null; location: string | null; peopleSearchUrl: string };

/** Leopile says DISTANCE_1/2/3, Unipile FIRST_DEGREE/SECOND_DEGREE/THIRD_DEGREE. */
const degree = (d: string | null): 1 | 2 | 3 | null =>
  d === "DISTANCE_1" || d === "FIRST_DEGREE" ? 1 : d === "DISTANCE_2" || d === "SECOND_DEGREE" ? 2 : d === "DISTANCE_3" || d === "THIRD_DEGREE" ? 3 : null;

function networkBadge(d: string | null): string | null {
  const n = degree(d);
  if (n === 1) return "1st · connected, won't be invited";
  if (n === 2) return "2nd";
  if (n === 3) return "3rd";
  return d === "OUT_OF_NETWORK" ? "Out of network" : null;
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

  // LinkedIn-only: find people AgentSDR hasn't seen before — the same box takes a
  // pasted profile or search URL, or a name/keywords (people or companies). Every
  // path lands in a preview list; nothing is added until "Add N leads".
  const [liveBusy, setLiveBusy] = useState(false);
  const [liveKind, setLiveKind] = useState<"people" | "companies">("people");
  const [connectionsOnly, setConnectionsOnly] = useState(false);
  const [liveResults, setLiveResults] = useState<LiveResult[] | null>(null);
  const [liveCompanies, setLiveCompanies] = useState<LiveCompany[] | null>(null);
  const [liveCompanyName, setLiveCompanyName] = useState<string | null>(null);
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

  async function searchLive(keywords: string, kind: "people" | "companies", companyName: string | null = null) {
    setLiveBusy(true);
    setLiveError(null);
    try {
      const response = await fetch("/api/linkedin/search/live", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ query: keywords, kind, connectionsOnly }),
      });
      const body = await response.json();
      if (!response.ok || !body.ok) throw new Error(body.error ?? "LinkedIn search failed");
      setLiveCompanies(kind === "companies" ? body.companies ?? [] : null);
      setLiveResults(kind === "companies" ? null : body.results ?? []);
      setLiveCompanyName(companyName);
    } catch (cause) {
      setLiveError(cause instanceof Error ? cause.message : "LinkedIn search failed");
    } finally {
      setLiveBusy(false);
    }
  }

  function runLinkedinLookup() {
    const value = query.trim();
    if (!value) return;
    void searchLive(value, isProfileUrl(value) ? "people" : liveKind);
  }

  async function addLiveSelected() {
    const rows = liveResults ?? [];
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
  const pastedUrl = channel === "linkedin" && isProfileUrl(query.trim());
  const toggle = (set: Set<string>, id: string) => {
    const next = new Set(set);
    if (next.has(id)) next.delete(id); else next.add(id);
    return next;
  };
  return createPortal(
    <div className="fixed inset-0 z-[100] flex items-center justify-center p-4">
      <button className="absolute inset-0 bg-overlay backdrop-blur-[2px]" aria-label="Close" onClick={onClose} />
      <div className="relative flex max-h-[80vh] w-full max-w-2xl flex-col rounded-2xl bg-bg-white-0 shadow-regular-md ring-1 ring-inset ring-stroke-soft-200">
        <div className="border-b border-stroke-soft-200 p-5">
          <h2 className="text-label-lg text-text-strong-950">Add from People</h2>
          <p className="mt-1 text-paragraph-sm text-text-sub-600">
            {channel === "linkedin"
              ? "Pick people already in your database, paste a LinkedIn profile URL, or type a name and search LinkedIn."
              : `Only people with a ${channel === "email" ? "valid email" : "phone number"} can be selected.`}
          </p>
          <div className="mt-4 flex gap-2">
            <Input.Root className="min-w-0 flex-1">
              <Input.Wrapper>
                <Input.Input
                  autoFocus
                  placeholder={channel === "linkedin" ? "Name, company — or paste linkedin.com/in/… URL" : "Search name, email, company, domain, or LinkedIn…"}
                  value={query}
                  onChange={(event) => { setQuery(event.target.value); setLiveResults(null); setLiveCompanies(null); setLiveError(null); }}
                  onKeyDown={(event) => { if (event.key === "Enter" && channel === "linkedin") runLinkedinLookup(); }}
                />
              </Input.Wrapper>
            </Input.Root>
            {channel === "linkedin" && !pastedUrl && (
              <select
                className="shrink-0 rounded-10 bg-bg-white-0 px-2 text-paragraph-sm text-text-strong-950 ring-1 ring-inset ring-stroke-soft-200"
                aria-label="Search LinkedIn for"
                value={liveKind}
                onChange={(event) => setLiveKind(event.target.value as "people" | "companies")}
              >
                <option value="people">People</option>
                <option value="companies">Companies</option>
              </select>
            )}
            {channel === "linkedin" && !pastedUrl && liveKind === "people" && (
              <label className="flex shrink-0 items-center gap-1.5 text-paragraph-sm text-text-sub-600" title="Search only your 1st-degree connections. They are not invited.">
                <Checkbox.Root checked={connectionsOnly} onCheckedChange={(v) => setConnectionsOnly(v === true)} />
                My connections
              </label>
            )}
            {channel === "linkedin" && (
              <Button.Root variant="primary" mode="filled" size="medium" className="shrink-0" disabled={!query.trim() || liveBusy} onClick={runLinkedinLookup}>
                {liveBusy && <Button.Icon as={RiLoader4Line} className="animate-spin" />}
                {liveBusy ? "Working…" : pastedUrl ? "Fetch" : "Search LinkedIn"}
              </Button.Root>
            )}
          </div>
          {liveError && <p className="mt-2 text-paragraph-sm text-error-base">{liveError}</p>}
        </div>
        {liveCompanies && (
          <div className="border-b border-stroke-soft-200 bg-bg-weak-50 p-3">
            <p className="px-2 pb-1 text-label-xs text-text-sub-600">
              {liveCompanies.length === 0 ? "No companies on LinkedIn for that search." : `${liveCompanies.length} companies — pick one to see its people`}
            </p>
            <div className="max-h-56 overflow-y-auto">
              {liveCompanies.map((c) => (
                <button key={c.id} type="button" disabled={liveBusy} onClick={() => void searchLive(c.peopleSearchUrl, "people", c.name)} className="flex w-full items-center gap-3 rounded-lg px-3 py-2 text-left hover:bg-bg-white-0">
                  <span className="min-w-0 flex-1">
                    <span className="block truncate text-label-sm text-text-strong-950">{c.name}</span>
                    <span className="block truncate text-paragraph-xs text-text-sub-600">{[c.industry, c.location].filter(Boolean).join(" · ")}</span>
                  </span>
                  <span className="shrink-0 text-label-xs text-primary-base">People →</span>
                </button>
              ))}
            </div>
          </div>
        )}
        {liveResults && (
          <div className="border-b border-stroke-soft-200 bg-bg-weak-50 p-3">
            <p className="px-2 pb-1 text-label-xs text-text-sub-600">
              {liveResults.length === 0
                ? "Nobody found on LinkedIn."
                : `${liveResults.length} found on LinkedIn${liveCompanyName ? ` at ${liveCompanyName}` : ""} — remove anyone you don't want, then add`}
            </p>
            <div className="max-h-56 overflow-y-auto">
              {liveResults.map((r) => (
                <div key={r.linkedinUrl} className="flex items-center gap-3 rounded-lg px-3 py-2 hover:bg-bg-white-0">
                  <span className="min-w-0 flex-1">
                    {linkedinProfileUrl(r.linkedinUrl) ? (
                      <a href={linkedinProfileUrl(r.linkedinUrl) ?? undefined} target="_blank" rel="noreferrer" className="block truncate text-label-sm text-text-strong-950 hover:text-primary-base hover:underline">{r.name || r.linkedinUrl}</a>
                    ) : (
                      <span className="block truncate text-label-sm text-text-strong-950">{r.name || r.linkedinUrl}</span>
                    )}
                    <span className="block truncate text-paragraph-xs text-text-sub-600">{[r.headline, r.company, r.location].filter(Boolean).join(" · ")}</span>
                  </span>
                  {networkBadge(r.networkDistance) && (
                    <span className={degree(r.networkDistance) === 1
                      ? "shrink-0 rounded-full bg-warning-lighter px-2 py-0.5 text-label-xs text-warning-base"
                      : "shrink-0 rounded-full bg-bg-soft-200 px-2 py-0.5 text-label-xs text-text-sub-600"}>{networkBadge(r.networkDistance)}</span>
                  )}
                  <Button.Root variant="neutral" mode="ghost" size="xxsmall" onClick={() => setLiveResults((current) => (current ?? []).filter((x) => x.linkedinUrl !== r.linkedinUrl))}>
                    Remove
                  </Button.Root>
                </div>
              ))}
            </div>
            {liveResults.length > 0 && (
              <div className="flex justify-end pt-2">
                <Button.Root variant="primary" mode="filled" size="small" disabled={saving} onClick={() => void addLiveSelected()}>
                  {saving ? "Adding…" : `Add ${liveResults.length} ${liveResults.length === 1 ? "lead" : "leads"}`}
                </Button.Root>
              </div>
            )}
          </div>
        )}
        <div className="min-h-48 flex-1 overflow-y-auto p-3">
          {pastedUrl ? (
            <p className="p-4 text-paragraph-sm text-text-sub-600">Press <span className="text-label-sm text-text-strong-950">Fetch</span> to look up the people at this LinkedIn URL. You can review them before anything is added.</p>
          ) : loading ? (
            <p className="p-4 text-paragraph-sm text-text-sub-600">Loading…</p>
          ) : eligible.length === 0 ? (
            <p className="p-4 text-paragraph-sm text-text-sub-600">
              {query.trim() && channel === "linkedin" ? "Nobody in your database matches — press Search LinkedIn to look them up on LinkedIn." : "No eligible people found."}
            </p>
          ) : eligible.map(({ person, company }) => (
            <label key={person.id} className="flex cursor-pointer items-center gap-3 rounded-lg px-3 py-2 hover:bg-bg-weak-50">
              <Checkbox.Root checked={selected.has(person.id)} onCheckedChange={() => setSelected((current) => toggle(current, person.id))} />
              <span className="min-w-0 flex-1">
                <span className="block truncate text-label-sm text-text-strong-950">{person.fullName || person.email || person.phone || person.linkedinUrl}</span>
                <span className="block truncate text-paragraph-xs text-text-sub-600">
                  {channel === "linkedin" && linkedinProfileUrl(person.linkedinUrl) ? (
                    <a href={linkedinProfileUrl(person.linkedinUrl) ?? undefined} target="_blank" rel="noreferrer" onClick={(event) => event.stopPropagation()} className="hover:text-primary-base hover:underline">{identity(person)}</a>
                  ) : identity(person)}
                  {company?.name ? ` · ${company.name}` : ""}
                </span>
              </span>
            </label>
          ))}
        </div>
        {error && <p className="px-5 pb-2 text-paragraph-sm text-error-base">{error}</p>}
        <div className="flex justify-end gap-2 border-t border-stroke-soft-200 p-4">
          <Button.Root variant="neutral" mode="stroke" size="small" onClick={onClose}>Cancel</Button.Root>
          <Button.Root variant="primary" mode="filled" size="small" disabled={!selected.size || saving} onClick={submit}>
            {saving ? "Adding…" : `Add ${selected.size || ""} ${selected.size === 1 ? "person" : "people"}`}
          </Button.Root>
        </div>
      </div>
    </div>,
    document.body,
  );
}
