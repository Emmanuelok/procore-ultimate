/**
 * STATUTORY FORMS (spec Vol I #652).
 *
 * The reportability engine decides WHETHER an incident must be reported and by
 * when. This is the other half: the records laid out in the shape the
 * authority's own form asks for — the OSHA 300 log, the 300A annual summary,
 * the 301 report, and the RIDDOR F2508 / F2508A prefill.
 *
 * TWO THINGS GOVERN EVERY FIELD HERE.
 *
 * A field the platform cannot establish is BLANK WITH ITS REASON PRINTED, not
 * zero. A blank in column (K) that silently means "we never recorded the days
 * away" is indistinguishable on paper from a genuine zero, and one of those is
 * a false statement on a legal document.
 *
 * And a generated artefact is FROZEN. A 300A is posted on a wall for three
 * months and signed by an executive; an F2508 is what was actually said to the
 * authority. Both are assertions made on a date from the records as they stood
 * then — so the payload is hashed and stored, and a correction is a new
 * artefact that supersedes this one rather than a quiet edit.
 *
 * Nothing here is transmitted to any authority. This produces the document a
 * competent person checks and files.
 */
import { useMemo, useState } from "react";
import {
  Alert,
  Badge,
  Button,
  Card,
  CardBody,
  DataTable,
  Field,
  Input,
  Modal,
  Select,
  Skeleton,
  type DataColumns,
} from "../../ui";
import { IconStamp } from "../../ui/icons";
import { api } from "../../lib/api";
import {
  LoadError,
  REGULATORY_FORM_LABEL,
  REGULATORY_STATUS_TONE,
  ReasonList,
  RefusalNotice,
  SectionHeading,
  count,
  dateTime,
  labelize,
  nameOf,
  useMutation,
  useResource,
  type Paged,
  type RegulatoryPreview,
  type RegulatoryReportRow,
  type SafetyIncident,
  type Resource,
} from "./safetyShared";

const YEAR_FORMS = ["osha_300", "osha_300a"];
const CASE_FORMS = ["osha_301", "riddor_f2508", "riddor_f2508a"];
const ALL_FORMS = [...YEAR_FORMS, ...CASE_FORMS];

