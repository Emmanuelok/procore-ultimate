/**
 * Hearing bundle builder (#343-344): ordered items drawn from files, RFIs,
 * delay events, claims and evidence; chronological sort; generation freezes
 * a manifest with sequential tab numbers and a Merkle root over the content
 * hashes, so the produced bundle is tamper-evident and verifiable later.
 */
import { useEffect, useMemo, useState, type FormEvent } from "react";
import { api, ApiClientError, fetchBlobUrl } from "../../lib/api";
import {
  Badge,
  Button,
  Card,
  CardBody,
  EmptyState,
  ErrorAlert,
  Input,
  Modal,
  Spinner,
  Table,
  Td,
  Th,
} from "../../ui";
import { formatDate, formatDateTime } from "../format";
import {
  bundleSourceLabel,
  isTerminal,
  SectionTitle,
  type BundleItem,
  type BundleRow,
  type ClaimLite,
  type DelayEventLite,
  type DisputeDetail,
  type EvidenceLite,
  type FileLite,
  type ListResponse,
  type RfiLite,
  type VerifyResult,
} from "./disputesShared";

/* ------------------------------- Pick sources ------------------------------- */

type SourceKey = "files" | "rfis" | "delay_events" | "claims" | "evidence";

const SOURCES: { key: SourceKey; label: string }[] = [
  { key: "files", label: "Files" },
  { key: "rfis", label: "RFIs" },
  { key: "delay_events", label: "Delay events" },
  { key: "claims", label: "Claims" },
  { key: "evidence", label: "Evidence" },
];

interface Pick {
  key: string;
  label: string;
  fileId?: string;
  recordType?: string;
  recordId?: string;
}

/** PUT payload shape for one bundle item (nulls omitted, not sent). */
function toItemPayload(it: BundleItem): Record<string, unknown> {
  const p: Record<string, unknown> = { title: it.title };
  if (it.date) p["date"] = it.date;
  if (it.fileId) p["fileId"] = it.fileId;
  if (it.recordType && it.recordId) {
    p["recordType"] = it.recordType;
    p["recordId"] = it.recordId;
  }
  return p;
}

function shortHash(sha: string): string {
  return sha.length > 16 ? `${sha.slice(0, 16)}…` : sha;
}

/* --------------------------------- Builder ---------------------------------- */

