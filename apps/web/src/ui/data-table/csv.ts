/**
 * data-table/csv — export the *current view* (visible columns, current order,
 * current filters and sort) as a spreadsheet-safe CSV.
 *
 * "Spreadsheet-safe" means two things nobody remembers until it bites:
 *   1. RFC-4180 quoting, with CRLF line endings so Excel on Windows behaves.
 *   2. Formula injection is neutralised — a cell starting `=`, `+`, `-`, `@`,
 *      TAB or CR is prefixed with a single quote so Excel treats it as text.
 */

const FORMULA_TRIGGER = /^[=+\-@\t\r]/;

export function escapeCsvValue(value: unknown): string {
  if (value === null || value === undefined) return "";
  let text = typeof value === "string" ? value : String(value);
  if (FORMULA_TRIGGER.test(text)) text = `'${text}`;
  if (/[",\r\n]/.test(text)) {
    return `"${text.replace(/"/g, '""')}"`;
  }
  return text;
}

export interface CsvTable {
  headers: readonly string[];
  rows: ReadonlyArray<ReadonlyArray<string | number | null | undefined>>;
}

export function toCsv(table: CsvTable, delimiter = ","): string {
  const lines: string[] = [];
  lines.push(table.headers.map(escapeCsvValue).join(delimiter));
  for (const row of table.rows) {
    lines.push(row.map(escapeCsvValue).join(delimiter));
  }
  // BOM so Excel reads UTF-8 without mangling accents and currency symbols.
  return `﻿${lines.join("\r\n")}\r\n`;
}

export function sanitiseFileName(name: string): string {
  const cleaned = name
    .replace(/[\\/:*?"<>|]+/g, "-")
    .replace(/\s+/g, "-")
    .replace(/-+/g, "-")
    .replace(/^-|-$/g, "");
  return cleaned || "export";
}

export function timestampSuffix(date = new Date()): string {
  const pad = (n: number) => String(n).padStart(2, "0");
  return `${date.getFullYear()}${pad(date.getMonth() + 1)}${pad(date.getDate())}-${pad(
    date.getHours(),
  )}${pad(date.getMinutes())}`;
}

/** Trigger a browser download. No-op outside the browser. */
export function downloadCsv(csv: string, fileName: string): void {
  if (typeof document === "undefined" || typeof URL === "undefined") return;
  const base = sanitiseFileName(fileName.replace(/\.csv$/i, ""));
  const blob = new Blob([csv], { type: "text/csv;charset=utf-8;" });
  const url = URL.createObjectURL(blob);
  const anchor = document.createElement("a");
  anchor.href = url;
  anchor.download = `${base}.csv`;
  anchor.rel = "noopener";
  anchor.style.display = "none";
  document.body.appendChild(anchor);
  anchor.click();
  document.body.removeChild(anchor);
  // Revoke on the next frame — Safari needs the URL alive during the click.
  window.setTimeout(() => URL.revokeObjectURL(url), 0);
}

export function exportCsv(table: CsvTable, fileName: string, delimiter = ","): void {
  downloadCsv(toCsv(table, delimiter), fileName);
}