export default function StatutoryTab({
  projectId,
  incidents,
  users,
  version,
  onMutated,
}: {
  projectId: string;
  incidents: Resource<Paged<SafetyIncident>>;
  users: Map<string, string>;
  version: number;
  onMutated: () => void;
}) {
  const [form, setForm] = useState("osha_300");
  const [year, setYear] = useState(() => String(new Date().getFullYear()));
  const [incidentId, setIncidentId] = useState("");
  const [preview, setPreview] = useState<RegulatoryPreview | null>(null);
  const [previewBusy, setPreviewBusy] = useState(false);
  const [certifyFor, setCertifyFor] = useState<RegulatoryReportRow | null>(null);
  const [certifierTitle, setCertifierTitle] = useState("");
  const [viewing, setViewing] = useState<RegulatoryReportRow | null>(null);

  const reports = useResource<Paged<RegulatoryReportRow>>(
    (signal) =>
      api.get<Paged<RegulatoryReportRow>>(
        `/api/v1/projects/${projectId}/safety/regulatory/reports?page=1&pageSize=100`,
        { signal },
      ),
    [projectId, version],
    projectId !== "",
  );

  const mutation = useMutation(() => {
    setPreview(null);
    onMutated();
  });

  const isYearForm = YEAR_FORMS.includes(form);
  const reportableIncidents = (incidents.data?.items ?? []).filter((i) => i.isReportable);
  const ready = isYearForm ? year !== "" : incidentId !== "";

  async function runPreview() {
    setPreviewBusy(true);
    try {
      const params = new URLSearchParams({ form });
      if (isYearForm) params.set("year", year);
      else params.set("incidentId", incidentId);
      setPreview(
        await api.get<RegulatoryPreview>(
          `/api/v1/projects/${projectId}/safety/regulatory/preview?${params.toString()}`,
        ),
      );
    } catch {
      setPreview(null);
    } finally {
      setPreviewBusy(false);
    }
  }

  const columns = useMemo<DataColumns<RegulatoryReportRow>>(
    () => [
      {
        id: "reference",
        header: "Number",
        accessor: "reference",
        type: "code",
        sticky: "start",
        width: 110,
        mono: true,
      },
      {
        id: "form",
        header: "Form",
        accessor: "form",
        type: "enum",
        width: 220,
        groupable: true,
        options: ALL_FORMS.map((f) => ({
          value: f,
          text: REGULATORY_FORM_LABEL[f] ?? f,
          label: REGULATORY_FORM_LABEL[f] ?? f,
        })),
        cell: ({ row }) => REGULATORY_FORM_LABEL[row.form] ?? labelize(row.form),
      },
      {
        id: "period",
        header: "Covers",
        accessor: (row) => row.periodYear ?? row.periodFrom ?? "",
        type: "text",
        width: 140,
        cell: ({ row }) =>
          row.incidentId ? (
            <span className="font-mono text-2xs">{row.incidentId}</span>
          ) : (
            <span>{row.periodYear ?? "—"}</span>
          ),
      },
      {
        id: "rows",
        header: "Rows",
        accessor: "rowCount",
        type: "number",
        width: 80,
        align: "right",
      },
      {
        id: "caveats",
        header: "Caveats",
        headerTooltip:
          "Everything the generator could not establish. They are stored WITH the artefact — they are part of what an executive certifies.",
        accessor: (row) => row.caveats.length,
        type: "number",
        width: 100,
        align: "right",
        cell: ({ row }) =>
          row.caveats.length === 0 ? (
            <span className="text-content-subtle">None</span>
          ) : (
            <Badge tone="warning" size="xs">
              {count(row.caveats.length)}
            </Badge>
          ),
      },
      {
        id: "status",
        header: "Status",
        accessor: "status",
        type: "enum",
        width: 140,
        cell: ({ row }) => (
          <Badge tone={REGULATORY_STATUS_TONE[row.status] ?? "neutral"} size="xs" dot>
            {labelize(row.status)}
          </Badge>
        ),
      },
      {
        id: "certified",
        header: "Certified",
        accessor: (row) => row.certifiedAt ?? "",
        type: "text",
        width: 190,
        cell: ({ row }) =>
          row.certifiedAt ? (
            <span className="block min-w-0">
              <span className="block truncate">{nameOf(users, row.certifiedBy)}</span>
              <span className="block truncate text-2xs text-content-subtle">
                {row.certifierTitle}
              </span>
            </span>
          ) : row.form === "osha_300a" ? (
            <span className="text-warning-fg">Not certified</span>
          ) : (
            <span className="text-content-subtle">—</span>
          ),
      },
      {
        id: "sha",
        header: "Hash",
        headerTooltip: "sha256 of the canonical payload — the artefact's identity.",
        accessor: "sha256",
        type: "code",
        width: 130,
        mono: true,
        cell: ({ row }) => <span className="font-mono text-2xs">{row.sha256.slice(0, 12)}…</span>,
      },
      {
        id: "generated",
        header: "Generated",
        accessor: "createdAt",
        type: "datetime",
        width: 170,
        cell: ({ row }) => dateTime(row.createdAt),
      },
    ],
    [users],
  );

  const rows = reports.data?.items ?? [];

  return (
    <div className="space-y-3">
      <Alert tone="info" title="Nothing here is transmitted to any authority">
        These are the authority's own forms, prefilled from the incident register's own
        classification columns. RIDDOR places the duty on the responsible person and 29 CFR 1904
        places recordability on the employer — read every field, complete the ones marked missing,
        and submit through the authority's own service.
      </Alert>

      <Card>
        <CardBody className="space-y-3">
          <SectionHeading
            title="Generate a form"
            hint="Preview first. Generating freezes the payload, hashes it and stores it as a file, because a form is an assertion made on a date."
          />
          {mutation.refusal ? <RefusalNotice refusal={mutation.refusal} onDismiss={mutation.clear} /> : null}
          {mutation.error ? (
            <Alert tone="danger" title="That could not be generated" onDismiss={mutation.clear}>
              {mutation.error}
            </Alert>
          ) : null}

          <div className="grid gap-3 sm:grid-cols-3">
            <Field label="Form">
              <Select value={form} onChange={(e) => setForm(e.target.value)}>
                {ALL_FORMS.map((f) => (
                  <option key={f} value={f}>
                    {REGULATORY_FORM_LABEL[f] ?? f}
                  </option>
                ))}
              </Select>
            </Field>
            {isYearForm ? (
              <Field label="Calendar year" required>
                <Input
                  type="number"
                  min={1970}
                  max={2200}
                  value={year}
                  onChange={(e) => setYear(e.target.value)}
                />
              </Field>
            ) : (
              <Field
                label="Incident"
                required
                hint="Only reportable incidents are offered — a form for a case with no statutory duty would be a report nobody asked for."
              >
                <Select value={incidentId} onChange={(e) => setIncidentId(e.target.value)}>
                  <option value="">Choose an incident</option>
                  {reportableIncidents.map((i) => (
                    <option key={i.id} value={i.id}>
                      {i.reference} — {i.title}
                    </option>
                  ))}
                </Select>
              </Field>
            )}
            <div className="flex items-end gap-2 pb-1">
              <Button size="sm" variant="secondary" disabled={!ready} loading={previewBusy} onClick={() => void runPreview()}>
                Preview
              </Button>
              <Button
                size="sm"
                disabled={!ready}
                loading={mutation.busy === "generate"}
                onClick={() =>
                  void mutation.run("generate", "This form could not be generated", () =>
                    api.post(`/api/v1/projects/${projectId}/safety/regulatory/reports`, {
                      form,
                      ...(isYearForm ? { year: Number(year) } : { incidentId }),
                    }),
                  )
                }
              >
                Generate and freeze
              </Button>
            </div>
          </div>

          {preview ? (
            <div className="space-y-2 rounded-lg border border-border bg-surface-raised p-3">
              <div className="flex flex-wrap items-center justify-between gap-2">
                <p className="text-meta font-medium text-content">
                  {REGULATORY_FORM_LABEL[preview.form] ?? preview.form} · {count(preview.rowCount)}{" "}
                  row{preview.rowCount === 1 ? "" : "s"}
                </p>
                <Badge tone="info" size="xs" variant="outline">
                  Not stored
                </Badge>
              </div>
              <p className="text-2xs text-content-muted">{preview.note}</p>
              {preview.caveats.length > 0 ? <ReasonList reasons={preview.caveats} /> : null}
              <pre className="max-h-72 overflow-auto rounded-md bg-surface-sunken p-2 font-mono text-2xs text-content-muted">
                {JSON.stringify(preview.payload, null, 2)}
              </pre>
            </div>
          ) : null}
        </CardBody>
      </Card>

      {reports.error ? (
        <LoadError
          message={reports.error}
          onRetry={reports.reload}
          title="The artefact register could not be loaded"
        />
      ) : reports.loading && rows.length === 0 ? (
        <Skeleton height={260} />
      ) : (
        <DataTable
          data={rows}
          columns={columns}
          getRowId={(row) => row.id}
          onRowClick={({ row }) => setViewing(row)}
          rowActions={(row) =>
            row.form === "osha_300a" && !row.certifiedAt && row.status === "generated" ? (
              <Button
                size="xs"
                variant="outline"
                onClick={(e) => {
                  e.stopPropagation();
                  setCertifyFor(row);
                  setCertifierTitle("");
                }}
              >
                Certify
              </Button>
            ) : null
          }
          empty={{
            icon: IconStamp,
            title: "No statutory form has been generated for this project",
            description:
              "The register can produce the OSHA 300 log and its annual summary, the 301, and a RIDDOR F2508 prefill from the incidents already held. Nothing is transmitted; the artefact is what a competent person checks and files.",
          }}
          aria-label="Statutory artefact register"
        />
      )}

      {/* ------------------------------------------------------------ */}
      <Modal
        open={certifyFor !== null}
        onClose={() => setCertifyFor(null)}
        title="Certify the 300A"
        size="md"
        footer={
          <div className="flex items-center gap-2">
            <Button variant="ghost" onClick={() => setCertifyFor(null)}>
              Cancel
            </Button>
            <Button
              disabled={certifierTitle.trim() === ""}
              loading={mutation.busy === "certify"}
              onClick={() =>
                void mutation.run("certify", "This summary could not be certified", async () => {
                  await api.post(
                    `/api/v1/projects/${projectId}/safety/regulatory/reports/${certifyFor?.id}/certify`,
                    { certifierTitle: certifierTitle.trim() },
                  );
                  setCertifyFor(null);
                })
              }
            >
              Certify it
            </Button>
          </div>
        }
      >
        <div className="space-y-3">
          <Alert tone="warning" title="This is a personal certification">
            29 CFR 1904.32(b)(3) makes the certifier personally responsible for having examined the
            300 log and reasonably believing the summary correct and complete. The caveats stored on
            this artefact are part of what is being certified.
          </Alert>
          {certifyFor && certifyFor.caveats.length > 0 ? (
            <ReasonList reasons={certifyFor.caveats} />
          ) : null}
          <Field label="Your title" required>
            <Input
              value={certifierTitle}
              placeholder="Chief Operating Officer"
              onChange={(e) => setCertifierTitle(e.target.value)}
            />
          </Field>
        </div>
      </Modal>

      {/* ------------------------------------------------------------ */}
      <Modal
        open={viewing !== null}
        onClose={() => setViewing(null)}
        title={viewing ? `${viewing.reference} · ${REGULATORY_FORM_LABEL[viewing.form] ?? viewing.form}` : ""}
        size="lg"
      >
        {viewing ? <ArtefactBody projectId={projectId} report={viewing} /> : null}
      </Modal>
    </div>
  );
}

function ArtefactBody({ projectId, report }: { projectId: string; report: RegulatoryReportRow }) {
  const detail = useResource<{
    payload: Record<string, unknown>;
    caveats: string[];
    integrity: { sha256: string; recomputed: string; note: string };
  }>(
    (signal) =>
      api.get(`/api/v1/projects/${projectId}/safety/regulatory/reports/${report.id}`, { signal }),
    [projectId, report.id],
    true,
  );

  if (detail.error) {
    return <LoadError message={detail.error} onRetry={detail.reload} title="Could not load it" />;
  }
  if (!detail.data) return <Skeleton height={220} />;
  const intact = detail.data.integrity.recomputed === detail.data.integrity.sha256;
  return (
    <div className="space-y-3">
      <Alert tone={intact ? "success" : "danger"} size="sm" title={intact ? "Intact" : "Altered since generation"}>
        {detail.data.integrity.note}
      </Alert>
      {detail.data.caveats.length > 0 ? <ReasonList reasons={detail.data.caveats} /> : null}
      <pre className="max-h-[28rem] overflow-auto rounded-md bg-surface-sunken p-2 font-mono text-2xs text-content-muted">
        {JSON.stringify(detail.data.payload, null, 2)}
      </pre>
    </div>
  );
}
