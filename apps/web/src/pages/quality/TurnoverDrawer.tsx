/**
 * ONE TURNOVER PACKAGE.
 *
 * The gap leads here too: the contents list is drawn as required-versus-present
 * with every missing kind called by name and togglable in place, because that
 * list IS the acceptance gate.
 *
 * Where the package is blocked, the BLOCKING RECORDS ARE NAMED. A refusal that
 * says "there are outstanding items" is just an argument; "PI-0412 'Fire damper
 * FD-3 not accessible' is open, and NCR-0031 'AHU-01 coil leak' is
 * verification_pending" is a list somebody can go and close. The API returns
 * exactly that list on every read, and this screen prints it rather than
 * summarising it into a status chip.
 */
import { useState } from "react";
import {
  Alert,
  Badge,
  Button,
  Checkbox,
  Drawer,
  Field,
  Input,
  Modal,
  Select,
  Skeleton,
  Textarea,
} from "../../ui";
import { cx } from "../../ui/cx";
import { IconCheckCircle, IconClose } from "../../ui/icons";
import { toneClass } from "../../ui/tokens";
import { api } from "../../lib/api";
import {
  CX_STATUS_TONE,
  DISPOSITION_TONE,
  Facts,
  LoadError,
  NCR_STATUS_TONE,
  ReasonList,
  RefusalNotice,
  STRICTNESS_MEANING,
  SectionTitle,
  TURNOVER_ARTEFACT_KINDS,
  TURNOVER_STATUS_TONE,
  artefactLabel,
  dateTime,
  isoDate,
  labelize,
  nameOf,
  pct,
  plural,
  useAction,
  useReason,
  useResource,
} from "./qualityShared";
import type { ArtefactEntry, TurnoverDetail } from "./types";

export default function TurnoverDrawer({
  packageId,
  projectId,
  users,
  onClose,
  onMutated,
}: {
  packageId: string | null;
  projectId: string;
  users: Map<string, string>;
  onClose: () => void;
  onMutated: () => void;
}) {
  const [nonce, setNonce] = useState(0);
  const detail = useResource<TurnoverDetail>(
    (signal) =>
      api.get<TurnoverDetail>(
        `/api/v1/projects/${projectId}/turnover-packages/${packageId}`,
        { signal },
      ),
    [projectId, packageId, nonce],
    packageId !== null,
  );

  function refresh() {
    setNonce((n) => n + 1);
    onMutated();
  }

  return (
    <Drawer
      open={packageId !== null}
      onClose={onClose}
      size="xl"
      title={detail.data ? `${detail.data.reference} · ${detail.data.name}` : "Turnover package"}
      description={
        detail.data
          ? detail.data.artefacts.gap > 0
            ? `${detail.data.artefacts.gap} required ${plural(detail.data.artefacts.gap, "artefact")} missing`
            : "Every required artefact is present"
          : undefined
      }
      resizable
      resizeStorageKey="quality.turnover.drawer"
    >
      {packageId === null ? null : detail.error ? (
        <div className="p-4">
          <LoadError
            message={detail.error}
            onRetry={detail.reload}
            title="This package could not be loaded"
          />
        </div>
      ) : detail.loading && !detail.data ? (
        <div className="space-y-3 p-4">
          <Skeleton height={140} />
          <Skeleton height={260} />
          <Skeleton height={180} />
        </div>
      ) : detail.data ? (
        <PackageBody pkg={detail.data} projectId={projectId} users={users} onMutated={refresh} />
      ) : null}
    </Drawer>
  );
}

/* ================================================================== */

