/**
 * REGISTRATIONS — what the tenant, its vendors and entities hold under each
 * regime, and whether anyone checked it with the authority (#800–801).
 *
 * Company-level: a vendor's VAT number is not a project fact. The rule the
 * screen enforces is that the person who recorded a registration cannot be
 * the person who verifies it — the claim and the check must not share an
 * author — and that a changed number silently voids an old verification.
 */
import { useEffect, useMemo, useState, type FormEvent } from "react";
import {
  Alert,
  Badge,
  Button,
  Card,
  CardBody,
  DataTable,
  Drawer,
  Field,
  Input,
  Select,
  StatusPill,
  Textarea,
  toast,
  type DataColumns,
} from "../../ui";
import { IconPlus } from "../../ui/icons";
import { useAuth } from "../../lib/auth";
import {
  DASH,
  HOLDER_TYPES,
  LoadError,
  REGISTRATION_KINDS,
  REGISTRATION_STATUSES,
  Row,
  VERIFICATION_STATUSES,
  dateTime,
  isoDate,
  pct,
  taxApi,
  titleCase,
  useAction,
  useRegimes,
  useResource,
  useVendors,
  verificationTone,
  type Paginated,
  type Registration,
  type RegistrationDetail,
} from "./taxShared";

export default function RegistrationsTab({ onChanged }: { onChanged: () => void }) {
  const [holderType, setHolderType] = useState("");
  const [kind, setKind] = useState("");
  const [regime, setRegime] = useState("");
  const [verification, setVerification] = useState("");
  const [search, setSearch] = useState("");
  const [creating, setCreating] = useState(false);
  const [openId, setOpenId] = useState<string | null>(null);

  const params = new URLSearchParams({ page: "1", pageSize: "500" });
  if (holderType) params.set("holderType", holderType);
  if (kind) params.set("kind", kind);
  if (regime) params.set("regime", regime);
  if (verification) params.set("verificationStatus", verification);
  if (search.trim()) params.set("search", search.trim());
  const list = useResource<Paginated<Registration>>(`/api/v1/tax/registrations?${params.toString()}`);
  const regimes = useRegimes();

  const columns = useMemo<DataColumns<Registration>>(
    () => [
      { id: "holderName", header: "Holder", accessor: "holderName", type: "text", width: 240 },
      { id: "holderType", header: "Type", accessor: (row) => titleCase(row.holderType), type: "text", width: 100 },
      { id: "regime", header: "Regime", accessor: (row) => row.regime.toUpperCase(), type: "code", width: 90, mono: true },
      { id: "kind", header: "Kind", accessor: (row) => row.kind.toUpperCase(), type: "code", width: 80, mono: true },
      { id: "number", header: "Number", accessor: (row) => row.number ?? "", type: "code", width: 170, mono: true, cell: ({ row }) => row.number ?? <span className="text-content-subtle">{DASH}</span> },
      { id: "status", header: "Status", accessor: "status", type: "text", width: 110, cell: ({ row }) => <StatusPill status={row.status} size="xs" /> },
      {
        id: "verificationStatus",
        header: "Verification",
        accessor: "verificationStatus",
        type: "text",
        width: 130,
        cell: ({ row }) => (
          <Badge tone={verificationTone(row.verificationStatus)} size="xs" dot>
            {titleCase(row.verificationStatus)}
          </Badge>
        ),
      },
      { id: "deductionRate", header: "Deduction rate", accessor: (row) => row.deductionRate ?? "", type: "number", align: "right", width: 120, cell: ({ row }) => (row.deductionRate === null ? DASH : pct(row.deductionRate)) },
      { id: "verifiedAt", header: "Verified", accessor: (row) => row.verifiedAt ?? "", type: "date", width: 120, cell: ({ row }) => isoDate(row.verifiedAt) },
      { id: "validTo", header: "Valid to", accessor: (row) => row.validTo ?? "", type: "date", width: 110, cell: ({ row }) => isoDate(row.validTo) },
    ],
    [],
  );

  return (
    <div className="space-y-4">
      <Card>
        <CardBody className="flex flex-wrap items-end gap-3">
          <Field label="Holder">
            <Select value={holderType} onChange={(e) => setHolderType(e.target.value)} size="sm">
              <option value="">Any</option>
              {HOLDER_TYPES.map((h) => (
                <option key={h} value={h}>
                  {titleCase(h)}
                </option>
              ))}
            </Select>
          </Field>
          <Field label="Kind">
            <Select value={kind} onChange={(e) => setKind(e.target.value)} size="sm">
              <option value="">Any</option>
              {REGISTRATION_KINDS.map((k) => (
                <option key={k} value={k}>
                  {k.toUpperCase()}
                </option>
              ))}
            </Select>
          </Field>
          <Field label="Regime">
            <Select value={regime} onChange={(e) => setRegime(e.target.value)} size="sm">
              <option value="">Any</option>
              {(regimes.data?.items ?? []).map((r) => (
                <option key={r.regime} value={r.regime}>
                  {r.name}
                </option>
              ))}
            </Select>
          </Field>
          <Field label="Verification">
            <Select value={verification} onChange={(e) => setVerification(e.target.value)} size="sm">
              <option value="">Any</option>
              {VERIFICATION_STATUSES.map((v) => (
                <option key={v} value={v}>
                  {titleCase(v)}
                </option>
              ))}
            </Select>
          </Field>
          <Field label="Holder name">
            <Input value={search} onChange={(e) => setSearch(e.target.value)} size="sm" placeholder="Search…" />
          </Field>
          <div className="ml-auto">
            <Button icon={IconPlus} onClick={() => setCreating(true)}>
              New registration
            </Button>
          </div>
        </CardBody>
      </Card>

      {list.error ? (
        <LoadError message={list.error} onRetry={list.reload} />
      ) : (
        <DataTable<Registration>
          tableId="tax.registrations"
          data={list.data?.items ?? []}
          columns={columns}
          getRowId={(row) => row.id}
          loading={list.loading && !list.data}
          height={520}
          rowHeight={44}
          stickyHeader
          exportFileName="tax-registrations"
          empty={{
            title: "No registrations recorded",
            description: "Record the tenant's own VAT and deduction-scheme registrations first, then each paying vendor's. Until a vendor has one on file the engine cannot say whether it may charge tax.",
            action: <Button onClick={() => setCreating(true)}>Record a registration</Button>,
          }}
          onRowClick={({ row }) => setOpenId(row.id)}
          rowTone={(row) => (row.verificationStatus === "expired" || row.verificationStatus === "failed" ? "danger" : row.verificationStatus === "unverified" ? "warning" : undefined)}
          aria-label="Tax registrations"
        />
      )}

      <RegistrationCreateDrawer
        open={creating}
        onClose={() => setCreating(false)}
        onCreated={() => {
          setCreating(false);
          list.reload();
          onChanged();
        }}
      />
      <RegistrationDrawer
        registrationId={openId}
        onClose={() => setOpenId(null)}
        onChanged={() => {
          list.reload();
          onChanged();
        }}
      />
    </div>
  );
}

