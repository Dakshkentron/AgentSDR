"use client";

import { linkedinProfileUrl } from "@/lib/leads/identity";
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import {
  RiAddLine,
  RiArrowLeftSLine,
  RiArrowRightSLine,
  RiCheckboxCircleLine,
  RiDeleteBinLine,
  RiDownloadLine,
  RiErrorWarningLine,
  RiExternalLinkLine,
  RiMoreLine,
  RiLoader4Line,
  RiPencilLine,
  RiSearchLine,
  RiTeamLine,
  RiUploadCloud2Line,
} from "@remixicon/react";
import * as Avatar from "@/components/alignui/avatar";
import * as Badge from "@/components/alignui/badge";
import * as Button from "@/components/alignui/button";
import * as Checkbox from "@/components/alignui/checkbox";
import * as Dropdown from "@/components/alignui/dropdown";
import * as Input from "@/components/alignui/input";
import * as Select from "@/components/alignui/select";
import * as Table from "@/components/alignui/table";
import { Frame, FrameHeader, FramePanel } from "@/components/analytics/kit/Frame";
import { useDialogs } from "@/components/DialogProvider";
import AddPeopleToCampaignModal from "@/components/leads/AddPeopleToCampaignModal";
import CampaignCsvMappingDialog from "@/components/leads/CampaignCsvMappingDialog";
import { LeadBulkActionBar } from "@/components/linkedin/LeadBulkActionBar";
import { LeadDetailPanel } from "@/components/linkedin/LeadDetailPanel";
import { LinkedInAccountTag } from "@/components/linkedin/LinkedInAccountTag";
import { EmptyState } from "@/components/page/EmptyState";
import { Skeleton } from "@/components/page/Skeletons";
import { downloadBase64File } from "@/lib/linkedin/downloadBase64File";
import { isMessageEditable, LEAD_MESSAGE_FIELDS } from "@/lib/linkedin/leadMessages";
import { campaignLeadTemplateFilename } from "@/lib/linkedin/leadsTemplate";
import { isAllPageSelected, isSomePageSelected, toggleAllOnPage, toggleLeadSelection } from "@/lib/linkedin/leadSelection";
import { cn } from "@/utils/cn";
import { LEAD_STATUS } from "./metrics";

type LinkedInAccount = { id: string; username: string; name: string | null; profilePictureUrl: string | null };
export type LeadsPagination = { page: number; limit: number; total: number; pages: number };

export type CampaignLead = {
  id: string;
  linkedinUrl: string;
  name: string | null;
  profilePictureUrl: string | null;
  headline: string | null;
  location: string | null;
  status: string;
  requestSentAt: string | null;
  invitationMessage: string | null;
  acceptanceMessage: string | null;
  followUp1Message: string | null;
  followUp1SentAt: string | null;
  followUp2Message: string | null;
  followUp2SentAt: string | null;
  followUp3Message: string | null;
  followUp3SentAt: string | null;
  linkedinAccountId: string | null;
  linkedInAccount: LinkedInAccount | null;
  createdAt: string;
  alsoInCampaigns?: { id: string; name: string }[];
};

export type InitialLeadsPage = { leads: CampaignLead[]; pagination: LeadsPagination };

type CrossCampaignNotice = { linkedinUrl: string; name: string | null; alsoInCampaigns: { id: string; name: string }[] };
type UploadResult = {
  ok: boolean;
  message: string;
  failedFileBase64?: string;
  failedFileName?: string;
  crossCampaignNotices?: CrossCampaignNotice[];
};

/** Radix Select can't hold an empty value, so "no filter" is this sentinel. */
const ALL = "__all";
const MESSAGE_FIELDS = LEAD_MESSAGE_FIELDS.map(({ key }) => key);