function PackageBody({
  pkg,
  projectId,
  users,
  onMutated,
}: {
  pkg: TurnoverDetail;
  projectId: string;
  users: Map<string, string>;
  onMutated: () => void;
}) {
  const { busy, refusal, clear, run } = useAction();
  const { ask, dialog } = useReason();
  const [acceptOpen, setAcceptOpen] = useState(false);
  const [addKind, setAddKind] = useState("");

  const base = `/api/v1/projects/${projectId}/turnover-packages/${pkg.id}`;
  const readiness = pkg.readiness;
  const gap = pkg.artefacts;
  const declared = new Set(gap.contents.map((c) => c.kind));
  const undeclared = TURNOVER_ARTEFACT_KINDS.filter((k) => !declared.has(k));
  const editable = pkg.status !== "handed_over";

  async function mark(kind: string, present: boolean, required = true) {
    const done = await run(`mark-${kind}`, () =>
      api.post(`${base}/contents/${kind}`, { present, required }),
    );
    if (done) onMutated();
  }

  async function addKindToContents() {
    if (addKind === "") return;
    const done = await run("addKind", () =>
      api.post(`${base}/contents/${addKind}`, { present: false, required: true }),
    );
    if (done) {
      setAddKind("");
      onMutated();
    }
  }

  async function submit() {
    const done = await run("submit", () => api.post(`${base}/submit`, {}));
    if (done) onMutated();
  }

  async function reject() {
    const reason = await ask({
      title: `Reject ${pkg.reference}`,
      description:
        "Rejection sends the package back to the party that assembled it. The reason is what they will work from.",
      label: "Why is this being rejected?",
      confirmLabel: "Reject the package",
      destructive: true,
    });
    if (!reason) return;
    const done = await run("reject", () => api.post(`${base}/reject`, { reason }));
    if (done) onMutated();
  }

  return (
    <div className="space-y-5 p-4">
      <RefusalNotice refusal={refusal} onDismiss={clear} />

      {/* ---------------- THE GAP ---------------- */}
      <section className="space-y-2.5">
        <SectionTitle
          title="The gap"
          hint="Required artefacts against present ones. This list is the acceptance gate."
          actions={
            <Badge tone={TURNOVER_STATUS_TONE[pkg.status] ?? "neutral"} size="sm" dot>
              {labelize(pkg.status)}
            </Badge>
          }
        />
        <div
          className={cx(
            "rounded-lg border p-3",
            gap.gap > 0
              ? cx(toneClass("danger", "subtle"), toneClass("danger", "border"))
              : cx(toneClass("success", "subtle"), toneClass("success", "border")),
          )}
        >
          <div className="flex flex-wrap items-baseline gap-2">
            <span className="text-2xl font-semibold tabular-nums">{gap.gap}</span>
            <span className="text-sm font-medium">
              {gap.gap === 0
                ? "nothing missing"
                : `required ${plural(gap.gap, "artefact")} missing`}
            </span>
            <span className="text-meta opacity-80">
              {gap.presentArtefactCount} present of {gap.requiredArtefactCount} required
              {gap.requiredArtefactCount > 0
                ? ` · ${pct((gap.presentArtefactCount / gap.requiredArtefactCount) * 100, 0)}`
                : ""}
            </span>
          </div>
          {gap.requiredArtefactCount === 0 ? (
            <p className="mt-1.5 text-meta">
              This package declares no required artefact, so there is no denominator and no
              completeness figure to report. That is not the same as being complete.
            </p>
          ) : gap.gap > 0 ? (
            <p className="mt-1.5 text-meta">
              Missing: {gap.missingKinds.map(artefactLabel).join(", ")}. An owner who accepts
              without them inherits a building nobody can operate or prove compliant.
            </p>
          ) : null}
        </div>

        <ul className="space-y-1.5">
          {gap.contents.map((entry) => (
            <ArtefactRow
              key={entry.kind}
              entry={entry}
              editable={editable}
              busy={busy === `mark-${entry.kind}`}
              onToggle={(present) => mark(entry.kind, present, entry.required)}
            />
          ))}
        </ul>

        {gap.contents.length === 0 ? (
          <p className="rounded-md border border-dashed border-border p-3 text-meta text-content-subtle">
            No artefact kind has been declared on this package. Nothing is required, so nothing can
            be missing — and nothing is being asked of the party handing over.
          </p>
        ) : null}

        {editable && undeclared.length > 0 ? (
          <div className="flex flex-wrap items-end gap-2">
            <Field label="Require another artefact" className="min-w-[16rem] flex-1">
              <Select value={addKind} onChange={(e) => setAddKind(e.target.value)}>
                <option value="">Choose an artefact kind…</option>
                {undeclared.map((k) => (
                  <option key={k} value={k}>
                    {artefactLabel(k)}
                  </option>
                ))}
              </Select>
            </Field>
            <Button
              size="sm"
              variant="secondary"
              disabled={addKind === ""}
              loading={busy === "addKind"}
              onClick={addKindToContents}
            >
              Require it
            </Button>
          </div>
        ) : null}
      </section>

      {/* ---------------- BLOCKING RECORDS, BY NAME ---------------- */}
      <section className="space-y-2.5">
        <SectionTitle
          title="What is holding this package"
          hint={`Strictness is "${readiness.strictness}". ${STRICTNESS_MEANING[readiness.strictness] ?? ""}`}
        />
        {readiness.clear ? (
          <Alert tone="success" variant="subtle" title="Nothing is outstanding">
            Every required artefact is present, and no punch item or NCR against this package&apos;s
            systems is open.
          </Alert>
        ) : (
          <>
            <Alert
              tone={readiness.wouldBlock ? "danger" : "warning"}
              title={
                readiness.wouldBlock
                  ? "Submission and acceptance are refused while these stand"
                  : "These are outstanding — acceptance is permitted but demonstrably informed"
              }
            >
              <ReasonList reasons={readiness.outstanding} className="text-content-muted" />
            </Alert>

            {readiness.openPunchItems.length > 0 ? (
              <div className="space-y-1.5">
                <h4 className="text-label uppercase tracking-wide text-content-subtle">
                  Open punch items ({readiness.openPunchItems.length})
                </h4>
                <ul className="space-y-1">
                  {readiness.openPunchItems.map((p) => (
                    <li
                      key={p.id}
                      className={cx(
                        "flex items-center justify-between gap-2 rounded-md border p-2.5 text-meta",
                        toneClass("warning", "subtle"),
                        toneClass("warning", "border"),
                      )}
                    >
                      <span className="min-w-0">
                        <span className="font-mono text-2xs">#{p.number}</span> {p.title}
                      </span>
                      <Badge tone="warning" size="xs" dot>
                        {labelize(p.status)}
                      </Badge>
                    </li>
                  ))}
                </ul>
              </div>
            ) : null}

            {readiness.openNcrs.length > 0 ? (
              <div className="space-y-1.5">
                <h4 className="text-label uppercase tracking-wide text-content-subtle">
                  Open NCRs ({readiness.openNcrs.length})
                </h4>
                <ul className="space-y-1">
                  {readiness.openNcrs.map((n) => (
                    <li
                      key={n.id}
                      className={cx(
                        "flex flex-wrap items-center justify-between gap-2 rounded-md border p-2.5 text-meta",
                        toneClass("danger", "subtle"),
                        toneClass("danger", "border"),
                      )}
                    >
                      <span className="min-w-0">
                        <span className="font-mono text-2xs">{n.reference}</span> {n.title}
                      </span>
                      <span className="flex items-center gap-1.5">
                        <Badge tone={DISPOSITION_TONE[n.disposition] ?? "neutral"} size="xs">
                          {labelize(n.disposition)}
                        </Badge>
                        <Badge tone={NCR_STATUS_TONE[n.status] ?? "neutral"} size="xs" dot>
                          {labelize(n.status)}
                        </Badge>
                      </span>
                    </li>
                  ))}
                </ul>
              </div>
            ) : null}
          </>
        )}
      </section>

      {/* ---------------- systems ---------------- */}
      <section className="space-y-2">
        <SectionTitle
          title={`Systems in this package (${readiness.systems.length})`}
          hint="Acceptance moves these systems' twin assets from a construction record to an operations one."
        />
        {readiness.systems.length === 0 ? (
          <p className="text-meta text-content-subtle">
            This package names no commissioning system, so no punch item or NCR can be traced to it
            and its blocking check has nothing to look at. The gap above is all the platform can
            tell you.
          </p>
        ) : (
          <ul className="flex flex-wrap gap-1.5">
            {readiness.systems.map((s) => (
              <li key={s.id}>
                <Badge tone={CX_STATUS_TONE[s.status] ?? "neutral"} size="xs" variant="outline">
                  {s.systemCode} · {labelize(s.status)}
                  {s.assetId ? "" : " · no twin asset"}
                </Badge>
              </li>
            ))}
          </ul>
        )}
      </section>

      {/* ---------------- the record ---------------- */}
      <section className="space-y-2.5">
        <SectionTitle title="The handover" />
        <Facts
          columns={3}
          items={[
            { label: "Type", value: labelize(pkg.packageType) },
            {
              label: "Submitted",
              value: pkg.submittedAt ? dateTime(pkg.submittedAt) : "not submitted",
              hint: pkg.submittedBy ? `by ${nameOf(users, pkg.submittedBy)}` : undefined,
            },
            {
              label: "Reviewed",
              value: pkg.reviewedAt ? dateTime(pkg.reviewedAt) : "not reviewed",
              hint: pkg.reviewedBy ? `by ${nameOf(users, pkg.reviewedBy)}` : undefined,
            },
            {
              label: "Accepted",
              value: pkg.acceptedAt ? dateTime(pkg.acceptedAt) : "not accepted",
              hint: pkg.acceptedBy
                ? `by ${nameOf(users, pkg.acceptedBy)} — never the submitter`
                : "Acceptance is refused to whoever submitted it.",
            },
            {
              label: "Resubmissions",
              value: String(pkg.resubmissionCount),
            },
            {
              label: "Assets handed over",
              value: pkg.assetCount === 0 ? "none yet" : String(pkg.assetCount),
              hint: pkg.assetHandoverCompletedAt
                ? `into the twin on ${isoDate(pkg.assetHandoverCompletedAt)}`
                : "Acceptance writes into the twin's asset register.",
            },
            {
              label: "COBie export",
              value: pkg.cobieFileId ?? "not attached",
            },
            {
              label: "Warranty start",
              value: pkg.warrantyStartDate ? isoDate(pkg.warrantyStartDate) : "not set",
            },
            {
              label: "Beneficial use",
              value: pkg.beneficialUseDate ? isoDate(pkg.beneficialUseDate) : "not set",
            },
          ]}
        />
        {pkg.reviewComments ? (
          <Alert tone="info" size="sm" variant="subtle" title="Review comments">
            <p className="whitespace-pre-wrap">{pkg.reviewComments}</p>
          </Alert>
        ) : null}
        {pkg.rejectionReason ? (
          <Alert tone="danger" size="sm" title="Rejected">
            <p className="whitespace-pre-wrap">{pkg.rejectionReason}</p>
          </Alert>
        ) : null}

        <div className="flex flex-wrap items-center gap-2">
          <Button
            size="sm"
            variant="secondary"
            loading={busy === "submit"}
            disabled={
              !["draft", "assembling", "comments_issued", "rejected"].includes(pkg.status)
            }
            onClick={submit}
          >
            Submit for acceptance
          </Button>
          <Button
            size="sm"
            variant="primary"
            disabled={!["submitted", "resubmitted", "under_review"].includes(pkg.status)}
            onClick={() => setAcceptOpen(true)}
          >
            Accept and hand over
          </Button>
          <Button
            size="sm"
            variant="ghost"
            loading={busy === "reject"}
            disabled={!["submitted", "resubmitted", "under_review"].includes(pkg.status)}
            onClick={reject}
          >
            Reject
          </Button>
        </div>
        {readiness.wouldBlock ? (
          <p className="text-2xs text-danger-fg">
            Strictness is <strong>block</strong>, so the API will refuse both submission and
            acceptance until the records named above are closed. That refusal is the last leverage
            anybody has to get the missing certificate.
          </p>
        ) : null}
      </section>

      <AcceptModal
        open={acceptOpen}
        onClose={() => setAcceptOpen(false)}
        base={base}
        pkg={pkg}
        onDone={onMutated}
      />
      {dialog}
    </div>
  );
}

