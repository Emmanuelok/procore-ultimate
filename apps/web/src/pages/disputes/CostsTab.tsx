/**
 * Dispute cost ledger and cost of recovery (spec Vol II Domain E #354).
 *
 * The number that decides whether pursuing a claim was worth it is not the
 * award — it is the award net of what it cost to get. Costs are bucketed by
 * currency and never summed across them; the cost-of-recovery ratio is only
 * computed in the dispute's own currency and states its reason when it
 * cannot be.
 */
import { useCallback, useEffect, useState, type FormEvent } from "react";
import { DISPUTE_COST_CATEGORIES } from "@constructos/shared";
import { api, ApiClientError } from "../../lib/api";
import {
  Badge,
  Button,
  Card,
  CardBody,
  ErrorAlert,
  Field,
  Input,
  Select,
  Spinner,
  Table,
  Td,
  Th,
} from "../../ui";
import { formatDate, humanize } from "../format";
import { fmtMoney, type DisputeDetail } from "./disputesShared";

interface CostRow {
  id: string;
  category: string;
  supplier: string | null;
  description: string;
  incurredAt: string;
  budgetAmount: number | null;
  actualAmount: number;
  currency: string;
  recoverable: number;
  createdAt: string;
}

interface CostsResponse {
  items: CostRow[];
  total: number;
  byCurrency: Array<{
    currency: string;
    actual: number;
    budgeted: number | null;
    variance: number | null;
    recoverable: number;
  }>;
  byCategory: Array<{
    category: string;
    byCurrency: Array<{ currency: string; actual: number }>;
  }>;
  awarded: number | null;
  currency: string;
  costOfRecovery: { ratio: number | null; reason: string | null };
}

