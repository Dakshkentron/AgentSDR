"use client";

import { useEffect, useState } from "react";
import Link from "next/link";
import { createPortal } from "react-dom";
import AddPeopleToCampaignModal from "./AddPeopleToCampaignModal";

type CampaignOption = { id: string; name: string };

/**
 * A LinkedIn search or profile URL only ever becomes a Person through a campaign
 * (src/lib/linkedin/importLeads.ts — "a search result is staging data, not a CRM
 * record"). So "Add from LinkedIn" here picks a campaign first, then reuses the
 * same search/profile-URL box the campaign wizard's "Add from People" step uses.
 */
export default function AddFromLinkedInPicker({ onClose, onAdded }: { onClose: () => void; onAdded: () => void }) {
  const [campaigns, setCampaigns] = useState<CampaignOption[] | null>(null);
  const [campaignId, setCampaignId] = useState<string | null>(null);

  useEffect(() => {
    void fetch("/api/linkedin/campaigns")
      .then((response) => response.json())
      .then((body) => setCampaigns(Array.isArray(body.campaigns) ? body.campaigns.map((c: CampaignOption) => ({ id: c.id, name: c.name })) : []))
      .catch(() => setCampaigns([]));
  }, []);

  if (campaignId) {
    return (
      <AddPeopleToCampaignModal
        campaignId={campaignId}
        channel="linkedin"
        onClose={onClose}
        onAdded={onAdded}
      />
    );
  }

  return createPortal(
    <div className="fixed inset-0 z-[100] flex items-center justify-center p-4">
      <button className="absolute inset-0 bg-slate-950/50" aria-label="Close" onClick={onClose} />
      <div className="relative flex max-h-[80vh] w-full max-w-md flex-col rounded-2xl bg-white shadow-2xl">
        <div className="border-b border-slate-200 p-5">
          <h2 className="text-base font-semibold text-slate-900">Add from LinkedIn</h2>
          <p className="mt-1 text-sm text-slate-500">Pick the campaign the people you find should be enrolled in.</p>
        </div>
        <div className="min-h-32 flex-1 overflow-y-auto p-3">
          {campaigns === null ? (
            <p className="p-4 text-sm text-slate-500">Loading campaigns…</p>
          ) : campaigns.length === 0 ? (
            <div className="p-4 text-sm text-slate-500">
              No LinkedIn campaigns yet.{" "}
              <Link href="/linkedin/campaigns/new" className="font-medium text-indigo-600 underline">Create one</Link>{" "}
              first, then come back here to add people to it.
            </div>
          ) : (
            campaigns.map((c) => (
              <button
                key={c.id}
                type="button"
                className="block w-full rounded-lg px-3 py-2 text-left text-sm text-slate-900 hover:bg-slate-50"
                onClick={() => setCampaignId(c.id)}
              >
                {c.name}
              </button>
            ))
          )}
        </div>
        <div className="flex justify-end border-t border-slate-200 p-4">
          <button className="rounded-lg border border-slate-200 px-4 py-2 text-sm" onClick={onClose}>Cancel</button>
        </div>
      </div>
    </div>,
    document.body,
  );
}
