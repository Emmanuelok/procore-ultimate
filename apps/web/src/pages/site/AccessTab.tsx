/**
 * SITE ACCESS — the live on-site register, inductions, passes, the gate feed
 * and musters (#1067–1069).
 *
 * The register is the fold of the gate feed and says WHY it is empty when it
 * is. A muster shows three named lists — present, unaccounted, unexpected —
 * because a headcount that is only a number tells nobody where to look.
 */
import { useMemo, useState, type FormEvent } from "react";
import { toast } from "sonner";
import { Badge, Button, Card, CardBody, Drawer, EmptyState, Field, Input, Select, Textarea } from "../../ui";
import { DataTable, type DataColumns } from "../../ui/data";
import { IconPlus, IconUsers } from "../../ui/icons";
import { api } from "../../lib/api";
import {
  EM_DASH,
  INDUCTION_STATUS_TONE,
  KeyValue,
  LoadError,
  PASS_STATUS_TONE,
  ReasonList,
  RefusalNotice,
  SectionHeading,
  dateTime,
  isoDate,
  labelize,
  minutesLabel,
  num,
  optionList,
  relativeToNow,
  useAction,
  useResource,
  type GateEventRow,
  type InductionRow,
  type ListResponse,
  type MusterDetail,
  type MusterRow,
  type PassRow,
  type RegisterPerson,
  type RegisterResponse,
  type SiteLookups,
} from "./siteShared";

type Panel = "register" | "inductions" | "passes" | "feed" | "musters";

const PANELS: Array<{ value: Panel; label: string }> = [
  { value: "register", label: "On site now" },
  { value: "inductions", label: "Inductions" },
  { value: "passes", label: "Passes" },
  { value: "feed", label: "Gate feed" },
  { value: "musters", label: "Musters" },
];

export default function AccessTab({
  projectId,
  lookups,
  onChanged,
}: {
  projectId: string;
  lookups: SiteLookups;
  onChanged: () => void;
}) {
  const [panel, setPanel] = useState<Panel>("register");
  const base = `/api/v1/projects/${projectId}/site`;

  return (
    <div className="space-y-4">
      <div className="flex flex-wrap gap-1.5">
        {PANELS.map((p) => (
          <Button key={p.value} size="xs" variant={panel === p.value ? "secondary" : "ghost"} onClick={() => setPanel(p.value)}>
            {p.label}
          </Button>
        ))}
      </div>
      {panel === "register" ? <RegisterPanel base={base} /> : null}
      {panel === "inductions" ? <InductionsPanel base={base} lookups={lookups} onChanged={onChanged} /> : null}
      {panel === "passes" ? <PassesPanel base={base} lookups={lookups} onChanged={onChanged} /> : null}
      {panel === "feed" ? <FeedPanel base={base} onChanged={onChanged} /> : null}
      {panel === "musters" ? <MustersPanel base={base} onChanged={onChanged} /> : null}
    </div>
  );
}

/* ------------------------------------------------------------------ */
/* Register                                                            */
/* ------------------------------------------------------------------ */

