/**
 * Pagination — the page control used under grids, lists and boards.
 *
 * Ranges are elided the way every good dashboard does it: first, last, a window
 * around the current page, and ellipses in between, so the control never
 * reflows as the user walks through 900 pages.
 */
import { useMemo } from "react";
import { cx } from "../cx";
import {
  IconChevronLeft,
  IconChevronRight,
  IconChevronsLeft,
  IconChevronsRight,
} from "../icons";
import { Button, Select } from "../primitives";
import { formatNumber } from "./format";
import type { PaginationProps } from "./types";

const DEFAULT_PAGE_SIZES = [25, 50, 100, 250] as const;

/** first, last, and a ±1 window around `page`, with `null` for each gap. */
export function pageWindow(page: number, pageCount: number): Array<number | null> {
  if (pageCount <= 7) return Array.from({ length: pageCount }, (_, index) => index);
  const window = new Set<number>([0, pageCount - 1, page, page - 1, page + 1]);
  if (page <= 2) [1, 2, 3].forEach((entry) => window.add(entry));
  if (page >= pageCount - 3) {
    [pageCount - 2, pageCount - 3, pageCount - 4].forEach((entry) => window.add(entry));
  }
  const pages = [...window].filter((entry) => entry >= 0 && entry < pageCount).sort((a, b) => a - b);

  const result: Array<number | null> = [];
  let previous = -1;
  for (const entry of pages) {
    if (previous >= 0 && entry - previous > 1) result.push(null);
    result.push(entry);
    previous = entry;
  }
  return result;
}

export function Pagination({
  page,
  pageSize,
  total,
  pageCount: pageCountProp,
  pageSizeOptions = DEFAULT_PAGE_SIZES,
  onPageChange,
  onPageSizeChange,
  showSizeSelector = true,
  showSummary = true,
  showPages = true,
  size = "sm",
  className,
  disabled = false,
  itemNoun = "row",
}: PaginationProps) {
  const pageCount = Math.max(
    1,
    pageCountProp ?? (total !== undefined ? Math.ceil(total / Math.max(1, pageSize)) : 1),
  );
  const current = Math.min(Math.max(0, page), pageCount - 1);
  const pages = useMemo(() => pageWindow(current, pageCount), [current, pageCount]);

  const from = total === 0 ? 0 : current * pageSize + 1;
  const to = total === undefined ? (current + 1) * pageSize : Math.min(total, (current + 1) * pageSize);

  const atStart = current === 0 || disabled;
  const atEnd = current >= pageCount - 1 || disabled;
  const buttonSize = size === "sm" ? "xs" : "sm";

  return (
    <nav
      aria-label="Pagination"
      className={cx(
        "flex flex-wrap items-center justify-between gap-x-4 gap-y-2 px-cell-x py-2",
        className,
      )}
    >
      <div className="flex min-w-0 items-center gap-3">
        {showSummary ? (
          <p className="text-meta text-content-muted">
            {total === undefined ? (
              <>
                Page <span className="tabular-nums text-content">{current + 1}</span> of{" "}
                <span className="tabular-nums text-content">{formatNumber(pageCount)}</span>
              </>
            ) : (
              <>
                <span className="tabular-nums text-content">
                  {formatNumber(from)}–{formatNumber(to)}
                </span>{" "}
                of <span className="tabular-nums text-content">{formatNumber(total)}</span>{" "}
                {total === 1 ? itemNoun : `${itemNoun}s`}
              </>
            )}
          </p>
        ) : null}

        {showSizeSelector && onPageSizeChange ? (
          <label className="flex items-center gap-1.5 text-meta text-content-subtle">
            <span className="hidden sm:inline">Rows</span>
            <Select
              size="xs"
              value={String(pageSize)}
              disabled={disabled}
              aria-label="Rows per page"
              onChange={(event) => onPageSizeChange(Number(event.target.value))}
              className="w-[4.5rem]"
            >
              {pageSizeOptions.map((option) => (
                <option key={option} value={option}>
                  {option}
                </option>
              ))}
            </Select>
          </label>
        ) : null}
      </div>

      <div className="flex items-center gap-0.5">
        <Button
          variant="ghost"
          size={buttonSize}
          iconOnly
          leadingIcon={IconChevronsLeft}
          aria-label="First page"
          disabled={atStart}
          onClick={() => onPageChange(0)}
        />
        <Button
          variant="ghost"
          size={buttonSize}
          iconOnly
          leadingIcon={IconChevronLeft}
          aria-label="Previous page"
          disabled={atStart}
          onClick={() => onPageChange(current - 1)}
        />

        {showPages ? (
          <ol className="mx-1 flex items-center gap-0.5">
            {pages.map((entry, index) =>
              entry === null ? (
                <li
                  key={`gap-${index}`}
                  aria-hidden="true"
                  className="px-1 text-meta text-content-disabled"
                >
                  …
                </li>
              ) : (
                <li key={entry}>
                  <button
                    type="button"
                    disabled={disabled}
                    aria-current={entry === current ? "page" : undefined}
                    onClick={() => onPageChange(entry)}
                    className={cx(
                      "inline-flex h-control-xs min-w-control-xs items-center justify-center rounded-sm px-1.5",
                      "text-meta tabular-nums transition-colors duration-fast",
                      entry === current
                        ? "bg-accent-subtle font-semibold text-accent-subtle-fg"
                        : "text-content-muted hover:bg-surface-hover hover:text-content",
                      disabled && "pointer-events-none opacity-50",
                    )}
                  >
                    {entry + 1}
                  </button>
                </li>
              ),
            )}
          </ol>
        ) : (
          <span className="mx-2 text-meta tabular-nums text-content-muted">
            {current + 1} / {pageCount}
          </span>
        )}

        <Button
          variant="ghost"
          size={buttonSize}
          iconOnly
          leadingIcon={IconChevronRight}
          aria-label="Next page"
          disabled={atEnd}
          onClick={() => onPageChange(current + 1)}
        />
        <Button
          variant="ghost"
          size={buttonSize}
          iconOnly
          leadingIcon={IconChevronsRight}
          aria-label="Last page"
          disabled={atEnd}
          onClick={() => onPageChange(pageCount - 1)}
        />
      </div>
    </nav>
  );
}