/* ================================================================== */

function ArtefactRow({
  entry,
  editable,
  busy,
  onToggle,
}: {
  entry: ArtefactEntry;
  editable: boolean;
  busy: boolean;
  onToggle: (present: boolean) => void;
}) {
  const missing = entry.required && !entry.present;
  return (
    <li
      className={cx(
        "flex flex-wrap items-center justify-between gap-2 rounded-md border p-2.5",
        missing
          ? cx(toneClass("danger", "subtle"), toneClass("danger", "border"))
          : entry.present
            ? cx(toneClass("success", "subtle"), toneClass("success", "border"))
            : "border-border bg-surface-raised",
      )}
    >
      <div className="flex min-w-0 items-center gap-2">
        {entry.present ? (
          <IconCheckCircle className="size-4" />
        ) : (
          <IconClose className="size-4" />
        )}
        <div className="min-w-0">
          <span className="text-meta font-medium">{artefactLabel(entry.kind)}</span>
          <span className="ml-1.5 text-2xs opacity-80">
            {entry.required ? "required" : "not required"}
          </span>
          {entry.note ? <p className="text-2xs opacity-80">{entry.note}</p> : null}
        </div>
      </div>
      <div className="flex items-center gap-1.5">
        {missing ? (
          <Badge tone="danger" size="xs" variant="solid">
            missing
          </Badge>
        ) : entry.present ? (
          <Badge tone="success" size="xs" dot>
            present
          </Badge>
        ) : (
          <Badge tone="neutral" size="xs" variant="outline">
            waived from the requirement
          </Badge>
        )}
        {editable ? (
          <Button size="xs" variant="ghost" loading={busy} onClick={() => onToggle(!entry.present)}>
            {entry.present ? "Mark absent" : "Mark present"}
          </Button>
        ) : null}
      </div>
    </li>
  );
}