function LeadAvatar({ src, name }: { src: string | null; name: string }) {
  const [err, setErr] = useState(false);
  const initials = name.split(/[\s/]/).filter(Boolean).slice(0, 2).map((w) => w[0]?.toUpperCase() ?? "").join("");
  if (src && !err) {
    return (
      <Avatar.Root size="32" className="shrink-0">
        <Avatar.Image
          src={src}
          alt=""
          onError={() => setErr(true)}
          // A server-rendered <img> can fail before hydration attaches onError.
          ref={(img) => { if (img?.complete && img.naturalWidth === 0) setErr(true); }}
        />
      </Avatar.Root>
    );
  }
  return (
    <Avatar.Root size="32" color="blue" className="shrink-0">
      {initials || "?"}
    </Avatar.Root>
  );
}

/**
 * The Leads tab of a LinkedIn campaign: import (file picker, drag-and-drop,
 * or People), filter by status / search / sender, select and bulk-delete,
 * and open a lead's detail panel. Owns its page of leads; tells the parent
 * when a lead is removed so the campaign's counts stay right.
 */
export function CampaignLeadsTab({
  campaignId,
  campaignName,
  totalLeads,
  statusCounts,
  senderOptions,
  initialLeadsPage,
  onLeadRemoved,
  onChanged,
}: {
  campaignId: string;
  campaignName: string;
  totalLeads: number;
  statusCounts: Record<string, number>;
  senderOptions: LinkedInAccount[];
  initialLeadsPage: InitialLeadsPage;
  onLeadRemoved: (status: string) => void;
  /** Leads were added or removed server-side; refresh the campaign's figures. */
  onChanged: () => void;
}) {
  const dialogs = useDialogs();
  const [leads, setLeads] = useState(initialLeadsPage.leads);
  const [pagination, setPagination] = useState<LeadsPagination>(initialLeadsPage.pagination);
  const [loading, setLoading] = useState(false);
  const [selectingAll, setSelectingAll] = useState(false);
  const [selectedLeadId, setSelectedLeadId] = useState<string | null>(null);
  const [deletingId, setDeletingId] = useState<string | null>(null);
  const [bulkDeleting, setBulkDeleting] = useState(false);
  const [selectedIds, setSelectedIds] = useState<Set<string>>(() => new Set());
  const [allMatchingSelected, setAllMatchingSelected] = useState(false);
  const [pendingImportFile, setPendingImportFile] = useState<File | null>(null);
  const [showPeople, setShowPeople] = useState(false);
  const [isDragging, setIsDragging] = useState(false);
  const [uploadResult, setUploadResult] = useState<UploadResult | null>(null);
  const [filterStatus, setFilterStatus] = useState("");
  const [filterSearch, setFilterSearch] = useState("");
  const [filterAccountId, setFilterAccountId] = useState("");
  const fileRef = useRef<HTMLInputElement>(null);
  const searchTimeout = useRef<ReturnType<typeof setTimeout> | null>(null);
  const dragDepthRef = useRef(0);

  const hasLeadFilters = Boolean(filterStatus || filterSearch || filterAccountId);

  const fetchLeads = useCallback(
    async (page: number, opts?: { status?: string; search?: string; accountId?: string }) => {
      setLoading(true);
      try {
        const s = opts?.status ?? filterStatus;
        const q = opts?.search ?? filterSearch;
        const a = opts?.accountId ?? filterAccountId;
        const params = new URLSearchParams({ page: String(page), limit: "20", campaignId });
        if (s) params.set("status", s);
        if (q.trim()) params.set("search", q.trim());
        if (a) params.set("accountId", a);
        const res = await fetch(`/api/linkedin/leads?${params}`);
        const data = await res.json();
        if (!data.ok) return;
        setLeads(data.leads ?? []);
        setPagination(data.pagination);
      } finally {
        setLoading(false);
      }
    },
    [campaignId, filterStatus, filterSearch, filterAccountId],
  );

  const clearSelection = () => {
    setSelectedIds(new Set());
    setAllMatchingSelected(false);
  };

  const applyLeadFilters = (next: { status?: string; search?: string; accountId?: string }) => {
    clearSelection();
    const s = next.status !== undefined ? next.status : filterStatus;
    const q = next.search !== undefined ? next.search : filterSearch;
    const a = next.accountId !== undefined ? next.accountId : filterAccountId;
    if (next.status !== undefined) setFilterStatus(next.status);
    if (next.search !== undefined) setFilterSearch(next.search);
    if (next.accountId !== undefined) setFilterAccountId(next.accountId);
    void fetchLeads(1, { status: s, search: q, accountId: a });
  };

  useEffect(() => () => { if (searchTimeout.current) clearTimeout(searchTimeout.current); }, []);

  const uploadFile = (file: File) => {
    const name = file.name.toLowerCase();
    if (!name.endsWith(".xlsx") && !name.endsWith(".xls") && !name.endsWith(".csv")) {
      setUploadResult({ ok: false, message: "Please upload an Excel or CSV file (.xlsx, .xls, .csv)" });
      return;
    }
    setUploadResult(null);
    setPendingImportFile(file);
  };

  const handleDragEnter = (e: React.DragEvent) => {
    e.preventDefault();
    e.stopPropagation();
    if (pendingImportFile) return;
    dragDepthRef.current += 1;
    setIsDragging(true);
  };
  const handleDragLeave = (e: React.DragEvent) => {
    e.preventDefault();
    e.stopPropagation();
    dragDepthRef.current = Math.max(0, dragDepthRef.current - 1);
    if (dragDepthRef.current === 0) setIsDragging(false);
  };
  const handleDragOver = (e: React.DragEvent) => {
    e.preventDefault();
    e.stopPropagation();
  };
  const handleDrop = (e: React.DragEvent) => {
    e.preventDefault();
    e.stopPropagation();
    dragDepthRef.current = 0;
    setIsDragging(false);
    if (pendingImportFile) return;
    const file = e.dataTransfer.files?.[0];
    if (file) uploadFile(file);
  };

  const handleDeleteLead = async (lead: CampaignLead) => {
    const ok = await dialogs.confirm({
      title: "Remove lead?",
      description: `${lead.name ?? lead.linkedinUrl} will be removed from this campaign with its message history. This cannot be undone.`,
      confirmLabel: "Remove lead",
      variant: "error",
    });
    if (!ok) return;
    setDeletingId(lead.id);
    try {
      await fetch(`/api/linkedin/leads/${lead.id}`, { method: "DELETE" });
      onLeadRemoved(lead.status);
      setSelectedIds((prev) => { const next = new Set(prev); next.delete(lead.id); return next; });
      if (selectedLeadId === lead.id) setSelectedLeadId(null);
      void fetchLeads(leads.length === 1 && pagination.page > 1 ? pagination.page - 1 : pagination.page);
      onChanged();
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
      const params = new URLSearchParams({ campaignId });
      if (filterStatus) params.set("status", filterStatus);
      if (filterSearch.trim()) params.set("search", filterSearch.trim());
      if (filterAccountId) params.set("accountId", filterAccountId);
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
                  campaignId,
                  ...(filterStatus ? { status: filterStatus } : {}),
                  ...(filterSearch.trim() ? { search: filterSearch.trim() } : {}),
                  ...(filterAccountId ? { accountId: filterAccountId } : {}),
                },
              }
            : { ids: [...selectedIds] },
        ),
      });
      const data = await res.json();
      if (!data.ok) return;
      if (selectedLeadId && (allMatchingSelected || selectedIds.has(selectedLeadId))) setSelectedLeadId(null);
      clearSelection();
      onChanged();
      if (allMatchingSelected) void fetchLeads(1);
      else if (leads.length <= selectedIds.size && pagination.page > 1) void fetchLeads(pagination.page - 1);
      else void fetchLeads(pagination.page);
    } finally {
      setBulkDeleting(false);
    }
  };

  const handleDeleteAll = async () => {
    const ok = await dialogs.confirm({
      title: "Delete all leads?",
      description: `All ${totalLeads.toLocaleString("en-US")} leads in this campaign will be removed with their message history. This cannot be undone.`,
      confirmLabel: "Delete all leads",
      variant: "error",
    });
    if (!ok) return;
    setBulkDeleting(true);
    try {
      const res = await fetch("/api/linkedin/leads/bulk-delete", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ matchFilters: true, filters: { campaignId } }),
      });
      const data = await res.json();
      if (!data.ok) return;
      setSelectedLeadId(null);
      clearSelection();
      onChanged();
      void fetchLeads(1);
    } finally {
      setBulkDeleting(false);
    }
  };

  const selectedCount = allMatchingSelected ? pagination.total : selectedIds.size;

  const statusOptions = useMemo(
    () => Object.entries(LEAD_STATUS).filter(([key]) => (statusCounts[key] ?? 0) > 0 || key === filterStatus),
    [statusCounts, filterStatus],
  );

  const openPicker = () => { if (!pendingImportFile) fileRef.current?.click(); };

  return (
    <>
      <Frame
        className={cn("relative transition", isDragging && "ring-2 ring-primary-base")}
        onDragEnter={handleDragEnter}
        onDragLeave={handleDragLeave}
        onDragOver={handleDragOver}
        onDrop={handleDrop}
      >
        {isDragging && (
          <div className="pointer-events-none absolute inset-0 z-10 flex items-center justify-center rounded-2xl bg-bg-white-0/85 backdrop-blur-[1px]">
            <div className="flex flex-col items-center gap-2 text-primary-base">
              <RiUploadCloud2Line className="size-9" />
              <p className="text-label-sm">Drop file to import leads</p>
            </div>
          </div>
        )}
        <FrameHeader
          title="Leads"
          description={
            hasLeadFilters
              ? `${pagination.total.toLocaleString("en-US")} of ${totalLeads.toLocaleString("en-US")} match. Select a lead to see and edit its messages.`
              : `${totalLeads.toLocaleString("en-US")} in this campaign. Select a lead to see and edit its messages. Drop a spreadsheet here to import.`
          }
          actions={
            <div className="flex flex-wrap items-center gap-2">
              <Button.Root variant="neutral" mode="ghost" size="xsmall" asChild>
                <a href={`/api/linkedin/campaigns/${campaignId}/template`} download={campaignLeadTemplateFilename(campaignName)} aria-label="Download import template" title="Download import template">
                  <Button.Icon as={RiDownloadLine} />
                  <span className="hidden sm:inline">Template</span>
                </a>
              </Button.Root>
              <Button.Root variant="neutral" mode="stroke" size="xsmall" onClick={() => setShowPeople(true)}>
                <Button.Icon as={RiAddLine} />
                Add from People
              </Button.Root>
              <Button.Root variant="primary" mode="filled" size="xsmall" onClick={openPicker} disabled={!!pendingImportFile}>
                <Button.Icon as={RiUploadCloud2Line} />
                Import
              </Button.Root>
              {totalLeads > 0 && (
                <Button.Root variant="error" mode="ghost" size="xsmall" onClick={() => void handleDeleteAll()} disabled={bulkDeleting}>
                  <Button.Icon as={bulkDeleting ? RiLoader4Line : RiDeleteBinLine} className={cn(bulkDeleting && "animate-spin")} />
                  Delete all leads
                </Button.Root>
              )}
            </div>
          }
        />
        <input ref={fileRef} type="file" accept=".xlsx,.xls,.csv" className="hidden" onChange={(e) => { const file = e.target.files?.[0]; if (file) uploadFile(file); }} />

        <FramePanel className="p-2 sm:p-3">
          {uploadResult && (
            <div
              role={uploadResult.ok ? "status" : "alert"}
              className={cn(
                "mb-3 flex flex-col gap-2 rounded-xl px-3 py-2.5 text-paragraph-sm sm:flex-row sm:items-center sm:justify-between",
                uploadResult.ok ? "bg-success-lighter text-success-dark" : "bg-error-lighter text-error-dark",
              )}
            >
              <span className="flex items-center gap-2">
                {uploadResult.ok ? <RiCheckboxCircleLine className="size-4 shrink-0" /> : <RiErrorWarningLine className="size-4 shrink-0" />}
                {uploadResult.message}
              </span>
              <div className="flex items-center gap-2">
                {uploadResult.failedFileBase64 && uploadResult.failedFileName && (
                  <Button.Root
                    variant="neutral"
                    mode="stroke"
                    size="xxsmall"
                    onClick={() =>
                      downloadBase64File(uploadResult.failedFileBase64!, uploadResult.failedFileName!, "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet")
                    }
                  >
                    <Button.Icon as={RiDownloadLine} />
                    Download failed rows
                  </Button.Root>
                )}
                <Button.Root variant="neutral" mode="ghost" size="xxsmall" onClick={() => setUploadResult(null)}>Dismiss</Button.Root>
              </div>
            </div>
          )}
          {uploadResult?.crossCampaignNotices && uploadResult.crossCampaignNotices.length > 0 && (
            <p className="mb-3 rounded-xl bg-warning-lighter px-3 py-2.5 text-paragraph-xs text-warning-dark">
              {uploadResult.crossCampaignNotices.length} of the imported leads were already contacted elsewhere:{" "}
              {uploadResult.crossCampaignNotices.slice(0, 5).map((n, i) => (
                <span key={n.linkedinUrl}>
                  {i > 0 && ", "}
                  <span className="font-medium">{n.name ?? n.linkedinUrl}</span> (also in {n.alsoInCampaigns.map((c) => c.name).join(", ")})
                </span>
              ))}
              {uploadResult.crossCampaignNotices.length > 5 && ` and ${uploadResult.crossCampaignNotices.length - 5} more`}
            </p>
          )}

          {totalLeads === 0 ? (
            <EmptyState
              icon={RiTeamLine}
              title="No leads yet"
              description="Import a CSV or Excel file — or drop one anywhere on this card — or add people already in your database."
              action={
                <div className="flex flex-wrap justify-center gap-2">
                  <Button.Root variant="neutral" mode="stroke" size="small" onClick={() => setShowPeople(true)}>
                    <Button.Icon as={RiAddLine} />
                    Add from People
                  </Button.Root>
                  <Button.Root variant="primary" mode="filled" size="small" onClick={openPicker} disabled={!!pendingImportFile}>
                    <Button.Icon as={RiUploadCloud2Line} />
                    Import spreadsheet
                  </Button.Root>
                </div>
              }
            />
          ) : (
            <>
              <div className="flex flex-wrap items-center gap-2 px-1 pb-3">
                <Select.Root size="small" value={filterStatus || ALL} onValueChange={(v) => applyLeadFilters({ status: v === ALL ? "" : v })}>
                  <Select.Trigger className="w-full sm:w-48" aria-label="Filter by status">
                    <Select.Value />
                  </Select.Trigger>
                  <Select.Content>
                    <Select.Item value={ALL}>All statuses</Select.Item>
                    {statusOptions.map(([key, meta]) => (
                      <Select.Item key={key} value={key}>
                        {meta.label} <span className="tabular-nums text-text-soft-400">{(statusCounts[key] ?? 0).toLocaleString("en-US")}</span>
                      </Select.Item>
                    ))}
                  </Select.Content>
                </Select.Root>

                {senderOptions.length > 0 && (
                  <Select.Root size="small" value={filterAccountId || ALL} onValueChange={(v) => applyLeadFilters({ accountId: v === ALL ? "" : v })}>
                    <Select.Trigger className="w-full sm:w-52" aria-label="Filter by sender">
                      <Select.Value />
                    </Select.Trigger>
                    <Select.Content>
                      <Select.Item value={ALL}>All senders</Select.Item>
                      {senderOptions.map((a) => (
                        <Select.Item key={a.id} value={a.id}>{a.name ?? `@${a.username}`}</Select.Item>
                      ))}
                    </Select.Content>
                  </Select.Root>
                )}

                <Input.Root size="small" className="w-full sm:ml-auto sm:w-72">
                  <Input.Wrapper>
                    <Input.Icon as={RiSearchLine} />
                    <Input.Input
                      type="search"
                      aria-label="Search leads"
                      placeholder="Search by name or headline…"
                      value={filterSearch}
                      onChange={(e) => {
                        const v = e.target.value;
                        setFilterSearch(v);
                        if (searchTimeout.current) clearTimeout(searchTimeout.current);
                        searchTimeout.current = setTimeout(() => applyLeadFilters({ search: v }), 300);
                      }}
                    />
                  </Input.Wrapper>
                </Input.Root>

                {hasLeadFilters && (
                  <Button.Root variant="neutral" mode="ghost" size="xsmall" onClick={() => applyLeadFilters({ status: "", search: "", accountId: "" })}>
                    Clear filters
                  </Button.Root>
                )}
              </div>

              {pagination.total === 0 && !loading ? (
                <EmptyState
                  icon={RiSearchLine}
                  title="No leads match"
                  description="Try another status, sender or search."
                  action={
                    <Button.Root variant="neutral" mode="stroke" size="small" onClick={() => applyLeadFilters({ status: "", search: "", accountId: "" })}>
                      Clear filters
                    </Button.Root>
                  }
                />
              ) : (
                <>
                  <div className="px-1">
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
                  <div aria-busy={loading || undefined} className={cn("overflow-x-auto transition-opacity duration-200", loading && "opacity-60")}>
                    <Table.Root className="min-w-[900px]">
                      <Table.Header>
                        <Table.Row>
                          <Table.Head scope="col" className="w-12 px-4">
                            <Checkbox.Root
                              aria-label="Select all leads on this page"
                              checked={allMatchingSelected || allPageSelected ? true : somePageSelected ? "indeterminate" : false}
                              onCheckedChange={(checked) => {
                                if (checked !== true) { clearSelection(); return; }
                                setSelectedIds((prev) => toggleAllOnPage(prev, pageIds, true));
                              }}
                            />
                          </Table.Head>
                          <Table.Head scope="col" className="px-4">Lead</Table.Head>
                          <Table.Head scope="col" className="w-36 px-4">Status</Table.Head>
                          <Table.Head scope="col" className="w-48 px-4">Sender</Table.Head>
                          <Table.Head scope="col" className="w-36 px-4" title="Messages not yet sent can still be edited for this lead">Messages</Table.Head>
                          <Table.Head scope="col" className="w-14 px-4"><span className="sr-only">Actions</span></Table.Head>
                        </Table.Row>
                      </Table.Header>
                      <Table.Body spacing={4}>
                        {leads.length === 0 && loading
                          ? Array.from({ length: 6 }, (_, i) => (
                              <Table.Row key={i}>
                                <Table.Cell colSpan={6} className="h-14 px-4">
                                  <div className="flex items-center gap-3">
                                    <Skeleton className="size-8 rounded-full" />
                                    <div className="flex-1 space-y-1.5">
                                      <Skeleton className="h-3.5 w-48" />
                                      <Skeleton className="h-3 w-72 max-w-full" />
                                    </div>
                                  </div>
                                </Table.Cell>
                              </Table.Row>
                            ))
                          : leads.map((lead) => {
                              const displayName = lead.name ?? lead.linkedinUrl;
                              const editableCount = MESSAGE_FIELDS.filter((k) => isMessageEditable(k, lead.status)).length;
                              const status = LEAD_STATUS[lead.status];
                              const selected = selectedIds.has(lead.id);
                              return (
                                <Table.Row
                                  key={lead.id}
                                  tabIndex={0}
                                  aria-selected={selected}
                                  onClick={() => setSelectedLeadId(lead.id)}
                                  onKeyDown={(e) => { if (e.target === e.currentTarget && e.key === "Enter") setSelectedLeadId(lead.id); }}
                                  className={cn(
                                    "cursor-pointer outline-none focus-visible:[&>td]:bg-bg-weak-50",
                                    (selectedLeadId === lead.id || selected) && "[&>td]:bg-bg-weak-50",
                                    deletingId === lead.id && "pointer-events-none opacity-60",
                                  )}
                                >
                                  <Table.Cell className="h-14 px-4" onClick={(e) => e.stopPropagation()} onKeyDown={(e) => e.stopPropagation()}>
                                    <Checkbox.Root
                                      aria-label={`Select ${displayName}`}
                                      checked={selected}
                                      onCheckedChange={(checked) => {
                                        const on = checked === true;
                                        if (!on) setAllMatchingSelected(false);
                                        setSelectedIds((prev) => toggleLeadSelection(prev, lead.id, on));
                                      }}
                                    />
                                  </Table.Cell>
                                  <Table.Cell className="px-4 py-2">
                                    <div className="flex min-w-0 items-center gap-3">
                                      <LeadAvatar src={lead.profilePictureUrl} name={displayName} />
                                      <div className="min-w-0">
                                        <div className="flex min-w-0 items-center gap-1.5">
                                          <span className="truncate text-label-sm text-text-strong-950" title={displayName}>{displayName}</span>
                                          <a
                                            href={linkedinProfileUrl(lead.linkedinUrl) ?? undefined}
                                            target="_blank"
                                            rel="noopener noreferrer"
                                            onClick={(e) => e.stopPropagation()}
                                            aria-label={`Open ${displayName} on LinkedIn`}
                                            title="Open on LinkedIn"
                                            className="shrink-0 rounded text-text-soft-400 outline-none transition hover:text-text-strong-950 focus-visible:ring-2 focus-visible:ring-primary-base"
                                          >
                                            <RiExternalLinkLine className="size-3.5" />
                                          </a>
                                        </div>
                                        {(lead.headline || (lead.alsoInCampaigns && lead.alsoInCampaigns.length > 0)) && (
                                          <div className="flex min-w-0 items-center gap-2">
                                            {lead.headline && (
                                              <p className="min-w-0 max-w-md truncate text-paragraph-xs text-text-sub-600" title={lead.headline}>{lead.headline}</p>
                                            )}
                                            {lead.alsoInCampaigns && lead.alsoInCampaigns.length > 0 && (
                                              <Badge.Root
                                                size="small"
                                                variant="lighter"
                                                color="orange"
                                                className="max-w-56 shrink-0"
                                                title={`Also in: ${lead.alsoInCampaigns.map((c) => c.name).join(", ")}`}
                                              >
                                                <span className="truncate">
                                                  Also in {lead.alsoInCampaigns[0]!.name}
                                                  {lead.alsoInCampaigns.length > 1 ? ` +${lead.alsoInCampaigns.length - 1}` : ""}
                                                </span>
                                              </Badge.Root>
                                            )}
                                          </div>
                                        )}
                                      </div>
                                    </div>
                                  </Table.Cell>
                                  <Table.Cell className="px-4">
                                    <Badge.Root size="medium" variant="lighter" color={status?.color ?? "gray"}>
                                      <Badge.Dot />
                                      {status?.label ?? lead.status}
                                    </Badge.Root>
                                  </Table.Cell>
                                  <Table.Cell className="px-4">
                                    {lead.linkedInAccount ? (
                                      <LinkedInAccountTag account={lead.linkedInAccount} />
                                    ) : (
                                      <span className="text-paragraph-sm text-text-soft-400">—</span>
                                    )}
                                  </Table.Cell>
                                  <Table.Cell className="px-4">
                                    {editableCount > 0 ? (
                                      <span className="inline-flex items-center gap-1 text-paragraph-sm text-text-sub-600">
                                        <RiPencilLine className="size-3.5 text-text-soft-400" />
                                        {editableCount} editable
                                      </span>
                                    ) : (
                                      <span className="text-paragraph-sm text-text-soft-400">All sent</span>
                                    )}
                                  </Table.Cell>
                                  <Table.Cell className="px-4" onClick={(e) => e.stopPropagation()} onKeyDown={(e) => e.stopPropagation()}>
                                    <div className="flex justify-end">
                                      <Dropdown.Root>
                                        <Dropdown.Trigger asChild>
                                          <Button.Root variant="neutral" mode="ghost" size="xsmall" disabled={deletingId === lead.id} aria-label={`More actions for ${displayName}`}>
                                            <Button.Icon as={deletingId === lead.id ? RiLoader4Line : RiMoreLine} className={cn(deletingId === lead.id && "animate-spin")} />
                                          </Button.Root>
                                        </Dropdown.Trigger>
                                        <Dropdown.Content>
                                          <Dropdown.Item onSelect={() => setSelectedLeadId(lead.id)}>
                                            <Dropdown.ItemIcon as={RiPencilLine} />
                                            View and edit messages
                                          </Dropdown.Item>
                                          <Dropdown.Item onSelect={() => window.open(linkedinProfileUrl(lead.linkedinUrl) ?? "", "_blank", "noopener,noreferrer")}>
                                            <Dropdown.ItemIcon as={RiExternalLinkLine} />
                                            Open on LinkedIn
                                          </Dropdown.Item>
                                          <Dropdown.Separator />
                                          <Dropdown.Item destructive onSelect={() => void handleDeleteLead(lead)}>
                                            <Dropdown.ItemIcon as={RiDeleteBinLine} />
                                            Remove lead
                                          </Dropdown.Item>
                                        </Dropdown.Content>
                                      </Dropdown.Root>
                                    </div>
                                  </Table.Cell>
                                </Table.Row>
                              );
                            })}
                      </Table.Body>
                    </Table.Root>
                  </div>

                  {pagination.pages > 1 && (
                    <div className="mt-2 flex items-center justify-between gap-3 border-t border-stroke-soft-200 px-1 pt-3">
                      <p className="text-paragraph-xs text-text-sub-600">
                        Page {pagination.page} of {pagination.pages} · {pagination.total.toLocaleString("en-US")} lead{pagination.total !== 1 ? "s" : ""}
                      </p>
                      <div className="flex gap-2">
                        <Button.Root variant="neutral" mode="stroke" size="xsmall" disabled={pagination.page <= 1 || loading} onClick={() => { clearSelection(); void fetchLeads(pagination.page - 1); }}>
                          <Button.Icon as={RiArrowLeftSLine} />
                          Prev
                        </Button.Root>
                        <Button.Root variant="neutral" mode="stroke" size="xsmall" disabled={pagination.page >= pagination.pages || loading} onClick={() => { clearSelection(); void fetchLeads(pagination.page + 1); }}>
                          Next
                          <Button.Icon as={RiArrowRightSLine} />
                        </Button.Root>
                      </div>
                    </div>
                  )}
                </>
              )}
            </>
          )}
        </FramePanel>
      </Frame>

      <LeadDetailPanel
        leadId={selectedLeadId}
        onClose={() => setSelectedLeadId(null)}
        onMessagesSaved={(id, updates) => setLeads((prev) => prev.map((l) => (l.id === id ? { ...l, ...updates } : l)))}
      />

      {showPeople && (
        <AddPeopleToCampaignModal campaignId={campaignId} channel="linkedin" onClose={() => setShowPeople(false)} onAdded={onChanged} />
      )}

      {pendingImportFile && (
        <CampaignCsvMappingDialog
          file={pendingImportFile}
          endpoint={`/api/linkedin/campaigns/${campaignId}/upload`}
          channel="linkedin"
          onClose={() => {
            setPendingImportFile(null);
            if (fileRef.current) fileRef.current.value = "";
          }}
          onImported={(data) => {
            const created = Number(data.created ?? 0);
            const attached = Number(data.attached ?? 0);
            const failed = Number(data.failed ?? 0);
            const parts = [`${created} imported`];
            if (attached) parts.push(`${attached} existing linked`);
            if (failed) parts.push(`${failed} failed`);
            setUploadResult({
              ok: true,
              message: parts.join(", "),
              ...(typeof data.failedFileBase64 === "string" && typeof data.failedFileName === "string"
                ? { failedFileBase64: data.failedFileBase64, failedFileName: data.failedFileName }
                : {}),
              ...(Array.isArray(data.crossCampaignNotices) ? { crossCampaignNotices: data.crossCampaignNotices as CrossCampaignNotice[] } : {}),
            });
            setPendingImportFile(null);
            if (fileRef.current) fileRef.current.value = "";
            onChanged();
            void fetchLeads(1);
          }}
        />
      )}
    </>
  );
}
