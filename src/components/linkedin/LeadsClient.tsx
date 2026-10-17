"use client";

import { linkedinProfileUrl } from "@/lib/leads/identity";
import { useState, useCallback, useEffect, useRef, useMemo } from "react";
import { Badge } from "@/components/linkedin/ui/badge";
import { Button } from "@/components/linkedin/ui/button";
import { Trash2, ChevronLeft, ChevronRight, Loader2, Search } from "lucide-react";
import { FilterSelect } from "@/components/linkedin/FilterSelect";
import { LeadDetailPanel } from "@/components/linkedin/LeadDetailPanel";
import { LeadBulkActionBar } from "@/components/linkedin/LeadBulkActionBar";
import { LeadSelectCheckbox } from "@/components/linkedin/LeadSelectCheckbox";
import {
  toggleLeadSelection,
  toggleAllOnPage,
  isAllPageSelected,
  isSomePageSelected,
} from "@/lib/linkedin/leadSelection";
import { LinkedInAccountTag } from "@/components/linkedin/LinkedInAccountTag";

type Lead = {
  id: string;
  linkedinUrl: string;
  name: string | null;
  profilePictureUrl: string | null;
  headline: string | null;
  location: string | null;
  campaign: { id: string; name: string } | null;
  status: string;
  createdAt: string;
  linkedInAccount: {
    username: string;
    name: string | null;
    profilePictureUrl: string | null;
  } | null;
};

type Account = { id: string; username: string; name: string | null; profilePictureUrl?: string | null };
type Pagination = { page: number; limit: number; total: number; pages: number };

const STATUS_VARIANTS: Record<string, "default" | "secondary" | "success" | "warning" | "destructive" | "muted" | "blue" | "purple"> = {
  PENDING: "muted",
  REQUEST_SENT: "warning",
  ACCEPT_MESSAGE_SENT: "success",
  FOLLOW_UP_1_SENT: "blue",
  FOLLOW_UP_2_SENT: "blue",
  FOLLOW_UP_3_SENT: "blue",
  COMPLETED: "secondary",
  REPLIED: "purple",
  FAILED: "destructive",
};

const STATUS_LABELS: Record<string, string> = {
  PENDING: "Pending",
  REQUEST_SENT: "Request Sent",
  ACCEPT_MESSAGE_SENT: "Accepted",
  FOLLOW_UP_1_SENT: "Follow-up 1",
  FOLLOW_UP_2_SENT: "Follow-up 2",
  FOLLOW_UP_3_SENT: "Follow-up 3",
  COMPLETED: "Completed",
  REPLIED: "Replied",
  FAILED: "Failed",
};

function Avatar({ src, name }: { src: string | null; name: string }) {
  const [imgError, setImgError] = useState(false);
  const initials = name.split(/[\s/]/).filter(Boolean).slice(0, 2).map((w) => w[0]?.toUpperCase() ?? "").join("");
  if (src && !imgError) {
    return <img src={src} alt={name} className="h-10 w-10 rounded-full object-cover shrink-0 bg-bg-weak-50" onError={() => setImgError(true)} />;
  }
  return (
    <div className="h-10 w-10 rounded-full bg-blue-100 dark:bg-blue-500/15 text-blue-600 dark:text-blue-400 flex items-center justify-center text-xs font-semibold shrink-0">
      {initials || "?"}
    </div>
  );
}

type InitialData = { leads: Lead[]; pagination: Pagination; accounts: Account[] };

