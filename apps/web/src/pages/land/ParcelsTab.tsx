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

  const compensable =
    selected !== null && ["under_negotiation", "agreed", "disputed"].includes(selected.status);
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
            </span>
          ) : null}
        </div>
        <Button onClick={openCreate}>Register parcel</Button>
      </div>

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
                  onClick={() => {
                    setActError(null);
                    setCompAmount(
                      String(selected.compensationAmount ?? selected.valuationAmount ?? ""),
                    );
                    setCompPaidAt(new Date().toISOString().slice(0, 10));
                    setCompEvidence([]);
                    setCompOpen(true);
                  }}
                >
                  Record compensation
                </Button>
              ) : null}
            </div>
            <p className="text-xs text-ink-400">
              A parcel only becomes <span className="font-medium">compensated</span> through the
              evidenced payment route — the status control cannot set it, so a payment can never be
              recorded without proof it reached the beneficiary (#554).
            </p>
          </div>
        ) : null}
      </Modal>

      {/* ---------------------------- compensate modal --------------------------- */}
      <Modal
        open={compOpen}
        title="Record compensation payment"
        onClose={() => setCompOpen(false)}
        wide
      >
        <form onSubmit={onCompensate} className="space-y-4">
          <div className="grid grid-cols-1 gap-4 sm:grid-cols-2">
            <Field
              label="Amount paid"
              hint={
                selected?.valuationAmount
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
