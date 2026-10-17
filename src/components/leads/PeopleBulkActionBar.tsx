"use client";

import { RiCloseLine, RiDeleteBinLine, RiLoader4Line } from "@remixicon/react";
import * as Button from "@/components/alignui/button";
import { cn } from "@/utils/cn";

/**
 * The selection summary + bulk delete bar above the People table, mirroring
 * the UX of CampaignLeadsTab's LeadBulkActionBar (checkbox selection,
 * "select all N matching", bulk delete) but built on AlignUI to match the
 * rest of this page.
 */
export function PeopleBulkActionBar({
  selectedCount,
  pageCount,
  totalCount,
  allPageSelected,
  allMatchingSelected,
  onSelectAllMatching,
  onClear,
  onDelete,
  deleting,
  selectingAll,
}: {
  selectedCount: number;
  pageCount: number;
  totalCount: number;
  allPageSelected: boolean;
  allMatchingSelected: boolean;
  onSelectAllMatching: () => void;
  onClear: () => void;
  onDelete: () => void;
  deleting: boolean;
  selectingAll?: boolean;
}) {
  const showSelectAllBanner = allPageSelected && !allMatchingSelected && totalCount > pageCount && pageCount > 0;
  if (selectedCount === 0 && !showSelectAllBanner) return null;

  return (
    <div className="space-y-2 px-1 pb-3">
      {showSelectAllBanner && (
        <div className="rounded-xl bg-information-lighter px-3 py-2.5 text-paragraph-sm text-information-dark">
          All <span className="font-medium">{pageCount}</span> people on this page are selected.{" "}
          <button
            type="button"
            onClick={onSelectAllMatching}
            disabled={selectingAll || deleting}
            className="font-medium underline underline-offset-2 hover:no-underline disabled:opacity-50"
          >
            {selectingAll ? "Selecting…" : `Select all ${totalCount.toLocaleString("en-US")} people`}
          </button>
        </div>
      )}

      {selectedCount > 0 && (
        <div className="flex flex-wrap items-center justify-between gap-3 rounded-xl bg-information-lighter px-3 py-2.5">
          <p className="text-paragraph-sm text-information-dark">
            <span className="font-medium">{selectedCount.toLocaleString("en-US")}</span> selected
            {allMatchingSelected ? " (all matching)" : selectedCount > pageCount ? " across pages" : ""}
          </p>
          <div className="flex items-center gap-2">
            <Button.Root variant="neutral" mode="ghost" size="xsmall" onClick={onClear} disabled={deleting || selectingAll}>
              <Button.Icon as={RiCloseLine} />
              Clear
            </Button.Root>
            <Button.Root variant="error" mode="stroke" size="xsmall" onClick={onDelete} disabled={deleting || selectingAll}>
              <Button.Icon as={deleting ? RiLoader4Line : RiDeleteBinLine} className={cn(deleting && "animate-spin")} />
              Delete selected
            </Button.Root>
          </div>
        </div>
      )}
    </div>
  );
}