export default function CostsTab({
  projectId,
  dispute,
  onChanged,
}: {
  projectId: string;
  dispute: DisputeDetail;
  onChanged: () => void;
}) {
  const base = `/api/v1/projects/${projectId}`;
  const [data, setData] = useState<CostsResponse | null>(null);
  const [error, setError] = useState<string | null>(null);

  const load = useCallback(async () => {
    setError(null);
    try {
      setData(await api.get<CostsResponse>(`${base}/disputes/${dispute.id}/costs`));
    } catch (err) {
      setError(err instanceof ApiClientError ? err.message : "Could not load the dispute costs");
    }
  }, [base, dispute.id]);

  useEffect(() => {
    void load();
  }, [load]);

  const [open, setOpen] = useState(false);
  const [category, setCategory] = useState<string>("legal");
  const [supplier, setSupplier] = useState("");
  const [description, setDescription] = useState("");
  const [incurredAt, setIncurredAt] = useState("");
  const [budget, setBudget] = useState("");
  const [actual, setActual] = useState("");
  const [recoverable, setRecoverable] = useState(true);
  const [formError, setFormError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  async function add(e: FormEvent) {
    e.preventDefault();
    setFormError(null);
    setBusy(true);
    try {
      await api.post(`${base}/disputes/${dispute.id}/costs`, {
        category,
        description: description.trim(),
        incurredAt,
        actualAmount: Number(actual),
        recoverable,
        ...(supplier.trim() ? { supplier: supplier.trim() } : {}),
        ...(budget.trim() ? { budgetAmount: Number(budget) } : {}),
      });
      setOpen(false);
      setDescription("");
      setSupplier("");
      setBudget("");
      setActual("");
      await load();
      onChanged();
    } catch (err) {
      setFormError(err instanceof ApiClientError ? err.message : "Could not record the cost");
    } finally {
      setBusy(false);
    }
  }

  if (data === null && error === null) return <Spinner label="Loading dispute costs…" />;

  return (
    <div className="space-y-4">
      <ErrorAlert message={error} />

      <div className="flex flex-wrap items-start justify-between gap-3">
        <div className="flex flex-wrap gap-3">
          {(data?.byCurrency ?? []).map((b) => (
            <Card key={b.currency}>
              <CardBody className="px-4 py-3">
                <div className="text-lg font-bold tabular-nums text-ink-900">
                  {fmtMoney(b.actual, b.currency)}
                </div>
                <div className="text-xs font-medium uppercase tracking-wide text-ink-400">
                  Actual cost
                </div>
                <div className="mt-1 text-[11px] text-ink-500">
                  {b.budgeted === null ? (
                    "no budget recorded"
                  ) : (
                    <>
                      budget {fmtMoney(b.budgeted, b.currency)} ·{" "}
                      <span className={(b.variance ?? 0) > 0 ? "text-red-700" : "text-emerald-700"}>
                        {fmtMoney(b.variance, b.currency)} variance
                      </span>
                    </>
                  )}
                </div>
                <div className="text-[11px] text-ink-500">
                  {fmtMoney(b.recoverable, b.currency)} marked recoverable
                </div>
              </CardBody>
            </Card>
          ))}
          <Card>
            <CardBody className="px-4 py-3">
              <div className="text-lg font-bold tabular-nums text-ink-900">
                {data?.costOfRecovery.ratio === null || data === null
                  ? "—"
                  : `${(data.costOfRecovery.ratio * 100).toFixed(1)}%`}
              </div>
              <div className="text-xs font-medium uppercase tracking-wide text-ink-400">
                Cost per unit recovered
              </div>
              <div className="mt-1 max-w-xs text-[11px] leading-4 text-ink-500">
                {data?.costOfRecovery.reason ??
                  `Costs in ${data?.currency} against an award of ${fmtMoney(data?.awarded ?? null, data?.currency)}.`}
              </div>
            </CardBody>
          </Card>
        </div>
        <Button size="sm" onClick={() => setOpen((v) => !v)}>
          {open ? "Cancel" : "Record cost"}
        </Button>
      </div>

      {open ? (
        <Card>
          <CardBody>
            <form onSubmit={add} className="space-y-3">
              <ErrorAlert message={formError} />
              <div className="grid grid-cols-1 gap-3 sm:grid-cols-3">
                <Field label="Category">
                  <Select value={category} onChange={(e) => setCategory(e.target.value)}>
                    {DISPUTE_COST_CATEGORIES.map((c) => (
                      <option key={c} value={c}>
                        {humanize(c)}
                      </option>
                    ))}
                  </Select>
                </Field>
                <Field label="Supplier / firm">
                  <Input value={supplier} onChange={(e) => setSupplier(e.target.value)} />
                </Field>
                <Field label="Incurred">
                  <Input
                    type="date"
                    required
                    value={incurredAt}
                    onChange={(e) => setIncurredAt(e.target.value)}
                  />
                </Field>
              </div>
              <Field label="Description">
                <Input
                  required
                  value={description}
                  onChange={(e) => setDescription(e.target.value)}
                  placeholder="Counsel's opinion on the notice provisions…"
                />
              </Field>
              <div className="grid grid-cols-1 gap-3 sm:grid-cols-3">
                <Field label={`Budget (${dispute.currency})`}>
                  <Input
                    type="number"
                    min="0"
                    step="0.01"
                    value={budget}
                    onChange={(e) => setBudget(e.target.value)}
                  />
                </Field>
                <Field label={`Actual (${dispute.currency})`}>
                  <Input
                    type="number"
                    min="0"
                    step="0.01"
                    required
                    value={actual}
                    onChange={(e) => setActual(e.target.value)}
                  />
                </Field>
                <div className="flex items-end pb-2">
                  <label className="flex items-center gap-2 text-xs text-ink-700">
                    <input
                      type="checkbox"
                      className="h-4 w-4 accent-brand-600"
                      checked={recoverable}
                      onChange={(e) => setRecoverable(e.target.checked)}
                    />
                    Recoverable from the other side
                  </label>
                </div>
              </div>
              <div className="flex justify-end">
                <Button type="submit" size="sm" disabled={busy}>
                  {busy ? "Recording…" : "Record cost"}
                </Button>
              </div>
            </form>
          </CardBody>
        </Card>
      ) : null}

      {!data || data.items.length === 0 ? (
        <p className="rounded-md bg-ink-50 px-3 py-2 text-xs text-ink-500 ring-1 ring-ink-100">
          No costs recorded on this dispute yet.
        </p>
      ) : (
        <Table>
          <thead>
            <tr>
              <Th>Date</Th>
              <Th>Category</Th>
              <Th>Description</Th>
              <Th className="text-right">Budget</Th>
              <Th className="text-right">Actual</Th>
              <Th>Recoverable</Th>
            </tr>
          </thead>
          <tbody className="divide-y divide-ink-100">
            {data.items.map((c) => (
              <tr key={c.id}>
                <Td className="whitespace-nowrap text-xs">{formatDate(c.incurredAt)}</Td>
                <Td className="text-xs">
                  {humanize(c.category)}
                  {c.supplier ? (
                    <div className="text-[11px] text-ink-400">{c.supplier}</div>
                  ) : null}
                </Td>
                <Td className="text-xs">{c.description}</Td>
                <Td className="whitespace-nowrap text-right tabular-nums">
                  {c.budgetAmount === null ? "—" : fmtMoney(c.budgetAmount, c.currency)}
                </Td>
                <Td className="whitespace-nowrap text-right font-medium tabular-nums">
                  {fmtMoney(c.actualAmount, c.currency)}
                </Td>
                <Td>
                  {c.recoverable === 1 ? (
                    <Badge tone="green">yes</Badge>
                  ) : (
                    <Badge tone="gray">no</Badge>
                  )}
                </Td>
              </tr>
            ))}
          </tbody>
        </Table>
      )}

      {data && data.byCategory.length > 0 ? (
        <p className="text-xs text-ink-400">
          By category:{" "}
          {data.byCategory
            .map(
              (c) =>
                `${humanize(c.category)} ${c.byCurrency
                  .map((b) => fmtMoney(b.actual, b.currency))
                  .join(" + ")}`,
            )
            .join(" · ")}
          . Currencies are listed side by side and never added together.
        </p>
      ) : null}
    </div>
  );
}