function RegisterPanel({ base }: { base: string }) {
  const [asOf, setAsOf] = useState("");
  const path = asOf ? `${base}/register?asOf=${encodeURIComponent(new Date(asOf).toISOString())}` : `${base}/register`;
  const register = useResource<RegisterResponse>(path);
  const r = register.data;

  const columns = useMemo<DataColumns<RegisterPerson>>(
    () => [
      { id: "personName", header: "Person", accessor: "personName", type: "text", sticky: "start", width: 220 },
      { id: "personKind", header: "Kind", accessor: (row) => row.personKind ?? "", type: "status", width: 120, groupable: true, cell: ({ row }) => labelize(row.personKind) },
      { id: "sinceAt", header: "In since", accessor: (row) => row.sinceAt ?? "", type: "datetime", width: 170, cell: ({ row }) => dateTime(row.sinceAt) },
      { id: "openMinutes", header: "On site", accessor: (row) => row.openMinutes ?? 0, type: "number", width: 110, cell: ({ row }) => minutesLabel(row.openMinutes) },
      { id: "lastGate", header: "Last gate", accessor: (row) => row.lastGate ?? "", type: "text", width: 120 },
      { id: "refusals", header: "Refused reads", accessor: "refusals", type: "number", width: 120 },
      {
        id: "anomalies",
        header: "Anomalies",
        accessor: (row) => row.anomalies.join(" "),
        type: "text",
        width: 420,
        cell: ({ row }) =>
          row.anomalies.length === 0 ? <span className="italic text-content-subtle">none</span> : <ReasonList reasons={row.anomalies} tone="danger" />,
      },
    ],
    [],
  );

  return (
    <div className="space-y-3">
      {register.error ? <LoadError message={register.error} onRetry={register.reload} /> : null}
      <div className="grid grid-cols-2 gap-3 md:grid-cols-4">
        <Card>
          <CardBody>
            <div className="text-label uppercase text-content-subtle">Headcount</div>
            <div className="text-display-xs font-semibold tabular-nums text-content">{r ? num(r.headcount) : EM_DASH}</div>
          </CardBody>
        </Card>
        <Card>
          <CardBody>
            <div className="text-label uppercase text-content-subtle">Overstays</div>
            <div className={`text-display-xs font-semibold tabular-nums ${(r?.overstays.length ?? 0) > 0 ? "text-warning-fg" : "text-content"}`}>
              {r ? num(r.overstays.length) : EM_DASH}
            </div>
          </CardBody>
        </Card>
        <Card>
          <CardBody>
            <div className="text-label uppercase text-content-subtle">Refused reads</div>
            <div className="text-display-xs font-semibold tabular-nums text-content">{r ? num(r.refusedEvents) : EM_DASH}</div>
          </CardBody>
        </Card>
        <Card>
          <CardBody>
            <div className="text-label uppercase text-content-subtle">Feed anomalies</div>
            <div className="text-display-xs font-semibold tabular-nums text-content">{r ? num(r.anomalyCount) : EM_DASH}</div>
          </CardBody>
        </Card>
      </div>

      <Card>
        <CardBody>
          <SectionHeading
            title="Who is on site"
            hint={
              r
                ? `Folded from ${num(r.eventsConsidered)} gate read(s) between ${dateTime(r.windowFrom)} and ${dateTime(r.windowTo)}. An entry with no exit is held open, never closed by guesswork.`
                : "Reading the gate feed…"
            }
            actions={
              <div className="flex items-end gap-2">
                <Field label="As at">
                  <Input type="datetime-local" value={asOf} onChange={(e) => setAsOf(e.target.value)} />
                </Field>
                {asOf ? (
                  <Button size="sm" variant="ghost" onClick={() => setAsOf("")}>
                    Now
                  </Button>
                ) : null}
              </div>
            }
          />
          <ReasonList reasons={r?.reasons ?? []} className="mb-3" />
          {(r?.onSite.length ?? 0) === 0 && !register.loading ? (
            <EmptyState
              icon={IconUsers}
              title="Nobody is on the register"
              description={
                r?.reasons[0] ??
                "No open entry is held for this moment. If people are on site, the gate feed is not reaching the platform."
              }
            />
          ) : (
            <DataTable
              data={r?.onSite ?? []}
              columns={columns}
              getRowId={(row) => row.personKey}
              loading={register.loading && !r}
              height={420}
              stickyHeader
              exportFileName="on-site-register"
              rowTone={(row) => ((row.openMinutes ?? 0) >= 16 * 60 ? "warning" : undefined)}
            />
          )}
        </CardBody>
      </Card>

      {(r?.overstays.length ?? 0) > 0 ? (
        <Card>
          <CardBody>
            <SectionHeading
              title="Overstays"
              hint="An entry with no exit, more than sixteen hours old. Either the person is still here or an exit read was missed — the platform does not invent it."
            />
            <ul className="space-y-1.5 text-meta">
              {(r?.overstays ?? []).map((p) => (
                <li key={p.personKey} className="flex items-center justify-between gap-3">
                  <span className="text-content">{p.personName}</span>
                  <span className="tabular-nums text-content-muted">
                    in since {dateTime(p.sinceAt)} · {minutesLabel(p.openMinutes)}
                  </span>
                </li>
              ))}
            </ul>
          </CardBody>
        </Card>
      ) : null}
    </div>
  );
}

/* ------------------------------------------------------------------ */
/* Inductions                                                          */
/* ------------------------------------------------------------------ */

