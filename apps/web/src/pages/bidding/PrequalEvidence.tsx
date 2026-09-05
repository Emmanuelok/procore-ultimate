/**
 * WHAT A PREQUALIFICATION ACTUALLY TURNS ON.
 *
 * The questionnaire is prose with a score on it. The three registers here are
 * the parts that decide the answer, and each is shown as the typed record it
 * is rather than as a sentence somebody wrote:
 *
 *  - THE TIER, AND WHAT CAPPED IT. A letter with no reasoning is a number
 *    somebody will argue with, so every ceiling that lowered it is listed
 *    next to it. The tier the CURRENT evidence supports is shown beside the
 *    one that was granted, because a licence that lapsed after the approval
 *    changes the answer and the stored letter cannot know that.
 *  - SAFETY, LICENCES AND REFERENCES. An EMR, an expiry date and the name of
 *    the person who took a reference up are the three facts a buyer needs and
 *    the three that vanish inside free text.
 *  - THE PROVENANCE. A self-declared figure, a claimed licence and an
 *    unchecked reference are labelled as such everywhere they appear. They
 *    become evidence when somebody verifies them, and not before.
 */
import { useState } from "react";
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
  Textarea,
} from "../../ui";
import type { DataColumns, Tone } from "../../ui";
import { IconCheck, IconPlus, IconWarning } from "../../ui/icons";
import { api } from "../../lib/api";
import {
  LoadError,
  LoadingBlock,
  RefusalPanel,
  isoDate,
  money,
  num,
  titleCase,
  useAction,
  useNames,
  useResource,
} from "./biddingShared";
import type {
  PrequalLicence,
  PrequalReference,
  PrequalSafetyRecord,
  PrequalTierBlock,
  Paginated,
  TierVerdict,
  VendorEvidenceView,
} from "./types";

const BASE = "/api/v1/companies/current/prequalification";

const TIER_TONE: Record<string, Tone> = {
  a: "success",
  b: "info",
  c: "warning",
  unrated: "neutral",
};

const RISK_TONE: Record<string, Tone> = {
  low: "success",
  medium: "warning",
  high: "danger",
  unrated: "neutral",
};

const LICENCE_TONE: Record<string, Tone> = {
  verified: "success",
  claimed: "info",
  expired: "danger",
  suspended: "danger",
  revoked: "danger",
  not_applicable: "neutral",
};

const REFERENCE_TONE: Record<string, Tone> = {
  delivered: "success",
  delivered_late: "warning",
  terminated: "danger",
  disputed: "danger",
  unknown: "neutral",
};

const tierLabel = (tier: string | null | undefined): string =>
  tier === null || tier === undefined
    ? "—"
    : tier === "unrated"
      ? "unrated"
      : `Tier ${tier.toUpperCase()}`;

/* ================================================================== */
/* The tier card                                                       */
/* ================================================================== */

/**
 * The letter, its basis, and every rule that lowered it. Where the current
 * evidence no longer supports the letter that was granted, that disagreement
 * is the headline rather than a footnote.
 */
