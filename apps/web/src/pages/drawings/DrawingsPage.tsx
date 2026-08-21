/**
 * Drawings home: drawing-set upload + processing status on the left, the
 * sheet register (filterable, searchable, review-queue aware) as the main
 * surface. Rows link into the full sheet viewer.
 */
import { useCallback, useEffect, useMemo, useRef, useState, type ChangeEvent } from "react";
import { Link, useParams } from "react-router-dom";
import { api, ApiClientError } from "../../lib/api";
import {
  Badge,
  Button,
  Card,
  CardBody,
  EmptyState,
  ErrorAlert,
  Input,
  PageHeader,
  Select,
  Spinner,
  Table,
  Td,
  Th,
} from "../../ui";
import { formatDate, humanize } from "../format";
import type { DrawingSetItem, ListResponse, SheetListItem } from "./types";

const DISCIPLINE_TONES: Record<string, string> = {
  general: "gray",
  civil: "green",
  architectural: "blue",
  structural: "violet",
  mechanical: "amber",
  electrical: "amber",
  plumbing: "blue",
  fire_protection: "red",
  landscape: "green",
  interiors: "violet",
  telecom: "gray",
  other: "gray",
};

const DISCIPLINES = [
  "general",
  "civil",
  "architectural",
  "structural",
  "mechanical",
  "electrical",
  "plumbing",
  "fire_protection",
  "landscape",
  "interiors",
  "telecom",
  "other",
];

function processingTone(status: string): string {
  if (status === "ready") return "green";
  if (status === "failed") return "red";
  return "blue";
}

interface ReviewDraft {
  number: string;
  title: string;
  discipline: string;
}