function InductionsPanel({ base, lookups, onChanged }: { base: string; lookups: SiteLookups; onChanged: () => void }) {
  const list = useResource<ListResponse<InductionRow>>(`${base}/inductions?pageSize=200`);
  const action = useAction();
  const [open, setOpen] = useState(false);

  const columns = useMemo<DataColumns<InductionRow>>(
    () => [
      { id: "personName", header: "Person", accessor: "personName", type: "text", sticky: "start", width: 220 },
      { id: "inductionType", header: "Type", accessor: "inductionType", type: "status", width: 140, groupable: true, cell: ({ row }) => labelize(row.inductionType) },
      {
        id: "status",
        header: "Status",
        accessor: "status",
        type: "status",
        width: 120,
        groupable: true,
        cell: ({ row }) => (
          <Badge tone={INDUCTION_STATUS_TONE[row.status] ?? "neutral"} size="xs" dot>
            {labelize(row.status)}
          </Badge>
        ),
      },
      { id: "conductedAt", header: "Conducted", accessor: (row) => row.conductedAt ?? "", type: "datetime", width: 170, cell: ({ row }) => dateTime(row.conductedAt) },
      { id: "validUntil", header: "Valid until", accessor: (row) => row.validUntil ?? "", type: "date", width: 130, cell: ({ row }) => isoDate(row.validUntil) },
      {
        id: "score",
        header: "Score",
        accessor: (row) => row.scorePercent ?? 0,
        type: "number",
        width: 110,
        cell: ({ row }) => (row.scorePercent === null ? <span className="italic text-content-subtle">not scored</span> : `${num(row.scorePercent)}%`),
      },
      { id: "topics", header: "Topics", accessor: (row) => row.topics.join(", "), type: "text", width: 320 },
      { id: "revokeReason", header: "Revoked because", accessor: (row) => row.revokeReason ?? "", type: "text", width: 280 },
    ],
    [],
  );

  async function revoke(row: InductionRow) {
    const reason = window.prompt(`Why is ${row.personName}'s induction being revoked?`);
    if (!reason) return;
    const r = await action.run("revoke", () => api.post<{ passesSuspended: number }>(`${base}/inductions/${row.id}/revoke`, { reason }));
    if (r) {
      toast.success(r.passesSuspended > 0 ? `Revoked; ${r.passesSuspended} pass(es) suspended` : "Induction revoked");
      list.reload();
      onChanged();
    }
  }

  return (
    <Card>
      <CardBody>
        {action.refusal ? <RefusalNotice refusal={action.refusal} onDismiss={action.clear} /> : null}
        <SectionHeading
          title="Inductions"
          hint="The record that a named person was told this site's rules, by whom, and for how long that lasts. A pass may not be issued against an induction that is not in force."
          actions={
            <Button size="sm" icon={IconPlus} onClick={() => setOpen(true)}>
              Record an induction
            </Button>
          }
        />
        {list.error ? <LoadError message={list.error} onRetry={list.reload} /> : null}
        <DataTable
          data={list.data?.items ?? []}
          columns={columns}
          getRowId={(row) => row.id}
          loading={list.loading && !list.data}
          height={480}
          stickyHeader
          filterRow
          exportFileName="site-inductions"
          searchPlaceholder="Search by name…"
          rowActions={({ row }) =>
            row.status === "revoked" ? null : (
              <Button size="xs" variant="ghost" onClick={() => void revoke(row)}>
                Revoke
              </Button>
            )
          }
          empty={{
            title: "No inductions recorded",
            description: "Nobody on this site has an induction on the platform. Record them here so every pass has something behind it.",
            action: (
              <Button size="sm" onClick={() => setOpen(true)}>
                Record the first induction
              </Button>
            ),
          }}
        />
        <InductionForm
          base={base}
          lookups={lookups}
          open={open}
          onClose={() => setOpen(false)}
          onCreated={() => {
            setOpen(false);
            list.reload();
            onChanged();
          }}
        />
      </CardBody>
    </Card>
  );
}

function InductionForm({
  base,
  lookups,
  open,
  onClose,
  onCreated,
}: {
  base: string;
  lookups: SiteLookups;
  open: boolean;
  onClose: () => void;
  onCreated: () => void;
}) {
  const action = useAction();
  const [personName, setPersonName] = useState("");
  const [personKind, setPersonKind] = useState("worker");
  const [workerId, setWorkerId] = useState("");
  const [vendorId, setVendorId] = useState("");
  const [inductionType, setInductionType] = useState("general");
  const [validUntil, setValidUntil] = useState("");
  const [topics, setTopics] = useState("Fire and evacuation\nTraffic management\nPermits to work");
  const [scorePercent, setScorePercent] = useState("");
  const [passMark, setPassMark] = useState("");

  async function submit(e: FormEvent) {
    e.preventDefault();
    const payload: Record<string, unknown> = {
      personName: personName.trim(),
      personKind,
      inductionType,
      topics: topics.split("\n").map((t) => t.trim()).filter(Boolean),
    };
    if (workerId) payload["workerId"] = workerId;
    if (vendorId) payload["vendorId"] = vendorId;
    if (validUntil) payload["validUntil"] = validUntil;
    if (scorePercent.trim()) payload["scorePercent"] = Number(scorePercent);
    if (passMark.trim()) payload["passMark"] = Number(passMark);
    const r = await action.run("create", () => api.post<InductionRow>(`${base}/inductions`, payload));
    if (r) {
      toast.success(r.status === "valid" ? `${r.personName} inducted` : `${r.personName} recorded as ${labelize(r.status)}`);
      setPersonName("");
      onCreated();
    }
  }

  return (
    <Drawer open={open} onClose={onClose} title="Record an induction" description="A score below the pass mark is recorded as failed, not as valid." size="md">
      <form onSubmit={(e) => void submit(e)} className="space-y-3">
        {action.refusal ? <RefusalNotice refusal={action.refusal} onDismiss={action.clear} /> : null}
        <ReasonList reasons={lookups.notes} />
        <Field label="Person" required>
          <Input value={personName} onChange={(e) => setPersonName(e.target.value)} required maxLength={200} />
        </Field>
        <div className="grid grid-cols-2 gap-3">
          <Field label="Kind">
            <Select value={personKind} onChange={(e) => setPersonKind(e.target.value)}>
              {["worker", "staff", "visitor", "subcontractor", "delivery_driver", "inspector", "client", "other"].map((k) => (
                <option key={k} value={k}>
                  {labelize(k)}
                </option>
              ))}
            </Select>
          </Field>
          <Field label="Induction type">
            <Select value={inductionType} onChange={(e) => setInductionType(e.target.value)}>
              {["general", "task_specific", "visitor", "refresher", "contractor", "plant_operator"].map((k) => (
                <option key={k} value={k}>
                  {labelize(k)}
                </option>
              ))}
            </Select>
          </Field>
          <Field label="Worker on the labour register" hint="Links this induction to the workforce record.">
            <Select value={workerId} onChange={(e) => setWorkerId(e.target.value)}>
              {optionList(lookups.workers, (w) => `${w.reference} — ${w.fullName}`).map((o) => (
                <option key={o.value} value={o.value}>
                  {o.label}
                </option>
              ))}
            </Select>
          </Field>
          <Field label="Employer">
            <Select value={vendorId} onChange={(e) => setVendorId(e.target.value)}>
              {optionList(lookups.vendors, (v) => v.name).map((o) => (
                <option key={o.value} value={o.value}>
                  {o.label}
                </option>
              ))}
            </Select>
          </Field>
          <Field label="Valid until">
            <Input type="date" value={validUntil} onChange={(e) => setValidUntil(e.target.value)} />
          </Field>
          <Field label="Score %">
            <Input type="number" min={0} max={100} value={scorePercent} onChange={(e) => setScorePercent(e.target.value)} />
          </Field>
          <Field label="Pass mark %">
            <Input type="number" min={0} max={100} value={passMark} onChange={(e) => setPassMark(e.target.value)} />
          </Field>
        </div>
        <Field label="Topics covered" hint="One per line.">
          <Textarea rows={4} value={topics} onChange={(e) => setTopics(e.target.value)} />
        </Field>
        <div className="flex justify-end gap-2">
          <Button type="button" variant="ghost" onClick={onClose}>
            Cancel
          </Button>
          <Button type="submit" loading={action.busy === "create"}>
            Record
          </Button>
        </div>
      </form>
    </Drawer>
  );
}