export function TierCard({ tier }: { tier: PrequalTierBlock | undefined }) {
  if (!tier) return null;
  const now = tier.onCurrentEvidence;
  const drifted = tier.drifted === true && tier.granted !== null;
  return (
    <Card>
      <CardBody className="space-y-3">
        <div className="flex flex-wrap items-start justify-between gap-3">
          <div>
            <div className="text-label uppercase text-content-subtle">Admitted at</div>
            <div className="mt-0.5 flex items-center gap-2">
              <Badge tone={TIER_TONE[tier.granted ?? "unrated"] ?? "neutral"} size="sm">
                {tierLabel(tier.granted)}
              </Badge>
              {tier.riskRating ? (
                <Badge tone={RISK_TONE[tier.riskRating] ?? "neutral"} size="xs">
                  {titleCase(tier.riskRating)} risk
                </Badge>
              ) : null}
            </div>
          </div>
          {now ? (
            <div className="text-right">
              <div className="text-label uppercase text-content-subtle">On today&rsquo;s evidence</div>
              <div className="mt-0.5">
                <Badge tone={TIER_TONE[now.tier] ?? "neutral"} size="sm">
                  {tierLabel(now.tier)}
                </Badge>
              </div>
            </div>
          ) : null}
        </div>

        {tier.granted === null ? (
          <p className="text-meta text-content-subtle">
            No tier has been granted. A tier is derived on the decision, and a rejection is not
            tiered — there is no size of package a rejected vendor may be considered for.
          </p>
        ) : (
          <p className="text-meta leading-relaxed text-content-muted">{tier.grantedBasis}</p>
        )}

        {drifted && now ? (
          <Alert tone="warning" icon={IconWarning} title="The evidence has moved since the decision">
            <p>
              This vendor was admitted at {tierLabel(tier.granted)}, but the evidence on file today
              supports {tierLabel(now.tier)}. The granted letter does not know about anything filed
              after the approval — re-assess before relying on it.
            </p>
          </Alert>
        ) : null}

        {now && now.ceilings.length > 0 ? (
          <section>
            <h4 className="text-label uppercase text-content-subtle">
              What is capping this vendor
            </h4>
            <ul className="mt-1.5 space-y-1">
              {now.ceilings.map((c, i) => (
                <li
                  key={i}
                  className="rounded-md border border-border bg-surface-subtle p-2 text-2xs leading-relaxed"
                >
                  {c}
                </li>
              ))}
            </ul>
            <p className="mt-1.5 text-2xs italic text-content-subtle">
              The score band alone would have granted {tierLabel(now.scoreBandTier)}. Nothing here
              can raise a tier — only lower it.
            </p>
          </section>
        ) : now ? (
          <p className="text-2xs italic text-content-subtle">
            Nothing on file caps this vendor below the band their score earned.
          </p>
        ) : null}

        {tier.riskBasis ? (
          <p className="text-2xs leading-relaxed text-content-subtle">{tier.riskBasis}</p>
        ) : null}

        {now && now.limit.value === null ? (
          <Alert tone="info" variant="subtle" title="No single-project limit">
            <ul className="space-y-0.5 text-2xs">
              {now.limit.reasons.map((r, i) => (
                <li key={i}>{r}</li>
              ))}
            </ul>
          </Alert>
        ) : null}
      </CardBody>
    </Card>
  );
}

/* ================================================================== */
/* The three registers for one vendor                                  */
/* ================================================================== */

