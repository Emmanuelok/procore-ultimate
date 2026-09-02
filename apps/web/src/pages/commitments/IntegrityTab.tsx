/**
 * THE ARITHMETIC, CHECKED AGAINST THE ROWS UNDERNEATH IT.
 *
 * Every headline figure this module publishes is derived, and a derived
 * figure that nobody checks is a figure nobody should trust. This tab runs
 * the identities over every commitment on the project and prints the FAILING
 * ones with both sides and the variance — a reconciliation report that can
 * only say "fine" is worthless.
 *
 * Beside it: committed cost by cost code against the budget, per currency,
 * with "remaining to commit" reported as unknown (with the reason) where
 * there is no budget to compare against rather than as the committed total
 * negated; and a re-materialise button that recomputes every rollup from the
 * schedules and change registers, which is idempotent by construction.
 */
import { useCallback, useEffect, useState } from "react";
import { api } from "../../lib/api";
import {
  Alert,
  Badge,
  Button,
  Card,
  CardBody,
  CardHeader,
  EmptyState,
  ErrorAlert,
  Spinner,
  Table,
  Td,
  Th,
} from "../../ui";
import { Figure, money, titleCase } from "./shared";
import type { Unknowable } from "./types";

interface Check {
  name: string;
  statement: string;
  left: number;
  right: number;
  variance: number;
  reconciles: boolean;
}

interface ReconcileRow {
  commitmentId: string;
  reference: string;
  title: string;
  status: string;
  currency: string;
  reconciles: boolean;
  failing: Check[];
  checks: Check[];
}

interface ReconcileReport {
  projectId: string;
  checkedAt: string;
  commitmentCount: number;
  reconciles: boolean;
  failingCount: number;
  results: ReconcileRow[];
}

interface CostCodeRow {
  costCode: string;
  costType: string;
  description: string | null;
  originalCommitted: number;
  changeOrders: number;
  revisedCommitted: number;
  pendingCommitted: number;
  invoiced: number;
  retainageHeld: number;
  balanceToFinish: number;
  commitmentCount: number;
  revisedBudget: Unknowable;
  remainingToCommit: Unknowable;
  percentBoughtOut: Unknowable;
}

interface CostCodeReport {
  mixedCurrency: boolean;
  currencies: string[];
  buckets: Array<{
    currency: string;
    rows: CostCodeRow[];
    totals: Record<string, number>;
  }>;
  notes: string[];
}