/* ------------------------------------------------------------------ */
/* Passes                                                              */
/* ------------------------------------------------------------------ */

function PassesPanel({ base, lookups, onChanged }: { base: string; lookups: SiteLookups; onChanged: () => void }) {
  const list = useResource<ListResponse<PassRow>>(`${base}/passes?pageSize=200`);
  const inductions = useResource<ListResponse<InductionRow>>(`${base}/inductions?status=valid&pageSize=200`);
  const action = useAction();
  const [open, setOpen] = useState(false);

  const columns = useMemo<DataColumns<PassRow>>(
    () => [
      { id: "badgeCode", header: "Badge", accessor: "badgeCode", type: "text", sticky: "start", width: 140 },
      { id: "personName", header: "Person", accessor: "personName", type: "text", width: 220 },
      {
        id: "status",
        header: "Status",
        accessor: "status",
        type: "status",
        width: 120,
        groupable: true,
        cell: ({ row }) => (
          <Badge tone={PASS_STATUS_TONE[row.status] ?? "neutral"} size="xs" dot>
            {labelize(row.status)}
          </Badge>
        ),
      },
      { id: "credentialType", header: "Credential", accessor: "credentialType", type: "status", width: 130, groupable: true, cell: ({ row }) => labelize(row.credentialType) },
      {
        id: "inductionId",
        header: "Induction",
        accessor: (row) => row.inductionId ?? "",
        type: "text",
        width: 160,
        cell: ({ row }) =>
          row.inductionId ? (
            <Badge tone="success" size="xs">
              linked
            </Badge>
          ) : (
            <Badge tone="danger" size="xs">
              none
            </Badge>
          ),
      },
      { id: "validUntil", header: "Valid until", accessor: (row) => row.validUntil ?? "", type: "date", width: 130, cell: ({ row }) => isoDate(row.validUntil) },
      { id: "revokeReason", header: "Revoked because", accessor: (row) => row.revokeReason ?? "", type: "text", width: 280 },
    ],
    [],
  );

  async function transition(row: PassRow, verb: "suspend" | "reinstate" | "revoke") {
    const reason = verb === "revoke" ? window.prompt(`Why is ${row.personName}'s pass being revoked?`) : undefined;
    if (verb === "revoke" && !reason) return;
    const r = await action.run(verb, () => api.post<PassRow>(`${base}/passes/${row.id}/${verb}`, reason ? { reason } : {}));
    if (r) {
      toast.success(`Pass ${labelize(r.status).toLowerCase()}`);
      list.reload();
      onChanged();
    }
  }

  return (
    <Card>
      <CardBody>
        {action.refusal ? <RefusalNotice refusal={action.refusal} onDismiss={action.clear} /> : null}
        <SectionHeading
          title="Site passes"
          hint="One badge, one person: a duplicate badge on a project is refused, because two people on one credential makes the register a fiction."
          actions={
            <Button size="sm" icon={IconPlus} onClick={() => setOpen(true)}>
              Issue a pass
            </Button>
          }
        />
        {list.error ? <LoadError message={list.error} onRetry={list.reload} /> : null}
        <DataTable
          data={list.data?.items ?? []}
          columns={columns}
          getRowId={(row) => row.id}
          loading={list.loading && !list.data}
          height={480}
          stickyHeader
          filterRow
          exportFileName="site-passes"
          searchPlaceholder="Search by badge or name…"
          rowTone={(row) => (row.inductionId === null && row.status === "active" ? "danger" : undefined)}
          rowActions={({ row }) => (
            <span className="flex gap-1">
              {row.status === "active" ? (
                <Button size="xs" variant="ghost" onClick={() => void transition(row, "suspend")}>
                  Suspend
                </Button>
              ) : null}
              {row.status === "suspended" ? (
                <Button size="xs" variant="ghost" onClick={() => void transition(row, "reinstate")}>
                  Reinstate
                </Button>
              ) : null}
              {row.status !== "revoked" ? (
                <Button size="xs" variant="ghost" onClick={() => void transition(row, "revoke")}>
                  Revoke
                </Button>
              ) : null}
            </span>
          )}
          empty={{
            title: "No passes issued",
            description: "Issue a pass against a valid induction so the gate feed can resolve a badge to a person.",
            action: (
              <Button size="sm" onClick={() => setOpen(true)}>
                Issue the first pass
              </Button>
            ),
          }}
        />
        <PassForm
          base={base}
          lookups={lookups}
          inductions={inductions.data?.items ?? []}
          open={open}
          onClose={() => setOpen(false)}
          onCreated={() => {
            setOpen(false);
            list.reload();
            onChanged();
          }}
        />
      </CardBody>
    </Card>
  );
}

