/**
 * SUPPLIER RISK — the engine's verdict per node with the basis of every
 * flag (#915–917, #946): single source, country concentration, financial
 * distress from prequalification, screening via the assurance entity,
 * prequal outcome, tier visibility, critical-path exposure and expediting
 * backlog. A node with nothing to read is "not assessable", never "low".
 */
import { useMemo, useState } from "react";
import { toast } from "sonner";
import { Badge, Button, Card, CardBody, Drawer, EmptyState } from "../../ui";
import { DataTable, type DataColumns } from "../../ui/data";
import { IconZap } from "../../ui/icons";
import { api } from "../../lib/api";
import {
  CRITICALITY_TONE,
  EM_DASH,
  LoadError,
  ReasonList,
  RefusalNotice,
  SUPPLIER_RISK_TONE,
  SectionHeading,
  dateTime,
  labelize,
  num,
  pct,
  useAction,
  useResource,
  type AssessmentRow,
  type ListResponse,
  type RiskResponse,
} from "./supplychainShared";

type RiskItem = RiskResponse["items"][number];

export default function RiskTab({ projectId, onChanged }: { projectId: string; onChanged: () => void }) {
  const base = `/api/v1/projects/${projectId}/supply-chain/risk`;
  const risk = useResource<RiskResponse>(base);
  const action = useAction();
  const [openNode, setOpenNode] = useState<string | null>(null);
  const history = useResource<ListResponse<AssessmentRow>>(openNode ? `${base}/assessments?nodeId=${openNode}&pageSize=50` : null);
  const [lastRun, setLastRun] = useState<string | null>(null);

  async function run() {
    const r = await action.run("run", () => api.post<{ nodes: number; signalsRaised: number; snapshotsWritten: number; unchanged: number }>(`${base}/run`, {}));
    if (r) {
      setLastRun(`${r.nodes} node(s) assessed · ${r.snapshotsWritten} verdict(s) changed · ${r.unchanged} unchanged · ${r.signalsRaised} new signal(s)`);
      toast.success(r.signalsRaised > 0 ? `${r.signalsRaised} new supplier risk signal(s)` : "Supplier risk engine ran");
      risk.reload();
      history.reload();
      onChanged();
    }
  }

  const columns = useMemo<DataColumns<RiskItem>>(
    () => [
      { id: "tier", header: "Tier", accessor: "tier", type: "number", width: 70, groupable: true },
      { id: "name", header: "Node", accessor: "name", type: "text", sticky: "start", width: 220 },
      { id: "level", header: "Level", accessor: "level", type: "status", width: 140, groupable: true, cell: ({ row }) => <Badge tone={SUPPLIER_RISK_TONE[row.level] ?? "neutral"} size="xs" dot>{labelize(row.level)}</Badge> },
      { id: "score", header: "Score", accessor: (row) => row.score, type: "number", width: 80, cell: ({ row }) => (row.score === null ? <span className="italic text-content-subtle">n/a</span> : num(row.score)) },
      { id: "criticality", header: "Criticality", accessor: "criticality", type: "status", width: 110, groupable: true, cell: ({ row }) => <Badge tone={CRITICALITY_TONE[row.criticality] ?? "neutral"} size="xs">{labelize(row.criticality)}</Badge> },
      { id: "country", header: "Country", accessor: (row) => row.country ?? "", type: "text", width: 90, groupable: true },
      { id: "flags", header: "Flags", accessor: (row) => row.flags.map((f) => f.code).join(", "), type: "text", width: 320, cell: ({ row }) => (row.flags.length === 0 ? <span className="italic text-content-subtle">none</span> : <span className="flex flex-wrap gap-1">{row.flags.map((f, i) => <Badge key={i} tone={f.severity === "critical" || f.severity === "high" ? "danger" : f.severity === "medium" ? "warning" : "neutral"} size="xs" title={`${f.detail} Basis: ${f.basis}`}>{labelize(f.code)}</Badge>)}</span>) },
      { id: "assessedAt", header: "Assessed", accessor: (row) => row.assessedAt ?? "", type: "datetime", width: 160, cell: ({ row }) => (row.assessedAt ? dateTime(row.assessedAt) : <span className="italic text-content-subtle">never</span>) },
    ],
    [],
  );

  const r = risk.data;
  const conc = r?.concentration;

  return (
    <div className="space-y-4">
      {action.refusal ? <RefusalNotice refusal={action.refusal} onDismiss={action.clear} /> : null}
      {risk.error ? <LoadError message={risk.error} onRetry={risk.reload} /> : null}
      <div className="grid grid-cols-2 gap-3 md:grid-cols-5">
        {(["critical", "high", "medium", "low", "not_assessable"] as const).map((level) => (
          <Card key={level}>
            <CardBody>
              <div className="text-label uppercase text-content-subtle">{labelize(level)}</div>
              <div className={`text-display-xs font-semibold tabular-nums ${level === "critical" && (r?.summary[level] ?? 0) > 0 ? "text-danger-fg" : "text-content"}`}>{r ? num(r.summary[level] ?? 0) : EM_DASH}</div>
            </CardBody>
          </Card>
        ))}
      </div>

      <Card>
        <CardBody>
          <SectionHeading
            title="Supplier risk register"
            hint={r?.lastRunAt ? `Engine last ran ${dateTime(r.lastRunAt)}. It also runs daily; a snapshot is written only when a verdict moves.` : "The engine has not run for this project yet."}
            actions={
              <Button size="sm" leadingIcon={IconZap} loading={action.busy === "run"} onClick={() => void run()}>
                Run the engine
              </Button>
            }
          />
          {lastRun ? <p className="mb-2 text-meta text-content-muted">{lastRun}</p> : null}
          <ReasonList reasons={r?.reasons ?? []} className="mb-2" />
          <DataTable<RiskItem>
            tableId="supply-chain-risk"
            data={r?.items ?? []}
            columns={columns}
            getRowId={(row) => row.nodeId}
            loading={risk.loading && !r}
            height={460}
            stickyHeader
            filterRow
            exportFileName="supplier-risk"
            searchPlaceholder="Search nodes…"
            defaultSort={[{ id: "score", desc: true }]}
            onRowClick={({ row }) => setOpenNode(row.nodeId)}
            rowTone={(row) => (row.level === "critical" ? "danger" : row.level === "high" ? "warning" : undefined)}
            empty={{ title: "No nodes to assess", description: "Add suppliers to the map first; the engine reads their links, prequalification, screening and long-lead items." }}
          />
        </CardBody>
      </Card>

      <Card>
        <CardBody>
          <SectionHeading title="Country concentration" hint={conc ? `A country holding ${pct(conc.threshold * 100, 0)} or more of the critical/high nodes is flagged.` : undefined} />
          {!conc ? null : conc.byCountry.length === 0 ? (
            <EmptyState size="sm" title="No nodes with a country" />
          ) : (
            <ul className="divide-y divide-border">
              {conc.byCountry.map((b) => (
                <li key={b.country} className="flex items-center justify-between gap-2 py-1.5 text-meta">
                  <span className="flex items-center gap-2">
                    <span className="font-medium">{b.country === "unknown" ? <span className="italic text-content-subtle">unknown</span> : b.country}</span>
                    {conc.flagged.some((f) => f.country === b.country) ? <Badge tone="warning" size="xs">concentrated</Badge> : null}
                  </span>
                  <span className="tabular-nums text-content-muted">{b.nodes} node{b.nodes === 1 ? "" : "s"} · {b.criticalNodes} critical/high · {pct(b.share * 100, 0)} of critical supply</span>
                </li>
              ))}
            </ul>
          )}
          <ReasonList reasons={conc?.reasons ?? []} className="mt-2" />
        </CardBody>
      </Card>

      <Drawer open={openNode !== null} onClose={() => setOpenNode(null)} size="md" title={r?.items.find((i) => i.nodeId === openNode)?.name ?? "Node"} description="Every flag with the basis it was read from, and the verdict history.">
        {(() => {
          const item = r?.items.find((i) => i.nodeId === openNode);
          if (!item) return null;
          return (
            <div className="space-y-4">
              <div className="flex items-center gap-2">
                <Badge tone={SUPPLIER_RISK_TONE[item.level] ?? "neutral"} size="sm" dot>{labelize(item.level)}</Badge>
                <span className="text-meta tabular-nums text-content-muted">score {item.score === null ? "n/a" : num(item.score)}</span>
              </div>
              {item.basis ? <p className="text-2xs text-content-muted">{item.basis}</p> : <p className="text-meta italic text-content-muted">Not assessed yet.</p>}
              <ul className="space-y-1.5">
                {item.flags.map((f, i) => (
                  <li key={i} className="rounded-md border border-border p-2 text-meta">
                    <div className="flex items-center gap-2">
                      <Badge tone={f.severity === "critical" || f.severity === "high" ? "danger" : f.severity === "medium" ? "warning" : "neutral"} size="xs">{f.severity}</Badge>
                      <span className="font-medium">{labelize(f.code)}</span>
                      <span className="ml-auto text-2xs tabular-nums text-content-subtle">+{f.points}</span>
                    </div>
                    <div className="mt-1">{f.detail}</div>
                    <div className="text-2xs text-content-muted">Basis: {f.basis}</div>
                  </li>
                ))}
              </ul>
              {item.inputs ? (
                <div>
                  <div className="text-2xs uppercase tracking-wide text-content-subtle">Inputs seen</div>
                  <dl className="grid grid-cols-2 gap-x-4 text-meta">
                    {Object.entries(item.inputs).map(([k, v]) => (
                      <div key={k} className="flex justify-between gap-2 border-b border-border py-0.5">
                        <dt className="text-content-muted">{labelize(k)}</dt>
                        <dd className="truncate tabular-nums">{v === null || v === undefined ? EM_DASH : String(v)}</dd>
                      </div>
                    ))}
                  </dl>
                </div>
              ) : null}
              <div>
                <div className="text-2xs uppercase tracking-wide text-content-subtle">History</div>
                {history.error ? <LoadError message={history.error} onRetry={history.reload} /> : (
                  <ul className="divide-y divide-border">
                    {(history.data?.items ?? []).map((a) => (
                      <li key={a.id} className="flex items-center justify-between gap-2 py-1.5 text-meta">
                        <span>{dateTime(a.assessedAt)}</span>
                        <span className="flex items-center gap-2">
                          <Badge tone={SUPPLIER_RISK_TONE[a.level] ?? "neutral"} size="xs" dot>{labelize(a.level)}</Badge>
                          <span className="tabular-nums text-content-muted">{a.score === null ? "n/a" : num(a.score)} · {a.flags.length} flag{a.flags.length === 1 ? "" : "s"}</span>
                        </span>
                      </li>
                    ))}
                  </ul>
                )}
              </div>
            </div>
          );
        })()}
      </Drawer>
    </div>
  );
}