export function VendorEvidencePanel({
  vendorId,
  submissionId,
  onMutated,
}: {
  vendorId: string | null;
  submissionId?: string | null;
  onMutated?: () => void;
}) {
  const evidence = useResource<VendorEvidenceView>(
    vendorId ? `${BASE}/vendors/${vendorId}/evidence` : null,
  );
  const action = useAction();
  const nameOf = useNames();
  const [addOpen, setAddOpen] = useState<null | "safety" | "licence" | "reference">(null);
  const [checkRef, setCheckRef] = useState<PrequalReference | null>(null);

  function reload() {
    evidence.reload();
    onMutated?.();
  }

  if (!vendorId) return null;
  if (evidence.loading && !evidence.data) return <LoadingBlock rows={4} />;
  if (evidence.error) return <LoadError message={evidence.error} onRetry={evidence.reload} />;
  const data = evidence.data;
  if (!data) return null;

  const safetyColumns: DataColumns<PrequalSafetyRecord> = [
    { id: "year", header: "Year", accessor: "year", type: "number", width: 80 },
    {
      id: "emr",
      header: "EMR",
      headerTooltip: "Experience modification rate. Above 1.2 caps the tier; above 1.5 caps it at C.",
      accessor: "emr",
      type: "number",
      width: 90,
      cell: ({ row }) =>
        row.emr === null ? (
          <span className="italic text-content-subtle">not stated</span>
        ) : (
          <span className={row.emr > 1.2 ? "tabular-nums font-medium text-danger" : "tabular-nums"}>
            {num(row.emr, 2)}
          </span>
        ),
    },
    {
      id: "trir",
      header: "TRIR",
      accessor: "trir",
      type: "number",
      width: 90,
      cell: ({ row }) => (row.trir === null ? "—" : num(row.trir, 2)),
    },
    {
      id: "fatalities",
      header: "Fatalities",
      accessor: "fatalities",
      type: "number",
      width: 110,
      cell: ({ row }) =>
        row.fatalities === null ? (
          <span className="italic text-content-subtle">not stated</span>
        ) : row.fatalities > 0 ? (
          <Badge tone="danger" size="xs">
            {row.fatalities}
          </Badge>
        ) : (
          "0"
        ),
    },
    {
      id: "source",
      header: "Provenance",
      accessor: "source",
      type: "text",
      width: 150,
      cell: ({ row }) => (
        <Badge tone={row.source === "self_declared" ? "warning" : "success"} size="xs">
          {titleCase(row.source)}
        </Badge>
      ),
    },
    {
      id: "verify",
      header: "",
      width: 150,
      cell: ({ row }) =>
        row.source === "self_declared" ? (
          <Button
            size="xs"
            variant="secondary"
            loading={action.busy === `verify:${row.id}`}
            onClick={() =>
              void action
                .run(`verify:${row.id}`, () =>
                  api.post(`${BASE}/safety-records/${row.id}/verify`, {
                    source: "audited",
                    note: "Checked against the audited return supplied for the year.",
                  }),
                )
                .then((ok) => ok && reload())
            }
          >
            Mark audited
          </Button>
        ) : (
          <span className="text-2xs text-content-subtle">
            {row.verifiedBy ? nameOf(row.verifiedBy) : "—"}
          </span>
        ),
    },
  ];

  const licenceColumns: DataColumns<PrequalLicence> = [
    {
      id: "kind",
      header: "Licence",
      accessor: (r) => titleCase(r.kind),
      type: "text",
      width: 180,
    },
    {
      id: "number",
      header: "Number",
      accessor: (r) => r.number ?? "",
      type: "text",
      width: 140,
    },
    {
      id: "jurisdiction",
      header: "Jurisdiction",
      accessor: (r) => r.jurisdiction ?? "",
      type: "text",
      width: 140,
    },
    {
      id: "expires",
      header: "Expires",
      accessor: "expiresAt",
      type: "date",
      width: 140,
      cell: ({ row }) =>
        row.expiresAt === null ? (
          <span className="italic text-content-subtle">not stated</span>
        ) : (
          <span className={row.expired ? "font-medium text-danger" : ""}>
            {isoDate(row.expiresAt)}
          </span>
        ),
    },
    {
      id: "status",
      header: "Standing",
      accessor: "status",
      type: "text",
      width: 130,
      cell: ({ row }) => (
        <Badge tone={LICENCE_TONE[row.status] ?? "neutral"} size="xs">
          {titleCase(row.status)}
        </Badge>
      ),
    },
    {
      id: "act",
      header: "",
      width: 120,
      cell: ({ row }) =>
        row.status === "claimed" && row.expiresAt && !row.expired ? (
          <Button
            size="xs"
            variant="secondary"
            icon={IconCheck}
            loading={action.busy === `lic:${row.id}`}
            onClick={() =>
              void action
                .run(`lic:${row.id}`, () =>
                  api.post(`${BASE}/licences/${row.id}/status`, {
                    status: "verified",
                    note: "Checked against the issuing body's register.",
                  }),
                )
                .then((ok) => ok && reload())
            }
          >
            Verify
          </Button>
        ) : null,
    },
  ];

  const referenceColumns: DataColumns<PrequalReference> = [
    { id: "client", header: "Client", accessor: "clientName", type: "text", width: 200 },
    {
      id: "project",
      header: "Project",
      accessor: (r) => r.projectName ?? "",
      type: "text",
      width: 200,
    },
    {
      id: "value",
      header: "Value",
      accessor: "contractValue",
      type: "number",
      width: 140,
      cell: ({ row }) =>
        row.contractValue === null ? (
          <span className="italic text-content-subtle">not stated</span>
        ) : (
          money(row.contractValue, row.currency)
        ),
    },
    {
      id: "outcome",
      header: "Outcome",
      accessor: "outcome",
      type: "text",
      width: 140,
      cell: ({ row }) => (
        <Badge tone={REFERENCE_TONE[row.outcome] ?? "neutral"} size="xs">
          {titleCase(row.outcome)}
        </Badge>
      ),
    },
    {
      id: "checked",
      header: "Taken up by",
      accessor: (r) => r.checkedBy ?? "",
      type: "text",
      width: 180,
      cell: ({ row }) =>
        row.checkedBy ? (
          <span className="text-2xs">
            {nameOf(row.checkedBy)}
            <span className="ml-1 text-content-subtle">{isoDate(row.checkedAt)}</span>
          </span>
        ) : (
          <span className="text-2xs italic text-warning">nobody has asked</span>
        ),
    },
    {
      id: "act",
      header: "",
      width: 110,
      cell: ({ row }) =>
        row.checkedBy ? null : (
          <Button size="xs" variant="secondary" onClick={() => setCheckRef(row)}>
            Take up
          </Button>
        ),
    },
  ];

  return (
    <div className="space-y-4">
      <RefusalPanel refusal={action.refusal} onDismiss={action.clear} />

      <div className="grid gap-2 sm:grid-cols-4">
        <Tile label="Safety years" value={String(data.counts.safety)} />
        <Tile
          label="Licences"
          value={`${data.counts.licences}`}
          hint={
            data.counts.licencesExpired > 0
              ? `${data.counts.licencesExpired} expired`
              : "none expired"
          }
          tone={data.counts.licencesExpired > 0 ? "danger" : undefined}
        />
        <Tile
          label="References"
          value={`${data.counts.referencesChecked} / ${data.counts.references}`}
          hint="taken up"
          tone={
            data.counts.references > 0 && data.counts.referencesChecked === 0
              ? "warning"
              : undefined
          }
        />
        <Tile label="Evidence files" value={String(data.fileCount)} />
      </div>

      <Section
        title="Safety record"
        note="An EMR, a TRIR and a fatality count compare across vendors and across years. Buried in a free-text answer they compare with nothing, and a fatality caps this vendor at tier C whatever the balance sheet says."
        onAdd={() => setAddOpen("safety")}
      >
        <DataTable<PrequalSafetyRecord>
          tableId="bidding.prequal.safety"
          data={data.safety}
          columns={safetyColumns}
          getRowId={(row) => row.id}
          density="compact"
          empty={{
            title: "No safety record on file",
            description:
              "A missing safety history is not a clean one — it caps this vendor below tier A until somebody files a year.",
          }}
        />
      </Section>

      <Section
        title="Licences"
        note="A licence has a jurisdiction and an expiry. The expiry is the whole reason this register exists, and it lapses on a schedule whether or not anybody opens this page."
        onAdd={() => setAddOpen("licence")}
      >
        <DataTable<PrequalLicence>
          tableId="bidding.prequal.licences"
          data={data.licences}
          columns={licenceColumns}
          getRowId={(row) => row.id}
          density="compact"
          rowTone={(row) => (row.expired ? "danger" : undefined)}
          empty={{
            title: "No licence recorded",
            description: "Nothing here is claimed, so nothing here has been checked.",
          }}
        />
      </Section>

      <Section
        title="References"
        note="A reference is a client, a project, a value and a person who was actually asked. Until somebody takes it up it is a name the vendor supplied, and the tiering rule treats it as one."
        onAdd={() => setAddOpen("reference")}
      >
        <DataTable<PrequalReference>
          tableId="bidding.prequal.references"
          data={data.references}
          columns={referenceColumns}
          getRowId={(row) => row.id}
          density="compact"
          empty={{
            title: "No reference recorded",
            description: "Tier A is not available without a reference somebody has taken up.",
          }}
        />
      </Section>

      {data.files.length > 0 ? (
        <Section
          title="Evidence repository"
          note="Every file this company holds on this vendor, wherever it was attached. Assembling it by hand is how an expired certificate sits unnoticed next to a current approval."
        >
          <ul className="space-y-1">
            {data.files.map((f) => (
              <li
                key={`${f.source}:${f.sourceId}:${f.fileId}`}
                className="flex items-center justify-between gap-3 rounded-md border border-border p-2 text-2xs"
              >
                <span className="truncate">{f.label}</span>
                <Badge tone="neutral" size="xs">
                  {titleCase(f.source)}
                </Badge>
              </li>
            ))}
          </ul>
        </Section>
      ) : null}

      <AddEvidenceModal
        kind={addOpen}
        vendorId={vendorId}
        submissionId={submissionId ?? null}
        onClose={() => setAddOpen(null)}
        onDone={() => {
          setAddOpen(null);
          reload();
        }}
      />

      <CheckReferenceModal
        reference={checkRef}
        onClose={() => setCheckRef(null)}
        onDone={() => {
          setCheckRef(null);
          reload();
        }}
      />
    </div>
  );
}