function AcceptModal({
  open,
  onClose,
  base,
  pkg,
  onDone,
}: {
  open: boolean;
  onClose: () => void;
  base: string;
  pkg: TurnoverDetail;
  onDone: () => void;
}) {
  const { busy, refusal, clear, run } = useAction();
  const [cobieFileId, setCobieFileId] = useState("");
  const [warrantyStart, setWarrantyStart] = useState(pkg.warrantyStartDate ?? "");
  const [warrantyEnd, setWarrantyEnd] = useState(pkg.warrantyEndDate ?? "");
  const [note, setNote] = useState("");
  const [acceptOutstanding, setAcceptOutstanding] = useState(false);

  async function submit() {
    const done = await run("accept", () =>
      api.post(`${base}/accept`, {
        cobieFileId: cobieFileId.trim() === "" ? null : cobieFileId.trim(),
        warrantyStartDate: warrantyStart === "" ? null : warrantyStart,
        warrantyEndDate: warrantyEnd === "" ? null : warrantyEnd,
        note: note.trim() === "" ? null : note.trim(),
        acceptOutstanding,
      }),
    );
    if (done) {
      onClose();
      onDone();
    }
  }

  const outstanding = pkg.readiness.outstanding;

  return (
    <Modal
      open={open}
      onClose={onClose}
      title={`Accept ${pkg.reference}`}
      description="Acceptance is the hand-over: the twin's assets stop being a construction artefact and become an operations one. It is refused to whoever submitted the package."
      footer={
        <div className="flex justify-end gap-2">
          <Button variant="ghost" onClick={onClose}>
            Cancel
          </Button>
          <Button variant="primary" loading={busy === "accept"} onClick={submit}>
            Accept and hand over
          </Button>
        </div>
      }
    >
      <div className="space-y-3">
        <RefusalNotice refusal={refusal} onDismiss={clear} />
        {outstanding.length > 0 ? (
          <Alert
            tone={pkg.readiness.wouldBlock ? "danger" : "warning"}
            title={`${outstanding.length} ${plural(outstanding.length, "thing")} outstanding`}
          >
            <ReasonList reasons={outstanding} />
            {!pkg.readiness.wouldBlock ? (
              <Checkbox
                className="mt-2"
                size="sm"
                checked={acceptOutstanding}
                onChange={(e) => setAcceptOutstanding(e.target.checked)}
                label="I am accepting this package with the items above outstanding"
                description="The acknowledgement goes on the record with the list of what was outstanding at the time."
              />
            ) : null}
          </Alert>
        ) : null}
        <Field label="COBie file id" hint="The structured asset export the operator will load.">
          <Input value={cobieFileId} onChange={(e) => setCobieFileId(e.target.value)} />
        </Field>
        <div className="grid gap-3 sm:grid-cols-2">
          <Field label="Warranty start">
            <Input
              type="date"
              value={warrantyStart}
              onChange={(e) => setWarrantyStart(e.target.value)}
            />
          </Field>
          <Field label="Warranty end">
            <Input
              type="date"
              value={warrantyEnd}
              onChange={(e) => setWarrantyEnd(e.target.value)}
            />
          </Field>
        </div>
        <Field label="Note">
          <Textarea rows={2} value={note} onChange={(e) => setNote(e.target.value)} />
        </Field>
      </div>
    </Modal>
  );
}
