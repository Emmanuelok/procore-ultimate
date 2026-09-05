/**
 * PROGRESS DETERMINATION (#995–1003).
 *
 * A claimed percentage and an independently observed one, recorded as an
 * Assertion, an Evidence row and the Reconciliation between them. The form
 * refuses to record an observation made by the claimant, and shows the
 * independence score with the reasons that produced it — because a verdict
 * without its basis is just an opinion with a number attached.
 */
import { useMemo, useState, type FormEvent } from "react";
import { toast } from "sonner";
import { Alert, Badge, Button, Card, CardBody, Drawer, Field, Input, Select, Textarea } from "../../ui";
import { DataTable, type DataColumns } from "../../ui/data";
import { IconPlus } from "../../ui/icons";
import { api } from "../../lib/api";
import {
  EM_DASH,
  KeyValue,
  LoadError,
  RECONCILIATION_TONE,
  ReasonList,
  RefusalNotice,
  SectionHeading,
  dateTime,
  labelize,
  num,
  optionList,
  useAction,
  useResource,
  type ListResponse,
  type ProgressDetail,
  type ProgressRow,
  type SiteLookups,
} from "./siteShared";

export default function ProgressTab({ projectId, lookups, onChanged }: { projectId: string; lookups: SiteLookups; onChanged: () => void }) {
  const base = `/api/v1/projects/${projectId}/site`;
  const list = useResource<ListResponse<ProgressRow> & { byResult: Record<string, number> }>(`${base}/progress-observations?pageSize=200`);
  const [open, setOpen] = useState(false);
  const [openId, setOpenId] = useState<string | null>(null);
  const detail = useResource<ProgressDetail>(openId ? `${base}/progress-observations/${openId}` : null);

  const columns = useMemo<DataColumns<ProgressRow>>(
    () => [
      { id: "reference", header: "Ref", accessor: "reference", type: "text", sticky: "start", width: 110 },
      { id: "zoneName", header: "Zone", accessor: "zoneName", type: "text", width: 220 },
      { id: "claimedPercent", header: "Claimed", accessor: "claimedPercent", type: "number", width: 100, cell: ({ row }) => `${num(row.claimedPercent, 1)}%` },
      { id: "observedPercent", header: "Observed", accessor: "observedPercent", type: "number", width: 100, cell: ({ row }) => `${num(row.observedPercent, 1)}%` },
      {
        id: "variancePercent",
        header: "Variance",
        accessor: "variancePercent",
        type: "number",
        width: 110,
        cell: ({ row }) => (
          <span className={`tabular-nums ${row.variancePercent > 5 ? "font-semibold text-danger-fg" : ""}`}>
            {row.variancePercent > 0 ? "+" : ""}
            {num(row.variancePercent, 1)} pp
          </span>
        ),
      },
      {
        id: "result",
        header: "Reconciliation",
        accessor: "result",
        type: "status",
        width: 180,
        groupable: true,
        cell: ({ row }) => (
          <Badge tone={RECONCILIATION_TONE[row.result] ?? "neutral"} size="xs" dot>
            {labelize(row.result)}
          </Badge>
        ),
      },
      { id: "method", header: "Method", accessor: "method", type: "status", width: 130, groupable: true, cell: ({ row }) => labelize(row.method) },
      {
        id: "independenceScore",
        header: "Independence",
        accessor: (row) => row.independenceScore ?? 0,
        type: "number",
        width: 130,
        cell: ({ row }) => (row.independenceScore === null ? EM_DASH : num(row.independenceScore, 2)),
      },
      { id: "claimSourceType", header: "Claim from", accessor: "claimSourceType", type: "status", width: 150, groupable: true, cell: ({ row }) => labelize(row.claimSourceType) },
      { id: "observedAt", header: "Observed", accessor: "observedAt", type: "datetime", width: 170, cell: ({ row }) => dateTime(row.observedAt) },
    ],
    [],
  );

  const byResult = list.data?.byResult ?? {};

  return (
    <div className="space-y-4">
      <div className="grid grid-cols-2 gap-3 md:grid-cols-5">
        {(["supported", "partially_supported", "unsupported", "contradicted", "insufficient_evidence"] as const).map((result) => (
          <Card key={result}>
            <CardBody>
              <div className="text-label uppercase text-content-subtle">{labelize(result)}</div>
              <div
                className={`text-display-xs font-semibold tabular-nums ${
                  (result === "unsupported" || result === "contradicted") && (byResult[result] ?? 0) > 0 ? "text-danger-fg" : "text-content"
                }`}
              >
                {num(byResult[result] ?? 0)}
              </div>
            </CardBody>
          </Card>
        ))}
      </div>

      <Card>
        <CardBody>
          <SectionHeading
            title="Progress observations"
            hint="Each row is three assurance records: the claim (an Assertion), the observation (Evidence), and the comparison between them (a Reconciliation). The observer may never be the claimant."
            actions={
              <Button size="sm" icon={IconPlus} onClick={() => setOpen(true)}>
                Record an observation
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
            exportFileName="progress-observations"
            onRowClick={({ row }) => setOpenId(row.id)}
            rowTone={(row) => (row.result === "unsupported" || row.result === "contradicted" ? "danger" : row.result === "partially_supported" ? "warning" : undefined)}
            empty={{
              title: "No progress has been independently observed",
              description:
                "Until somebody other than the claimant walks, flies or scans the work, claimed progress on this project is untested. Record the first observation here.",
              action: (
                <Button size="sm" onClick={() => setOpen(true)}>
                  Record the first observation
                </Button>
              ),
            }}
          />
        </CardBody>
      </Card>

      <ObservationForm
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

      <Drawer
        open={openId !== null}
        onClose={() => setOpenId(null)}
        title={detail.data ? `${detail.data.reference} — ${detail.data.zoneName}` : "Progress observation"}
        description={detail.data ? labelize(detail.data.result) : undefined}
        size="lg"
      >
        {detail.error ? <LoadError message={detail.error} onRetry={detail.reload} /> : null}
        {detail.data ? (
          <div className="space-y-4">
            <Alert
              tone={
                detail.data.result === "supported"
                  ? "success"
                  : detail.data.result === "insufficient_evidence"
                    ? "warning"
                    : "danger"
              }
              title={labelize(detail.data.result)}
            >
              {detail.data.reconciliation?.notes ?? "No note was recorded against this reconciliation."}
            </Alert>

            <div>
              <SectionHeading title="The claim (Assertion)" />
              <KeyValue
                items={[
                  { label: "Claimed", value: `${num(detail.data.claimedPercent, 1)}%` },
                  { label: "Claimant", value: detail.data.claimantId },
                  { label: "From", value: labelize(detail.data.claimSourceType) },
                  { label: "Basis", value: detail.data.assertion?.basis ?? EM_DASH },
                  { label: "Asserted at", value: dateTime(detail.data.assertion?.assertedAt ?? null) },
                ]}
              />
            </div>

            <div>
              <SectionHeading title="The observation (Evidence)" />
              <KeyValue
                items={[
                  { label: "Observed", value: `${num(detail.data.observedPercent, 1)}%` },
                  { label: "Method", value: labelize(detail.data.method) },
                  { label: "Observer", value: detail.data.observedBy },
                  { label: "Kind", value: labelize(detail.data.evidence?.kind ?? null) },
                  { label: "Independence", value: num(detail.data.independenceScore ?? 0, 2) },
                  { label: "Content hash", value: <span className="font-mono text-2xs">{detail.data.evidence?.contentHash.slice(0, 24) ?? EM_DASH}…</span> },
                ]}
              />
              {Array.isArray((detail.data.evidence?.provenance as { basis?: unknown } | null)?.basis) ? (
                <ReasonList reasons={((detail.data.evidence?.provenance as { basis: string[] }).basis) ?? []} className="mt-2" />
              ) : null}
            </div>

            <div>
              <SectionHeading title="The comparison (Reconciliation)" />
              <KeyValue
                items={[
                  { label: "Method", value: labelize(detail.data.reconciliation?.method ?? null) },
                  { label: "Result", value: labelize(detail.data.reconciliation?.result ?? null) },
                  { label: "Variance", value: `${num(detail.data.variancePercent, 1)} percentage points` },
                  { label: "Confidence", value: num(detail.data.confidence ?? 0, 2) },
                  { label: "Signal raised", value: detail.data.signalId ? "yes" : "no" },
                ]}
              />
            </div>
          </div>
        ) : detail.loading ? (
          <p className="text-meta text-content-muted">Loading the observation…</p>
        ) : null}
      </Drawer>
    </div>
  );
}

function ObservationForm({
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
  const [zoneName, setZoneName] = useState("");
  const [workPackageRef, setWorkPackageRef] = useState("");
  const [claimedPercent, setClaimedPercent] = useState("");
  const [observedPercent, setObservedPercent] = useState("");
  const [method, setMethod] = useState("photo");
  const [claimSourceType, setClaimSourceType] = useState("valuation");
  const [claimSourceId, setClaimSourceId] = useState("");
  const [claimantId, setClaimantId] = useState("");
  const [claimantVendorId, setClaimantVendorId] = useState("");
  const [observerVendorId, setObserverVendorId] = useState("");
  const [notes, setNotes] = useState("");

  async function submit(e: FormEvent) {
    e.preventDefault();
    const payload: Record<string, unknown> = {
      zoneName: zoneName.trim(),
      claimedPercent: Number(claimedPercent),
      observedPercent: Number(observedPercent),
      method,
      claimSourceType,
      claimantId: claimantId.trim(),
    };
    if (workPackageRef.trim()) payload["workPackageRef"] = workPackageRef.trim();
    if (claimSourceId.trim()) payload["claimSourceId"] = claimSourceId.trim();
    if (claimantVendorId) payload["claimantVendorId"] = claimantVendorId;
    if (observerVendorId) payload["observerVendorId"] = observerVendorId;
    if (notes.trim()) payload["notes"] = notes.trim();
    const r = await action.run("create", () =>
      api.post<ProgressRow & { assessment: { result: string; independenceScore: number; reasons: string[] } }>(
        `${base}/progress-observations`,
        payload,
      ),
    );
    if (r) {
      toast.success(`${r.reference}: ${labelize(r.assessment.result)}`);
      setZoneName("");
      setClaimedPercent("");
      setObservedPercent("");
      onCreated();
    }
  }

  return (
    <Drawer
      open={open}
      onClose={onClose}
      title="Record a progress observation"
      description="You are the observer. The platform will refuse this if you are also the claimant — an assertion and the evidence that tests it must come from different pathways."
      size="md"
    >
      <form onSubmit={(e) => void submit(e)} className="space-y-3">
        {action.refusal ? <RefusalNotice refusal={action.refusal} onDismiss={action.clear} /> : null}
        <ReasonList reasons={lookups.notes} />
        <Field label="Zone or area" required>
          <Input value={zoneName} onChange={(e) => setZoneName(e.target.value)} required maxLength={200} placeholder="Level 3 slab, grid A–D" />
        </Field>
        <div className="grid grid-cols-2 gap-3">
          <Field label="Claimed %" required>
            <Input type="number" min={0} max={100} step="0.1" value={claimedPercent} onChange={(e) => setClaimedPercent(e.target.value)} required />
          </Field>
          <Field label="Observed %" required>
            <Input type="number" min={0} max={100} step="0.1" value={observedPercent} onChange={(e) => setObservedPercent(e.target.value)} required />
          </Field>
          <Field label="How it was observed" hint="A scan or a survey is stronger evidence than an eye, and the score says so.">
            <Select value={method} onChange={(e) => setMethod(e.target.value)}>
              {["visual", "photo", "drone", "scan", "survey", "measurement"].map((m) => (
                <option key={m} value={m}>
                  {labelize(m)}
                </option>
              ))}
            </Select>
          </Field>
          <Field label="Where the claim came from">
            <Select value={claimSourceType} onChange={(e) => setClaimSourceType(e.target.value)}>
              {["valuation", "progress_claim", "daily_log", "schedule_update", "application", "manual"].map((s) => (
                <option key={s} value={s}>
                  {labelize(s)}
                </option>
              ))}
            </Select>
          </Field>
          <Field label="Claim record id">
            <Input value={claimSourceId} onChange={(e) => setClaimSourceId(e.target.value)} maxLength={64} />
          </Field>
          <Field label="Work package">
            <Input value={workPackageRef} onChange={(e) => setWorkPackageRef(e.target.value)} maxLength={200} />
          </Field>
          <Field label="Claimant (user id)" required hint="Whose claim this is. It may not be you.">
            <Input value={claimantId} onChange={(e) => setClaimantId(e.target.value)} required maxLength={64} />
          </Field>
          <Field label="Claimant's employer">
            <Select value={claimantVendorId} onChange={(e) => setClaimantVendorId(e.target.value)}>
              {optionList(lookups.vendors, (v) => v.name).map((o) => (
                <option key={o.value} value={o.value}>
                  {o.label}
                </option>
              ))}
            </Select>
          </Field>
          <Field label="Your employer" hint="Leave blank if you are the client's own staff. Sharing an employer with the claimant lowers the independence score.">
            <Select value={observerVendorId} onChange={(e) => setObserverVendorId(e.target.value)}>
              {optionList(lookups.vendors, (v) => v.name).map((o) => (
                <option key={o.value} value={o.value}>
                  {o.label}
                </option>
              ))}
            </Select>
          </Field>
        </div>
        <Field label="Notes">
          <Textarea rows={3} value={notes} onChange={(e) => setNotes(e.target.value)} />
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