function Tile({
  label,
  value,
  hint,
  tone,
}: {
  label: string;
  value: string;
  hint?: string;
  tone?: Tone;
}) {
  return (
    <Card>
      <CardBody className="py-2">
        <div className="text-label uppercase text-content-subtle">{label}</div>
        <div
          className={`mt-0.5 text-lg font-semibold tabular-nums${
            tone === "danger" ? " text-danger" : tone === "warning" ? " text-warning" : ""
          }`}
        >
          {value}
        </div>
        {hint ? <div className="text-2xs text-content-subtle">{hint}</div> : null}
      </CardBody>
    </Card>
  );
}

function Section({
  title,
  note,
  onAdd,
  children,
}: {
  title: string;
  note: string;
  onAdd?: () => void;
  children: React.ReactNode;
}) {
  return (
    <section>
      <div className="flex items-start justify-between gap-3">
        <div>
          <h3 className="text-label uppercase text-content-subtle">{title}</h3>
          <p className="mt-0.5 max-w-3xl text-2xs leading-relaxed text-content-subtle">{note}</p>
        </div>
        {onAdd ? (
          <Button size="xs" variant="secondary" icon={IconPlus} onClick={onAdd}>
            Add
          </Button>
        ) : null}
      </div>
      <div className="mt-2">{children}</div>
    </section>
  );
}