function PassForm({
  base,
  lookups,
  inductions,
  open,
  onClose,
  onCreated,
}: {
  base: string;
  lookups: SiteLookups;
  inductions: InductionRow[];
  open: boolean;
  onClose: () => void;
  onCreated: () => void;
}) {
  const action = useAction();
  const [inductionId, setInductionId] = useState("");
  const [personName, setPersonName] = useState("");
  const [badgeCode, setBadgeCode] = useState("");
  const [credentialType, setCredentialType] = useState("badge");
  const [vendorId, setVendorId] = useState("");
  const [validUntil, setValidUntil] = useState("");

  async function submit(e: FormEvent) {
    e.preventDefault();
    const payload: Record<string, unknown> = { personName: personName.trim(), badgeCode: badgeCode.trim(), credentialType };
    if (inductionId) payload["inductionId"] = inductionId;
    if (vendorId) payload["vendorId"] = vendorId;
    if (validUntil) payload["validUntil"] = validUntil;
    const r = await action.run("create", () => api.post<PassRow>(`${base}/passes`, payload));
    if (r) {
      toast.success(`Badge ${r.badgeCode} issued to ${r.personName}`);
      setBadgeCode("");
      setPersonName("");
      onCreated();
    }
  }

  return (
    <Drawer open={open} onClose={onClose} title="Issue a site pass" description="A pass issued without a valid induction behind it is flagged by the credentials sweep." size="md">
      <form onSubmit={(e) => void submit(e)} className="space-y-3">
        {action.refusal ? <RefusalNotice refusal={action.refusal} onDismiss={action.clear} /> : null}
        <Field label="Induction" hint="Only inductions currently in force are listed.">
          <Select
            value={inductionId}
            onChange={(e) => {
              setInductionId(e.target.value);
              const found = inductions.find((i) => i.id === e.target.value);
              if (found && !personName) setPersonName(found.personName);
            }}
          >
            {optionList(inductions, (i) => `${i.personName} — ${labelize(i.inductionType)}`).map((o) => (
              <option key={o.value} value={o.value}>
                {o.label}
              </option>
            ))}
          </Select>
        </Field>
        <div className="grid grid-cols-2 gap-3">
          <Field label="Person" required>
            <Input value={personName} onChange={(e) => setPersonName(e.target.value)} required maxLength={200} />
          </Field>
          <Field label="Badge code" required>
            <Input value={badgeCode} onChange={(e) => setBadgeCode(e.target.value)} required maxLength={64} />
          </Field>
          <Field label="Credential">
            <Select value={credentialType} onChange={(e) => setCredentialType(e.target.value)}>
              {["badge", "biometric", "qr", "vehicle_plate", "mobile"].map((k) => (
                <option key={k} value={k}>
                  {labelize(k)}
                </option>
              ))}
            </Select>
          </Field>
          <Field label="Employer">
            <Select value={vendorId} onChange={(e) => setVendorId(e.target.value)}>
              {optionList(lookups.vendors, (v) => v.name).map((o) => (
                <option key={o.value} value={o.value}>
                  {o.label}
                </option>
              ))}
            </Select>
          </Field>
          <Field label="Valid until">
            <Input type="date" value={validUntil} onChange={(e) => setValidUntil(e.target.value)} />
          </Field>
        </div>
        <div className="flex justify-end gap-2">
          <Button type="button" variant="ghost" onClick={onClose}>
            Cancel
          </Button>
          <Button type="submit" loading={action.busy === "create"}>
            Issue
          </Button>
        </div>
      </form>
    </Drawer>
  );
}

/* ------------------------------------------------------------------ */
/* Gate feed                                                           */
/* ------------------------------------------------------------------ */

