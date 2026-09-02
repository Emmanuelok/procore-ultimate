/** The sheet register: filterable by discipline, area, set, review state, and by the text on the sheet (#287). */
import { useEffect, useMemo, useState } from "react";
import { useNavigate } from "react-router-dom";
import { Badge, DataTable, EmptyState, Input, Select, type DataColumns } from "../../ui";
import { IconDrawing } from "../../ui/icons";
import { useResource } from "../../layouts/project/lib";
import { humanize, formatDate } from "../format";
import { DISCIPLINES, verdictTone } from "./drawingsShared";
import type { DrawingSetItem, ListResponse, SheetListItem } from "./types";

export default function SheetsTab({ projectId, version, byDiscipline, onChanged }: { projectId: string; version: number; byDiscipline: Record<string, number>; onChanged: () => void }) {
  const navigate = useNavigate();
  const [discipline, setDiscipline] = useState("");
  const [area, setArea] = useState("");
  const [setId, setSetId] = useState("");
  const [search, setSearch] = useState("");
  const [text, setText] = useState("");
  const [debounced, setDebounced] = useState({ search: "", text: "" });
  const [reviewOnly, setReviewOnly] = useState(false);

  useEffect(() => {
    const h = window.setTimeout(() => setDebounced({ search: search.trim(), text: text.trim() }), 300);
    return () => window.clearTimeout(h);
  }, [search, text]);

  const params = new URLSearchParams({ pageSize: "500", _v: String(version) });
  if (discipline) params.set("discipline", discipline);
  if (area) params.set("area", area);
  if (setId) params.set("setId", setId);
  if (debounced.search) params.set("search", debounced.search);
  if (debounced.text) params.set("text", debounced.text);
  if (reviewOnly) params.set("needsReview", "1");
  const sheets = useResource<ListResponse<SheetListItem> & { access?: { segregated: boolean } }>(`/api/v1/projects/${projectId}/sheets?${params}`);
  const sets = useResource<ListResponse<DrawingSetItem>>(`/api/v1/projects/${projectId}/drawing-sets?pageSize=100&_v=${version}`);

  const rows = sheets.data?.items ?? [];
  const areas = useMemo(() => [...new Set(rows.map((r) => r.area).filter((a): a is string => Boolean(a)))].sort(), [rows]);
  const chips = DISCIPLINES.filter((d) => (byDiscipline[d] ?? 0) > 0);

  const columns = useMemo<DataColumns<SheetListItem>>(
    () => [
      { id: "number", header: "Number", accessor: "number", type: "code", width: 120, mono: true, sticky: "start" },
      { id: "title", header: "Title", accessor: "title", type: "text", width: 320, truncate: true },
      { id: "discipline", header: "Discipline", accessor: "discipline", type: "status", width: 140, groupable: true, cell: ({ row }) => <Badge tone="neutral" size="xs">{humanize(row.discipline)}</Badge> },
      { id: "area", header: "Area", accessor: (row) => row.area ?? "", type: "text", width: 120, cell: ({ row }) => row.area ?? <span className="text-content-subtle">—</span> },
      { id: "rev", header: "Rev", accessor: (row) => row.currentRevision?.revision ?? "", type: "code", width: 70, mono: true, cell: ({ row }) => row.currentRevision?.revision ?? "—" },
      {
        id: "verdict",
        header: "Change",
        accessor: (row) => row.currentRevision?.changeVerdict ?? "",
        type: "status",
        width: 130,
        headerTooltip: "Text-layer diff of the current revision against the one it superseded.",
        cell: ({ row }) => {
          const v = row.currentRevision?.changeVerdict;
          if (!v) return <span className="text-content-subtle">first issue</span>;
          return <Badge tone={verdictTone(v)} size="xs" dot>{v}</Badge>;
        },
      },
      { id: "issued", header: "Issued", accessor: (row) => row.currentRevision?.createdAt ?? "", type: "text", width: 110, cell: ({ row }) => formatDate(row.currentRevision?.createdAt) },
      {
        id: "status",
        header: "Status",
        accessor: (row) => (Number(row.needsReview) === 1 ? "needs review" : "confirmed"),
        type: "status",
        width: 130,
        cell: ({ row }) => (Number(row.needsReview) === 1 ? <Badge tone="warning" size="xs">needs review</Badge> : <Badge tone="success" size="xs">confirmed</Badge>),
      },
    ],
    [],
  );

  return (
    <div className="space-y-3">
      <div className="flex flex-wrap items-center gap-2">
        <button type="button" onClick={() => setDiscipline("")} className={`rounded-full px-3 py-1 text-xs font-medium ring-1 transition-colors ${discipline === "" ? "bg-brand-600 text-white ring-brand-600" : "bg-white text-ink-600 ring-ink-200 hover:bg-ink-50"}`}>
          All
        </button>
        {chips.map((d) => (
          <button key={d} type="button" onClick={() => setDiscipline(discipline === d ? "" : d)} className={`rounded-full px-3 py-1 text-xs font-medium ring-1 transition-colors ${discipline === d ? "bg-brand-600 text-white ring-brand-600" : "bg-white text-ink-600 ring-ink-200 hover:bg-ink-50"}`}>
            {humanize(d)} <span className="opacity-60">{byDiscipline[d]}</span>
          </button>
        ))}
        <div className="ml-auto flex flex-wrap items-center gap-2">
          {areas.length > 0 || area ? (
            <Select value={area} onChange={(e) => setArea(e.target.value)} className="w-40 py-1.5! text-xs">
              <option value="">All areas</option>
              {areas.map((a) => (
                <option key={a} value={a}>{a}</option>
              ))}
            </Select>
          ) : null}
          <Select value={setId} onChange={(e) => setSetId(e.target.value)} className="w-44 py-1.5! text-xs">
            <option value="">All sets</option>
            {(sets.data?.items ?? []).map((s) => (
              <option key={s.id} value={s.id}>{s.name}</option>
            ))}
          </Select>
          <Input value={search} onChange={(e) => setSearch(e.target.value)} placeholder="Number or title…" className="w-44" />
          <Input value={text} onChange={(e) => setText(e.target.value)} placeholder="Words on the sheet…" className="w-44" title="Full-text search over the extracted text of each current revision" />
          <button type="button" onClick={() => setReviewOnly((v) => !v)} className={`whitespace-nowrap rounded-md px-3 py-2 text-xs font-medium ring-1 transition-colors ${reviewOnly ? "bg-amber-100 text-amber-800 ring-amber-300" : "bg-white text-ink-600 ring-ink-200 hover:bg-ink-50"}`}>
            Needs review
          </button>
        </div>
      </div>

      {sheets.error ? <p className="text-sm text-red-600">{sheets.error}</p> : null}
      {!sheets.loading && rows.length === 0 && !discipline && !area && !setId && !debounced.search && !debounced.text && !reviewOnly ? (
        <EmptyState icon={IconDrawing} title="No sheets yet" hint="Upload a drawing set PDF in the Sets tab — each page becomes a sheet automatically, and pages whose title block could not be read wait in the review queue." />
      ) : (
        <DataTable<SheetListItem>
          tableId="drawing-sheets"
          data={rows}
          columns={columns}
          getRowId={(r) => r.id}
          loading={sheets.loading}
          height={560}
          stickyHeader
          gridLines
          toolbar={false}
          onRowClick={({ row }) => navigate(row.id)}
          rowActions={(row) => [
            { id: "open", label: "Open in viewer", onSelect: () => navigate(row.id) },
            { id: "refresh", label: "Refresh register", onSelect: () => { sheets.reload(); onChanged(); } },
          ]}
          empty={{ title: "No sheets match", description: "Adjust the filters or the search terms." }}
          aria-label="Sheet register"
        />
      )}
      <p className="text-xs text-ink-400">
        {sheets.data ? `${rows.length}${(sheets.data.total ?? rows.length) > rows.length ? ` of ${sheets.data.total}` : ""} sheet${rows.length === 1 ? "" : "s"}` : ""}
        {sheets.data?.access?.segregated ? " · segregation rules apply to what you see" : ""}
        {debounced.text ? ` · full-text search over the current revisions' extracted text; scanned pages without a text layer cannot match` : ""}
      </p>
    </div>
  );
}
