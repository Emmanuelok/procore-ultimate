/**
 * Land parcel register (spec Domain J #547-554, #591). A cadastral list whose
 * tenure column treats customary and communal holdings as first-class — a
 * title-only data model simply cannot represent the land most internationally
 * financed infrastructure actually crosses — plus the acquisition flow and
 * the evidenced compensation route.
 */
import { useCallback, useEffect, useState, type FormEvent } from "react";
import { PARCEL_STATUSES, TENURE_TYPES } from "@constructos/shared";
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
  Textarea,
  Th,
} from "../../ui";
import { formatDate, humanize } from "../format";
import EvidencePicker from "./EvidencePicker";
import TaskPicker from "./TaskPicker";
import {
  fmtLatLng,
  fmtMoney,
  fmtNum,
  parcelTone,
  type ListResponse,
  type ParcelDetail,
  type ParcelRow,
  type ParcelSummary,
} from "./landShared";

interface FormState {
  reference: string;
  tenureType: string;
  ownerName: string;
  areaSqm: string;
  valuation: string;
  currency: string;
  latitude: string;
  longitude: string;
  encumbrances: string;
  description: string;
  blockingTaskIds: string[];
}

const EMPTY_FORM: FormState = {
  reference: "",
  tenureType: "freehold",
  ownerName: "",
  areaSqm: "",
  valuation: "",
  currency: "USD",
  latitude: "",
  longitude: "",
  encumbrances: "",
  description: "",
  blockingTaskIds: [],
};

function formFrom(p: ParcelDetail): FormState {
  return {
    reference: p.reference,
    tenureType: p.tenureType,
    ownerName: p.ownerName ?? "",
    areaSqm: p.areaSqm === null ? "" : String(p.areaSqm),
    valuation: p.valuationAmount === null ? "" : String(p.valuationAmount),
    currency: p.currency,
    latitude: p.latitude === null ? "" : String(p.latitude),
    longitude: p.longitude === null ? "" : String(p.longitude),
    encumbrances: p.encumbrances ?? "",
    description: p.description ?? "",
    blockingTaskIds: [...p.blockingTaskIds],
  };
}

/** Optional numeric field: "" means "leave unset", not zero. */
function optionalNumber(raw: string): number | null | undefined {
  const trimmed = raw.trim();
  if (trimmed === "") return null;
  const n = Number(trimmed);
  return Number.isFinite(n) ? n : undefined;
}

