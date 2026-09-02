/**
 * Project Affected Persons census, the entitlement matrix and the cut-off
 * declaration (spec Domain J #555-568). This is the register an IFC PS5 /
 * ESS5 supervision mission and an independent RAP monitor (#568) work from;
 * the roll-up they read first lives on the RAP dashboard tab.
 */
import { useCallback, useEffect, useState, type FormEvent } from "react";
import { DISPLACEMENT_TYPES, PAP_STATUSES } from "@constructos/shared";
import { api, ApiClientError } from "../../lib/api";
import {
  Badge,
  Button,
  Card,
  CardBody,
  EmptyState,
  ErrorAlert,
  Field,
  Input,
  Modal,
  Select,
  Spinner,
  Table,
  Td,
  Th,
} from "../../ui";
import { formatDate, humanize } from "../format";
import EvidencePicker from "./EvidencePicker";
import {
  fmtMoney,
  fmtNum,
  papTone,
  type CutOffResponse,
  type Entitlement,
  type ListResponse,
  type PapRow,
  type ParcelRow,
} from "./landShared";

/** Displacement is a factual classification, not a verdict — no red here. */
function displacementTone(kind: string): string {
  switch (kind) {
    case "both":
      return "violet";
    case "physical":
      return "blue";
    case "economic":
      return "amber";
    default:
      return "gray";
  }
}

const VULNERABILITY_FLAGS = [
  "elderly",
  "disabled",
  "female_headed",
  "landless",
  "indigenous",
  "below_poverty_line",
  "child_headed",
] as const;

interface EntitlementDraft {
  item: string;
  basis: string;
  amount: string;
  delivered: boolean;
}

