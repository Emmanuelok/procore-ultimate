/**
 * Evidence pack tab — bundle selected evidence into a Merkle-notarised pack:
 * the root hash, a per-item inclusion proof, the seal and ledger head the pack
 * is bound to, and the COMPLETENESS STATEMENT naming what was left out.
 *
 * Packs are persisted and their chain of custody is kept: every view and every
 * download is recorded, because "who has seen this bundle" is part of what
 * makes it evidence.
 */
import { useCallback, useEffect, useState } from "react";
import { EVIDENCE_PACK_PURPOSES } from "@constructos/shared";
import { api } from "../../lib/api";
import {
  Badge,
  Button,
  Card,
  CardBody,
  EmptyState,
  ErrorAlert,
  Select,
  Spinner,
  Table,
  Td,
  Th,
} from "../../ui";
import { formatDateTime, humanize } from "../format";
import {
  CopyButton,
  downloadAuthenticated,
  HashChip,
  ScoreMeter,
  type EvidenceRow,
  type ListResponse,
} from "./assuranceShared";

interface PackItem {
  evidenceId: string;
  contentHash: string;
  kind?: string;
  source?: string;
  proof: unknown;
}

interface PackResult {
  id: string;
  root: string;
  generatedAt: string;
  items: PackItem[];
  statement?: string;
  exclusions?: { objectType: string; objectId: string; reason: string }[];
  seal?: { id: string; sequence: number; sealedAt: string } | null;
  ledgerHeadHash?: string | null;
}

interface StoredPack {
  id: string;
  title: string;
  purpose: string;
  root: string;
  itemCount: number;
  caseId: string | null;
  sealSequence: number | null;
  generatedAt: string;
}