export default function BundleBuilder({
  projectId,
  dispute,
  onChanged,
}: {
  projectId: string;
  dispute: DisputeDetail;
  onChanged: () => Promise<void>;
}) {
  const base = `/api/v1/projects/${projectId}`;
  const active = !isTerminal(dispute.status);

  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [selectedId, setSelectedId] = useState<string | null>(dispute.bundles[0]?.id ?? null);
  const [verify, setVerify] = useState<VerifyResult | null>(null);
  const [copied, setCopied] = useState(false);

  // keep a valid selection when the bundle list changes underneath us
  useEffect(() => {
    if (selectedId && dispute.bundles.some((b) => b.id === selectedId)) return;
    setSelectedId(dispute.bundles[0]?.id ?? null);
  }, [dispute.bundles, selectedId]);

  useEffect(() => {
    setVerify(null);
    setCopied(false);
  }, [selectedId]);

  const bundle: BundleRow | null = dispute.bundles.find((b) => b.id === selectedId) ?? null;

  /* ------------------------------ create bundle ------------------------------ */

  const [newName, setNewName] = useState("");
  async function onCreateBundle(e: FormEvent) {
    e.preventDefault();
    if (!newName.trim()) return;
    setError(null);
    setBusy(true);
    try {
      const created = await api.post<BundleRow>(`${base}/disputes/${dispute.id}/bundles`, {
        name: newName.trim(),
      });
      setNewName("");
      await onChanged();
      setSelectedId(created.id);
    } catch (err) {
      setError(err instanceof ApiClientError ? err.message : "Failed to create the bundle.");
    } finally {
      setBusy(false);
    }
  }

  /* ------------------------------ draft mutations ----------------------------- */

  async function putItems(next: BundleItem[]) {
    if (!bundle) return;
    if (next.length === 0) {
      setError("A bundle needs at least one item — add a replacement before removing the last one.");
      return;
    }
    setError(null);
    setBusy(true);
    try {
      await api.put(`${base}/dispute-bundles/${bundle.id}/items`, {
        items: next.map(toItemPayload),
      });
      await onChanged();
    } catch (err) {
      setError(err instanceof ApiClientError ? err.message : "Failed to update the bundle items.");
    } finally {
      setBusy(false);
    }
  }

  function moveItem(i: number, dir: -1 | 1) {
    if (!bundle) return;
    const next = [...bundle.items];
    const j = i + dir;
    if (j < 0 || j >= next.length) return;
    const a = next[i];
    const b = next[j];
    if (!a || !b) return;
    next[i] = b;
    next[j] = a;
    void putItems(next);
  }

  function removeItem(i: number) {
    if (!bundle) return;
    void putItems(bundle.items.filter((_, idx) => idx !== i));
  }

  async function sortChronological() {
    if (!bundle) return;
    setError(null);
    setBusy(true);
    try {
      await api.post(`${base}/dispute-bundles/${bundle.id}/chronological`);
      await onChanged();
    } catch (err) {
      setError(err instanceof ApiClientError ? err.message : "Chronological sort failed.");
    } finally {
      setBusy(false);
    }
  }

  /* ------------------------- generate / verify / issue ------------------------ */

  const [generateOpen, setGenerateOpen] = useState(false);
  async function onGenerate() {
    if (!bundle) return;
    setError(null);
    setBusy(true);
    try {
      await api.post(`${base}/dispute-bundles/${bundle.id}/generate`);
      setGenerateOpen(false);
      await onChanged();
    } catch (err) {
      setError(err instanceof ApiClientError ? err.message : "Bundle generation failed.");
    } finally {
      setBusy(false);
    }
  }

  async function onVerify() {
    if (!bundle) return;
    setError(null);
    setBusy(true);
    setVerify(null);
    try {
      setVerify(await api.post<VerifyResult>(`${base}/dispute-bundles/${bundle.id}/verify`));
    } catch (err) {
      setError(err instanceof ApiClientError ? err.message : "Integrity check failed.");
    } finally {
      setBusy(false);
    }
  }

  async function onIssue() {
    if (!bundle) return;
    setError(null);
    setBusy(true);
    try {
      await api.post(`${base}/dispute-bundles/${bundle.id}/issue`);
      await onChanged();
    } catch (err) {
      setError(err instanceof ApiClientError ? err.message : "Failed to issue the bundle.");
    } finally {
      setBusy(false);
    }
  }

  async function downloadManifest() {
    if (!bundle) return;
    setError(null);
    try {
      const url = await fetchBlobUrl(`${base}/dispute-bundles/${bundle.id}/manifest.csv`);
      const a = document.createElement("a");
      a.href = url;
      a.download = `bundle-${bundle.name.replace(/[^\w-]+/g, "-").toLowerCase()}-manifest.csv`;
      document.body.appendChild(a);
      a.click();
      a.remove();
      URL.revokeObjectURL(url);
    } catch (err) {
      setError(err instanceof Error ? err.message : "Manifest download failed");
    }
  }

  async function copyRoot(root: string) {
    try {
      await navigator.clipboard.writeText(root);
      setCopied(true);
      setTimeout(() => setCopied(false), 1500);
    } catch {
      setError("Clipboard copy failed — select the root manually.");
    }
  }

  /* ------------------------------ add-items modal ----------------------------- */

  const [addOpen, setAddOpen] = useState(false);
  const [addError, setAddError] = useState<string | null>(null);
  const [source, setSource] = useState<SourceKey>("files");
  const [picks, setPicks] = useState<Map<string, Pick>>(new Map());
  const [fileSearch, setFileSearch] = useState("");
  const [fileRows, setFileRows] = useState<FileLite[] | null>(null);
  const [rfiRows, setRfiRows] = useState<RfiLite[] | null>(null);
  const [delayRows, setDelayRows] = useState<DelayEventLite[] | null>(null);
  const [claimRows, setClaimRows] = useState<ClaimLite[] | null>(null);
  const [evidenceRows, setEvidenceRows] = useState<EvidenceLite[] | null>(null);

  function openAdd() {
    setAddError(null);
    setPicks(new Map());
    setSource("files");
    setFileSearch("");
    setAddOpen(true);
  }

  // files load (debounced on search)
  useEffect(() => {
    if (!addOpen || source !== "files") return;
    let cancelled = false;
    const t = setTimeout(() => {
      void (async () => {
        try {
          const params = new URLSearchParams({ pageSize: "50" });
          if (fileSearch.trim()) params.set("search", fileSearch.trim());
          const res = await api.get<ListResponse<FileLite>>(`${base}/files?${params}`);
          if (!cancelled) setFileRows(res.items);
        } catch {
          if (!cancelled) setFileRows([]);
        }
      })();
    }, 250);
    return () => {
      cancelled = true;
      clearTimeout(t);
    };
  }, [addOpen, source, fileSearch, base]);

  // record sources load lazily, once per modal open
  useEffect(() => {
    if (!addOpen) return;
    let cancelled = false;
    void (async () => {
      try {
        if (source === "rfis" && rfiRows === null) {
          const res = await api.get<ListResponse<RfiLite>>(`${base}/rfis?pageSize=100`);
          if (!cancelled) setRfiRows(res.items);
        } else if (source === "delay_events" && delayRows === null) {
          const res = await api.get<ListResponse<DelayEventLite>>(`${base}/delay-events?pageSize=100`);
          if (!cancelled) setDelayRows(res.items);
        } else if (source === "claims" && claimRows === null) {
          const res = await api.get<ListResponse<ClaimLite>>(`${base}/claims?pageSize=100`);
          if (!cancelled) setClaimRows(res.items);
        } else if (source === "evidence" && evidenceRows === null) {
          const res = await api.get<ListResponse<EvidenceLite>>(`${base}/evidence?pageSize=100`);
          if (!cancelled) setEvidenceRows(res.items);
        }
      } catch {
        // empty source lists render an empty state
        if (cancelled) return;
        if (source === "rfis") setRfiRows([]);
        else if (source === "delay_events") setDelayRows([]);
        else if (source === "claims") setClaimRows([]);
        else if (source === "evidence") setEvidenceRows([]);
      }
    })();
    return () => {
      cancelled = true;
    };
  }, [addOpen, source, base, rfiRows, delayRows, claimRows, evidenceRows]);

  function togglePick(p: Pick) {
    setPicks((prev) => {
      const next = new Map(prev);
      if (next.has(p.key)) next.delete(p.key);
      else next.set(p.key, p);
      return next;
    });
  }

  async function onAddPicks() {
    if (!bundle || picks.size === 0) return;
    setAddError(null);
    setBusy(true);
    try {
      const items = [
        ...bundle.items.map(toItemPayload),
        // titles/dates omitted for new picks — the server resolves canonical ones
        ...[...picks.values()].map((p) => {
          const raw: Record<string, unknown> = {};
          if (p.fileId) raw["fileId"] = p.fileId;
          if (p.recordType && p.recordId) {
            raw["recordType"] = p.recordType;
            raw["recordId"] = p.recordId;
          }
          return raw;
        }),
      ];
      await api.put(`${base}/dispute-bundles/${bundle.id}/items`, { items });
      setAddOpen(false);
      await onChanged();
    } catch (err) {
      setAddError(err instanceof ApiClientError ? err.message : "Failed to add the items.");
    } finally {
      setBusy(false);
    }
  }

  const pickRows = useMemo(() => {
    switch (source) {
      case "files":
        return (fileRows ?? []).map(
          (f): Pick => ({ key: `file:${f.id}`, label: f.name, fileId: f.id }),
        );
      case "rfis":
        return (rfiRows ?? []).map(
          (r): Pick => ({
            key: `rfi:${r.id}`,
            label: `RFI-${r.number}: ${r.subject}`,
            recordType: "rfi",
            recordId: r.id,
          }),
        );
      case "delay_events":
        return (delayRows ?? []).map(
          (d): Pick => ({
            key: `delay_event:${d.id}`,
            label: `DEL-${String(d.number).padStart(3, "0")}: ${d.title}`,
            recordType: "delay_event",
            recordId: d.id,
          }),
        );
      case "claims":
        return (claimRows ?? []).map(
          (c): Pick => ({
            key: `claim:${c.id}`,
            label: `CLM-${String(c.number).padStart(3, "0")}: ${c.title}`,
            recordType: "claim",
            recordId: c.id,
          }),
        );
      case "evidence":
        return (evidenceRows ?? []).map(
          (ev): Pick => ({
            key: `evidence:${ev.id}`,
            label: `${ev.kind} — ${ev.source}`,
            recordType: "evidence",
            recordId: ev.id,
          }),
        );
    }
  }, [source, fileRows, rfiRows, delayRows, claimRows, evidenceRows]);

  const sourceLoading =
    (source === "files" && fileRows === null) ||
    (source === "rfis" && rfiRows === null) ||
    (source === "delay_events" && delayRows === null) ||
    (source === "claims" && claimRows === null) ||
    (source === "evidence" && evidenceRows === null);

  /* ---------------------------------- render ---------------------------------- */

  return (
    <div>
      <ErrorAlert message={error} />

      {/* bundle selector + create */}
      <div className="mb-4 flex flex-wrap items-center gap-2">
        {dispute.bundles.map((b) => (
          <button
            key={b.id}
            type="button"
            onClick={() => setSelectedId(b.id)}
            className={`inline-flex items-center gap-1.5 rounded-full px-3 py-1 text-xs font-medium ring-1 ${
              b.id === selectedId
                ? "bg-brand-600 text-white ring-brand-600"
                : "bg-white text-ink-700 ring-ink-200 hover:bg-ink-50"
            }`}
          >
            {b.name}
            <span
              className={`rounded-full px-1.5 py-0.5 text-[10px] font-semibold uppercase ${
                b.id === selectedId ? "bg-white/20" : "bg-ink-100 text-ink-500"
              }`}
            >
              {b.status}
            </span>
          </button>
        ))}
        {active ? (
          <form onSubmit={onCreateBundle} className="ml-auto flex items-center gap-2">
            <Input
              value={newName}
              onChange={(e) => setNewName(e.target.value)}
              placeholder="New bundle name…"
              className="w-52 py-1.5 text-xs"
            />
            <Button type="submit" size="sm" variant="secondary" disabled={busy || !newName.trim()}>
              Create bundle
            </Button>
          </form>
        ) : null}
      </div>

      {bundle === null ? (
        <EmptyState
          title="No hearing bundles yet"
          hint="Create a bundle, add documents and records, order them, then generate the tamper-evident manifest to produce to the tribunal."
        />
      ) : bundle.status === "draft" ? (
        /* --------------------------- draft: the builder --------------------------- */
        <div>
          <div className="mb-3 flex flex-wrap items-center justify-between gap-2">
            <SectionTitle>
              {bundle.name} — draft ({bundle.items.length} item{bundle.items.length === 1 ? "" : "s"})
            </SectionTitle>
            <div className="flex gap-2">
              <Button size="sm" variant="secondary" disabled={busy} onClick={openAdd}>
                Add items…
              </Button>
              <Button
                size="sm"
                variant="secondary"
                disabled={busy || bundle.items.length < 2}
                onClick={() => void sortChronological()}
              >
                Sort chronologically
              </Button>
              <Button
                size="sm"
                disabled={busy || bundle.items.length === 0}
                onClick={() => setGenerateOpen(true)}
              >
                Generate bundle…
              </Button>
            </div>
          </div>

          {bundle.items.length === 0 ? (
            <p className="rounded-md bg-ink-50 px-3 py-6 text-center text-xs text-ink-400">
              The bundle is empty — add files, RFIs, delay events, claims or evidence. Tab numbers
              are assigned at generation.
            </p>
          ) : (
            <ul className="divide-y divide-ink-100 rounded-md border border-ink-100">
              {bundle.items.map((it, i) => (
                <li key={it.id} className="flex items-center gap-2 px-3 py-2">
                  <span className="w-8 shrink-0 text-right font-mono text-xs text-ink-400 tabular-nums">
                    {i + 1}.
                  </span>
                  <Badge tone={it.fileId ? "blue" : "violet"}>{bundleSourceLabel(it)}</Badge>
                  <span className="min-w-0 flex-1 truncate text-sm text-ink-800" title={it.title}>
                    {it.title}
                  </span>
                  <span className="whitespace-nowrap text-xs text-ink-400">
                    {it.date ? formatDate(it.date) : "undated"}
                  </span>
                  <span className="flex shrink-0 items-center gap-1">
                    <button
                      type="button"
                      aria-label={`Move item ${i + 1} up`}
                      disabled={busy || i === 0}
                      onClick={() => moveItem(i, -1)}
                      className="rounded p-1 text-ink-400 hover:bg-ink-100 hover:text-ink-700 disabled:opacity-30"
                    >
                      ↑
                    </button>
                    <button
                      type="button"
                      aria-label={`Move item ${i + 1} down`}
                      disabled={busy || i === bundle.items.length - 1}
                      onClick={() => moveItem(i, 1)}
                      className="rounded p-1 text-ink-400 hover:bg-ink-100 hover:text-ink-700 disabled:opacity-30"
                    >
                      ↓
                    </button>
                    <button
                      type="button"
                      aria-label={`Remove item ${i + 1}`}
                      disabled={busy}
                      onClick={() => removeItem(i)}
                      className="rounded p-1 text-ink-400 hover:bg-red-50 hover:text-red-700 disabled:opacity-30"
                    >
                      ✕
                    </button>
                  </span>
                </li>
              ))}
            </ul>
          )}
        </div>
      ) : (
        /* --------------------- generated / issued: frozen manifest --------------------- */
        <div>
          <Card className="mb-4">
            <CardBody>
              <div className="mb-2 flex flex-wrap items-center gap-2">
                <span className="text-sm font-semibold text-ink-900">{bundle.name}</span>
                <Badge tone={bundle.status === "issued" ? "green" : "blue"}>{bundle.status}</Badge>
                {bundle.manifest ? (
                  <span className="text-xs text-ink-400">
                    frozen {formatDateTime(bundle.manifest.generatedAt)} ·{" "}
                    {bundle.manifest.itemCount} tab{bundle.manifest.itemCount === 1 ? "" : "s"}
                  </span>
                ) : null}
              </div>

              {bundle.manifest ? (
                <div className="mb-3">
                  <div className="text-xs font-medium uppercase tracking-wide text-ink-400">
                    Merkle root
                  </div>
                  <div className="mt-1 flex items-center gap-2">
                    <code className="min-w-0 flex-1 break-all rounded bg-ink-50 px-2 py-1 font-mono text-xs text-ink-800 ring-1 ring-ink-100">
                      {bundle.manifest.merkleRoot}
                    </code>
                    <Button
                      size="sm"
                      variant="secondary"
                      onClick={() => void copyRoot(bundle.manifest!.merkleRoot)}
                    >
                      {copied ? "Copied" : "Copy"}
                    </Button>
                  </div>
                </div>
              ) : null}

              <div className="flex flex-wrap gap-2">
                <Button size="sm" variant="secondary" disabled={busy} onClick={() => void onVerify()}>
                  {busy ? "Checking…" : "Verify integrity"}
                </Button>
                <Button size="sm" variant="secondary" onClick={() => void downloadManifest()}>
                  Download manifest.csv
                </Button>
                {bundle.status === "generated" ? (
                  <Button size="sm" disabled={busy} onClick={() => void onIssue()}>
                    Issue bundle
                  </Button>
                ) : null}
              </div>

              {verify ? (
                verify.intact ? (
                  <div className="mt-3 rounded-md bg-emerald-50 px-3 py-2 text-sm text-emerald-800 ring-1 ring-emerald-200">
                    <strong>Bundle intact.</strong> All {verify.itemCount} content hashes match the
                    frozen manifest and the Merkle root recomputes exactly.
                  </div>
                ) : (
                  <div className="mt-3 rounded-md bg-red-50 px-3 py-2 text-sm text-red-800 ring-1 ring-red-200">
                    <strong>Integrity failure.</strong> {verify.mismatches.length} item
                    {verify.mismatches.length === 1 ? "" : "s"} no longer match the frozen manifest:
                    <ul className="mt-1 space-y-1">
                      {verify.mismatches.map((m) => (
                        <li key={m.tab} className="text-xs">
                          <span className="font-mono font-semibold">{m.tab}</span> {m.title} —
                          expected <code className="font-mono">{shortHash(m.expected)}</code>, got{" "}
                          <code className="font-mono">
                            {m.actual ? shortHash(m.actual) : "missing"}
                          </code>
                        </li>
                      ))}
                    </ul>
                  </div>
                )
              ) : null}
            </CardBody>
          </Card>

          {bundle.manifest ? (
            <Table>
              <thead>
                <tr>
                  <Th>Tab</Th>
                  <Th>Title</Th>
                  <Th>Date</Th>
                  <Th>Source</Th>
                  <Th>SHA-256</Th>
                </tr>
              </thead>
              <tbody className="divide-y divide-ink-100">
                {bundle.manifest.index.map((e) => (
                  <tr key={e.tab}>
                    <Td className="whitespace-nowrap font-mono text-xs font-semibold text-ink-700">
                      {e.tab}
                    </Td>
                    <Td className="max-w-56">
                      <span className="block truncate" title={e.title}>
                        {e.title}
                      </span>
                    </Td>
                    <Td className="whitespace-nowrap text-xs">
                      {e.date ? formatDate(e.date) : "—"}
                    </Td>
                    <Td className="whitespace-nowrap font-mono text-xs text-ink-500">{e.source}</Td>
                    <Td>
                      <code className="font-mono text-xs text-ink-500" title={e.sha256}>
                        {shortHash(e.sha256)}
                      </code>
                    </Td>
                  </tr>
                ))}
              </tbody>
            </Table>
          ) : null}
        </div>
      )}

      {/* ------------------------------ generate modal ------------------------------ */}
      <Modal
        open={generateOpen}
        title="Generate the bundle"
        onClose={() => setGenerateOpen(false)}
      >
        <p className="mb-3 text-sm text-ink-700">
          Generation freezes the bundle: every item gets a sequential tab number and a content
          hash, and the hashes roll up to a Merkle root. The manifest can never be edited again —
          any later change to an underlying file or record will show up in an integrity check.
        </p>
        <p className="mb-4 text-xs text-ink-500">
          {bundle?.items.length ?? 0} item{(bundle?.items.length ?? 0) === 1 ? "" : "s"} will be
          numbered A1…A{bundle?.items.length ?? 0}.
        </p>
        <div className="flex justify-end gap-2">
          <Button variant="secondary" onClick={() => setGenerateOpen(false)}>
            Cancel
          </Button>
          <Button disabled={busy} onClick={() => void onGenerate()}>
            {busy ? "Generating…" : "Generate and freeze"}
          </Button>
        </div>
      </Modal>

      {/* ------------------------------ add-items modal ------------------------------ */}
      <Modal open={addOpen} title="Add items to the bundle" onClose={() => setAddOpen(false)} wide>
        <ErrorAlert message={addError} />

        <div className="mb-3 flex flex-wrap gap-1 border-b border-ink-200">
          {SOURCES.map((s) => (
            <button
              key={s.key}
              type="button"
              onClick={() => setSource(s.key)}
              className={
                source === s.key
                  ? "-mb-px border-b-2 border-brand-600 px-3 py-2 text-sm font-medium text-brand-700"
                  : "-mb-px border-b-2 border-transparent px-3 py-2 text-sm font-medium text-ink-500 hover:text-ink-800"
              }
            >
              {s.label}
            </button>
          ))}
        </div>

        {source === "files" ? (
          <Input
            value={fileSearch}
            onChange={(e) => setFileSearch(e.target.value)}
            placeholder="Search files by name…"
            className="mb-3"
          />
        ) : null}

        {sourceLoading ? (
          <Spinner />
        ) : pickRows.length === 0 ? (
          <p className="rounded-md bg-ink-50 px-3 py-6 text-center text-xs text-ink-400">
            Nothing to pick from this source.
          </p>
        ) : (
          <div className="max-h-72 space-y-1 overflow-y-auto rounded-md border border-ink-200 p-2">
            {pickRows.map((p) => (
              <label key={p.key} className="flex cursor-pointer items-center gap-2 text-sm">
                <input
                  type="checkbox"
                  checked={picks.has(p.key)}
                  onChange={() => togglePick(p)}
                  className="rounded border-ink-300 text-brand-600 focus:ring-brand-500"
                />
                <span className="truncate text-ink-800" title={p.label}>
                  {p.label}
                </span>
              </label>
            ))}
          </div>
        )}

        <div className="mt-4 flex items-center justify-between">
          <span className="text-xs text-ink-500">
            {picks.size} item{picks.size === 1 ? "" : "s"} selected across sources
          </span>
          <div className="flex gap-2">
            <Button variant="secondary" onClick={() => setAddOpen(false)}>
              Cancel
            </Button>
            <Button disabled={busy || picks.size === 0} onClick={() => void onAddPicks()}>
              {busy ? "Adding…" : `Append ${picks.size || ""} item${picks.size === 1 ? "" : "s"}`}
            </Button>
          </div>
        </div>
      </Modal>
    </div>
  );
}