function FeedPanel({ base, onChanged }: { base: string; onChanged: () => void }) {
  const [acceptedOnly, setAcceptedOnly] = useState<"all" | "1" | "0">("all");
  const query = acceptedOnly === "all" ? "" : `&accepted=${acceptedOnly}`;
  const list = useResource<ListResponse<GateEventRow>>(`${base}/gate-events?pageSize=200${query}`);
  const action = useAction();
  const [open, setOpen] = useState(false);

  const columns = useMemo<DataColumns<GateEventRow>>(
    () => [
      { id: "occurredAt", header: "At", accessor: "occurredAt", type: "datetime", sticky: "start", width: 175, cell: ({ row }) => dateTime(row.occurredAt) },
      {
        id: "direction",
        header: "Direction",
        accessor: "direction",
        type: "status",
        width: 110,
        groupable: true,
        cell: ({ row }) => (
          <Badge tone={row.direction === "in" ? "info" : "neutral"} size="xs">
            {row.direction === "in" ? "In" : "Out"}
          </Badge>
        ),
      },
      { id: "personName", header: "Person", accessor: (row) => row.personName ?? "", type: "text", width: 200 },
      { id: "badgeCode", header: "Badge", accessor: (row) => row.badgeCode ?? "", type: "text", width: 130 },
      { id: "gateName", header: "Gate", accessor: "gateName", type: "text", width: 120, groupable: true },
      { id: "source", header: "Source", accessor: "source", type: "status", width: 120, groupable: true, cell: ({ row }) => labelize(row.source) },
      {
        id: "accepted",
        header: "Outcome",
        accessor: (row) => (row.accepted === 1 ? "accepted" : "refused"),
        type: "status",
        width: 200,
        groupable: true,
        cell: ({ row }) =>
          row.accepted === 1 ? (
            <Badge tone="success" size="xs">
              Accepted
            </Badge>
          ) : (
            <Badge tone="danger" size="xs" title={row.refusalReason ?? undefined}>
              Refused — {labelize(row.refusalReason)}
            </Badge>
          ),
      },
      { id: "externalRef", header: "Device ref", accessor: (row) => row.externalRef ?? "", type: "text", width: 160 },
    ],
    [],
  );

  return (
    <Card>
      <CardBody>
        {action.refusal ? <RefusalNotice refusal={action.refusal} onDismiss={action.clear} /> : null}
        <SectionHeading
          title="Gate feed"
          hint="Machine reads from the turnstiles, kept exactly as they arrived. A read the reader should not have accepted is stored as refused with the reason, never discarded — a refused read at 03:00 is the record an investigation needs."
          actions={
            <div className="flex items-end gap-2">
              <Field label="Show">
                <Select value={acceptedOnly} onChange={(e) => setAcceptedOnly(e.target.value as "all" | "1" | "0")}>
                  <option value="all">All reads</option>
                  <option value="1">Accepted only</option>
                  <option value="0">Refused only</option>
                </Select>
              </Field>
              <Button size="sm" icon={IconPlus} onClick={() => setOpen(true)}>
                Record a read
              </Button>
            </div>
          }
        />
        {list.error ? <LoadError message={list.error} onRetry={list.reload} /> : null}
        <DataTable
          data={list.data?.items ?? []}
          columns={columns}
          getRowId={(row) => row.id}
          loading={list.loading && !list.data}
          height={480}
          stickyHeader
          filterRow
          exportFileName="gate-events"
          rowTone={(row) => (row.accepted === 0 ? "danger" : undefined)}
          empty={{
            title: "The gate feed is empty",
            description:
              "No reader has posted to POST /projects/:projectId/site/gate-events. Until it does, the on-site register cannot be derived and a muster has nothing to reconcile against.",
          }}
        />
        <GateEventForm
          base={base}
          open={open}
          onClose={() => setOpen(false)}
          onCreated={() => {
            setOpen(false);
            list.reload();
            onChanged();
          }}
        />
      </CardBody>
    </Card>
  );
}

function GateEventForm({ base, open, onClose, onCreated }: { base: string; open: boolean; onClose: () => void; onCreated: () => void }) {
  const action = useAction();
  const [badgeCode, setBadgeCode] = useState("");
  const [direction, setDirection] = useState("in");
  const [occurredAt, setOccurredAt] = useState("");
  const [gateName, setGateName] = useState("main");

  async function submit(e: FormEvent) {
    e.preventDefault();
    const payload = {
      badgeCode: badgeCode.trim(),
      direction,
      gateName: gateName.trim() || "main",
      source: "manual",
      occurredAt: occurredAt ? new Date(occurredAt).toISOString() : new Date().toISOString(),
    };
    const r = await action.run("create", () =>
      api.post<{ accepted: number; refused: number; notes: string[] }>(`${base}/gate-events`, payload),
    );
    if (r) {
      toast.success(r.accepted > 0 ? "Read recorded" : `Read stored as refused${r.notes[0] ? ` — ${r.notes[0]}` : ""}`);
      setBadgeCode("");
      onCreated();
    }
  }

  return (
    <Drawer
      open={open}
      onClose={onClose}
      title="Record a gate read"
      description="For a reader that is offline or a manual gate. Manual reads carry a weaker source than a turnstile and the register says so."
      size="sm"
    >
      <form onSubmit={(e) => void submit(e)} className="space-y-3">
        {action.refusal ? <RefusalNotice refusal={action.refusal} onDismiss={action.clear} /> : null}
        <Field label="Badge code" required>
          <Input value={badgeCode} onChange={(e) => setBadgeCode(e.target.value)} required maxLength={64} />
        </Field>
        <Field label="Direction">
          <Select value={direction} onChange={(e) => setDirection(e.target.value)}>
            <option value="in">In</option>
            <option value="out">Out</option>
          </Select>
        </Field>
        <Field label="Gate">
          <Input value={gateName} onChange={(e) => setGateName(e.target.value)} maxLength={120} />
        </Field>
        <Field label="At" hint="Defaults to now.">
          <Input type="datetime-local" value={occurredAt} onChange={(e) => setOccurredAt(e.target.value)} />
        </Field>
        <div className="flex justify-end gap-2">
          <Button type="button" variant="ghost" onClick={onClose}>
            Cancel
          </Button>
          <Button type="submit" loading={action.busy === "create"}>
            Record
          </Button>
        </div>
      </form>
    </Drawer>
  );
}