export default function EvidencePackTab({ projectId }: { projectId: string }) {
  const base = `/api/v1/projects/${projectId}`;

  const [evidence, setEvidence] = useState<EvidenceRow[] | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [selected, setSelected] = useState<Set<string>>(new Set());
  const [pack, setPack] = useState<PackResult | null>(null);
  const [busy, setBusy] = useState(false);
  const [packError, setPackError] = useState<string | null>(null);
  const [openProof, setOpenProof] = useState<string | null>(null);
  const [stored, setStored] = useState<StoredPack[] | null>(null);
  const [storedError, setStoredError] = useState<string | null>(null);
  const [purpose, setPurpose] = useState("audit");

  const load = useCallback(async () => {
    setError(null);
    try {
      const res = await api.get<ListResponse<EvidenceRow>>(`${base}/evidence?pageSize=100`);
      setEvidence(res.items);
    } catch (err) {
      setEvidence([]);
      setError(err instanceof Error ? err.message : "Failed to load evidence");
    }
  }, [base]);

  const loadStored = useCallback(async () => {
    setStoredError(null);
    try {
      const res = await api.get<ListResponse<StoredPack>>(`${base}/evidence-packs?pageSize=25`);
      setStored(res.items);
    } catch (err) {
      setStored([]);
      setStoredError(err instanceof Error ? err.message : "Failed to load stored packs");
    }
  }, [base]);

  useEffect(() => {
    void load();
    void loadStored();
  }, [load, loadStored]);

  async function generate() {
    if (selected.size === 0) return;
    setBusy(true);
    setPackError(null);
    try {
      const res = await api.post<PackResult>(`${base}/evidence-packs`, {
        evidenceIds: [...selected],
        purpose,
      });
      setPack(res);
      setOpenProof(null);
      await loadStored();
    } catch (err) {
      setPackError(err instanceof Error ? err.message : "Failed to generate the evidence pack");
    } finally {
      setBusy(false);
    }
  }

  return (
    <div className="space-y-4">
      <ErrorAlert message={error} />
      {evidence === null ? (
        <Spinner />
      ) : evidence.length === 0 ? (
        <EmptyState
          title="No evidence to pack"
          hint="Ingest evidence in the Reconcile tab, then bundle it here for handover to an auditor or regulator."
        />
      ) : (
        <>
          <div className="flex items-center justify-between gap-3">
            <p className="text-sm text-ink-600">
              Select the evidence to notarise — the pack's Merkle root commits to every item, and each
              item ships with its own inclusion proof.
            </p>
            <div className="flex items-center gap-2">
              <div className="w-44">
                <Select value={purpose} onChange={(e) => setPurpose(e.target.value)}>
                  {EVIDENCE_PACK_PURPOSES.map((p) => (
                    <option key={p} value={p}>
                      {humanize(p)}
                    </option>
                  ))}
                </Select>
              </div>
              <Button onClick={() => void generate()} disabled={busy || selected.size === 0}>
                {busy ? "Generating…" : `Generate pack (${selected.size})`}
              </Button>
            </div>
          </div>
          <ErrorAlert message={packError} />

          <Table>
            <thead>
              <tr>
                <Th className="w-10" />
                <Th>Kind</Th>
                <Th>Source</Th>
                <Th>Content hash</Th>
                <Th>Independence</Th>
                <Th>Ingested</Th>
              </tr>
            </thead>
            <tbody className="divide-y divide-ink-100">
              {evidence.map((ev) => (
                <tr key={ev.id} className="hover:bg-ink-50/60">
                  <Td>
                    <input
                      type="checkbox"
                      checked={selected.has(ev.id)}
                      onChange={(e) => {
                        setSelected((prev) => {
                          const next = new Set(prev);
                          if (e.target.checked) next.add(ev.id);
                          else next.delete(ev.id);
                          return next;
                        });
                      }}
                    />
                  </Td>
                  <Td>
                    <Badge tone="violet">{humanize(ev.kind)}</Badge>
                  </Td>
                  <Td className="max-w-xs">
                    <span className="line-clamp-1">{ev.source}</span>
                  </Td>
                  <Td>
                    <HashChip value={ev.contentHash} />
                  </Td>
                  <Td>
                    <ScoreMeter value={ev.independenceScore} />
                  </Td>
                  <Td className="whitespace-nowrap text-xs text-ink-500">
                    {formatDateTime(ev.ingestedAt)}
                  </Td>
                </tr>
              ))}
            </tbody>
          </Table>

          {pack ? (
            <Card>
              <CardBody>
                <div className="mb-1 text-sm font-semibold text-ink-900">Evidence pack {pack.id}</div>
                <p className="mb-2 text-xs text-ink-500">
                  Generated {formatDateTime(pack.generatedAt)} · {pack.items.length} item
                  {pack.items.length === 1 ? "" : "s"} ·{" "}
                  {pack.seal
                    ? `bound to seal #${pack.seal.sequence} (${formatDateTime(pack.seal.sealedAt)})`
                    : "the chain carries NO seal — membership is provable, chain completeness is not"}
                  · the generation event is recorded in the ledger.
                </p>
                {pack.statement ? (
                  <p className="mb-3 rounded-md bg-ink-50 px-3 py-2 text-xs text-ink-700">
                    <span className="font-semibold">Completeness statement.</span> {pack.statement}
                  </p>
                ) : null}
                {pack.exclusions && pack.exclusions.length > 0 ? (
                  <ul className="mb-3 list-inside list-disc rounded-md bg-amber-50 px-3 py-2 text-xs text-amber-900 ring-1 ring-amber-200">
                    {pack.exclusions.map((x, i) => (
                      <li key={i}>
                        <span className="font-mono">
                          {x.objectType}:{x.objectId}
                        </span>{" "}
                        — {x.reason}
                      </li>
                    ))}
                  </ul>
                ) : null}
                <div className="mb-4 flex flex-wrap items-center gap-2 rounded-md bg-ink-950/95 px-3 py-2">
                  <span className="text-xs font-semibold uppercase tracking-wide text-ink-300">
                    Merkle root
                  </span>
                  <code className="break-all font-mono text-xs text-emerald-300">{pack.root}</code>
                  <CopyButton text={pack.root} />
                </div>
                <div className="divide-y divide-ink-100 rounded-md border border-ink-100">
                  {pack.items.map((it) => (
                    <div key={it.evidenceId}>
                      <button
                        type="button"
                        className="flex w-full items-center justify-between gap-3 px-3 py-2 text-left hover:bg-ink-50"
                        onClick={() =>
                          setOpenProof((p) => (p === it.evidenceId ? null : it.evidenceId))
                        }
                      >
                        <span className="flex min-w-0 items-center gap-2 text-sm">
                          <span className="text-ink-400">
                            {openProof === it.evidenceId ? "▾" : "▸"}
                          </span>
                          {it.kind ? <Badge tone="violet">{humanize(it.kind)}</Badge> : null}
                          <span className="truncate text-ink-700">{it.source ?? it.evidenceId}</span>
                        </span>
                        <HashChip value={it.contentHash} />
                      </button>
                      {openProof === it.evidenceId ? (
                        <pre className="overflow-x-auto border-t border-ink-100 bg-ink-50 p-3 font-mono text-xs leading-5 text-ink-700">
                          {JSON.stringify(it.proof, null, 2)}
                        </pre>
                      ) : null}
                    </div>
                  ))}
                </div>
              </CardBody>
            </Card>
          ) : null}

          <Card>
            <CardBody>
              <div className="mb-2 text-sm font-semibold text-ink-900">Packs on record</div>
              <ErrorAlert message={storedError} />
              {stored === null ? (
                <Spinner />
              ) : stored.length === 0 ? (
                <EmptyState
                  title="No packs generated for this project yet"
                  hint="A pack is persisted with its root, its exclusions and the seal in force, and every download is logged."
                />
              ) : (
                <Table>
                  <thead>
                    <tr>
                      <Th>Title</Th>
                      <Th>Purpose</Th>
                      <Th>Items</Th>
                      <Th>Seal</Th>
                      <Th>Root</Th>
                      <Th>Generated</Th>
                      <Th />
                    </tr>
                  </thead>
                  <tbody>
                    {stored.map((p) => (
                      <tr key={p.id}>
                        <Td className="text-sm">{p.title}</Td>
                        <Td className="text-xs">{humanize(p.purpose)}</Td>
                        <Td className="tabular-nums text-sm">{p.itemCount}</Td>
                        <Td className="whitespace-nowrap text-xs">
                          {p.sealSequence === null ? (
                            <span className="text-amber-700">unsealed</span>
                          ) : (
                            `#${p.sealSequence}`
                          )}
                        </Td>
                        <Td>
                          <HashChip value={p.root} />
                        </Td>
                        <Td className="whitespace-nowrap text-xs text-ink-500">
                          {formatDateTime(p.generatedAt)}
                        </Td>
                        <Td className="whitespace-nowrap">
                          <button
                            type="button"
                            className="text-xs text-brand-700 underline"
                            onClick={() => {
                              void downloadAuthenticated(
                                `/api/v1/evidence-packs/${p.id}/download`,
                                `constructos-evidence-pack-${p.id}.json`,
                              ).catch((err: unknown) =>
                                setStoredError(
                                  err instanceof Error ? err.message : "Download failed",
                                ),
                              );
                            }}
                          >
                            Download JSON
                          </button>
                        </Td>
                      </tr>
                    ))}
                  </tbody>
                </Table>
              )}
            </CardBody>
          </Card>
        </>
      )}
    </div>
  );
}