/* ================================= Create ================================= */

function RegistrationCreateDrawer({ open, onClose, onCreated }: { open: boolean; onClose: () => void; onCreated: () => void }) {
  const action = useAction();
  const regimes = useRegimes();
  const vendors = useVendors();
  const [holderType, setHolderType] = useState<string>("vendor");
  const [holderId, setHolderId] = useState("");
  const [holderName, setHolderName] = useState("");
  const [regime, setRegime] = useState("uk");
  const [kind, setKind] = useState<string>("vat");
  const [number, setNumber] = useState("");
  const [status, setStatus] = useState<string>("active");
  const [validFrom, setValidFrom] = useState("");
  const [validTo, setValidTo] = useState("");
  const [country, setCountry] = useState("");
  const [notes, setNotes] = useState("");

  useEffect(() => {
    if (!open) return;
    setHolderType("vendor");
    setHolderId("");
    setHolderName("");
    setRegime(regimes.data?.items[0]?.regime ?? "uk");
    setKind("vat");
    setNumber("");
    setStatus("active");
    setValidFrom("");
    setValidTo("");
    setCountry("");
    setNotes("");
    action.clear();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [open]);

  async function submit(e: FormEvent) {
    e.preventDefault();
    const body: Record<string, unknown> = { holderType, regime, kind, status };
    if (holderType !== "company") body["holderId"] = holderId.trim() || null;
    if (holderName.trim()) body["holderName"] = holderName.trim();
    if (number.trim()) body["number"] = number.trim();
    if (validFrom) body["validFrom"] = validFrom;
    if (validTo) body["validTo"] = validTo;
    if (country.trim()) body["country"] = country.trim().toUpperCase();
    if (notes.trim()) body["notes"] = notes.trim();
    const created = await action.run("create", () => taxApi.createRegistration(body));
    if (created) {
      toast.success(`Registration recorded for ${created.holderName}`);
      onCreated();
    }
  }

  return (
    <Drawer
      open={open}
      onClose={onClose}
      size="md"
      title="Record a registration"
      description="Recording is a claim. Verification with the authority is a separate act by a different person."
      footer={
        <div className="flex justify-end gap-2">
          <Button variant="ghost" onClick={onClose}>
            Cancel
          </Button>
          <Button type="submit" form="tax-registration-create" loading={action.busy === "create"}>
            Record
          </Button>
        </div>
      }
    >
      <form id="tax-registration-create" onSubmit={submit} className="space-y-4">
        {action.error ? <Alert tone="danger" size="sm">{action.error}</Alert> : null}
        <Field label="Holder" required>
          <Select value={holderType} onChange={(e) => setHolderType(e.target.value)}>
            {HOLDER_TYPES.map((h) => (
              <option key={h} value={h}>
                {h === "company" ? "This company (the tenant)" : titleCase(h)}
              </option>
            ))}
          </Select>
        </Field>
        {holderType === "vendor" ? (
          <Field label="Vendor" required error={vendors.error}>
            <Select value={holderId} onChange={(e) => setHolderId(e.target.value)} placeholder="Choose the vendor">
              {(vendors.data?.items ?? []).map((v) => (
                <option key={v.id} value={v.id}>
                  {v.name}
                  {v.country ? ` (${v.country})` : ""}
                </option>
              ))}
            </Select>
          </Field>
        ) : null}
        {holderType === "entity" ? (
          <div className="grid gap-3 sm:grid-cols-2">
            <Field label="Entity id" required>
              <Input value={holderId} onChange={(e) => setHolderId(e.target.value)} />
            </Field>
            <Field label="Entity name" required>
              <Input value={holderName} onChange={(e) => setHolderName(e.target.value)} />
            </Field>
          </div>
        ) : null}
        <div className="grid gap-3 sm:grid-cols-2">
          <Field label="Regime" required>
            <Select value={regime} onChange={(e) => setRegime(e.target.value)}>
              {(regimes.data?.items ?? []).map((r) => (
                <option key={r.regime} value={r.regime}>
                  {r.name}
                </option>
              ))}
              {regimes.data ? null : <option value="uk">United Kingdom</option>}
            </Select>
          </Field>
          <Field label="Kind" required hint="VAT/GST/SST · CIS · RCT · WHT deductor · TIN/ABN/PAN/W-9">
            <Select value={kind} onChange={(e) => setKind(e.target.value)}>
              {REGISTRATION_KINDS.map((k) => (
                <option key={k} value={k}>
                  {k.toUpperCase()}
                </option>
              ))}
            </Select>
          </Field>
        </div>
        <div className="grid gap-3 sm:grid-cols-2">
          <Field label="Registration number">
            <Input value={number} onChange={(e) => setNumber(e.target.value)} />
          </Field>
          <Field label="Status">
            <Select value={status} onChange={(e) => setStatus(e.target.value)}>
              {REGISTRATION_STATUSES.map((s) => (
                <option key={s} value={s}>
                  {titleCase(s)}
                </option>
              ))}
            </Select>
          </Field>
        </div>
        <div className="grid gap-3 sm:grid-cols-3">
          <Field label="Valid from">
            <Input type="date" value={validFrom} onChange={(e) => setValidFrom(e.target.value)} />
          </Field>
          <Field label="Valid to">
            <Input type="date" value={validTo} onChange={(e) => setValidTo(e.target.value)} />
          </Field>
          <Field label="Country (ISO-2)" hint="Defaults to the regime's">
            <Input value={country} onChange={(e) => setCountry(e.target.value)} maxLength={2} />
          </Field>
        </div>
        <Field label="Notes">
          <Textarea value={notes} onChange={(e) => setNotes(e.target.value)} rows={3} />
        </Field>
      </form>
    </Drawer>
  );
}

/* ================================= Detail ================================= */

function RegistrationDrawer({ registrationId, onClose, onChanged }: { registrationId: string | null; onClose: () => void; onChanged: () => void }) {
  const { user, company } = useAuth();
  const detail = useResource<RegistrationDetail>(registrationId ? `/api/v1/tax/registrations/${registrationId}` : null);
  const action = useAction();
  const r = detail.data;
  const [outcome, setOutcome] = useState<"verified" | "failed">("verified");
  const [reference, setReference] = useState("");
  const [rate, setRate] = useState("");
  const [number, setNumber] = useState("");
  const [status, setStatus] = useState("");
  const [validTo, setValidTo] = useState("");

  useEffect(() => {
    if (!r) return;
    setOutcome("verified");
    setReference("");
    setRate(r.deductionRate === null ? "" : String(r.deductionRate));
    setNumber(r.number ?? "");
    setStatus(r.status);
    setValidTo(r.validTo ?? "");
    action.clear();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [r?.id, r?.updatedAt]);

  const isRecorder = r !== null && user !== null && r.createdBy === user.id;
  const isAdmin = company?.role === "owner" || company?.role === "admin";
  const needsRate = r?.kind === "cis" || r?.kind === "rct";

  async function verify(e: FormEvent) {
    e.preventDefault();
    if (!r) return;
    const body: Record<string, unknown> = { outcome };
    if (reference.trim()) body["reference"] = reference.trim();
    if (outcome === "verified" && rate.trim() !== "") body["deductionRate"] = Number(rate);
    const res = await action.run("verify", () => taxApi.verifyRegistration(r.id, body));
    if (res) {
      toast.success(outcome === "verified" ? "Registration verified" : "Verification recorded as failed");
      detail.reload();
      onChanged();
    }
  }

  async function save(e: FormEvent) {
    e.preventDefault();
    if (!r) return;
    const body: Record<string, unknown> = { status };
    body["number"] = number.trim() || null;
    body["validTo"] = validTo || null;
    const res = await action.run("save", () => taxApi.patchRegistration(r.id, body));
    if (res) {
      toast.success("Registration updated");
      detail.reload();
      onChanged();
    }
  }

  async function remove() {
    if (!r) return;
    if (!window.confirm(`Delete the ${r.kind.toUpperCase()} registration for ${r.holderName}? The ledger keeps the record of its existence.`)) return;
    const res = await action.run("delete", () => taxApi.deleteRegistration(r.id).then(() => true));
    if (res) {
      toast.success("Registration deleted");
      onClose();
      onChanged();
    }
  }

  return (
    <Drawer
      open={registrationId !== null}
      onClose={onClose}
      size="lg"
      title={r ? `${r.holderName} — ${r.kind.toUpperCase()} (${r.regime.toUpperCase()})` : "Registration"}
      description={r?.regimeDef ? r.regimeDef.name : undefined}
      footer={
        r && isAdmin ? (
          <div className="flex justify-between">
            <Button variant="danger" size="sm" onClick={() => void remove()} loading={action.busy === "delete"}>
              Delete
            </Button>
            <Button variant="ghost" onClick={onClose}>
              Close
            </Button>
          </div>
        ) : undefined
      }
    >
      {detail.loading && !r ? <div className="text-meta text-content-subtle">Loading…</div> : null}
      {detail.error ? <LoadError message={detail.error} onRetry={detail.reload} /> : null}
      {r ? (
        <div className="space-y-5">
          {action.error ? <Alert tone="danger" size="sm">{action.error}</Alert> : null}
          <dl className="divide-y divide-border">
            <Row label="Holder">
              {r.holderName} <span className="text-content-subtle">({titleCase(r.holderType)})</span>
            </Row>
            <Row label="Number">{r.number ?? DASH}</Row>
            <Row label="Status">
              <StatusPill status={r.status} size="xs" />
            </Row>
            <Row label="Verification">
              <Badge tone={verificationTone(r.verificationStatus)} size="xs" dot>
                {titleCase(r.verificationStatus)}
              </Badge>
            </Row>
            {r.verifiedAt ? (
              <Row label="Verified" hint={r.verificationReference ? `Ref ${r.verificationReference}` : undefined}>
                {dateTime(r.verifiedAt)}
              </Row>
            ) : null}
            <Row label="Deduction rate" hint="Authority-assigned; applies while the verification stands">
              {r.deductionRate === null ? DASH : pct(r.deductionRate)}
            </Row>
            <Row label="Validity">
              {isoDate(r.validFrom)} → {isoDate(r.validTo)}
            </Row>
            <Row label="Country">{r.country ?? DASH}</Row>
            {r.notes ? <Row label="Notes">{r.notes}</Row> : null}
          </dl>

          <section className="space-y-3 rounded-md border border-border p-3">
            <h3 className="text-sm font-semibold text-content">Verify with the authority</h3>
            {isRecorder ? (
              <Alert tone="warning" size="sm">
                You recorded this registration, so you cannot verify it. A different person must confirm it with the authority — the claim and the check must not share an author.
              </Alert>
            ) : (
              <form onSubmit={verify} className="space-y-3">
                <div className="grid gap-3 sm:grid-cols-3">
                  <Field label="Outcome">
                    <Select value={outcome} onChange={(e) => setOutcome(e.target.value === "failed" ? "failed" : "verified")}>
                      <option value="verified">Verified</option>
                      <option value="failed">Failed</option>
                    </Select>
                  </Field>
                  <Field label="Authority reference">
                    <Input value={reference} onChange={(e) => setReference(e.target.value)} />
                  </Field>
                  {needsRate && outcome === "verified" ? (
                    <Field label="Deduction rate (%)" required hint="What the authority returned">
                      <Input type="number" min={0} max={100} step="0.5" value={rate} onChange={(e) => setRate(e.target.value)} />
                    </Field>
                  ) : null}
                </div>
                <Button type="submit" size="sm" loading={action.busy === "verify"}>
                  Record verification
                </Button>
              </form>
            )}
          </section>

          <section className="space-y-3 rounded-md border border-border p-3">
            <h3 className="text-sm font-semibold text-content">Update</h3>
            <form onSubmit={save} className="space-y-3">
              <div className="grid gap-3 sm:grid-cols-3">
                <Field label="Number" hint="Changing it voids the verification">
                  <Input value={number} onChange={(e) => setNumber(e.target.value)} />
                </Field>
                <Field label="Status">
                  <Select value={status} onChange={(e) => setStatus(e.target.value)}>
                    {REGISTRATION_STATUSES.map((s) => (
                      <option key={s} value={s}>
                        {titleCase(s)}
                      </option>
                    ))}
                  </Select>
                </Field>
                <Field label="Valid to">
                  <Input type="date" value={validTo} onChange={(e) => setValidTo(e.target.value)} />
                </Field>
              </div>
              <Button type="submit" size="sm" variant="secondary" loading={action.busy === "save"}>
                Save changes
              </Button>
            </form>
          </section>
        </div>
      ) : null}
    </Drawer>
  );
}