/* ------------------------------------------------------------------ */
/* Musters                                                             */
/* ------------------------------------------------------------------ */

function MustersPanel({ base, onChanged }: { base: string; onChanged: () => void }) {
  const list = useResource<ListResponse<MusterRow>>(`${base}/musters?pageSize=100`);
  const action = useAction();
  const [openId, setOpenId] = useState<string | null>(null);
  const detail = useResource<MusterDetail>(openId ? `${base}/musters/${openId}` : null);

  const columns = useMemo<DataColumns<MusterRow>>(
    () => [
      { id: "reference", header: "Ref", accessor: "reference", type: "text", sticky: "start", width: 110 },
      { id: "kind", header: "Kind", accessor: "kind", type: "status", width: 120, groupable: true, cell: ({ row }) => labelize(row.kind) },
      { id: "declaredAt", header: "Declared", accessor: "declaredAt", type: "datetime", width: 175, cell: ({ row }) => dateTime(row.declaredAt) },
      { id: "expectedCount", header: "On register", accessor: "expectedCount", type: "number", width: 110 },
      { id: "accountedCount", header: "Accounted", accessor: "accountedCount", type: "number", width: 110 },
      {
        id: "unaccountedCount",
        header: "Unaccounted",
        accessor: "unaccountedCount",
        type: "number",
        width: 120,
        cell: ({ row }) => (
          <span className={row.unaccountedCount > 0 ? "font-semibold text-danger-fg tabular-nums" : "tabular-nums"}>{num(row.unaccountedCount)}</span>
        ),
      },
      { id: "unexpectedCount", header: "Unexpected", accessor: "unexpectedCount", type: "number", width: 110 },
      {
        id: "durationSeconds",
        header: "Time to clear",
        accessor: (row) => row.durationSeconds ?? 0,
        type: "number",
        width: 130,
        cell: ({ row }) => (row.durationSeconds === null ? <span className="italic text-content-subtle">no check-ins</span> : `${num(row.durationSeconds)} s`),
      },
      { id: "status", header: "Status", accessor: "status", type: "status", width: 120, groupable: true, cell: ({ row }) => labelize(row.status) },
    ],
    [],
  );

  async function declare(kind: string) {
    const r = await action.run("declare", () => api.post<MusterRow & { registerReasons: string[] }>(`${base}/musters`, { kind }));
    if (r) {
      toast.success(`${r.reference} declared — ${r.expectedCount} person(s) on the register`);
      list.reload();
      setOpenId(r.id);
      onChanged();
    }
  }

  return (
    <div className="space-y-3">
      {action.refusal ? <RefusalNotice refusal={action.refusal} onDismiss={action.clear} /> : null}
      <Card>
        <CardBody>
          <SectionHeading
            title="Musters"
            hint="Declaring a muster snapshots the on-site register at that instant. Later gate reads never change who the muster was looking for."
            actions={
              <span className="flex gap-2">
                <Button size="sm" variant="secondary" loading={action.busy === "declare"} onClick={() => void declare("drill")}>
                  Declare a drill
                </Button>
                <Button size="sm" variant="danger" loading={action.busy === "declare"} onClick={() => void declare("emergency")}>
                  Declare an emergency
                </Button>
              </span>
            }
          />
          {list.error ? <LoadError message={list.error} onRetry={list.reload} /> : null}
          <DataTable
            data={list.data?.items ?? []}
            columns={columns}
            getRowId={(row) => row.id}
            loading={list.loading && !list.data}
            height={380}
            stickyHeader
            exportFileName="site-musters"
            onRowClick={({ row }) => setOpenId(row.id)}
            rowTone={(row) => (row.unaccountedCount > 0 ? "danger" : undefined)}
            empty={{
              title: "No musters",
              description: "Declare a drill to test whether the register and the muster point agree before an emergency does it for you.",
            }}
          />
        </CardBody>
      </Card>

      <MusterDrawer
        base={base}
        musterId={openId}
        detail={detail}
        onClose={() => setOpenId(null)}
        onChanged={() => {
          detail.reload();
          list.reload();
          onChanged();
        }}
      />
    </div>
  );
}