/* ================================================================== */
/* Capture                                                             */
/* ================================================================== */

function AddEvidenceModal({
  kind,
  vendorId,
  submissionId,
  onClose,
  onDone,
}: {
  kind: null | "safety" | "licence" | "reference";
  vendorId: string;
  submissionId: string | null;
  onClose: () => void;
  onDone: () => void;
}) {
  const action = useAction();
  const [form, setForm] = useState<Record<string, string>>({});
  const set = (key: string, value: string) => setForm((p) => ({ ...p, [key]: value }));
  const numOrNull = (key: string): number | null =>
    (form[key] ?? "").trim() === "" ? null : Number(form[key]);

  async function submit() {
    if (!kind) return;
    const shared = { vendorId, submissionId };
    const payload =
      kind === "safety"
        ? {
            ...shared,
            year: Number(form["year"] ?? new Date().getUTCFullYear() - 1),
            emr: numOrNull("emr"),
            trir: numOrNull("trir"),
            dart: numOrNull("dart"),
            fatalities: numOrNull("fatalities"),
            hoursWorked: numOrNull("hoursWorked"),
            source: form["source"] ?? "self_declared",
          }
        : kind === "licence"
          ? {
              ...shared,
              kind: form["kind"] ?? "",
              jurisdiction: form["jurisdiction"] || null,
              number: form["number"] || null,
              issuedBy: form["issuedBy"] || null,
              expiresAt: form["expiresAt"] || null,
            }
          : {
              ...shared,
              clientName: form["clientName"] ?? "",
              projectName: form["projectName"] || null,
              contractValue: numOrNull("contractValue"),
              currency: form["currency"] || "GBP",
              completedAt: form["completedAt"] || null,
              contactName: form["contactName"] || null,
              contactEmail: form["contactEmail"] || null,
            };
    const path =
      kind === "safety" ? "safety-records" : kind === "licence" ? "licences" : "references";
    const done = await action.run("add", () => api.post(`${BASE}/${path}`, payload));
    if (done) {
      setForm({});
      onDone();
    }
  }

  const title =
    kind === "safety"
      ? "File a safety year"
      : kind === "licence"
        ? "Record a licence"
        : "Record a reference";

  return (
    <Modal
      open={kind !== null}
      onClose={onClose}
      title={title}
      size="md"
      footer={
        <div className="flex justify-end gap-2">
          <Button variant="ghost" onClick={onClose}>
            Cancel
          </Button>
          <Button loading={action.busy === "add"} onClick={() => void submit()}>
            Save
          </Button>
        </div>
      }
    >
      <div className="space-y-3">
        <RefusalPanel refusal={action.refusal} onDismiss={action.clear} />
        {kind === "safety" ? (
          <>
            <div className="grid gap-3 sm:grid-cols-2">
              <Field label="Reporting year" required>
                <Input
                  type="number"
                  value={form["year"] ?? String(new Date().getUTCFullYear() - 1)}
                  onChange={(e) => set("year", e.target.value)}
                />
              </Field>
              <Field label="Provenance" hint="A self-declared figure is a claim until it is audited.">
                <Select
                  value={form["source"] ?? "self_declared"}
                  onChange={(e) => set("source", e.target.value)}
                >
                  <option value="self_declared">Self declared</option>
                  <option value="audited">Audited</option>
                  <option value="regulator">Regulator</option>
                </Select>
              </Field>
              <Field label="EMR" hint="Above 1.2 caps the tier; above 1.5 caps it at C.">
                <Input value={form["emr"] ?? ""} onChange={(e) => set("emr", e.target.value)} />
              </Field>
              <Field label="TRIR" hint="Per 200,000 hours.">
                <Input value={form["trir"] ?? ""} onChange={(e) => set("trir", e.target.value)} />
              </Field>
              <Field label="DART">
                <Input value={form["dart"] ?? ""} onChange={(e) => set("dart", e.target.value)} />
              </Field>
              <Field label="Fatalities" hint="One is a hard ceiling at tier C.">
                <Input
                  value={form["fatalities"] ?? ""}
                  onChange={(e) => set("fatalities", e.target.value)}
                />
              </Field>
              <Field label="Hours worked">
                <Input
                  value={form["hoursWorked"] ?? ""}
                  onChange={(e) => set("hoursWorked", e.target.value)}
                />
              </Field>
            </div>
            <p className="text-2xs italic text-content-subtle">
              A blank stays blank. A rate nobody supplied is not zero, and the tiering rule says so
              rather than assuming a clean record.
            </p>
          </>
        ) : kind === "licence" ? (
          <div className="grid gap-3 sm:grid-cols-2">
            <Field label="Licence kind" required hint="gas_safe, asbestos, electrical, …">
              <Input value={form["kind"] ?? ""} onChange={(e) => set("kind", e.target.value)} />
            </Field>
            <Field label="Number">
              <Input value={form["number"] ?? ""} onChange={(e) => set("number", e.target.value)} />
            </Field>
            <Field label="Jurisdiction">
              <Input
                value={form["jurisdiction"] ?? ""}
                onChange={(e) => set("jurisdiction", e.target.value)}
              />
            </Field>
            <Field label="Issued by">
              <Input
                value={form["issuedBy"] ?? ""}
                onChange={(e) => set("issuedBy", e.target.value)}
              />
            </Field>
            <Field
              label="Expires"
              hint="The column the register exists for. A date already past is filed as expired."
            >
              <Input
                type="date"
                value={form["expiresAt"] ?? ""}
                onChange={(e) => set("expiresAt", e.target.value)}
              />
            </Field>
          </div>
        ) : (
          <div className="grid gap-3 sm:grid-cols-2">
            <Field label="Client" required>
              <Input
                value={form["clientName"] ?? ""}
                onChange={(e) => set("clientName", e.target.value)}
              />
            </Field>
            <Field label="Project">
              <Input
                value={form["projectName"] ?? ""}
                onChange={(e) => set("projectName", e.target.value)}
              />
            </Field>
            <Field label="Contract value">
              <Input
                value={form["contractValue"] ?? ""}
                onChange={(e) => set("contractValue", e.target.value)}
              />
            </Field>
            <Field label="Currency">
              <Input
                value={form["currency"] ?? "GBP"}
                onChange={(e) => set("currency", e.target.value)}
              />
            </Field>
            <Field label="Completed">
              <Input
                type="date"
                value={form["completedAt"] ?? ""}
                onChange={(e) => set("completedAt", e.target.value)}
              />
            </Field>
            <Field label="Contact name">
              <Input
                value={form["contactName"] ?? ""}
                onChange={(e) => set("contactName", e.target.value)}
              />
            </Field>
            <Field label="Contact email" className="sm:col-span-2">
              <Input
                value={form["contactEmail"] ?? ""}
                onChange={(e) => set("contactEmail", e.target.value)}
              />
            </Field>
            <p className="text-2xs italic text-content-subtle sm:col-span-2">
              The outcome and the rating are not entered here. They are what the reference says, and
              nobody has asked yet — a vendor-supplied outcome is the vendor marking their own
              homework.
            </p>
          </div>
        )}
      </div>
    </Modal>
  );
}