export default function DrawingsPage() {
  const { projectId } = useParams<{ projectId: string }>();

  /* ------------------------------- sets ------------------------------- */
  const [sets, setSets] = useState<DrawingSetItem[] | null>(null);
  const [setsError, setSetsError] = useState<string | null>(null);
  const [uploading, setUploading] = useState(false);
  const fileInputRef = useRef<HTMLInputElement>(null);

  /* ------------------------------ sheets ------------------------------ */
  const [sheets, setSheets] = useState<SheetListItem[] | null>(null);
  const [sheetsTotal, setSheetsTotal] = useState(0);
  const [sheetsError, setSheetsError] = useState<string | null>(null);
  const [discipline, setDiscipline] = useState<string>("");
  const [search, setSearch] = useState("");
  const [debouncedSearch, setDebouncedSearch] = useState("");
  const [reviewOnly, setReviewOnly] = useState(false);
  const [presentDisciplines, setPresentDisciplines] = useState<string[]>([]);
  const [reviewCount, setReviewCount] = useState(0);

  /* ------------------------- review inline edit ------------------------ */
  const [reviewDrafts, setReviewDrafts] = useState<Record<string, ReviewDraft>>({});
  const [savingReview, setSavingReview] = useState<string | null>(null);
  const [reviewError, setReviewError] = useState<string | null>(null);

  const loadSets = useCallback(async () => {
    if (!projectId) return;
    try {
      const res = await api.get<ListResponse<DrawingSetItem>>(
        `/api/v1/projects/${projectId}/drawing-sets?pageSize=100`,
      );
      setSets(res.items ?? []);
      setSetsError(null);
    } catch (err) {
      setSetsError(err instanceof ApiClientError ? err.message : "Failed to load drawing sets");
      setSets((prev) => prev ?? []);
    }
  }, [projectId]);

  const loadSheets = useCallback(async () => {
    if (!projectId) return;
    try {
      const params = new URLSearchParams({ pageSize: "200" });
      if (discipline) params.set("discipline", discipline);
      if (debouncedSearch) params.set("search", debouncedSearch);
      if (reviewOnly) params.set("needsReview", "1");
      const res = await api.get<ListResponse<SheetListItem>>(
        `/api/v1/projects/${projectId}/sheets?${params.toString()}`,
      );
      const items = res.items ?? [];
      setSheets(items);
      setSheetsTotal(res.total ?? items.length);
      setSheetsError(null);
      if (!discipline && !debouncedSearch && !reviewOnly) {
        setPresentDisciplines([...new Set(items.map((s) => s.discipline))]);
        setReviewCount(items.filter((s) => Number(s.needsReview) === 1).length);
      }
    } catch (err) {
      setSheetsError(err instanceof ApiClientError ? err.message : "Failed to load sheets");
      setSheets((prev) => prev ?? []);
    }
  }, [projectId, discipline, debouncedSearch, reviewOnly]);

  useEffect(() => {
    void loadSets();
  }, [loadSets]);

  useEffect(() => {
    const h = window.setTimeout(() => setDebouncedSearch(search.trim()), 300);
    return () => window.clearTimeout(h);
  }, [search]);

  useEffect(() => {
    void loadSheets();
  }, [loadSheets]);

  // Poll processing sets every 2s until everything is ready/failed.
  const anyProcessing = useMemo(
    () => (sets ?? []).some((s) => s.processing === "pending" || s.processing === "processing"),
    [sets],
  );
  useEffect(() => {
    if (!anyProcessing) return;
    const h = window.setInterval(() => {
      void loadSets();
      void loadSheets();
    }, 2000);
    return () => window.clearInterval(h);
  }, [anyProcessing, loadSets, loadSheets]);

  async function onUpload(e: ChangeEvent<HTMLInputElement>) {
    const file = e.target.files?.[0];
    e.target.value = "";
    if (!file || !projectId) return;
    setUploading(true);
    setSetsError(null);
    try {
      const form = new FormData();
      form.append("name", file.name.replace(/\.pdf$/i, ""));
      form.append("file", file);
      await api.upload(`/api/v1/projects/${projectId}/drawing-sets`, form);
      await Promise.all([loadSets(), loadSheets()]);
    } catch (err) {
      setSetsError(err instanceof ApiClientError ? err.message : "Upload failed");
    } finally {
      setUploading(false);
    }
  }

  function draftFor(sheet: SheetListItem): ReviewDraft {
    return (
      reviewDrafts[sheet.id] ?? {
        number: sheet.number,
        title: sheet.title,
        discipline: sheet.discipline,
      }
    );
  }

  async function confirmReview(sheet: SheetListItem) {
    const draft = draftFor(sheet);
    setSavingReview(sheet.id);
    setReviewError(null);
    try {
      await api.patch(`/api/v1/sheets/${sheet.id}`, {
        number: draft.number.trim(),
        title: draft.title.trim(),
        discipline: draft.discipline,
        confirmReview: true,
      });
      setReviewDrafts((prev) => {
        const next = { ...prev };
        delete next[sheet.id];
        return next;
      });
      await loadSheets();
    } catch (err) {
      setReviewError(err instanceof ApiClientError ? err.message : "Failed to confirm sheet");
    } finally {
      setSavingReview(null);
    }
  }

  const chips = useMemo(() => {
    const present = presentDisciplines.length
      ? DISCIPLINES.filter((d) => presentDisciplines.includes(d))
      : [];
    return present;
  }, [presentDisciplines]);

  return (
    <div>
      <PageHeader
        title="Drawings"
        subtitle="Sheet register, revisions and markups"
        actions={
          <>
            <input
              ref={fileInputRef}
              type="file"
              accept="application/pdf,.pdf"
              className="hidden"
              onChange={(e) => void onUpload(e)}
            />
            <Button onClick={() => fileInputRef.current?.click()} disabled={uploading}>
              {uploading ? "Uploading…" : "Upload drawing set"}
            </Button>
          </>
        }
      />

      <div className="grid gap-5 lg:grid-cols-[280px_minmax(0,1fr)]">
        {/* ------------------------------ sets ------------------------------ */}
        <div>
          <Card>
            <CardBody>
              <div className="mb-2 flex items-center justify-between">
                <h2 className="text-sm font-semibold text-ink-900">Drawing sets</h2>
                {anyProcessing ? (
                  <span className="flex items-center gap-1 text-xs text-brand-600">
                    <span className="h-2 w-2 animate-pulse rounded-full bg-brand-500" />
                    processing…
                  </span>
                ) : null}
              </div>
              <ErrorAlert message={setsError} />
              {sets === null ? (
                <Spinner label="Loading sets…" />
              ) : sets.length === 0 ? (
                <p className="py-4 text-center text-xs text-ink-400">
                  No sets yet. Upload a multi-sheet PDF to build the register.
                </p>
              ) : (
                <ul className="divide-y divide-ink-100">
                  {sets.map((set) => (
                    <li key={set.id} className="py-2.5">
                      <div className="flex items-start justify-between gap-2">
                        <div className="min-w-0">
                          <p className="truncate text-sm font-medium text-ink-800">{set.name}</p>
                          <p className="mt-0.5 text-xs text-ink-400">
                            {set.sheetCount ?? 0} sheet{(set.sheetCount ?? 0) === 1 ? "" : "s"}
                            {set.createdAt ? ` · ${formatDate(set.createdAt)}` : ""}
                          </p>
                        </div>
                        <Badge tone={processingTone(set.processing)}>
                          {set.processing === "processing" || set.processing === "pending"
                            ? "processing…"
                            : set.processing}
                        </Badge>
                      </div>
                    </li>
                  ))}
                </ul>
              )}
            </CardBody>
          </Card>
          {reviewCount > 0 ? (
            <button
              type="button"
              onClick={() => setReviewOnly(true)}
              className="mt-3 w-full rounded-lg bg-amber-50 px-3 py-2 text-left text-xs text-amber-800 ring-1 ring-amber-200 hover:bg-amber-100"
            >
              <span className="font-semibold">{reviewCount}</span> sheet
              {reviewCount === 1 ? "" : "s"} need title-block review — confirm number &amp; title.
            </button>
          ) : null}
        </div>

        {/* ----------------------------- register --------------------------- */}
        <div className="min-w-0">
          <div className="mb-3 flex flex-wrap items-center gap-2">
            <button
              type="button"
              onClick={() => setDiscipline("")}
              className={`rounded-full px-3 py-1 text-xs font-medium ring-1 transition-colors ${
                discipline === ""
                  ? "bg-brand-600 text-white ring-brand-600"
                  : "bg-white text-ink-600 ring-ink-200 hover:bg-ink-50"
              }`}
            >
              All
            </button>
            {chips.map((d) => (
              <button
                key={d}
                type="button"
                onClick={() => setDiscipline(discipline === d ? "" : d)}
                className={`rounded-full px-3 py-1 text-xs font-medium ring-1 transition-colors ${
                  discipline === d
                    ? "bg-brand-600 text-white ring-brand-600"
                    : "bg-white text-ink-600 ring-ink-200 hover:bg-ink-50"
                }`}
              >
                {humanize(d)}
              </button>
            ))}
            <div className="ml-auto flex items-center gap-2">
              <Input
                value={search}
                onChange={(e) => setSearch(e.target.value)}
                placeholder="Search number or title…"
                className="w-56"
              />
              <button
                type="button"
                onClick={() => setReviewOnly((v) => !v)}
                className={`whitespace-nowrap rounded-md px-3 py-2 text-xs font-medium ring-1 transition-colors ${
                  reviewOnly
                    ? "bg-amber-100 text-amber-800 ring-amber-300"
                    : "bg-white text-ink-600 ring-ink-200 hover:bg-ink-50"
                }`}
              >
                Needs review
              </button>
            </div>
          </div>

          <ErrorAlert message={sheetsError} />
          <ErrorAlert message={reviewError} />

          {sheets === null ? (
            <Spinner label="Loading sheet register…" />
          ) : sheets.length === 0 ? (
            <EmptyState
              title={reviewOnly || discipline || debouncedSearch ? "No sheets match" : "No sheets yet"}
              hint={
                reviewOnly || discipline || debouncedSearch
                  ? "Adjust the filters or search term."
                  : "Upload a drawing set PDF — each page is split into a sheet automatically."
              }
            />
          ) : (
            <>
              <Table>
                <thead>
                  <tr>
                    <Th>Number</Th>
                    <Th>Title</Th>
                    <Th>Discipline</Th>
                    <Th>Rev</Th>
                    <Th>Status</Th>
                    <Th className="w-px" />
                  </tr>
                </thead>
                <tbody className="divide-y divide-ink-50">
                  {sheets.map((sheet) => {
                    const needsReview = Number(sheet.needsReview) === 1;
                    const draft = draftFor(sheet);
                    return (
                      <tr key={sheet.id} className="hover:bg-ink-50/60">
                        <Td className="font-medium">
                          {needsReview ? (
                            <Input
                              value={draft.number}
                              onChange={(e) =>
                                setReviewDrafts((prev) => ({
                                  ...prev,
                                  [sheet.id]: { ...draft, number: e.target.value },
                                }))
                              }
                              className="w-28 py-1! text-xs"
                            />
                          ) : (
                            <Link
                              to={sheet.id}
                              className="text-brand-700 hover:text-brand-800 hover:underline"
                            >
                              {sheet.number}
                            </Link>
                          )}
                        </Td>
                        <Td>
                          {needsReview ? (
                            <Input
                              value={draft.title}
                              onChange={(e) =>
                                setReviewDrafts((prev) => ({
                                  ...prev,
                                  [sheet.id]: { ...draft, title: e.target.value },
                                }))
                              }
                              className="w-full min-w-40 py-1! text-xs"
                            />
                          ) : (
                            <Link to={sheet.id} className="block text-ink-800 hover:text-ink-950">
                              {sheet.title}
                            </Link>
                          )}
                        </Td>
                        <Td>
                          {needsReview ? (
                            <Select
                              value={draft.discipline}
                              onChange={(e) =>
                                setReviewDrafts((prev) => ({
                                  ...prev,
                                  [sheet.id]: { ...draft, discipline: e.target.value },
                                }))
                              }
                              className="w-36 py-1! text-xs"
                            >
                              {DISCIPLINES.map((d) => (
                                <option key={d} value={d}>
                                  {humanize(d)}
                                </option>
                              ))}
                            </Select>
                          ) : (
                            <Badge tone={DISCIPLINE_TONES[sheet.discipline] ?? "gray"}>
                              {humanize(sheet.discipline)}
                            </Badge>
                          )}
                        </Td>
                        <Td>
                          {sheet.currentRevision ? (
                            <span className="inline-flex items-center rounded bg-ink-100 px-1.5 py-0.5 font-mono text-xs text-ink-700">
                              {sheet.currentRevision.revision}
                            </span>
                          ) : (
                            <span className="text-xs text-ink-300">—</span>
                          )}
                        </Td>
                        <Td>
                          {needsReview ? (
                            <Badge tone="amber">needs review</Badge>
                          ) : (
                            <Badge tone="green">confirmed</Badge>
                          )}
                        </Td>
                        <Td>
                          {needsReview ? (
                            <Button
                              size="sm"
                              onClick={() => void confirmReview(sheet)}
                              disabled={savingReview === sheet.id || !draft.number.trim()}
                            >
                              {savingReview === sheet.id ? "Saving…" : "Confirm"}
                            </Button>
                          ) : (
                            <Link
                              to={sheet.id}
                              className="whitespace-nowrap text-xs font-medium text-brand-700 hover:underline"
                            >
                              Open →
                            </Link>
                          )}
                        </Td>
                      </tr>
                    );
                  })}
                </tbody>
              </Table>
              <p className="mt-2 text-xs text-ink-400">
                {sheets.length < sheetsTotal
                  ? `Showing ${sheets.length} of ${sheetsTotal} sheets — refine the filters to narrow down.`
                  : `${sheetsTotal} sheet${sheetsTotal === 1 ? "" : "s"}`}
              </p>
            </>
          )}
        </div>
      </div>
    </div>
  );
}