function MusterDrawer({
  base,
  musterId,
  detail,
  onClose,
  onChanged,
}: {
  base: string;
  musterId: string | null;
  detail: ReturnType<typeof useResource<MusterDetail>>;
  onClose: () => void;
  onChanged: () => void;
}) {
  const action = useAction();
  const [extraName, setExtraName] = useState("");
  const m = detail.data;

  async function checkIn(personKey: string, personName: string, status: string) {
    const r = await action.run("checkin", () =>
      api.post<{ reconciliation: { unaccountedCount: number; clear: boolean } }>(`${base}/musters/${musterId}/checkins`, {
        checkins: [{ personKey, personName, status }],
      }),
    );
    if (r) {
      toast.success(r.reconciliation.clear ? "Muster clear" : `${r.reconciliation.unaccountedCount} still unaccounted for`);
      onChanged();
    }
  }

  async function addUnexpected(e: FormEvent) {
    e.preventDefault();
    if (!extraName.trim()) return;
    const r = await action.run("checkin", () =>
      api.post<unknown>(`${base}/musters/${musterId}/checkins`, {
        checkins: [{ personName: extraName.trim(), status: "present" }],
      }),
    );
    if (r) {
      setExtraName("");
      toast.success("Recorded at the muster point");
      onChanged();
    }
  }

  async function close() {
    const notes = (m?.unaccountedCount ?? 0) > 0 ? window.prompt("Everyone must be accounted for. What happened to the people still missing?") : undefined;
    if ((m?.unaccountedCount ?? 0) > 0 && !notes) return;
    const r = await action.run("close", () => api.post<MusterRow>(`${base}/musters/${musterId}/close`, notes ? { notes } : {}));
    if (r) {
      toast.success(`${r.reference} closed`);
      onChanged();
      onClose();
    }
  }

  const checkedIn = new Set((m?.checkins ?? []).filter((c) => c.status !== "unaccounted").map((c) => c.personKey));

  return (
    <Drawer
      open={musterId !== null}
      onClose={onClose}
      title={m ? `${m.reference} — ${labelize(m.kind)}` : "Muster"}
      description={m ? `Declared ${dateTime(m.declaredAt)}${m.musterPoint ? ` at ${m.musterPoint}` : ""}.` : undefined}
      size="lg"
    >
      {action.refusal ? <RefusalNotice refusal={action.refusal} onDismiss={action.clear} /> : null}
      {detail.error ? <LoadError message={detail.error} onRetry={detail.reload} /> : null}
      {m ? (
        <div className="space-y-4">
          <KeyValue
            items={[
              { label: "On the register", value: num(m.expectedCount) },
              { label: "Accounted for", value: num(m.accountedCount) },
              { label: "Unaccounted", value: <span className={m.unaccountedCount > 0 ? "font-semibold text-danger-fg" : ""}>{num(m.unaccountedCount)}</span> },
              { label: "At the point but not on the register", value: num(m.unexpectedCount) },
              { label: "Time to clear", value: m.durationSeconds === null ? "no check-ins yet" : `${num(m.durationSeconds)} s` },
              { label: "Status", value: labelize(m.status) },
            ]}
          />

          <div>
            <SectionHeading title="On the register at declaration" hint="Tick each person off as they reach the muster point." />
            {m.expectedRegister.length === 0 ? (
              <p className="text-meta text-content-muted">
                The register was empty when this muster was declared. A clear muster against an empty register proves nothing — connect the gate feed.
              </p>
            ) : (
              <ul className="space-y-1.5">
                {m.expectedRegister.map((p) => (
                  <li key={p.key} className="flex items-center justify-between gap-3 rounded-md border border-border-subtle px-3 py-1.5">
                    <span className="min-w-0">
                      <span className="text-meta font-medium text-content">{p.name}</span>
                      <span className="ml-2 text-2xs text-content-muted">in since {dateTime(p.sinceAt)}</span>
                    </span>
                    {checkedIn.has(p.key) ? (
                      <Badge tone="success" size="xs" dot>
                        Accounted for
                      </Badge>
                    ) : (
                      <span className="flex gap-1">
                        <Button size="xs" onClick={() => void checkIn(p.key, p.name, "present")}>
                          Present
                        </Button>
                        <Button size="xs" variant="ghost" onClick={() => void checkIn(p.key, p.name, "accounted_offsite")}>
                          Reached off site
                        </Button>
                      </span>
                    )}
                  </li>
                ))}
              </ul>
            )}
          </div>

          <div>
            <SectionHeading
              title="Arrived without being on the register"
              hint="Either the feed missed their entry or they came on site without badging. Both are findings."
            />
            <ul className="mb-2 space-y-1 text-meta">
              {(m.checkins ?? [])
                .filter((c) => c.unexpected === 1)
                .map((c) => (
                  <li key={c.id} className="flex items-center justify-between gap-2">
                    <span className="text-content">{c.personName}</span>
                    <Badge tone="warning" size="xs">
                      not on the register
                    </Badge>
                  </li>
                ))}
            </ul>
            <form onSubmit={(e) => void addUnexpected(e)} className="flex items-end gap-2">
              <Field label="Name" className="flex-1">
                <Input value={extraName} onChange={(e) => setExtraName(e.target.value)} placeholder="Someone at the point who is not listed" />
              </Field>
              <Button type="submit" size="sm" variant="secondary" loading={action.busy === "checkin"}>
                Add
              </Button>
            </form>
          </div>

          {m.status !== "closed" ? (
            <div className="flex justify-end">
              <Button variant={m.unaccountedCount > 0 ? "danger" : "primary"} loading={action.busy === "close"} onClick={() => void close()}>
                Close the muster
              </Button>
            </div>
          ) : null}
        </div>
      ) : detail.loading ? (
        <p className="text-meta text-content-muted">Loading the muster…</p>
      ) : null}
    </Drawer>
  );
}