function CheckReferenceModal({
  reference,
  onClose,
  onDone,
}: {
  reference: PrequalReference | null;
  onClose: () => void;
  onDone: () => void;
}) {
  const action = useAction();
  const [outcome, setOutcome] = useState("delivered");
  const [rating, setRating] = useState("");
  const [note, setNote] = useState("");

  async function submit() {
    if (!reference) return;
    const done = await action.run("check", () =>
      api.post(`${BASE}/references/${reference.id}/check`, {
        outcome,
        rating: rating.trim() === "" ? null : Number(rating),
        checkNote: note,
      }),
    );
    if (done) {
      setNote("");
      setRating("");
      onDone();
    }
  }

  return (
    <Modal
      open={reference !== null}
      onClose={onClose}
      title={reference ? `Take up — ${reference.clientName}` : "Take up a reference"}
      size="md"
      description="Record what the referee actually said, and who asked them."
      footer={
        <div className="flex justify-end gap-2">
          <Button variant="ghost" onClick={onClose}>
            Cancel
          </Button>
          <Button
            loading={action.busy === "check"}
            disabled={note.trim().length < 3}
            onClick={() => void submit()}
          >
            Record the check
          </Button>
        </div>
      }
    >
      <div className="space-y-3">
        <RefusalPanel refusal={action.refusal} onDismiss={action.clear} />
        <Field label="Outcome" required>
          <Select value={outcome} onChange={(e) => setOutcome(e.target.value)}>
            <option value="delivered">Delivered</option>
            <option value="delivered_late">Delivered late</option>
            <option value="terminated">Terminated</option>
            <option value="disputed">Disputed</option>
          </Select>
        </Field>
        <Field label="Rating" hint="0 to 5, and blank where the referee would not give one.">
          <Input value={rating} onChange={(e) => setRating(e.target.value)} />
        </Field>
        <Field label="What they said" required>
          <Textarea
            rows={4}
            value={note}
            onChange={(e) => setNote(e.target.value)}
            placeholder="Spoke to … on … ; they said …"
          />
        </Field>
        <p className="text-2xs italic text-content-subtle">
          A terminated or disputed reference caps this vendor at tier C until the circumstances are
          recorded and accepted.
        </p>
      </div>
    </Modal>
  );
}