export default function IntegrityTab({
  projectId,
  onSynced,
}: {
  projectId: string;
  onSynced: () => void;
}) {
  const base = `/api/v1/projects/${projectId}/commitments/rollups`;
  const [report, setReport] = useState<ReconcileReport | null>(null);
  const [byCode, setByCode] = useState<CostCodeReport | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [syncNote, setSyncNote] = useState<string | null>(null);

  const load = useCallback(async () => {
    setError(null);
    try {
      const [rec, codes] = await Promise.all([
        api.get<ReconcileReport>(`${base}/reconcile`),
        api.get<CostCodeReport>(`${base}/by-cost-code`),
      ]);
      setReport(rec);
      setByCode(codes);
    } catch (err) {
      setReport(null);
      setError(err instanceof Error ? err.message : "The reconciliation could not be run.");
    }
  }, [base]);

  useEffect(() => {
    void load();
  }, [load]);

  async function sync() {
    setBusy(true);
    setError(null);
    setSyncNote(null);
    try {
      const res = await api.post<{ commitments?: number; budgetLinesUpdated?: number }>(
        `${base}/sync`,
        {},
      );
      setSyncNote(
        `Re-materialised ${res.commitments ?? 0} commitment total(s) and ${res.budgetLinesUpdated ?? 0} budget line(s).`,
      );
      await load();
      onSynced();
    } catch (err) {
      setError(err instanceof Error ? err.message : "The rollups could not be re-materialised.");
    } finally {
      setBusy(false);
    }
  }

  return (
    <div className="space-y-4">
      <ErrorAlert message={error} />

      <div className="flex flex-wrap items-center justify-between gap-2">
        <p className="text-meta text-content-muted">
          {report
            ? `${report.commitmentCount} commitment(s) checked at ${new Date(report.checkedAt).toLocaleString()}.`
            : "Checking every identity against the stored rows…"}
        </p>
        <div className="flex gap-2">
          <Button size="sm" variant="secondary" disabled={busy} onClick={() => void load()}>
            Re-check
          </Button>
          <Button size="sm" disabled={busy} onClick={() => void sync()}>
            {busy ? "Re-materialising…" : "Re-materialise the rollups"}
          </Button>
        </div>
      </div>

      {syncNote ? (
        <Alert tone="success" size="sm" title="Rollups rebuilt">
          {syncNote} Recomputation is idempotent: running it twice changes nothing.
        </Alert>
      ) : null}

      {report === null ? (
        <Spinner label="Reconciling…" />
      ) : report.reconciles ? (
        <Alert tone="success" title="Every identity holds">
          Original sum + approved changes = revised sum, on the header and on the schedule of
          values, for all {report.commitmentCount} commitment(s) on this project.
        </Alert>
      ) : (
        <Alert
          tone="danger"
          title={`${report.failingCount} commitment(s) do not reconcile`}
        >
          Each failing check is printed below with both sides and the variance. A commitment whose
          register and schedule disagree is a commitment whose sum nobody can defend.
        </Alert>
      )}

      {report && report.failingCount > 0 ? (
        <div className="space-y-3">
          {report.results
            .filter((r) => !r.reconciles)
            .map((r) => (
              <Card key={r.commitmentId}>
                <CardHeader
                  title={
                    <span className="flex items-center gap-2">
                      <span className="font-mono">{r.reference}</span>
                      <span className="truncate">{r.title}</span>
                      <Badge size="xs" tone="danger" dot>
                        {r.failing.length} failing
                      </Badge>
                    </span>
                  }
                  subtitle={`${titleCase(r.status)} · ${r.currency}`}
                />
                <CardBody>
                  <Table>
                    <thead>
                      <tr>
                        <Th>Identity</Th>
                        <Th className="text-right">Left</Th>
                        <Th className="text-right">Right</Th>
                        <Th className="text-right">Variance</Th>
                      </tr>
                    </thead>
                    <tbody className="divide-y divide-border">
                      {r.failing.map((c) => (
                        <tr key={c.name}>
                          <Td className="text-2xs">
                            <code className="font-mono">{c.statement}</code>
                          </Td>
                          <Td className="whitespace-nowrap text-right font-mono tabular-nums">
                            {money(c.left, r.currency)}
                          </Td>
                          <Td className="whitespace-nowrap text-right font-mono tabular-nums">
                            {money(c.right, r.currency)}
                          </Td>
                          <Td className="whitespace-nowrap text-right font-mono tabular-nums text-danger-fg">
                            {money(c.variance, r.currency)}
                          </Td>
                        </tr>
                      ))}
                    </tbody>
                  </Table>
                </CardBody>
              </Card>
            ))}
        </div>
      ) : null}

      <Card>
        <CardHeader
          title="Committed cost by cost code"
          subtitle="Against the active budget, per currency. Two currencies are never added together."
        />
        <CardBody className="space-y-3">
          {byCode === null ? (
            <Spinner label="Loading the rollup…" />
          ) : byCode.buckets.length === 0 ? (
            <EmptyState
              title="Nothing committed on this project yet"
              hint="Approve a subcontract or purchase order and its schedule lands here against the budget."
            />
          ) : (
            byCode.buckets.map((bucket) => (
              <div key={bucket.currency} className="space-y-1">
                {byCode.buckets.length > 1 ? (
                  <div className="text-label uppercase text-content-subtle">{bucket.currency}</div>
                ) : null}
                <div className="overflow-x-auto">
                  <Table>
                    <thead>
                      <tr>
                        <Th>Cost code</Th>
                        <Th>Type</Th>
                        <Th className="text-right">Original</Th>
                        <Th className="text-right">Changes</Th>
                        <Th className="text-right">Revised</Th>
                        <Th className="text-right">Pending</Th>
                        <Th className="text-right">Budget</Th>
                        <Th className="text-right">Remaining to commit</Th>
                        <Th className="text-right">Bought out</Th>
                      </tr>
                    </thead>
                    <tbody className="divide-y divide-border">
                      {bucket.rows.map((r) => (
                        <tr key={`${r.costCode}-${r.costType}`}>
                          <Td className="font-mono text-xs">{r.costCode}</Td>
                          <Td className="text-xs">{titleCase(r.costType)}</Td>
                          <Td className="whitespace-nowrap text-right font-mono tabular-nums">
                            {money(r.originalCommitted, bucket.currency)}
                          </Td>
                          <Td className="whitespace-nowrap text-right font-mono tabular-nums">
                            {money(r.changeOrders, bucket.currency)}
                          </Td>
                          <Td className="whitespace-nowrap text-right font-mono tabular-nums">
                            {money(r.revisedCommitted, bucket.currency)}
                          </Td>
                          <Td className="whitespace-nowrap text-right font-mono tabular-nums">
                            {money(r.pendingCommitted, bucket.currency)}
                          </Td>
                          <Td className="whitespace-nowrap text-right font-mono tabular-nums">
                            <Figure
                              figure={r.revisedBudget}
                              render={(v) => money(v, bucket.currency)}
                            />
                          </Td>
                          <Td className="whitespace-nowrap text-right font-mono tabular-nums">
                            <Figure
                              figure={r.remainingToCommit}
                              render={(v) => money(v, bucket.currency)}
                            />
                          </Td>
                          <Td className="whitespace-nowrap text-right font-mono tabular-nums">
                            <Figure
                              figure={r.percentBoughtOut}
                              render={(v) => `${v.toFixed(1)}%`}
                            />
                          </Td>
                        </tr>
                      ))}
                    </tbody>
                  </Table>
                </div>
              </div>
            ))
          )}
          {byCode && byCode.notes.length > 0 ? (
            <Alert tone="info" size="sm" variant="subtle" title="What these figures do and do not say">
              <ul className="list-disc pl-4">
                {byCode.notes.map((n) => (
                  <li key={n}>{n}</li>
                ))}
              </ul>
            </Alert>
          ) : null}
        </CardBody>
      </Card>
    </div>
  );
}