export default function PapsTab({
  projectId,
  onChanged,
}: {
  projectId: string;
  onChanged: () => void;
}) {
  const base = `/api/v1/projects/${projectId}`;
  const [paps, setPaps] = useState<PapRow[] | null>(null);
  const [cutOff, setCutOff] = useState<CutOffResponse | null>(null);
  const [parcels, setParcels] = useState<ParcelRow[]>([]);
  const [error, setError] = useState<string | null>(null);
  const [statusFilter, setStatusFilter] = useState("");
  const [displacementFilter, setDisplacementFilter] = useState("");
  const [vulnerableOnly, setVulnerableOnly] = useState(false);
  const [selected, setSelected] = useState<PapRow | null>(null);

  const load = useCallback(async () => {
    setError(null);
    try {
      const qs = new URLSearchParams({ pageSize: "200" });
      if (statusFilter) qs.set("status", statusFilter);
      if (displacementFilter) qs.set("displacementType", displacementFilter);
      if (vulnerableOnly) qs.set("vulnerable", "true");
      const [list, co] = await Promise.all([
        api.get<ListResponse<PapRow>>(`${base}/affected-persons?${qs.toString()}`),
        api.get<CutOffResponse>(`${base}/land/cut-off`),
      ]);
      setPaps(list.items);
      setCutOff(co);
    } catch (err) {
      setPaps([]);
      setError(err instanceof Error ? err.message : "Failed to load the PAP census");
    }
  }, [base, statusFilter, displacementFilter, vulnerableOnly]);

  useEffect(() => {
    void load();
  }, [load]);

  // The parcel a household sits on, so the parcel drawer can show who is on it.
  useEffect(() => {
    let cancelled = false;
    void (async () => {
      try {
        const list = await api.get<ListResponse<ParcelRow>>(`${base}/parcels?pageSize=200`);
        if (!cancelled) setParcels(list.items ?? []);
      } catch {
        // the parcel picker simply stays empty
      }
    })();
    return () => {
      cancelled = true;
    };
  }, [base]);

  const refreshSelected = useCallback(
    async (id: string) => {
      try {
        setSelected(await api.get<PapRow>(`${base}/affected-persons/${id}`));
      } catch {
        setSelected(null);
      }
    },
    [base],
  );

  /* -------------------------------- create --------------------------------- */

  const [createOpen, setCreateOpen] = useState(false);
  const [createError, setCreateError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [reference, setReference] = useState("");
  const [head, setHead] = useState("");
  const [size, setSize] = useState("");
  const [displacement, setDisplacement] = useState<string>("physical");
  const [censusDate, setCensusDate] = useState("");
  const [flags, setFlags] = useState<string[]>([]);
  const [parcelId, setParcelId] = useState("");

  function openCreate() {
    setCreateError(null);
    setReference("");
    setHead("");
    setSize("");
    setDisplacement("physical");
    setCensusDate("");
    setFlags([]);
    setParcelId("");
    setCreateOpen(true);
  }

  async function onCreate(e: FormEvent) {
    e.preventDefault();
    setCreateError(null);
    setBusy(true);
    try {
      const payload: Record<string, unknown> = {
        reference: reference.trim(),
        householdHead: head.trim(),
        displacementType: displacement,
      };
      if (Number(size) > 0) payload["householdSize"] = Number(size);
      if (censusDate) payload["censusDate"] = censusDate;
      if (flags.length > 0) payload["vulnerabilities"] = flags;
      if (parcelId) payload["parcelId"] = parcelId;
      await api.post(`${base}/affected-persons`, payload);
      setCreateOpen(false);
      await load();
      onChanged();
    } catch (err) {
      setCreateError(
        err instanceof ApiClientError ? err.message : "Failed to register the household.",
      );
    } finally {
      setBusy(false);
    }
  }

  /* ------------------------------- cut-off --------------------------------- */

  const [cutOffOpen, setCutOffOpen] = useState(false);
  const [cutOffDraft, setCutOffDraft] = useState("");
  const [cutOffError, setCutOffError] = useState<string | null>(null);

  async function onDeclareCutOff(e: FormEvent) {
    e.preventDefault();
    setCutOffError(null);
    setBusy(true);
    try {
      await api.post(`${base}/land/cut-off`, { date: cutOffDraft });
      setCutOffOpen(false);
      await load();
      onChanged();
    } catch (err) {
      setCutOffError(
        err instanceof ApiClientError ? err.message : "Failed to declare the cut-off date.",
      );
    } finally {
      setBusy(false);
    }
  }

  /* ----------------------------- entitlements ------------------------------ */

  const [entOpen, setEntOpen] = useState(false);
  const [entRows, setEntRows] = useState<EntitlementDraft[]>([]);
  const [actError, setActError] = useState<string | null>(null);

  function openEntitlements(pap: PapRow) {
    setActError(null);
    setEntRows(
      pap.entitlements.length > 0
        ? pap.entitlements.map((e) => ({
            item: e.item,
            basis: e.basis,
            amount: String(e.amount),
            delivered: e.delivered === true,
          }))
        : [{ item: "", basis: "", amount: "", delivered: false }],
    );
    setEntOpen(true);
  }

  const entTotal = entRows.reduce((s, r) => s + (Number(r.amount) || 0), 0);
  const entDelivered = entRows.reduce(
    (s, r) => s + (r.delivered ? Number(r.amount) || 0 : 0),
    0,
  );

  async function onSaveEntitlements(e: FormEvent) {
    e.preventDefault();
    if (!selected) return;
    setActError(null);
    setBusy(true);
    try {
      const entitlements = entRows
        .filter((r) => r.item.trim() && r.basis.trim())
        .map((r) => ({
          item: r.item.trim(),
          basis: r.basis.trim(),
          amount: Number(r.amount) || 0,
          delivered: r.delivered,
        }));
      await api.put(`${base}/affected-persons/${selected.id}/entitlements`, { entitlements });
      setEntOpen(false);
      await refreshSelected(selected.id);
      await load();
      onChanged();
    } catch (err) {
      setActError(
        err instanceof ApiClientError ? err.message : "Failed to apply the entitlement matrix.",
      );
    } finally {
      setBusy(false);
    }
  }

  /* ------------------------------ compensate ------------------------------- */

  const [compOpen, setCompOpen] = useState(false);
  const [compPaidAt, setCompPaidAt] = useState("");
  const [compEvidence, setCompEvidence] = useState<string[]>([]);

  async function onCompensate(e: FormEvent) {
    e.preventDefault();
    if (!selected) return;
    setActError(null);
    setBusy(true);
    try {
      await api.post(`${base}/affected-persons/${selected.id}/compensate`, {
        paidAt: compPaidAt,
        evidenceIds: compEvidence,
      });
      setCompOpen(false);
      await refreshSelected(selected.id);
      await load();
      onChanged();
    } catch (err) {
      setActError(err instanceof ApiClientError ? err.message : "Failed to record the payment.");
    } finally {
      setBusy(false);
    }
  }

  async function setStatus(status: string) {
    if (!selected) return;
    setActError(null);
    try {
      await api.post(`${base}/affected-persons/${selected.id}/status`, { status });
      await refreshSelected(selected.id);
      await load();
      onChanged();
    } catch (err) {
      setActError(err instanceof ApiClientError ? err.message : "Status change failed.");
    }
  }

  /* --------------------------------- render -------------------------------- */

  const totals = paps
    ? {
        count: paps.length,
        people: paps.reduce((s, p) => s + (p.householdSize ?? 0), 0),
        vulnerable: paps.filter((p) => p.vulnerabilities.length > 0).length,
        awaitingEntitlements: paps.filter((p) => p.entitlements.length === 0).length,
      }
    : null;

  return (
    <div className="space-y-4">
      {/* cut-off banner (#564) */}
      <Card className={cutOff?.cutOffDate ? undefined : "ring-1 ring-amber-200"}>
        <CardBody className="flex flex-wrap items-center justify-between gap-3 py-3">
          <div className="text-sm">
            {cutOff?.cutOffDate ? (
              <>
                <Badge tone="blue">Cut-off declared</Badge>
                <span className="ml-2 text-ink-700">
                  {formatDate(cutOff.cutOffDate)} — households censused after this date are
                  encroachment, not project-affected persons (#564).
                </span>
                {cutOff.papsAfterCutOff > 0 ? (
                  <span className="ml-2 font-semibold text-red-700">
                    {cutOff.papsAfterCutOff} household(s) on the register post-date it.
                  </span>
                ) : null}
              </>
            ) : (
              <>
                <Badge tone="amber">No cut-off date</Badge>
                <span className="ml-2 text-ink-700">
                  Until a cut-off date is declared and disclosed, the entitlement population can be
                  inflated after the fact — the classic vector for compensation fraud.
                </span>
              </>
            )}
          </div>
          <Button
            variant="secondary"
            size="sm"
            onClick={() => {
              setCutOffError(null);
              setCutOffDraft(cutOff?.cutOffDate ?? new Date().toISOString().slice(0, 10));
              setCutOffOpen(true);
            }}
          >
            {cutOff?.cutOffDate ? "Re-declare" : "Declare cut-off"}
          </Button>
        </CardBody>
      </Card>

      {/* register */}
      <div className="flex flex-wrap items-center justify-between gap-2">
        <div className="flex flex-wrap items-center gap-2">
          <Select
            className="w-48"
            value={statusFilter}
            onChange={(e) => setStatusFilter(e.target.value)}
            aria-label="Filter by household status"
          >
            <option value="">All statuses</option>
            {PAP_STATUSES.map((s) => (
              <option key={s} value={s}>
                {humanize(s)}
              </option>
            ))}
          </Select>
          <Select
            className="w-48"
            value={displacementFilter}
            onChange={(e) => setDisplacementFilter(e.target.value)}
            aria-label="Filter by displacement type"
          >
            <option value="">All displacement types</option>
            {DISPLACEMENT_TYPES.map((d) => (
              <option key={d} value={d}>
                {humanize(d)}
              </option>
            ))}
          </Select>
          <label className="flex items-center gap-1.5 text-xs text-ink-600">
            <input
              type="checkbox"
              className="h-4 w-4 rounded border-ink-300 text-brand-600 focus:ring-brand-500"
              checked={vulnerableOnly}
              onChange={(e) => setVulnerableOnly(e.target.checked)}
            />
            Vulnerable only
          </label>
          {totals ? (
            <span className="text-xs tabular-nums text-ink-400">
              {fmtNum(totals.count)} household{totals.count === 1 ? "" : "s"} ·{" "}
              {fmtNum(totals.people)} people · {fmtNum(totals.vulnerable)} vulnerable
              {totals.awaitingEntitlements > 0 ? (
                <span className="text-amber-700">
                  {" "}
                  · {fmtNum(totals.awaitingEntitlements)} awaiting entitlements
                </span>
              ) : null}
            </span>
          ) : null}
        </div>
        <Button onClick={openCreate}>Register household</Button>
      </div>

      <ErrorAlert message={error} />

      {paps === null ? (
        <Spinner label="Loading the census…" />
      ) : paps.length === 0 ? (
        <EmptyState
          title="No affected households censused"
          hint="Register the households the scheme displaces physically or economically, screen them for vulnerability, then apply the entitlement matrix."
          action={<Button onClick={openCreate}>Register the first household</Button>}
        />
      ) : (
        <Table>
          <thead>
            <tr>
              <Th>Reference</Th>
              <Th>Household head</Th>
              <Th className="text-right">Size</Th>
              <Th>Displacement</Th>
              <Th>Vulnerability</Th>
              <Th className="text-right">Entitlement</Th>
              <Th>Census</Th>
              <Th>Status</Th>
            </tr>
          </thead>
          <tbody className="divide-y divide-ink-100">
            {paps.map((p) => (
              <tr key={p.id} className="hover:bg-ink-50">
                <Td>
                  <button
                    type="button"
                    className="font-medium text-brand-700 hover:text-brand-800"
                    onClick={() => setSelected(p)}
                  >
                    {p.reference}
                  </button>
                </Td>
                <Td className="max-w-[14rem] truncate">{p.householdHead}</Td>
                <Td className="text-right tabular-nums">{p.householdSize ?? "—"}</Td>
                <Td>
                  <Badge tone={displacementTone(p.displacementType)}>
                    {humanize(p.displacementType)}
                  </Badge>
                </Td>
                <Td>
                  {p.vulnerabilities.length === 0 ? (
                    <span className="text-xs text-ink-400">—</span>
                  ) : (
                    <span className="flex flex-wrap gap-1">
                      {p.vulnerabilities.map((v) => (
                        <Badge key={v} tone="violet">
                          {humanize(v)}
                        </Badge>
                      ))}
                    </span>
                  )}
                </Td>
                <Td className="text-right tabular-nums">
                  {p.compensationPaidAt ? (
                    <span className="font-medium text-emerald-700">
                      {fmtMoney(p.compensationTotal)}
                    </span>
                  ) : (
                    <span className="text-ink-500">{fmtMoney(p.compensationTotal)}</span>
                  )}
                </Td>
                <Td className="tabular-nums">{formatDate(p.censusDate)}</Td>
                <Td>
                  <Badge tone={papTone(p.status)}>{humanize(p.status)}</Badge>
                </Td>
              </tr>
            ))}
          </tbody>
        </Table>
      )}

      {/* ------------------------------ create modal ----------------------------- */}
      <Modal
        open={createOpen}
        title="Register an affected household"
        onClose={() => setCreateOpen(false)}
        wide
      >
        <ErrorAlert message={createError} />
        <form onSubmit={onCreate} className="space-y-4">
          <div className="grid grid-cols-1 gap-4 sm:grid-cols-2">
            <Field label="Census reference">
              <Input
                required
                value={reference}
                onChange={(e) => setReference(e.target.value)}
                placeholder="PAP-0042"
              />
            </Field>
            <Field label="Household head">
              <Input required value={head} onChange={(e) => setHead(e.target.value)} />
            </Field>
          </div>
          <div className="grid grid-cols-1 gap-4 sm:grid-cols-3">
            <Field label="Household size">
              <Input
                type="number"
                min="1"
                value={size}
                onChange={(e) => setSize(e.target.value)}
              />
            </Field>
            <Field label="Displacement type" hint="Physical vs economic (#565).">
              <Select value={displacement} onChange={(e) => setDisplacement(e.target.value)}>
                {DISPLACEMENT_TYPES.map((d) => (
                  <option key={d} value={d}>
                    {humanize(d)}
                  </option>
                ))}
              </Select>
            </Field>
            <Field
              label="Census date"
              hint={
                cutOff?.cutOffDate
                  ? `Must be on or before the ${cutOff.cutOffDate} cut-off.`
                  : "Optional until a cut-off is declared."
              }
            >
              <Input
                type="date"
                value={censusDate}
                max={cutOff?.cutOffDate ?? undefined}
                onChange={(e) => setCensusDate(e.target.value)}
              />
            </Field>
          </div>
          <Field
            label="Land parcel"
            hint="Links the household to the land it holds or occupies, so the parcel record shows who is affected."
          >
            <Select value={parcelId} onChange={(e) => setParcelId(e.target.value)}>
              <option value="">Not linked to a parcel</option>
              {parcels.map((p) => (
                <option key={p.id} value={p.id}>
                  {p.reference}
                  {p.ownerName ? ` — ${p.ownerName}` : ""}
                </option>
              ))}
            </Select>
          </Field>
          <fieldset>
            <legend className="mb-1 text-xs font-medium text-ink-600">Vulnerability screening</legend>
            <p className="mb-2 text-xs text-ink-400">
              A household carrying any of these attracts enhanced entitlements and targeted
              livelihood support under IFC PS5 (#557). Screen before entitlements are agreed — a
              flag added afterwards cannot restore what was already determined.
            </p>
            <div className="grid grid-cols-2 gap-x-4 gap-y-1.5 sm:grid-cols-4">
              {VULNERABILITY_FLAGS.map((f) => {
                const on = flags.includes(f);
                return (
                  <label
                    key={f}
                    className={`flex cursor-pointer items-center gap-2 rounded px-1.5 py-1 text-sm ${
                      on ? "bg-violet-50 text-violet-900" : "text-ink-700 hover:bg-ink-50"
                    }`}
                  >
                    <input
                      type="checkbox"
                      className="h-4 w-4 rounded border-ink-300 text-brand-600 focus:ring-brand-500"
                      checked={on}
                      onChange={() =>
                        setFlags((cur) => (on ? cur.filter((x) => x !== f) : [...cur, f]))
                      }
                    />
                    {humanize(f)}
                  </label>
                );
              })}
            </div>
            {flags.length > 0 ? (
              <p className="mt-1.5 text-xs text-violet-800">
                {flags.length} flag{flags.length === 1 ? "" : "s"} — this household enters the
                enhanced-entitlement population.
              </p>
            ) : null}
          </fieldset>
          <div className="flex justify-end gap-2">
            <Button variant="secondary" onClick={() => setCreateOpen(false)}>
              Cancel
            </Button>
            <Button type="submit" disabled={busy}>
              {busy ? "Registering…" : "Register household"}
            </Button>
          </div>
        </form>
      </Modal>

      {/* ------------------------------ cut-off modal ---------------------------- */}
      <Modal open={cutOffOpen} title="Declare the cut-off date" onClose={() => setCutOffOpen(false)}>
        <ErrorAlert message={cutOffError} />
        <form onSubmit={onDeclareCutOff} className="space-y-4">
          <p className="text-sm text-ink-600">
            The cut-off date is the moment the entitlement population is fixed. Households censused
            after it are encroachment, not project-affected persons. The declaration is ledgered.
          </p>
          <Field label="Cut-off date">
            <Input
              type="date"
              required
              value={cutOffDraft}
              onChange={(e) => setCutOffDraft(e.target.value)}
            />
          </Field>
          <div className="flex justify-end gap-2">
            <Button variant="secondary" onClick={() => setCutOffOpen(false)}>
              Cancel
            </Button>
            <Button type="submit" disabled={busy}>
              {busy ? "Declaring…" : "Declare"}
            </Button>
          </div>
        </form>
      </Modal>

      {/* ------------------------------ detail modal ----------------------------- */}
      <Modal
        open={selected !== null}
        title={selected ? `${selected.reference} — ${selected.householdHead}` : ""}
        onClose={() => {
          setSelected(null);
          setActError(null);
        }}
        wide
      >
        {selected ? (
          <div className="space-y-4">
            <ErrorAlert message={actError} />
            <div className="flex flex-wrap items-center gap-2">
              <Badge tone={papTone(selected.status)}>{humanize(selected.status)}</Badge>
              <Badge tone="gray">{humanize(selected.displacementType)}</Badge>
              {selected.vulnerabilities.map((v) => (
                <Badge key={v} tone="violet">
                  {humanize(v)}
                </Badge>
              ))}
            </div>

            <div>
              <h4 className="mb-1.5 text-xs font-semibold uppercase tracking-wide text-ink-500">
                Entitlement matrix (#566)
              </h4>
              {selected.entitlements.length === 0 ? (
                <p className="text-xs text-ink-400">
                  No entitlements determined. Compensation cannot be recorded until they are.
                </p>
              ) : (
                <Table>
                  <thead>
                    <tr>
                      <Th>Item</Th>
                      <Th>Basis</Th>
                      <Th className="text-right">Amount</Th>
                      <Th className="text-right">Delivered</Th>
                    </tr>
                  </thead>
                  <tbody className="divide-y divide-ink-100">
                    {selected.entitlements.map((e: Entitlement, i) => (
                      <tr key={`${e.item}-${i}`}>
                        <Td>{e.item}</Td>
                        <Td className="text-ink-500">{e.basis}</Td>
                        <Td className="text-right tabular-nums">{fmtMoney(e.amount)}</Td>
                        <Td className="text-right">
                          {e.delivered ? (
                            <Badge tone="green">Delivered</Badge>
                          ) : (
                            <span className="text-xs text-ink-400">Outstanding</span>
                          )}
                        </Td>
                      </tr>
                    ))}
                    <tr className="bg-ink-50">
                      <Td className="font-semibold">Total</Td>
                      <Td />
                      <Td className="text-right font-semibold tabular-nums">
                        {fmtMoney(selected.compensationTotal)}
                      </Td>
                      <Td className="text-right text-xs tabular-nums text-ink-500">
                        {fmtMoney(
                          selected.entitlements
                            .filter((e) => e.delivered)
                            .reduce((s, e) => s + e.amount, 0),
                        )}{" "}
                        delivered
                      </Td>
                    </tr>
                  </tbody>
                </Table>
              )}
            </div>

            {selected.compensationPaidAt ? (
              <p className="rounded-md bg-emerald-50 px-3 py-2 text-sm text-emerald-800">
                Compensation of {fmtMoney(selected.compensationTotal)} recorded as paid on{" "}
                {formatDate(selected.compensationPaidAt)} against evidence held in the ledger.
              </p>
            ) : null}

            <div className="flex flex-wrap items-center gap-2 border-t border-ink-100 pt-3">
              <Button
                variant="secondary"
                size="sm"
                onClick={() => openEntitlements(selected)}
                disabled={selected.compensationPaidAt !== null}
              >
                {selected.entitlements.length > 0 ? "Revise entitlements" : "Apply entitlements"}
              </Button>
              {selected.compensationPaidAt === null && selected.compensationTotal !== null ? (
                <Button
                  size="sm"
                  onClick={() => {
                    setActError(null);
                    setCompPaidAt(new Date().toISOString().slice(0, 10));
                    setCompEvidence([]);
                    setCompOpen(true);
                  }}
                >
                  Record compensation
                </Button>
              ) : null}
              {selected.status !== "livelihood_restored" && selected.livelihoodRequired ? (
                <Button
                  variant="secondary"
                  size="sm"
                  onClick={() => void setStatus("livelihood_restored")}
                >
                  Mark livelihood restored
                </Button>
              ) : null}
              {selected.status !== "resettled" ? (
                <Button variant="secondary" size="sm" onClick={() => void setStatus("resettled")}>
                  Mark resettled
                </Button>
              ) : null}
            </div>
          </div>
        ) : null}
      </Modal>

      {/* --------------------------- entitlements modal -------------------------- */}
      <Modal
        open={entOpen}
        title="Entitlement matrix"
        onClose={() => setEntOpen(false)}
        wide
      >
        <form onSubmit={onSaveEntitlements} className="space-y-3">
          <p className="text-xs text-ink-500">
            The total is recomputed from these lines on save — it is never entered directly, so the
            register total and what was actually promised cannot drift apart (#566).
          </p>
          <div className="hidden gap-2 px-1 text-xs font-medium uppercase tracking-wide text-ink-400 sm:flex">
            <span className="flex-1">Item</span>
            <span className="flex-1">Basis</span>
            <span className="w-32 text-right">Amount</span>
            <span className="w-24 text-center">Delivered</span>
            <span className="w-8" />
          </div>
          {entRows.map((r, i) => (
            <div key={i} className="flex items-start gap-2">
              <Input
                className="flex-1"
                placeholder="Item — e.g. Replacement dwelling"
                value={r.item}
                onChange={(e) =>
                  setEntRows((rows) =>
                    rows.map((x, j) => (j === i ? { ...x, item: e.target.value } : x)),
                  )
                }
              />
              <Input
                className="flex-1"
                placeholder="Basis — e.g. Full replacement cost"
                value={r.basis}
                onChange={(e) =>
                  setEntRows((rows) =>
                    rows.map((x, j) => (j === i ? { ...x, basis: e.target.value } : x)),
                  )
                }
              />
              <Input
                className="w-32 text-right tabular-nums"
                type="number"
                min="0"
                step="any"
                placeholder="Amount"
                value={r.amount}
                onChange={(e) =>
                  setEntRows((rows) =>
                    rows.map((x, j) => (j === i ? { ...x, amount: e.target.value } : x)),
                  )
                }
              />
              <label className="flex w-24 items-center justify-center gap-1.5 py-2 text-xs text-ink-600">
                <input
                  type="checkbox"
                  className="h-4 w-4 rounded border-ink-300 text-brand-600 focus:ring-brand-500"
                  checked={r.delivered}
                  aria-label={`Entitlement ${i + 1} delivered`}
                  onChange={(e) =>
                    setEntRows((rows) =>
                      rows.map((x, j) => (j === i ? { ...x, delivered: e.target.checked } : x)),
                    )
                  }
                />
                <span className="sm:hidden">Delivered</span>
              </label>
              <Button
                className="w-8"
                variant="ghost"
                size="sm"
                aria-label={`Remove entitlement ${i + 1}`}
                onClick={() => setEntRows((rows) => rows.filter((_, j) => j !== i))}
              >
                ✕
              </Button>
            </div>
          ))}
          <div className="flex flex-wrap items-center justify-between gap-2">
            <Button
              variant="secondary"
              size="sm"
              onClick={() =>
                setEntRows((rows) => [
                  ...rows,
                  { item: "", basis: "", amount: "", delivered: false },
                ])
              }
            >
              Add line
            </Button>
            <span className="text-sm tabular-nums text-ink-700">
              {entDelivered > 0 ? (
                <span className="mr-3 text-xs text-emerald-700">
                  {fmtMoney(entDelivered)} delivered
                </span>
              ) : null}
              Total <span className="font-semibold">{fmtMoney(entTotal)}</span>
            </span>
          </div>
          <div className="flex justify-end gap-2 pt-2">
            <Button variant="secondary" onClick={() => setEntOpen(false)}>
              Cancel
            </Button>
            <Button type="submit" disabled={busy}>
              {busy ? "Saving…" : "Apply matrix"}
            </Button>
          </div>
        </form>
      </Modal>

      {/* ---------------------------- compensate modal --------------------------- */}
      <Modal
        open={compOpen}
        title="Record household compensation"
        onClose={() => setCompOpen(false)}
        wide
      >
        <form onSubmit={onCompensate} className="space-y-4">
          <p className="text-sm text-ink-600">
            Paying {fmtMoney(selected?.compensationTotal ?? null)} — the determined entitlement
            total. Evidence of the payment reaching the household is mandatory (#567).
          </p>
          <Field label="Paid on">
            <Input
              type="date"
              required
              value={compPaidAt}
              onChange={(e) => setCompPaidAt(e.target.value)}
            />
          </Field>
          <Field label="Payment evidence">
            <EvidencePicker
              projectId={projectId}
              selected={compEvidence}
              onChange={setCompEvidence}
            />
          </Field>
          <div className="flex justify-end gap-2">
            <Button variant="secondary" onClick={() => setCompOpen(false)}>
              Cancel
            </Button>
            <Button type="submit" disabled={busy || compEvidence.length === 0}>
              {busy ? "Recording…" : "Record payment"}
            </Button>
          </div>
        </form>
      </Modal>
    </div>
  );
}
