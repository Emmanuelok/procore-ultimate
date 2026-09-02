/**
 * PE EXPOSURE — days in the host country per entity per project against
 * the treaty / domestic-law threshold (#806–807). Presence is recorded as
 * date ranges so the count is recomputable and never hand-typed; overlaps
 * are merged so a day is never counted twice. The projected breach date is
 * a run-rate warning device, not a forecast, and says so.
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
  Progress,
  Select,
  Textarea,
  toast,
  type DataColumns,
} from "../../ui";
import { IconPlus, IconTrash } from "../../ui/icons";
import {
  DASH,
  LoadError,
  PE_ENTITY_TYPES,
  PRESENCE_SOURCES,
  Row,
  count,
  dateTime,
  exposureTone,
  isoDate,
  pct,
  taxApi,
  titleCase,
  useAction,
  useProfile,
  useRegimes,
  useResource,
  useVendors,
  type Exposure,
  type ExposureDetail,
  type Paginated,
} from "./taxShared";

export default function PeExposureTab({ projectId, onChanged }: { projectId: string; onChanged: () => void }) {
  const [status, setStatus] = useState("");
  const [creating, setCreating] = useState(false);
  const [openId, setOpenId] = useState<string | null>(null);

  const params = new URLSearchParams({ page: "1", pageSize: "500" });
  if (status) params.set("status", status);
  const list = useResource<Paginated<Exposure>>(`/api/v1/projects/${projectId}/tax/pe-exposures?${params.toString()}`);

  const columns = useMemo<DataColumns<Exposure>>(
    () => [
      { id: "entityName", header: "Entity", accessor: "entityName", type: "text", width: 220 },
      { id: "entityType", header: "Type", accessor: (row) => titleCase(row.entityType), type: "text", width: 90 },
      { id: "route", header: "Home → host", accessor: (row) => `${row.homeCountry} → ${row.hostCountry}`, type: "text", width: 120 },
      {
        id: "daysInWindow",
        header: "Days / threshold",
        accessor: "daysInWindow",
        type: "number",
        align: "right",
        width: 200,
        cell: ({ row }) => (
          <div className="min-w-40">
            <div className="flex justify-between text-meta tabular-nums">
              <span className="font-semibold">{row.daysInWindow}</span>
              <span className="text-content-subtle">/ {row.thresholdDays}</span>
            </div>
            <Progress value={Math.min(row.daysInWindow, row.thresholdDays)} max={row.thresholdDays} size="xs" tone={exposureTone(row.status)} />
          </div>
        ),
      },
      { id: "percentOfThreshold", header: "%", accessor: (row) => row.percentOfThreshold ?? 0, type: "number", align: "right", width: 80, cell: ({ row }) => pct(row.percentOfThreshold ?? null) },
      { id: "window", header: "Window", accessor: (row) => row.windowMonths, type: "number", width: 110, cell: ({ row }) => (row.windowMonths > 0 ? `${row.windowMonths} months` : "project life") },
      { id: "projectedBreachDate", header: "Projected breach", accessor: (row) => row.projectedBreachDate ?? "", type: "date", width: 140, cell: ({ row }) => (row.projectedBreachDate ? row.projectedBreachDate : <span className="text-content-subtle">{row.status === "breached" ? "crossed" : "not projectable"}</span>) },
      { id: "lastPresenceDate", header: "Last presence", accessor: (row) => row.lastPresenceDate ?? "", type: "date", width: 120, cell: ({ row }) => isoDate(row.lastPresenceDate) },
      { id: "status", header: "Status", accessor: "status", type: "text", width: 110, cell: ({ row }) => <Badge tone={exposureTone(row.status)} size="xs" dot>{titleCase(row.status)}</Badge> },
    ],
    [],
  );

  return (
    <div className="space-y-4">
      <Card>
        <CardBody className="flex flex-wrap items-end gap-3">
          <Field label="Status">
            <Select value={status} onChange={(e) => setStatus(e.target.value)} size="sm">
              <option value="">Any</option>
              {["monitoring", "approaching", "breached", "mitigated", "closed"].map((s) => (
                <option key={s} value={s}>
                  {titleCase(s)}
                </option>
              ))}
            </Select>
          </Field>
          <div className="ml-auto">
            <Button icon={IconPlus} onClick={() => setCreating(true)}>
              New exposure
            </Button>
          </div>
        </CardBody>
      </Card>

      {list.error ? (
        <LoadError message={list.error} onRetry={list.reload} />
      ) : (
        <DataTable<Exposure>
          tableId="tax.pe-exposures"
          data={list.data?.items ?? []}
          columns={columns}
          getRowId={(row) => row.id}
          loading={list.loading && !list.data}
          height={520}
          rowHeight={52}
          stickyHeader
          exportFileName="pe-exposures"
          empty={{
            title: "No permanent-establishment exposures tracked",
            description: "Track each foreign entity or expatriate whose presence on this project counts toward a taxable presence in the host country. Presence is recorded as date ranges, never as a typed number.",
            action: <Button onClick={() => setCreating(true)}>Track an exposure</Button>,
          }}
          onRowClick={({ row }) => setOpenId(row.id)}
          rowTone={(row) => (row.status === "breached" ? "danger" : row.status === "approaching" ? "warning" : undefined)}
          aria-label="Permanent establishment exposures"
        />
      )}

      <ExposureCreateDrawer
        projectId={projectId}
        open={creating}
        onClose={() => setCreating(false)}
        onCreated={() => {
          setCreating(false);
          list.reload();
          onChanged();
        }}
      />
      <ExposureDrawer
        projectId={projectId}
        exposureId={openId}
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

function ExposureCreateDrawer({ projectId, open, onClose, onCreated }: { projectId: string; open: boolean; onClose: () => void; onCreated: () => void }) {
  const action = useAction();
  const profile = useProfile(projectId);
  const regimes = useRegimes();
  const vendors = useVendors();
  const [entityType, setEntityType] = useState<string>("person");
  const [entityId, setEntityId] = useState("");
  const [entityName, setEntityName] = useState("");
  const [homeCountry, setHomeCountry] = useState("");
  const [hostCountry, setHostCountry] = useState("");
  const [regime, setRegime] = useState("");
  const [thresholdDays, setThresholdDays] = useState("");
  const [thresholdBasis, setThresholdBasis] = useState("");
  const [windowMonths, setWindowMonths] = useState("");
  const [notes, setNotes] = useState("");

  useEffect(() => {
    if (!open) return;
    setEntityType("person");
    setEntityId("");
    setEntityName("");
    setHomeCountry("");
    setHostCountry("");
    setRegime("");
    setThresholdDays("");
    setThresholdBasis("");
    setWindowMonths("");
    setNotes("");
    action.clear();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [open]);

  const resolved = regime || profile.data?.resolved.regime || null;
  const regimeSummary = (regimes.data?.items ?? []).find((r) => r.regime === resolved) ?? null;
  const defaultThreshold = regimeSummary ? (entityType === "person" ? regimeSummary.peServiceDays : regimeSummary.peConstructionSiteDays) : null;

  async function submit(e: FormEvent) {
    e.preventDefault();
    const body: Record<string, unknown> = { entityType, entityName: entityName.trim(), homeCountry: homeCountry.trim().toUpperCase() };
    if (entityId.trim()) body["entityId"] = entityId.trim();
    if (hostCountry.trim()) body["hostCountry"] = hostCountry.trim().toUpperCase();
    if (regime) body["regime"] = regime;
    if (thresholdDays.trim() !== "") body["thresholdDays"] = Number(thresholdDays);
    if (thresholdBasis.trim()) body["thresholdBasis"] = thresholdBasis.trim();
    if (windowMonths.trim() !== "") body["windowMonths"] = Number(windowMonths);
    if (notes.trim()) body["notes"] = notes.trim();
    const created = await action.run("create", () => taxApi.createExposure(projectId, body));
    if (created) {
      toast.success(`Tracking ${created.entityName}: ${created.thresholdDays}-day threshold`);
      onCreated();
    }
  }

  return (
    <Drawer
      open={open}
      onClose={onClose}
      size="md"
      title="Track a permanent-establishment exposure"
      description="The threshold defaults to the regime's building-site or individual-presence day count and is cited; override it only with a stated treaty basis."
      footer={
        <div className="flex justify-end gap-2">
          <Button variant="ghost" onClick={onClose}>
            Cancel
          </Button>
          <Button type="submit" form="tax-pe-create" loading={action.busy === "create"}>
            Track
          </Button>
        </div>
      }
    >
      <form id="tax-pe-create" onSubmit={submit} className="space-y-4">
        {action.error ? <Alert tone="danger" size="sm">{action.error}</Alert> : null}
        <div className="grid gap-3 sm:grid-cols-2">
          <Field label="Entity type" required hint={entityType === "person" ? "Individual presence: rolling 12-month window" : "Building site: whole project life"}>
            <Select value={entityType} onChange={(e) => setEntityType(e.target.value)}>
              {PE_ENTITY_TYPES.map((t) => (
                <option key={t} value={t}>
                  {titleCase(t)}
                </option>
              ))}
            </Select>
          </Field>
          {entityType === "vendor" ? (
            <Field label="Vendor">
              <Select
                value={entityId}
                onChange={(e) => {
                  setEntityId(e.target.value);
                  const v = (vendors.data?.items ?? []).find((x) => x.id === e.target.value);
                  if (v) {
                    setEntityName(v.name);
                    if (v.country) setHomeCountry(v.country);
                  }
                }}
                placeholder="Choose the vendor"
              >
                {(vendors.data?.items ?? []).map((v) => (
                  <option key={v.id} value={v.id}>
                    {v.name}
                  </option>
                ))}
              </Select>
            </Field>
          ) : (
            <Field label="Entity / person id">
              <Input value={entityId} onChange={(e) => setEntityId(e.target.value)} />
            </Field>
          )}
        </div>
        <Field label="Name" required>
          <Input value={entityName} onChange={(e) => setEntityName(e.target.value)} required />
        </Field>
        <div className="grid gap-3 sm:grid-cols-3">
          <Field label="Home country (ISO-2)" required>
            <Input value={homeCountry} onChange={(e) => setHomeCountry(e.target.value)} maxLength={2} required />
          </Field>
          <Field label="Host country (ISO-2)" hint="Defaults to the regime's">
            <Input value={hostCountry} onChange={(e) => setHostCountry(e.target.value)} maxLength={2} />
          </Field>
          <Field label="Regime" hint={resolved && !regime ? `Project's (${resolved.toUpperCase()})` : undefined}>
            <Select value={regime} onChange={(e) => setRegime(e.target.value)}>
              <option value="">Project default</option>
              {(regimes.data?.items ?? []).map((r) => (
                <option key={r.regime} value={r.regime}>
                  {r.name}
                </option>
              ))}
            </Select>
          </Field>
        </div>
        <div className="grid gap-3 sm:grid-cols-2">
          <Field label="Threshold (days)" hint={defaultThreshold !== null ? `Regime default ${defaultThreshold}` : "No regime resolved — state it"}>
            <Input type="number" min={1} max={3650} value={thresholdDays} onChange={(e) => setThresholdDays(e.target.value)} placeholder={defaultThreshold !== null ? String(defaultThreshold) : ""} />
          </Field>
          <Field label="Window (months)" hint="0 = whole project life">
            <Input type="number" min={0} max={120} value={windowMonths} onChange={(e) => setWindowMonths(e.target.value)} placeholder={entityType === "person" ? "12" : "0"} />
          </Field>
        </div>
        <Field label="Threshold basis" hint="Required when the threshold departs from the regime default: the treaty article or law relied on" required={thresholdDays.trim() !== ""}>
          <Textarea value={thresholdBasis} onChange={(e) => setThresholdBasis(e.target.value)} rows={2} />
        </Field>
        <Field label="Notes">
          <Textarea value={notes} onChange={(e) => setNotes(e.target.value)} rows={2} />
        </Field>
      </form>
    </Drawer>
  );
}

/* ================================= Detail ================================= */