/* ================================================================== */
/* The vendor's own link                                               */
/* ================================================================== */

/**
 * A declaration typed in by the buyer's own staff is not the vendor's
 * declaration, whatever the form says at the bottom. This mints a `pq_` link
 * so the vendor answers for themselves — shown once, and never recoverable.
 */
export function VendorPortalPanel({
  submissionId,
  portal,
  onMutated,
}: {
  submissionId: string;
  portal: { issued: boolean; expiresAt: string | null; lastAccessAt: string | null } | undefined;
  onMutated: () => void;
}) {
  const action = useAction();
  const [minted, setMinted] = useState<{ token: string; expiresAt: string } | null>(null);
  const [acknowledged, setAcknowledged] = useState(false);

  async function mint() {
    const res = await action.run("mint", () =>
      api.post<{ token: string; expiresAt: string }>(
        `${BASE}/submissions/${submissionId}/portal-token`,
        {},
      ),
    );
    if (res) {
      setAcknowledged(false);
      setMinted({ token: res.token, expiresAt: res.expiresAt });
      onMutated();
    }
  }

  async function revoke() {
    const done = await action.run("revoke", () =>
      api.del(`${BASE}/submissions/${submissionId}/portal-token`),
    );
    if (done !== null) onMutated();
  }

  return (
    <>
      <section>
        <h3 className="text-label uppercase text-content-subtle">
          The vendor&rsquo;s own link
        </h3>
        <div className="mt-2 flex flex-wrap items-center justify-between gap-3 rounded-md border border-border p-3">
          <div className="min-w-0">
            <p className="text-meta">
              {portal?.issued ? (
                <>
                  A link is live
                  {portal.expiresAt ? ` until ${isoDate(portal.expiresAt)}` : ""}.{" "}
                  {portal.lastAccessAt
                    ? `Last opened ${isoDate(portal.lastAccessAt)}.`
                    : "It has not been opened yet."}
                </>
              ) : (
                "No link has been issued. Until one is, somebody on this side is answering on the vendor's behalf."
              )}
            </p>
            <p className="mt-0.5 text-2xs text-content-subtle">
              Only the sha256 is stored, so the token cannot be read back — issuing a new one
              replaces the old immediately.
            </p>
          </div>
          <div className="flex gap-2">
            {portal?.issued ? (
              <Button
                size="sm"
                variant="ghost"
                loading={action.busy === "revoke"}
                onClick={() => void revoke()}
              >
                Revoke
              </Button>
            ) : null}
            <Button size="sm" loading={action.busy === "mint"} onClick={() => void mint()}>
              {portal?.issued ? "Replace the link" : "Issue a link"}
            </Button>
          </div>
        </div>
        <RefusalPanel refusal={action.refusal} onDismiss={action.clear} />
      </section>

      <Modal
        open={minted !== null}
        title="Vendor link — shown once"
        onClose={() => {
          if (acknowledged) setMinted(null);
        }}
        dismissible={acknowledged}
        closeOnOverlayClick={false}
        tone="warning"
        footer={
          <div className="flex justify-end gap-2">
            <Button disabled={!acknowledged} onClick={() => setMinted(null)}>
              I have sent it — close
            </Button>
          </div>
        }
      >
        <div className="space-y-3">
          <Alert tone="warning" title="This value is not recoverable">
            <p>
              Only its sha256 is stored. If it is lost, issue a new one — which is the correct cost
              of losing a credential.
            </p>
          </Alert>
          <code className="block break-all rounded-md border border-border bg-surface-subtle p-2 font-mono text-2xs">
            {minted?.token}
          </code>
          <p className="text-2xs text-content-subtle">
            Valid until {isoDate(minted?.expiresAt ?? null)}.
          </p>
          <label className="flex items-center gap-2 text-meta">
            <input
              type="checkbox"
              checked={acknowledged}
              onChange={(e) => setAcknowledged(e.target.checked)}
            />
            I have sent this to the vendor and stored it where it needs to be.
          </label>
        </div>
      </Modal>
    </>
  );
}

