/**
 * Computed covenants and lender waivers (spec Vol II Domain O #743, #747).
 *
 * Two pieces the manual-reading covenant card cannot carry: the period
 * cashflow inputs from which named ratios (DSCR, LLCR, gearing…) are
 * computed, and the waiver that lifts a draw-stop. A computed reading shows
 * the inputs it used; a ratio whose inputs are missing shows why it could
 * not be computed instead of a zero.
 */
import { useCallback, useEffect, useState, type FormEvent } from "react";
import { api, ApiClientError } from "../../lib/api";
import {
  Badge,
  Button,
  Card,
  CardBody,
  ErrorAlert,
  Field,
  Input,
  Spinner,
  Table,
  Td,
  Textarea,
  Th,
} from "../../ui";
import { formatDate, humanize } from "../format";
import { fmtNum } from "./financeShared";

interface CashflowRow {
  id: string;
  facilityId: string;
  periodEnd: string;
  inputs: Record<string, number>;
  note: string | null;
  recordedBy: string;
  createdAt: string;
}

interface ComputedReading {
  covenantId: string;
  name: string;
  formula: string;
  value: number | null;
  basis: string;
  unavailableReason: string | null;
}

/** Per-period financial inputs; the covenant readings follow automatically. */
export function CashflowsPanel({
  base,
  facilityId,
  onChanged,
}: {
  base: string;
  facilityId: string;
  onChanged: () => void;
}) {
  const [items, setItems] = useState<CashflowRow[] | null>(null);
  const [inputKeys, setInputKeys] = useState<string[]>([]);
  const [error, setError] = useState<string | null>(null);
  const [formOpen, setFormOpen] = useState(false);
  const [formError, setFormError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [periodEnd, setPeriodEnd] = useState("");
  const [values, setValues] = useState<Record<string, string>>({});
  const [computed, setComputed] = useState<ComputedReading[] | null>(null);

  const load = useCallback(async () => {
    setError(null);
    try {
      const res = await api.get<{ items: CashflowRow[]; inputs: string[] }>(
        `${base}/facilities/${facilityId}/cashflows`,
      );
      setItems(res.items);
      setInputKeys(res.inputs ?? []);
    } catch (err) {
      setItems([]);
      setError(err instanceof ApiClientError ? err.message : "Could not load the cashflow periods");
    }
  }, [base, facilityId]);

  useEffect(() => {
    void load();
  }, [load]);

  async function save(e: FormEvent) {
    e.preventDefault();
    setFormError(null);
    setBusy(true);
    try {
      const inputs: Record<string, number> = {};
      for (const [k, v] of Object.entries(values)) {
        if (v.trim() !== "" && Number.isFinite(Number(v))) inputs[k] = Number(v);
      }
      if (Object.keys(inputs).length === 0) {
        setFormError("Enter at least one input — an empty period computes nothing.");
        setBusy(false);
        return;
      }
      const res = await api.put<CashflowRow & { computed: ComputedReading[] }>(
        `${base}/facilities/${facilityId}/cashflows`,
        { periodEnd, inputs },
      );
      setComputed(res.computed ?? []);
      setValues({});
      await load();
      onChanged();
    } catch (err) {
      setFormError(err instanceof ApiClientError ? err.message : "Could not save the period inputs");
    } finally {
      setBusy(false);
    }
  }

  return (
    <Card className="mb-5">
      <CardBody>
        <div className="mb-3 flex flex-wrap items-start justify-between gap-2">
          <div>
            <h3 className="text-sm font-semibold text-ink-900">Period cashflow inputs</h3>
            <p className="text-xs text-ink-400">
              Saving a period recomputes every formula-driven covenant on this facility (#743).
              Covenants marked <em>custom</em> keep their manual readings.
            </p>
          </div>
          <Button variant="secondary" size="sm" onClick={() => setFormOpen((v) => !v)}>
            {formOpen ? "Cancel" : "Enter period"}
          </Button>
        </div>

        {formOpen ? (
          <form onSubmit={save} className="mb-4 rounded-md bg-ink-50 p-3 ring-1 ring-ink-100">
            <div className="mb-3 max-w-xs">
              <Field label="Period end">
                <Input
                  type="date"
                  required
                  value={periodEnd}
                  onChange={(e) => setPeriodEnd(e.target.value)}
                />
              </Field>
            </div>
            <div className="grid grid-cols-2 gap-3 sm:grid-cols-4">
              {inputKeys.map((k) => (
                <Field key={k} label={humanize(k)}>
                  <Input
                    type="number"
                    step="any"
                    value={values[k] ?? ""}
                    onChange={(e) => setValues((v) => ({ ...v, [k]: e.target.value }))}
                  />
                </Field>
              ))}
            </div>
            <div className="mt-3 flex justify-end">
              <Button type="submit" size="sm" disabled={busy}>
                {busy ? "Computing…" : "Save period & recompute"}
              </Button>
            </div>
            {formError ? <ErrorAlert message={formError} /> : null}
          </form>
        ) : null}

        {computed && computed.length > 0 ? (
          <ul className="mb-4 space-y-1 rounded-md bg-brand-50 px-3 py-2 text-xs text-brand-900 ring-1 ring-brand-100">
            {computed.map((c) => (
              <li key={c.covenantId}>
                <span className="font-semibold">{c.name}</span>{" "}
                {c.value === null ? (
                  <span className="text-amber-800">— {c.unavailableReason}</span>
                ) : (
                  <>
                    = <span className="tabular-nums font-semibold">{fmtNum(c.value)}</span>{" "}
                    <span className="text-brand-700">({c.basis})</span>
                  </>
                )}
              </li>
            ))}
          </ul>
        ) : null}

        <ErrorAlert message={error} />

        {items === null ? (
          <Spinner />
        ) : items.length === 0 ? (
          <p className="py-3 text-center text-xs text-ink-400">
            No cashflow periods recorded — computed covenants have nothing to read.
          </p>
        ) : (
          <div className="overflow-x-auto">
            <Table>
              <thead>
                <tr>
                  <Th>Period end</Th>
                  <Th>Inputs</Th>
                  <Th>Note</Th>
                </tr>
              </thead>
              <tbody className="divide-y divide-ink-100">
                {items.map((row) => (
                  <tr key={row.id}>
                    <Td className="whitespace-nowrap text-xs font-medium">
                      {formatDate(row.periodEnd)}
                    </Td>
                    <Td className="text-xs">
                      {Object.entries(row.inputs ?? {})
                        .map(([k, v]) => `${humanize(k)} ${fmtNum(v)}`)
                        .join(" · ")}
                    </Td>
                    <Td className="text-xs text-ink-500">{row.note ?? "—"}</Td>
                  </tr>
                ))}
              </tbody>
            </Table>
          </div>
        )}
      </CardBody>
    </Card>
  );
}

/** Record a lender waiver of a covenant breach — this is what lifts a draw-stop. */
export function WaiveCovenantForm({
  base,
  covenantId,
  onDone,
  onCancel,
}: {
  base: string;
  covenantId: string;
  onDone: () => void;
  onCancel: () => void;
}) {
  const [reason, setReason] = useState("");
  const [reference, setReference] = useState("");
  const [from, setFrom] = useState(new Date().toISOString().slice(0, 10));
  const [to, setTo] = useState("");
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  async function submit(e: FormEvent) {
    e.preventDefault();
    setError(null);
    setBusy(true);
    try {
      await api.post(`${base}/covenants/${covenantId}/waive`, {
        reason: reason.trim(),
        effectiveFrom: from,
        ...(reference.trim() ? { lenderReference: reference.trim() } : {}),
        ...(to ? { effectiveTo: to } : {}),
      });
      onDone();
    } catch (err) {
      setError(err instanceof ApiClientError ? err.message : "Could not record the waiver");
    } finally {
      setBusy(false);
    }
  }

  return (
    <form onSubmit={submit} className="space-y-4">
      <ErrorAlert message={error} />
      <div className="flex flex-wrap items-center gap-2">
        <Badge tone="amber">Admin</Badge>
        <p className="text-xs leading-5 text-ink-500">
          A waiver lifts the draw-stop this breach creates. Record the lender&rsquo;s own reference
          so the concession is auditable.
        </p>
      </div>
      <Field label="Lender reason / terms">
        <Textarea
          required
          value={reason}
          onChange={(e) => setReason(e.target.value)}
          placeholder="Lender waived the Q2 DSCR test subject to an equity cure by 30 September…"
        />
      </Field>
      <div className="grid grid-cols-1 gap-4 sm:grid-cols-3">
        <Field label="Lender reference">
          <Input value={reference} onChange={(e) => setReference(e.target.value)} />
        </Field>
        <Field label="Effective from">
          <Input type="date" required value={from} onChange={(e) => setFrom(e.target.value)} />
        </Field>
        <Field label="Effective to" hint="Blank = open-ended.">
          <Input type="date" value={to} onChange={(e) => setTo(e.target.value)} />
        </Field>
      </div>
      <div className="flex justify-end gap-2">
        <Button variant="secondary" onClick={onCancel}>
          Cancel
        </Button>
        <Button type="submit" disabled={busy}>
          {busy ? "Recording…" : "Record waiver"}
        </Button>
      </div>
    </form>
  );
}