export function LeadsClient({ initialData }: { initialData: InitialData }) {
  const [leads, setLeads] = useState<Lead[]>(initialData.leads);
  const [pagination, setPagination] = useState<Pagination>(initialData.pagination);
  const [loading, setLoading] = useState(false);
  const [deletingId, setDeletingId] = useState<string | null>(null);
  const [bulkDeleting, setBulkDeleting] = useState(false);
  const [selectedIds, setSelectedIds] = useState<Set<string>>(() => new Set());
  const [allMatchingSelected, setAllMatchingSelected] = useState(false);
  const [selectingAll, setSelectingAll] = useState(false);
  const [selectedLeadId, setSelectedLeadId] = useState<string | null>(null);

  const [status, setStatus] = useState("");
  const [search, setSearch] = useState("");
  const [accountId, setAccountId] = useState("");

  const searchTimeout = useRef<ReturnType<typeof setTimeout> | null>(null);

  const fetchLeads = useCallback(async (page: number, opts?: { status?: string; search?: string; accountId?: string }) => {
    setLoading(true);
    try {
      const params = new URLSearchParams({ page: String(page), limit: "20" });
      const s = opts?.status ?? status;
      const q = opts?.search ?? search;
      const a = opts?.accountId ?? accountId;
      if (s) params.set("status", s);
      if (q) params.set("search", q);
      if (a) params.set("accountId", a);
      const res = await fetch(`/api/linkedin/leads?${params}`);
      const data = await res.json();
      setLeads(data.leads ?? []);
      setPagination(data.pagination);
    } finally {
      setLoading(false);
    }
  }, [status, search, accountId]);

  const clearSelection = () => {
    setSelectedIds(new Set());
    setAllMatchingSelected(false);
  };

  const handleStatusChange = (v: string) => { setStatus(v); clearSelection(); fetchLeads(1, { status: v }); };
  const handleAccountChange = (v: string) => { setAccountId(v); clearSelection(); fetchLeads(1, { accountId: v }); };
  const handleSearchChange = (v: string) => {
    setSearch(v);
    if (searchTimeout.current) clearTimeout(searchTimeout.current);
    searchTimeout.current = setTimeout(() => { clearSelection(); fetchLeads(1, { search: v }); }, 300);
  };

  useEffect(() => () => { if (searchTimeout.current) clearTimeout(searchTimeout.current); }, []);

  const handleDelete = async (id: string) => {
    setDeletingId(id);
    try {
      await fetch(`/api/linkedin/leads/${id}`, { method: "DELETE" });
      setLeads((prev) => prev.filter((l) => l.id !== id));
      setPagination((prev) => ({ ...prev, total: prev.total - 1 }));
      setSelectedIds((prev) => { const next = new Set(prev); next.delete(id); return next; });
      if (selectedLeadId === id) setSelectedLeadId(null);
    } finally {
      setDeletingId(null);
    }
  };

  const pageIds = leads.map((l) => l.id);
  const allPageSelected = isAllPageSelected(selectedIds, pageIds);
  const somePageSelected = isSomePageSelected(selectedIds, pageIds);

  const handleSelectAllMatching = async () => {
    setSelectingAll(true);
    try {
      const params = new URLSearchParams();
      if (status) params.set("status", status);
      if (search) params.set("search", search);
      if (accountId) params.set("accountId", accountId);
      const res = await fetch(`/api/linkedin/leads/ids?${params}`);
      const data = await res.json();
      if (!data.ok) return;
      setSelectedIds(new Set(data.ids as string[]));
      setAllMatchingSelected(true);
    } finally {
      setSelectingAll(false);
    }
  };

  const handleBulkDelete = async () => {
    if (!allMatchingSelected && selectedIds.size === 0) return;
    setBulkDeleting(true);
    try {
      const res = await fetch("/api/linkedin/leads/bulk-delete", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(
          allMatchingSelected
            ? {
                matchFilters: true,
                filters: {
                  ...(status ? { status } : {}),
                  ...(search ? { search } : {}),
                  ...(accountId ? { accountId } : {}),
                },
              }
            : { ids: [...selectedIds] }
        ),
      });
      const data = await res.json();
      if (!data.ok) return;
      const deletedCount = data.deleted ?? 0;
      if (allMatchingSelected) {
        setLeads([]);
        setPagination((prev) => ({ ...prev, total: 0, pages: 0, page: 1 }));
        setSelectedLeadId(null);
      } else {
        const deleted = new Set(selectedIds);
        setLeads((prev) => prev.filter((l) => !deleted.has(l.id)));
        setPagination((prev) => ({
          ...prev,
          total: Math.max(0, prev.total - deletedCount),
          pages: Math.max(1, Math.ceil(Math.max(0, prev.total - deletedCount) / prev.limit)),
        }));
        if (selectedLeadId && deleted.has(selectedLeadId)) setSelectedLeadId(null);
      }
      clearSelection();
      if (!allMatchingSelected && pagination.page > 1 && leads.length <= selectedIds.size) {
        fetchLeads(pagination.page - 1);
      } else if (allMatchingSelected || leads.length === 0) {
        fetchLeads(1);
      }
    } finally {
      setBulkDeleting(false);
    }
  };

  const selectedCount = allMatchingSelected ? pagination.total : selectedIds.size;

  const hasFilters = status || search || accountId;

  const statusOptions = useMemo(
    () => Object.entries(STATUS_LABELS).map(([val, label]) => ({ value: val, label })),
    []
  );

  const accountOptions = useMemo(
    () =>
      initialData.accounts.map((a) => ({
        value: a.id,
        label: a.name ?? `@${a.username}`,
        sublabel: a.name ? `@${a.username}` : undefined,
        avatarUrl: a.profilePictureUrl,
      })),
    [initialData.accounts]
  );

  return (
    <div>
      {/* Filter bar */}
      <div className="flex items-center gap-3 mb-5">
        {/* Status */}
        <FilterSelect
          value={status}
          onChange={handleStatusChange}
          options={statusOptions}
          placeholder="All statuses"
          clearLabel="All statuses"
          compact
          className="min-w-[9rem]"
        />

        {/* Search */}
        <div className="relative flex-1">
          <Search className="absolute left-3 top-1/2 -translate-y-1/2 h-4 w-4 text-text-soft-400 pointer-events-none" />
          <input
            type="text"
            value={search}
            onChange={(e) => handleSearchChange(e.target.value)}
            placeholder="Search by name or headline…"
            className="h-9 w-full rounded-lg border border-stroke-soft-200 bg-bg-white-0 pl-9 pr-3 text-sm text-text-strong-950 shadow-sm focus:outline-none focus:ring-2 focus:ring-blue-500"
          />
        </div>

        {/* Select senders */}
        {initialData.accounts.length > 0 && (
          <FilterSelect
            value={accountId}
            onChange={handleAccountChange}
            options={accountOptions}
            placeholder="All senders"
            clearLabel="All senders"
            showAvatars
            compact
            className="min-w-40"
          />
        )}

        {/* Clear */}
        {hasFilters && (
          <button
            onClick={() => { setStatus(""); setSearch(""); setAccountId(""); clearSelection(); fetchLeads(1, { status: "", search: "", accountId: "" }); }}
            className="text-xs text-text-soft-400 hover:text-text-strong-950 transition-colors"
          >
            Clear
          </button>
        )}
      </div>

      {/* Table */}
      <div className="rounded-xl border border-stroke-soft-200 bg-bg-white-0 shadow-sm overflow-hidden">
        {loading ? (
          <div className="flex items-center justify-center py-20">
            <Loader2 className="h-6 w-6 animate-spin text-text-soft-400" />
          </div>
        ) : leads.length === 0 ? (
          <div className="flex flex-col items-center justify-center py-20 text-center">
            <p className="text-text-sub-600 font-medium">{hasFilters ? "No leads match your filters" : "No leads yet"}</p>
            <p className="text-text-soft-400 text-sm mt-1">{hasFilters ? "Try adjusting your search or filters" : "Import leads through a campaign to get started"}</p>
          </div>
        ) : (
          <>
            <div className="px-4 pt-3">
              <LeadBulkActionBar
                selectedCount={selectedCount}
                pageCount={pageIds.length}
                totalCount={pagination.total}
                allPageSelected={allPageSelected}
                allMatchingSelected={allMatchingSelected}
                onSelectAllMatching={handleSelectAllMatching}
                onClear={clearSelection}
                onDelete={handleBulkDelete}
                deleting={bulkDeleting}
                selectingAll={selectingAll}
              />
            </div>
            <table className="w-full text-sm">
            <thead>
              <tr className="border-b border-stroke-soft-200 bg-bg-weak-50 text-left">
                <th className="px-4 py-3 w-10">
                  <LeadSelectCheckbox
                    checked={allMatchingSelected || allPageSelected}
                    indeterminate={!allMatchingSelected && somePageSelected && !allPageSelected}
                    onChange={(checked) => {
                      if (!checked) {
                        clearSelection();
                        return;
                      }
                      setSelectedIds((prev) => toggleAllOnPage(prev, pageIds, true));
                    }}
                    onClick={(e) => e.stopPropagation()}
                    ariaLabel="Select all leads on this page"
                  />
                </th>
                <th className="px-4 py-3 font-semibold text-text-sub-600">Lead</th>
                <th className="px-4 py-3 font-semibold text-text-sub-600">Campaign</th>
                <th className="px-4 py-3 font-semibold text-text-sub-600">Status</th>
                <th className="px-4 py-3 font-semibold text-text-sub-600 w-14">Sender</th>
                <th className="px-4 py-3 w-10" />
              </tr>
            </thead>
            <tbody className="divide-y divide-stroke-soft-200">
              {leads.map((lead) => (
                <tr
                  key={lead.id}
                  onClick={() => setSelectedLeadId(lead.id)}
                  className={`hover:bg-bg-weak-50 transition-colors cursor-pointer ${
                    selectedLeadId === lead.id ? "bg-blue-50/80 dark:bg-blue-500/10" : selectedIds.has(lead.id) ? "bg-blue-50/40 dark:bg-blue-500/10" : ""
                  }`}
                >
                  <td className="px-4 py-3" onClick={(e) => e.stopPropagation()}>
                    <LeadSelectCheckbox
                      checked={selectedIds.has(lead.id)}
                      onChange={(checked) => {
                        if (!checked) setAllMatchingSelected(false);
                        setSelectedIds((prev) => toggleLeadSelection(prev, lead.id, checked));
                      }}
                      ariaLabel={`Select ${lead.name ?? lead.linkedinUrl}`}
                    />
                  </td>
                  <td className="px-4 py-3">
                    <div className="flex items-center gap-3">
                      <Avatar src={lead.profilePictureUrl} name={lead.name ?? lead.linkedinUrl} />
                      <div className="min-w-0">
                        <a
                          href={linkedinProfileUrl(lead.linkedinUrl) ?? undefined}
                          target="_blank"
                          rel="noopener noreferrer"
                          onClick={(e) => e.stopPropagation()}
                          className="inline-flex items-center gap-1 max-w-full font-medium text-blue-600 dark:text-blue-400 hover:underline"
                        >
                          <span className="truncate">{lead.name ?? lead.linkedinUrl}</span>
                        </a>
                        {lead.headline && <p className="text-xs text-text-soft-400 truncate mt-0.5 max-w-xs">{lead.headline}</p>}
                        {lead.location && <p className="text-xs text-text-disabled-300 truncate max-w-xs">{lead.location}</p>}
                      </div>
                    </div>
                  </td>
                  <td className="px-4 py-3 text-text-sub-600 text-sm">
                    {lead.campaign ? lead.campaign.name : <span className="text-text-disabled-300">—</span>}
                  </td>
                  <td className="px-4 py-3">
                    <Badge variant={STATUS_VARIANTS[lead.status] ?? "secondary"}>
                      {STATUS_LABELS[lead.status] ?? lead.status}
                    </Badge>
                  </td>
                  <td className="px-4 py-3">
                    {lead.linkedInAccount ? (
                      <LinkedInAccountTag account={lead.linkedInAccount} />
                    ) : (
                      <span className="text-text-disabled-300 text-sm">—</span>
                    )}
                  </td>
                  <td className="px-2 py-3" onClick={(e) => e.stopPropagation()}>
                    <button
                      onClick={() => handleDelete(lead.id)}
                      disabled={deletingId === lead.id}
                      className="p-1.5 rounded-md text-text-disabled-300 hover:text-red-500 hover:bg-red-50 dark:hover:bg-red-500/10 transition-colors disabled:opacity-50"
                      title="Delete lead"
                    >
                      {deletingId === lead.id
                        ? <Loader2 className="h-3.5 w-3.5 animate-spin" />
                        : <Trash2 className="h-3.5 w-3.5" />}
                    </button>
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
          </>
        )}
      </div>

      {/* Pagination */}
      {pagination.pages > 1 && (
        <div className="flex items-center justify-between mt-4">
          <p className="text-sm text-text-sub-600">
            Page {pagination.page} of {pagination.pages} · {pagination.total} leads
          </p>
          <div className="flex gap-2">
            <Button variant="outline" size="sm" disabled={pagination.page <= 1} onClick={() => { clearSelection(); fetchLeads(pagination.page - 1); }}>
              <ChevronLeft className="h-4 w-4" />Prev
            </Button>
            <Button variant="outline" size="sm" disabled={pagination.page >= pagination.pages} onClick={() => { clearSelection(); fetchLeads(pagination.page + 1); }}>
              Next<ChevronRight className="h-4 w-4" />
            </Button>
          </div>
        </div>
      )}

      <LeadDetailPanel
        leadId={selectedLeadId}
        onClose={() => setSelectedLeadId(null)}
        onMessagesSaved={(id, updates) => {
          setLeads((prev) =>
            prev.map((l) => (l.id === id ? { ...l, ...updates } : l))
          );
        }}
      />
    </div>
  );
}