/* ================================================================== */
/* Company-wide licence register                                       */
/* ================================================================== */

/**
 * Every licence this company holds, ordered by the date it runs out. This is
 * the view that answers "who is about to be working on an expired ticket",
 * which is invisible from any one vendor's page.
 */
export function LicenceRegisterView() {
  const [horizon, setHorizon] = useState("90");
  const path =
    horizon === "all"
      ? `${BASE}/licences?pageSize=200`
      : `${BASE}/licences?pageSize=200&expiringWithinDays=${horizon}`;
  const licences = useResource<Paginated<PrequalLicence>>(path);
  const action = useAction();

  const columns: DataColumns<PrequalLicence> = [
    {
      id: "kind",
      header: "Licence",
      accessor: (r) => titleCase(r.kind),
      type: "text",
      width: 200,
    },
    {
      id: "number",
      header: "Number",
      accessor: (r) => r.number ?? "",
      type: "text",
      width: 160,
    },
    {
      id: "expires",
      header: "Expires",
      accessor: "expiresAt",
      type: "date",
      width: 150,
      cell: ({ row }) =>
        row.expiresAt === null ? (
          <span className="italic text-content-subtle">not stated</span>
        ) : (
          <span className={row.expired ? "font-medium text-danger" : ""}>
            {isoDate(row.expiresAt)}
          </span>
        ),
    },
    {
      id: "status",
      header: "Standing",
      accessor: "status",
      type: "text",
      width: 140,
      cell: ({ row }) => (
        <Badge tone={LICENCE_TONE[row.status] ?? "neutral"} size="xs">
          {titleCase(row.status)}
        </Badge>
      ),
    },
  ];

  return (
    <div className="space-y-3">
      <div className="flex flex-wrap items-center justify-between gap-3">
        <p className="max-w-3xl text-meta leading-relaxed text-content-muted">
          A licence lapses on a date nobody is watching. The sweep expires it and raises a signal
          against the vendor on its own; this is the list that lets somebody act before it does.
        </p>
        <div className="flex items-center gap-2">
          <Select
            aria-label="Expiry horizon"
            value={horizon}
            onChange={(e) => setHorizon(e.target.value)}
          >
            <option value="30">Expiring within 30 days</option>
            <option value="90">Expiring within 90 days</option>
            <option value="365">Expiring within a year</option>
            <option value="all">Every licence</option>
          </Select>
          <Button
            size="sm"
            variant="secondary"
            loading={action.busy === "sweep"}
            onClick={() =>
              void action
                .run("sweep", () => api.post(`${BASE}/licences/sweep`, {}))
                .then((ok) => ok && licences.reload())
            }
          >
            Run the sweep now
          </Button>
        </div>
      </div>
      <RefusalPanel refusal={action.refusal} onDismiss={action.clear} />
      {licences.loading && !licences.data ? (
        <LoadingBlock rows={5} />
      ) : licences.error ? (
        <LoadError message={licences.error} onRetry={licences.reload} />
      ) : (
        <DataTable<PrequalLicence>
          tableId="bidding.prequal.licence-register"
          data={licences.data?.items ?? []}
          columns={columns}
          getRowId={(row) => row.id}
          density="compact"
          rowTone={(row) => (row.expired ? "danger" : undefined)}
          empty={{
            title: "No licence in this window",
            description:
              horizon === "all"
                ? "No licence has been recorded against any vendor yet."
                : "Nothing on file runs out inside the horizon you chose.",
          }}
        />
      )}
    </div>
  );
}

export type { TierVerdict };