function ExposureDrawer({ projectId, exposureId, onClose, onChanged }: { projectId: string; exposureId: string | null; onClose: () => void; onChanged: () => void }) {
  const detail = useResource<ExposureDetail>(exposureId ? `/api/v1/projects/${projectId}/tax/pe-exposures/${exposureId}` : null);
  const action = useAction();
  const x = detail.data;
  const [startDate, setStartDate] = useState("");
  const [endDate, setEndDate] = useState("");
  const [purpose, setPurpose] = useState("");
  const [source, setSource] = useState<string>("manual");
  const [note, setNote] = useState("");
  const [thresholdDays, setThresholdDays] = useState("");
  const [thresholdBasis, setThresholdBasis] = useState("");

  useEffect(() => {
    setStartDate("");
    setEndDate("");
    setPurpose("");
    setSource("manual");
    setNote("");
    setThresholdDays("");
    setThresholdBasis("");
    action.clear();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [exposureId]);

  function done(message: string) {
    toast.success(message);
    detail.reload();
    onChanged();
  }

  async function addEntry(e: FormEvent) {
    e.preventDefault();
    if (!x) return;
    const body: Record<string, unknown> = { startDate, endDate, source };
    if (purpose.trim()) body["purpose"] = purpose.trim();
    const res = await action.run("entry", () => taxApi.addEntry(projectId, x.id, body));
    if (res) {
      setStartDate("");
      setEndDate("");
      setPurpose("");
      done(`${res.entry.days} day${res.entry.days === 1 ? "" : "s"} recorded — ${res.exposure.daysInWindow} in window, ${titleCase(res.exposure.status)}`);
    }
  }

  async function removeEntry(entryId: string) {
    if (!x) return;
    const res = await action.run(`del:${entryId}`, () => taxApi.deleteEntry(projectId, x.id, entryId));
    if (res) done(`Entry removed — ${res.daysInWindow} days in window`);
  }

  async function updateThreshold(e: FormEvent) {
    e.preventDefault();
    if (!x) return;
    const body: Record<string, unknown> = {};
    if (thresholdDays.trim() !== "") body["thresholdDays"] = Number(thresholdDays);
    if (thresholdBasis.trim()) body["thresholdBasis"] = thresholdBasis.trim();
    const res = await action.run("threshold", () => taxApi.patchExposure(projectId, x.id, body));
    if (res) done(`Threshold now ${res.thresholdDays} days — ${titleCase(res.status)}`);
  }

  async function mitigate() {
    if (!x || note.trim().length < 5) return;
    const res = await action.run("mitigate", () => taxApi.mitigate(projectId, x.id, note.trim()));
    if (res) done("Mitigation recorded; the count keeps running");
  }

  async function close() {
    if (!x || note.trim().length === 0) return;
    const res = await action.run("close", () => taxApi.closeExposure(projectId, x.id, note.trim()));
    if (res) done("Exposure closed");
  }

  const isClosed = x?.status === "closed";

  return (
    <Drawer
      open={exposureId !== null}
      onClose={onClose}
      size="lg"
      title={x ? `${x.entityName} in ${x.hostCountry}` : "Exposure"}
      description={x ? `${titleCase(x.entityType)} from ${x.homeCountry} · ${x.regime.toUpperCase()}` : undefined}
    >
      {detail.loading && !x ? <div className="text-meta text-content-subtle">Loading…</div> : null}
      {detail.error ? <LoadError message={detail.error} onRetry={detail.reload} /> : null}
      {x ? (
        <div className="space-y-5">
          {action.error ? <Alert tone="danger" size="sm">{action.error}</Alert> : null}
          <div className="rounded-md border border-border p-3">
            <div className="flex items-center justify-between gap-2">
              <Badge tone={exposureTone(x.status)} size="sm" dot>
                {titleCase(x.status)}
              </Badge>
              <span className="text-lg font-semibold tabular-nums">
                {x.daysInWindow} <span className="text-meta font-normal text-content-subtle">/ {x.thresholdDays} days</span>
              </span>
            </div>
            <Progress value={Math.min(x.daysInWindow, x.thresholdDays)} max={x.thresholdDays} size="sm" tone={exposureTone(x.status)} className="mt-2" showValue />
            <dl className="mt-3 divide-y divide-border">
              <Row label="Window">{x.windowMonths > 0 ? `rolling ${x.windowMonths} months` : "whole project life"}</Row>
              <Row label="Warns at">{pct(x.warnFraction * 100)} of the threshold</Row>
              <Row label="Days over all time">{count(x.daysTotal)}</Row>
              <Row label="Presence">
                {isoDate(x.firstPresenceDate)} → {isoDate(x.lastPresenceDate)}
              </Row>
              <Row label="Projected breach" hint="Linear run-rate over the window; a warning device, not a forecast">
                {x.projectedBreachDate ?? (x.status === "breached" ? "already crossed" : "not projectable yet")}
              </Row>
              <Row label="Last computed">{dateTime(x.lastComputedAt)}</Row>
            </dl>
            <p className="mt-2 text-2xs text-content-subtle">Basis: {x.thresholdBasis}</p>
            {x.mitigationNote ? (
              <Alert tone="info" size="sm" className="mt-2" title="Disposition">
                {x.mitigationNote}
              </Alert>
            ) : null}
          </div>

          <section className="space-y-2">
            <h3 className="text-sm font-semibold text-content">Presence entries</h3>
            {x.entries.length === 0 ? (
              <div className="text-meta text-content-subtle">No presence recorded yet.</div>
            ) : (
              <ul className="divide-y divide-border rounded-md border border-border">
                {x.entries.map((en) => (
                  <li key={en.id} className="flex items-center justify-between gap-2 px-3 py-1.5 text-meta">
                    <span className="tabular-nums">
                      {en.startDate} → {en.endDate}
                    </span>
                    <span className="text-content-subtle">
                      {en.days} d · {titleCase(en.source)}
                      {en.purpose ? ` · ${en.purpose}` : ""}
                    </span>
                    {!isClosed ? (
                      <Button size="xs" variant="ghost" icon={IconTrash} onClick={() => void removeEntry(en.id)} loading={action.busy === `del:${en.id}`} aria-label="Remove entry">
                        Remove
                      </Button>
                    ) : null}
                  </li>
                ))}
              </ul>
            )}
            {!isClosed ? (
              <form onSubmit={addEntry} className="grid items-end gap-2 sm:grid-cols-5">
                <Field label="From" required>
                  <Input type="date" value={startDate} onChange={(e) => setStartDate(e.target.value)} required size="sm" />
                </Field>
                <Field label="To" required>
                  <Input type="date" value={endDate} onChange={(e) => setEndDate(e.target.value)} required size="sm" />
                </Field>
                <Field label="Source">
                  <Select value={source} onChange={(e) => setSource(e.target.value)} size="sm">
                    {PRESENCE_SOURCES.map((s) => (
                      <option key={s} value={s}>
                        {titleCase(s)}
                      </option>
                    ))}
                  </Select>
                </Field>
                <Field label="Purpose">
                  <Input value={purpose} onChange={(e) => setPurpose(e.target.value)} size="sm" />
                </Field>
                <Button type="submit" size="sm" loading={action.busy === "entry"}>
                  Add days
                </Button>
              </form>
            ) : null}
          </section>

          {!isClosed ? (
            <>
              <form onSubmit={updateThreshold} className="space-y-2 rounded-md border border-border p-3">
                <h3 className="text-sm font-semibold text-content">Threshold</h3>
                <div className="grid gap-2 sm:grid-cols-3">
                  <Field label="Days">
                    <Input type="number" min={1} max={3650} value={thresholdDays} onChange={(e) => setThresholdDays(e.target.value)} placeholder={String(x.thresholdDays)} size="sm" />
                  </Field>
                  <Field label="Basis" required className="sm:col-span-2" hint="A changed threshold needs the treaty or law relied on">
                    <Input value={thresholdBasis} onChange={(e) => setThresholdBasis(e.target.value)} size="sm" />
                  </Field>
                </div>
                <Button type="submit" size="sm" variant="secondary" disabled={thresholdDays.trim() === "" && thresholdBasis.trim() === ""} loading={action.busy === "threshold"}>
                  Update threshold
                </Button>
              </form>

              <section className="space-y-2 rounded-md border border-border p-3">
                <h3 className="text-sm font-semibold text-content">Disposition</h3>
                <Field label="Note / reason" required>
                  <Textarea value={note} onChange={(e) => setNote(e.target.value)} rows={2} />
                </Field>
                <div className="flex gap-2">
                  <Button size="sm" variant="secondary" onClick={() => void mitigate()} disabled={note.trim().length < 5} loading={action.busy === "mitigate"}>
                    Record mitigation
                  </Button>
                  <Button size="sm" variant="danger" onClick={() => void close()} disabled={note.trim().length === 0} loading={action.busy === "close"}>
                    Close exposure
                  </Button>
                </div>
                <p className="text-2xs text-content-subtle">A mitigated exposure keeps counting; if it actually breaches it is shown as breached again. {DASH} A closed exposure accepts no further entries.</p>
              </section>
            </>
          ) : null}
        </div>
      ) : null}
    </Drawer>
  );
}