export default function ParcelsTab({
  projectId,
  focusParcelId,
  onFocusHandled,
  onChanged,
}: {
  projectId: string;
  focusParcelId: string | null;
  onFocusHandled: () => void;
  onChanged: () => void;
}) {
  const base = `/api/v1/projects/${projectId}`;
  const [parcels, setParcels] = useState<ParcelRow[] | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [statusFilter, setStatusFilter] = useState("");
  const [tenureFilter, setTenureFilter] = useState("");
  const [selected, setSelected] = useState<ParcelDetail | null>(null);
  /*
   * The pipeline is counted over the WHOLE register, not the filtered page:
   * "12 under negotiation" has to keep meaning the same thing while you are
   * looking at one status. It fails alone — the register still renders when
   * the aggregate does not.
   */
  const [pipeline, setPipeline] = useState<ParcelSummary | null>(null);

  const load = useCallback(async () => {
    setError(null);
    try {
      const qs = new URLSearchParams({ pageSize: "200" });
      if (statusFilter) qs.set("status", statusFilter);
      if (tenureFilter) qs.set("tenureType", tenureFilter);
      const list = await api.get<ListResponse<ParcelRow>>(`${base}/parcels?${qs.toString()}`);
      setParcels(list.items);
    } catch (err) {
      setParcels([]);
      setError(err instanceof Error ? err.message : "Failed to load the parcel register");
    }
    try {
      setPipeline(await api.get<ParcelSummary>(`${base}/land/parcel-summary`));
    } catch {
      setPipeline(null);
    }
  }, [base, statusFilter, tenureFilter]);

  useEffect(() => {
    void load();
  }, [load]);

  const openParcel = useCallback(
    async (id: string) => {
      try {
        setSelected(await api.get<ParcelDetail>(`${base}/parcels/${id}`));
      } catch (err) {
        setError(err instanceof Error ? err.message : "Failed to open the parcel");
      }
    },
    [base],
  );

  // The RAP dashboard's risk table links straight through to a parcel drawer.
  useEffect(() => {
    if (!focusParcelId) return;
    void openParcel(focusParcelId);
    onFocusHandled();
  }, [focusParcelId, openParcel, onFocusHandled]);

  /* --------------------------- create / edit form --------------------------- */

  const [formOpen, setFormOpen] = useState(false);
  const [editing, setEditing] = useState<ParcelDetail | null>(null);
  const [formError, setFormError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [form, setForm] = useState<FormState>(EMPTY_FORM);

  const set = <K extends keyof FormState>(key: K, value: FormState[K]) =>
    setForm((f) => ({ ...f, [key]: value }));

  function openCreate() {
    setFormError(null);
    setEditing(null);
    setForm(EMPTY_FORM);
    setFormOpen(true);
  }

  function openEdit(p: ParcelDetail) {
    setFormError(null);
    setEditing(p);
    setForm(formFrom(p));
    setFormOpen(true);
  }

  async function onSubmitForm(e: FormEvent) {
    e.preventDefault();
    setFormError(null);
    const lat = optionalNumber(form.latitude);
    const lng = optionalNumber(form.longitude);
    if (lat === undefined || lng === undefined) {
      setFormError("Latitude and longitude must be decimal degrees, or left blank.");
      return;
    }
    setBusy(true);
    try {
      const payload: Record<string, unknown> = {
        reference: form.reference.trim(),
        tenureType: form.tenureType,
        ownerName: form.ownerName.trim() || null,
        description: form.description.trim() || null,
        encumbrances: form.encumbrances.trim() || null,
        areaSqm: optionalNumber(form.areaSqm) ?? null,
        valuationAmount: optionalNumber(form.valuation) ?? null,
        latitude: lat,
        longitude: lng,
        blockingTaskIds: form.blockingTaskIds,
      };
      const currency = form.currency.trim().toUpperCase();
      if (currency.length === 3) payload["currency"] = currency;
      if (editing) {
        const updated = await api.patch<ParcelDetail>(`${base}/parcels/${editing.id}`, payload);
        setFormOpen(false);
        setEditing(null);
        await openParcel(updated.id);
      } else {
        await api.post<ParcelRow>(`${base}/parcels`, payload);
        setFormOpen(false);
      }
      await load();
      onChanged();
    } catch (err) {
      setFormError(
        err instanceof ApiClientError
          ? err.message
          : editing
            ? "Failed to save the parcel."
            : "Failed to register the parcel.",
      );
    } finally {
      setBusy(false);
    }
  }

  /* ------------------------------- detail acts ------------------------------ */

  const [actError, setActError] = useState<string | null>(null);
  const [compOpen, setCompOpen] = useState(false);
  const [compAmount, setCompAmount] = useState("");
  const [compPaidAt, setCompPaidAt] = useState("");
  const [compEvidence, setCompEvidence] = useState<string[]>([]);
  /*
   * Correcting a paid figure is a different act from paying more, so it is a
   * different form: it restates the total, and it needs a reason and its own
   * evidence (the revised valuation, the corrected receipt, the audit
   * finding). The server is admin-gated and ledgers both figures.
   */
  const [corrOpen, setCorrOpen] = useState(false);
  const [corrAmount, setCorrAmount] = useState("");
  const [corrReason, setCorrReason] = useState("");
  const [corrEvidence, setCorrEvidence] = useState<string[]>([]);
  /* Acquisition (#551-552): the basis on which title actually passed. */
  const [acqOpen, setAcqOpen] = useState(false);
  const [acqBasis, setAcqBasis] = useState("purchase");
  const [acqDate, setAcqDate] = useState("");
  const [acqEvidence, setAcqEvidence] = useState<string[]>([]);
  const [acqNote, setAcqNote] = useState("");

  async function advance(status: string) {
    if (!selected) return;
    setActError(null);
    setBusy(true);
    try {
      await api.post(`${base}/parcels/${selected.id}/status`, { status });
      await openParcel(selected.id);
      await load();
      onChanged();
    } catch (err) {
      setActError(err instanceof ApiClientError ? err.message : "Status change failed.");
    } finally {
      setBusy(false);
    }
  }

  async function onCompensate(e: FormEvent) {
    e.preventDefault();
    if (!selected) return;
    setActError(null);
    setBusy(true);
    try {
      await api.post(`${base}/parcels/${selected.id}/compensate`, {
        amount: Number(compAmount),
        paidAt: compPaidAt,
        evidenceIds: compEvidence,
      });
      setCompOpen(false);
      await openParcel(selected.id);
      await load();
      onChanged();
    } catch (err) {
      setActError(
        err instanceof ApiClientError ? err.message : "Failed to record the compensation payment.",
      );
    } finally {
      setBusy(false);
    }
  }

  async function onCorrect(e: FormEvent) {
    e.preventDefault();
    if (!selected) return;
    setActError(null);
    setBusy(true);
    try {
      await api.post(`${base}/parcels/${selected.id}/compensation-correction`, {
        correctedAmount: Number(corrAmount),
        reason: corrReason.trim(),
        evidenceIds: corrEvidence,
      });
      setCorrOpen(false);
      await openParcel(selected.id);
      await load();
      onChanged();
    } catch (err) {
      setActError(
        err instanceof ApiClientError ? err.message : "Failed to correct the compensation figure.",
      );
    } finally {
      setBusy(false);
    }
  }

  async function onAcquire(e: FormEvent) {
    e.preventDefault();
    if (!selected) return;
    setActError(null);
    setBusy(true);
    try {
      await api.post(`${base}/parcels/${selected.id}/acquire`, {
        acquisitionBasis: acqBasis,
        acquiredAt: acqDate,
        evidenceIds: acqEvidence,
        note: acqNote.trim() === "" ? null : acqNote.trim(),
      });
      setAcqOpen(false);
      await openParcel(selected.id);
      await load();
      onChanged();
    } catch (err) {
      setActError(
        err instanceof ApiClientError ? err.message : "Failed to record the acquisition.",
      );
    } finally {
      setBusy(false);
    }
  }

  /*
   * The server decides — including for an already-compensated or acquired
   * parcel, where a further payment is a SUPPLEMENT that adds to the total.
   * Hard-coding the three pre-payment statuses here is what left a revised
   * valuation with nowhere to go.
   */
  const compensable = selected?.compensable === true;
  const alreadyPaid = selected?.compensationPaidAt != null;
  /* Bases that need a payment on file first — the server enforces it too. */
  const acqNeedsPayment =
    selected !== null &&
    (selected.cashAcquisitionBases ?? []).includes(acqBasis) &&
    !selected.compensationPaidAt;
  const coords = selected ? fmtLatLng(selected.latitude, selected.longitude) : null;

  /* --------------------------------- render --------------------------------- */

  return (
    <div className="space-y-4">
      <div className="flex flex-wrap items-center justify-between gap-2">
        <div className="flex flex-wrap items-center gap-2">
          <Select
            className="w-44"
            value={statusFilter}
            onChange={(e) => setStatusFilter(e.target.value)}
            aria-label="Filter by acquisition status"
          >
            <option value="">All statuses</option>
            {PARCEL_STATUSES.map((s) => (
              <option key={s} value={s}>
                {humanize(s)}
              </option>
            ))}
          </Select>
          <Select
            className="w-44"
            value={tenureFilter}
            onChange={(e) => setTenureFilter(e.target.value)}
            aria-label="Filter by tenure type"
          >
            <option value="">All tenure types</option>
            {TENURE_TYPES.map((t) => (
              <option key={t} value={t}>
                {humanize(t)}
              </option>
            ))}
          </Select>
          {parcels ? (
            <span className="text-xs tabular-nums text-ink-400">
              {parcels.length} parcel{parcels.length === 1 ? "" : "s"}
              {pipeline && pipeline.total !== parcels.length ? (
                <> of {pipeline.total}</>
              ) : null}
            </span>
          ) : null}
        </div>
        <Button onClick={openCreate}>Register parcel</Button>
      </div>

      {/* Acquisition pipeline over the whole register — also the filter. */}
      {pipeline && pipeline.total > 0 ? (
        <div className="mb-3 flex flex-wrap items-center gap-1.5">
          {PARCEL_STATUSES.filter((s) => (pipeline.byStatus[s] ?? 0) > 0).map((s) => {
            const active = statusFilter === s;
            return (
              <button
                key={s}
                type="button"
                onClick={() => setStatusFilter(active ? "" : s)}
                aria-pressed={active}
                className={`rounded-full px-2.5 py-1 text-xs ring-1 transition ${
                  active
                    ? "bg-brand-600 text-white ring-brand-600"
                    : "bg-white text-ink-600 ring-ink-200 hover:bg-ink-50"
                }`}
                title={`${pipeline.byStatus[s]} parcel(s) ${humanize(s).toLowerCase()} — click to filter`}
              >
                {humanize(s)}{" "}
                <span className="tabular-nums font-medium">{pipeline.byStatus[s]}</span>
              </button>
            );
          })}
        </div>
      ) : null}

      <ErrorAlert message={error} />

      {parcels === null ? (
        <Spinner label="Loading the parcel register…" />
      ) : parcels.length === 0 ? (
        <EmptyState
          title={
            statusFilter || tenureFilter
              ? "No parcels match this filter"
              : "No land parcels registered"
          }
          hint={
            statusFilter || tenureFilter
              ? "Clear the filters to see the whole register."
              : "Register the cadastral parcels the scheme needs — including customary and communal holdings, which a title-only model cannot represent — to start tracking acquisition, compensation and programme risk."
          }
          action={
            statusFilter || tenureFilter ? (
              <Button
                variant="secondary"
                onClick={() => {
                  setStatusFilter("");
                  setTenureFilter("");
                }}
              >
                Clear filters
              </Button>
            ) : (
              <Button onClick={openCreate}>Register the first parcel</Button>
            )
          }
        />
      ) : (
        <Table>
          <thead>
            <tr>
              <Th>Reference</Th>
              <Th>Tenure</Th>
              <Th className="text-right">Area (m²)</Th>
              <Th>Owner / holder</Th>
              <Th>Status</Th>
              <Th className="text-right">Compensation</Th>
              <Th className="text-right">PAPs</Th>
            </tr>
          </thead>
          <tbody className="divide-y divide-ink-100">
            {parcels.map((p) => (
              <tr key={p.id} className="hover:bg-ink-50">
                <Td>
                  <button
                    type="button"
                    className="font-medium text-brand-700 hover:text-brand-800"
                    onClick={() => void openParcel(p.id)}
                  >
                    {p.reference}
                  </button>
                  {p.blockingTaskIds.length > 0 ? (
                    <span
                      className="ml-1.5 text-[11px] text-ink-400"
                      title={`This parcel blocks ${p.blockingTaskIds.length} schedule task(s)`}
                    >
                      blocks {p.blockingTaskIds.length}
                    </span>
                  ) : null}
                </Td>
                <Td>
                  <Badge tone={p.tenureType === "freehold" ? "gray" : "violet"}>
                    {humanize(p.tenureType)}
                  </Badge>
                </Td>
                <Td className="text-right tabular-nums">{fmtNum(p.areaSqm)}</Td>
                <Td className="max-w-[14rem] truncate">{p.ownerName ?? "—"}</Td>
                <Td>
                  <Badge tone={parcelTone(p.status)}>{humanize(p.status)}</Badge>
                </Td>
                <Td className="text-right tabular-nums">
                  {p.compensationPaidAt ? (
                    <span
                      className="font-medium text-emerald-700"
                      title={`Paid ${p.compensationPaidAt}`}
                    >
                      {fmtMoney(p.compensationAmount, p.currency)}
                    </span>
                  ) : (
                    <span className="text-ink-400">
                      {fmtMoney(p.compensationAmount ?? p.valuationAmount, p.currency)}
                    </span>
                  )}
                </Td>
                <Td className="text-right tabular-nums">{p.papCount}</Td>
              </tr>
            ))}
          </tbody>
        </Table>
      )}

      {/* ------------------------------- row drawer ------------------------------- */}
      <Modal
        open={selected !== null}
        title={selected ? `Parcel ${selected.reference}` : ""}
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
              <Badge tone={parcelTone(selected.status)}>{humanize(selected.status)}</Badge>
              <Badge tone={selected.tenureType === "freehold" ? "gray" : "violet"}>
                {humanize(selected.tenureType)}
              </Badge>
              {selected.compensationPaidAt ? (
                <Badge tone="green">
                  Compensated {formatDate(selected.compensationPaidAt)} ·{" "}
                  {selected.evidenceIds.length} evidence item
                  {selected.evidenceIds.length === 1 ? "" : "s"}
                </Badge>
              ) : null}
              <span className="ml-auto">
                <Button variant="secondary" size="sm" onClick={() => openEdit(selected)}>
                  Edit
                </Button>
              </span>
            </div>

            <dl className="grid grid-cols-2 gap-x-6 gap-y-2 text-sm sm:grid-cols-4">
              {[
                ["Owner / holder", selected.ownerName ?? "—"],
                ["Area", selected.areaSqm ? `${fmtNum(selected.areaSqm)} m²` : "—"],
                ["Valuation", fmtMoney(selected.valuationAmount, selected.currency)],
                ["Compensation", fmtMoney(selected.compensationAmount, selected.currency)],
              ].map(([k, v]) => (
                <div key={k}>
                  <dt className="text-xs uppercase tracking-wide text-ink-400">{k}</dt>
                  <dd className="tabular-nums text-ink-800">{v}</dd>
                </div>
              ))}
            </dl>

            {/* map-less location: the coordinate, plainly, and copyable */}
            <Card>
              <CardBody className="flex flex-wrap items-center justify-between gap-3 py-2.5">
                <div>
                  <div className="text-xs uppercase tracking-wide text-ink-400">Location</div>
                  {coords ? (
                    <div className="font-mono text-sm tabular-nums text-ink-800">{coords}</div>
                  ) : (
                    <div className="text-sm text-ink-400">
                      No coordinate recorded — add one so the parcel can be found on the ground.
                    </div>
                  )}
                </div>
                {coords ? (
                  <span className="font-mono text-xs tabular-nums text-ink-400">
                    {selected.latitude}, {selected.longitude}
                  </span>
                ) : null}
              </CardBody>
            </Card>

            {selected.description ? (
              <p className="rounded-md bg-ink-50 px-3 py-2 text-sm text-ink-700">
                {selected.description}
              </p>
            ) : null}
            {selected.encumbrances ? (
              <div>
                <h4 className="mb-1 text-xs font-semibold uppercase tracking-wide text-ink-500">
                  Encumbrances
                </h4>
                <p className="text-sm text-ink-700">{selected.encumbrances}</p>
              </div>
            ) : null}

            <div>
              <h4 className="mb-1.5 text-xs font-semibold uppercase tracking-wide text-ink-500">
                Works blocked by this parcel ({selected.blockingTasks.length})
              </h4>
              {selected.blockingTasks.length === 0 ? (
                <p className="text-xs text-ink-400">
                  This parcel is not mapped to any schedule task, so it raises no programme
                  countdown. Map it on Edit.
                </p>
              ) : (
                <ul className="space-y-1 text-sm">
                  {selected.blockingTasks.map((t) => (
                    <li key={t.id} className="flex items-center justify-between gap-3">
                      <span className={t.missing ? "text-red-700" : "text-ink-800"}>
                        {t.name ?? "Task no longer in the schedule"}
                      </span>
                      <span className="tabular-nums text-xs text-ink-500">
                        {formatDate(t.startDate)}
                      </span>
                    </li>
                  ))}
                </ul>
              )}
            </div>

            <div>
              <h4 className="mb-1.5 text-xs font-semibold uppercase tracking-wide text-ink-500">
                Affected households ({selected.affectedPersons.length})
              </h4>
              {selected.affectedPersons.length === 0 ? (
                <p className="text-xs text-ink-400">No households censused against this parcel.</p>
              ) : (
                <ul className="space-y-1 text-sm">
                  {selected.affectedPersons.map((p) => (
                    <li key={p.id} className="flex items-center justify-between gap-3">
                      <span className="text-ink-800">
                        {p.reference} · {p.householdHead}
                      </span>
                      <Badge tone="gray">{humanize(p.status)}</Badge>
                    </li>
                  ))}
                </ul>
              )}
            </div>

            {selected.compensationPayments.length > 0 ? (
              <div>
                <div className="mb-1 text-xs uppercase tracking-wide text-ink-400">
                  Compensation history · total{" "}
                  {fmtMoney(selected.compensationAmount, selected.currency)}
                </div>
                <ul className="space-y-1 text-sm">
                  {selected.compensationPayments.map((pay) => (
                    <li
                      key={pay.id}
                      className="flex flex-wrap items-baseline justify-between gap-2 rounded-md bg-ink-50 px-2 py-1"
                    >
                      <span className="flex items-center gap-2">
                        <Badge tone={pay.kind === "correction" ? "amber" : "green"}>
                          {humanize(pay.kind)}
                        </Badge>
                        <span className="text-ink-700">{formatDate(pay.paidAt)}</span>
                      </span>
                      <span className="tabular-nums text-ink-800">
                        {pay.delta >= 0 ? "+" : "−"}
                        {fmtMoney(Math.abs(pay.delta), selected.currency)} → total{" "}
                        {fmtMoney(pay.amount, selected.currency)}
                      </span>
                      {pay.reason ? (
                        <span className="w-full text-xs text-ink-500">{pay.reason}</span>
                      ) : null}
                    </li>
                  ))}
                </ul>
                <p className="mt-1 text-xs text-ink-400">
                  Payments accumulate: the total is their sum, and the compensated date stays the
                  date the first payment reached the beneficiary. A correction restates the total
                  and carries its own reason and evidence.
                </p>
              </div>
            ) : null}

            <div className="flex flex-wrap items-center gap-2 border-t border-ink-100 pt-3">
              {selected.allowedTransitions.length === 0 ? (
                <span className="text-xs text-ink-400">
                  No onward status is available from {humanize(selected.status).toLowerCase()}.
                </span>
              ) : (
                selected.allowedTransitions.map((s) => (
                  <Button
                    key={s}
                    variant="secondary"
                    size="sm"
                    disabled={busy}
                    onClick={() => void advance(s)}
                  >
                    Move to {humanize(s)}
                  </Button>
                ))
              )}
              {compensable ? (
                <Button
                  size="sm"
                  variant={alreadyPaid ? "secondary" : "primary"}
                  onClick={() => {
                    setActError(null);
                    // a supplement is a NEW payment, so the field starts
                    // empty rather than pre-filled with the running total
                    setCompAmount(
                      alreadyPaid ? "" : String(selected.valuationAmount ?? ""),
                    );
                    setCompPaidAt(new Date().toISOString().slice(0, 10));
                    setCompEvidence([]);
                    setCompOpen(true);
                  }}
                >
                  {alreadyPaid ? "Record a further payment" : "Record compensation"}
                </Button>
              ) : null}
              {selected.correctable ? (
                <Button
                  size="sm"
                  variant="secondary"
                  onClick={() => {
                    setActError(null);
                    setCorrAmount(String(selected.compensationAmount ?? ""));
                    setCorrReason("");
                    setCorrEvidence([]);
                    setCorrOpen(true);
                  }}
                >
                  Correct the figure
                </Button>
              ) : null}
              {selected.acquirable ? (
                <Button
                  size="sm"
                  onClick={() => {
                    setActError(null);
                    setAcqBasis(
                      selected.compensationPaidAt
                        ? "purchase"
                        : selected.tenureType === "state"
                          ? "state_allocation"
                          : "donation",
                    );
                    setAcqDate(new Date().toISOString().slice(0, 10));
                    setAcqEvidence([]);
                    setAcqNote("");
                    setAcqOpen(true);
                  }}
                >
                  Record acquisition
                </Button>
              ) : null}
            </div>
            <p className="text-xs text-ink-400">
              A parcel only becomes <span className="font-medium">compensated</span> through the
              evidenced payment route, and only becomes{" "}
              <span className="font-medium">acquired</span> through the evidenced acquisition
              route, which records the basis on which title passed — purchase, donation, state
              allocation, lease or court order. Neither can be set from the status control, so a
              payment can never be recorded without proof it reached the beneficiary (#554), and a
              state-owned or donated parcel never has to be routed through a fictitious dispute to
              be marked acquired (#551-552).
            </p>
          </div>
        ) : null}
      </Modal>

      {/* ---------------------------- acquisition modal -------------------------- */}
      <Modal
        open={acqOpen}
        title={selected ? `Record acquisition of ${selected.reference}` : "Record acquisition"}
        onClose={() => setAcqOpen(false)}
        wide
      >
        <form onSubmit={onAcquire} className="space-y-4">
          <ErrorAlert message={actError} />
          <div className="grid grid-cols-1 gap-4 sm:grid-cols-2">
            <Field
              label="Basis on which title passed"
              hint="Purchase and expropriation require compensation to have been paid first (IFC PS5 para 20)."
            >
              <Select value={acqBasis} onChange={(e) => setAcqBasis(e.target.value)}>
                {(selected?.acquisitionBases ?? []).map((b) => (
                  <option key={b} value={b}>
                    {humanize(b)}
                  </option>
                ))}
              </Select>
            </Field>
            <Field label="Title passed on">
              <Input
                type="date"
                required
                value={acqDate}
                onChange={(e) => setAcqDate(e.target.value)}
              />
            </Field>
          </div>
          <Field
            label="Title evidence"
            hint="Transfer deed, lease, donation deed, government allocation letter or court order."
          >
            <EvidencePicker
              projectId={projectId}
              selected={acqEvidence}
              onChange={setAcqEvidence}
            />
          </Field>
          <Field label="Note (optional)">
            <Textarea
              value={acqNote}
              onChange={(e) => setAcqNote(e.target.value)}
              className="min-h-16"
              maxLength={10000}
            />
          </Field>
          <div className="flex flex-wrap items-center justify-end gap-2">
            {acqNeedsPayment ? (
              <p className="mr-auto max-w-sm text-xs text-amber-700">
                No compensation payment is on file. A purchase or expropriation cannot take
                possession before payment — record the payment first, or state the non-cash basis
                on which title passed.
              </p>
            ) : acqEvidence.length === 0 ? (
              <p className="mr-auto max-w-sm text-xs text-amber-700">
                Select at least one title document — an acquisition with no evidence is an
                assertion, not a record.
              </p>
            ) : null}
            <Button variant="secondary" onClick={() => setAcqOpen(false)}>
              Cancel
            </Button>
            <Button type="submit" disabled={busy || acqEvidence.length === 0 || acqNeedsPayment}>
              {busy ? "Recording…" : "Record acquisition"}
            </Button>
          </div>
        </form>
      </Modal>

      {/* ---------------------------- compensate modal --------------------------- */}
      <Modal
        open={compOpen}
        title={alreadyPaid ? "Record a further compensation payment" : "Record compensation payment"}
        onClose={() => setCompOpen(false)}
        wide
      >
        <form onSubmit={onCompensate} className="space-y-4">
          {alreadyPaid && selected ? (
            <p className="rounded-md bg-ink-50 px-3 py-2 text-sm text-ink-700">
              {fmtMoney(selected.compensationAmount, selected.currency)} has already been paid
              against this parcel. This payment is <span className="font-medium">added</span> to
              that total with its own date and evidence — it does not replace it. If the figure on
              the register is simply wrong, close this and use “Correct the figure” instead.
            </p>
          ) : null}
          <div className="grid grid-cols-1 gap-4 sm:grid-cols-2">
            <Field
              label={alreadyPaid ? "Amount of this payment" : "Amount paid"}
              hint={
                alreadyPaid
                  ? "The amount going out now, not the running total."
                  : selected?.valuationAmount
                    ? `Valued at ${fmtMoney(selected.valuationAmount, selected.currency)}.`
                    : undefined
              }
            >
              <Input
                type="number"
                min="0.01"
                step="any"
                required
                value={compAmount}
                onChange={(e) => setCompAmount(e.target.value)}
              />
            </Field>
            <Field label="Paid on">
              <Input
                type="date"
                required
                value={compPaidAt}
                onChange={(e) => setCompPaidAt(e.target.value)}
              />
            </Field>
          </div>
          <Field
            label="Payment evidence"
            hint="Compensation is the most fraud-exposed transaction in a resettlement programme (#554)."
          >
            <EvidencePicker
              projectId={projectId}
              selected={compEvidence}
              onChange={setCompEvidence}
            />
          </Field>
          <div className="flex flex-wrap items-center justify-end gap-2">
            {compEvidence.length === 0 ? (
              <p className="mr-auto max-w-sm text-xs text-amber-700">
                Select at least one evidence item — a bank transaction, a signed receipt, a
                beneficiary-verified disbursement — before the payment can be recorded.
              </p>
            ) : null}
            <Button variant="secondary" onClick={() => setCompOpen(false)}>
              Cancel
            </Button>
            <Button
              type="submit"
              disabled={busy || compEvidence.length === 0}
              title={
                compEvidence.length === 0
                  ? "Compensation cannot be recorded without payment evidence (#554)"
                  : undefined
              }
            >
              {busy ? "Recording…" : "Record payment"}
            </Button>
          </div>
        </form>
      </Modal>
      {/* --------------------------- correction modal ---------------------------- */}
      <Modal
        open={corrOpen}
        title={selected ? `Correct the compensation on ${selected.reference}` : "Correct compensation"}
        onClose={() => setCorrOpen(false)}
        wide
      >
        <form onSubmit={onCorrect} className="space-y-4">
          <p className="rounded-md bg-amber-50 px-3 py-2 text-sm text-amber-900">
            A correction restates what the register says was paid; it does not record money going
            out. Both figures, the movement and your reason go to the ledger, and the act needs
            administrator rights on the land register.
          </p>
          <div className="grid grid-cols-1 gap-4 sm:grid-cols-2">
            <Field
              label="Corrected total"
              hint={
                selected
                  ? `Currently ${fmtMoney(selected.compensationAmount, selected.currency)}.`
                  : undefined
              }
            >
              <Input
                type="number"
                min="0"
                step="any"
                required
                value={corrAmount}
                onChange={(e) => setCorrAmount(e.target.value)}
              />
            </Field>
            <Field label="Reason" hint="At least a sentence — this is the audit trail.">
              <Input
                required
                value={corrReason}
                onChange={(e) => setCorrReason(e.target.value)}
                placeholder="Second instalment keyed twice; the bank statement shows one transfer"
              />
            </Field>
          </div>
          <Field
            label="Evidence for the corrected figure"
            hint="The revised valuation, the corrected receipt or the audit finding."
          >
            <EvidencePicker
              projectId={projectId}
              selected={corrEvidence}
              onChange={setCorrEvidence}
            />
          </Field>
          <div className="flex flex-wrap items-center justify-end gap-2">
            <Button variant="secondary" onClick={() => setCorrOpen(false)}>
              Cancel
            </Button>
            <Button
              type="submit"
              disabled={busy || corrEvidence.length === 0 || corrReason.trim().length < 10}
              title={
                corrEvidence.length === 0
                  ? "A correction needs the document that establishes the right figure"
                  : undefined
              }
            >
              {busy ? "Correcting…" : "Restate the figure"}
            </Button>
          </div>
        </form>
      </Modal>
      {/* ---------------------------- create/edit modal --------------------------- */}
      <Modal
        open={formOpen}
        title={editing ? `Edit parcel ${editing.reference}` : "Register a land parcel"}
        onClose={() => setFormOpen(false)}
        wide
      >
        <ErrorAlert message={formError} />
        <form onSubmit={onSubmitForm} className="space-y-4">
          <div className="grid grid-cols-1 gap-4 sm:grid-cols-2">
            <Field label="Cadastral reference" hint="Unique on this project.">
              <Input
                required
                value={form.reference}
                onChange={(e) => set("reference", e.target.value)}
                placeholder="CAD/12/447"
              />
            </Field>
            <Field
              label="Tenure type"
              hint="Customary and communal tenure are first-class (#549)."
            >
              <Select
                value={form.tenureType}
                onChange={(e) => set("tenureType", e.target.value)}
              >
                {TENURE_TYPES.map((t) => (
                  <option key={t} value={t}>
                    {humanize(t)}
                  </option>
                ))}
              </Select>
            </Field>
          </div>

          <div className="grid grid-cols-1 gap-4 sm:grid-cols-4">
            <Field label="Owner / holder">
              <Input
                value={form.ownerName}
                onChange={(e) => set("ownerName", e.target.value)}
                placeholder="Elders of Kibaale"
              />
            </Field>
            <Field label="Area (m²)">
              <Input
                type="number"
                min="0"
                step="any"
                value={form.areaSqm}
                onChange={(e) => set("areaSqm", e.target.value)}
              />
            </Field>
            <Field label="Valuation">
              <Input
                type="number"
                min="0"
                step="any"
                value={form.valuation}
                onChange={(e) => set("valuation", e.target.value)}
              />
            </Field>
            <Field label="Currency">
              <Input
                value={form.currency}
                maxLength={3}
                onChange={(e) => set("currency", e.target.value)}
                placeholder="USD"
              />
            </Field>
          </div>

          <div className="grid grid-cols-1 gap-4 sm:grid-cols-2">
            <Field label="Latitude" hint="Decimal degrees, e.g. 0.31628.">
              <Input
                type="number"
                min="-90"
                max="90"
                step="any"
                value={form.latitude}
                onChange={(e) => set("latitude", e.target.value)}
              />
            </Field>
            <Field label="Longitude" hint="Decimal degrees, e.g. 31.44012.">
              <Input
                type="number"
                min="-180"
                max="180"
                step="any"
                value={form.longitude}
                onChange={(e) => set("longitude", e.target.value)}
              />
            </Field>
          </div>

          <Field
            label="Works blocked by this parcel"
            hint="Maps the parcel to the programme (#591) — the countdown to works starting on unacquired land is computed from this."
          >
            <TaskPicker
              projectId={projectId}
              selected={form.blockingTaskIds}
              onChange={(ids) => set("blockingTaskIds", ids)}
            />
          </Field>

          <div className="grid grid-cols-1 gap-4 sm:grid-cols-2">
            <Field label="Description">
              <Textarea
                className="min-h-12"
                value={form.description}
                onChange={(e) => set("description", e.target.value)}
                placeholder="Grazing land held under customary tenure; seasonal access route crosses the northern boundary."
              />
            </Field>
            <Field label="Encumbrances" hint="Charges, rights of way, pending claims.">
              <Textarea
                className="min-h-12"
                value={form.encumbrances}
                onChange={(e) => set("encumbrances", e.target.value)}
                placeholder="Registered right of way in favour of the adjoining plot."
              />
            </Field>
          </div>

          <div className="flex justify-end gap-2">
            <Button variant="secondary" onClick={() => setFormOpen(false)}>
              Cancel
            </Button>
            <Button type="submit" disabled={busy}>
              {busy ? "Saving…" : editing ? "Save changes" : "Register parcel"}
            </Button>
          </div>
        </form>
      </Modal>

    </div>
  );
}
