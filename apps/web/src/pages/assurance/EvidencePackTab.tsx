/**
 * Evidence pack tab — bundle selected evidence into a Merkle-notarised pack:
 * shows the root hash and a per-item inclusion proof.
 */
import { useCallback, useEffect, useState } from "react";
import { api } from "../../lib/api";
import {
  Badge,
  Button,
  Card,
  CardBody,
  EmptyState,
  ErrorAlert,
  Spinner,
  Table,
  Td,
  Th,
} from "../../ui";
import { formatDateTime, humanize } from "../format";
import {
  CopyButton,
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

  useEffect(() => {
    void load();
  }, [load]);

  async function generate() {
    if (selected.size === 0) return;
    setBusy(true);
    setPackError(null);
    try {
      const res = await api.post<PackResult>(`${base}/evidence-packs`, {
        evidenceIds: [...selected],
      });
      setPack(res);
      setOpenProof(null);
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
            <Button onClick={() => void generate()} disabled={busy || selected.size === 0}>
              {busy ? "Generating…" : `Generate pack (${selected.size})`}
            </Button>
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
                <p className="mb-3 text-xs text-ink-500">
                  Generated {formatDateTime(pack.generatedAt)} · {pack.items.length} item
                  {pack.items.length === 1 ? "" : "s"} · the generation event is recorded in the ledger.
                </p>
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
        </>
      )}
    </div>
  );
}
