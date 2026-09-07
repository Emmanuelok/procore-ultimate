/**
 * ONE NON-CONFORMANCE REPORT — and the disposition workflow, which is the
 * whole reason the register exists.
 *
 * The workflow is drawn as two SEPARATE acts by two SEPARATE people, because
 * that is what it is:
 *
 *   PROPOSE   somebody says what should happen to the non-conforming work.
 *   APPROVE   somebody ELSE agrees. The API refuses the case where they are
 *             the same person, and a `use_as_is` additionally requires the
 *             designer's concession reference before it will be approved at
 *             all.
 *
 * When that refusal fires it is presented as the control working. A use-as-is
 * approved by its own proposer is a decision nobody independent ever made, and
 * it is the single most common way non-conforming work ends up permanently in
 * a building behind a paper trail that looks fine. The platform declining to
 * be the place that record was created IS the product.
 *
 * Corrective actions are not kept here. They are rows in the project's one
 * corrective-action register (`safety_corrective_actions`, sourceType "ncr"),
 * so a project has one overdue-actions list rather than a safety one and a
 * quality one — and this screen says so rather than quietly presenting them as
 * its own.
 */
import { useState } from "react";
import {
  Alert,
  Badge,
  Button,
  Drawer,
  Field,
  Input,
  Modal,
  Select,
  Skeleton,
  Textarea,
} from "../../ui";
import { cx } from "../../ui/cx";
import { toneClass, type Tone } from "../../ui/tokens";
import { api } from "../../lib/api";
import { useAuth } from "../../lib/auth";
import {
  CONCESSION_DISPOSITIONS,
  DISPOSITION_MEANING,
  DISPOSITION_TONE,
  EM_DASH,
  EditModal,
  Facts,
  LoadError,
  NCR_SEVERITY_TONE,
  NCR_STATUS_TONE,
  RefusalNotice,
  SectionTitle,
  dateTime,
  isoDate,
  labelize,
  money,
  nameOf,
  plural,
  todayIso,
  useAction,
  useReason,
  useResource,
  type EditFieldSpec,
} from "./qualityShared";
import type { CorrectiveAction, NcrDetail } from "./types";

/*
 * What may be corrected on a raised non-conformance: what it is, where it is,
 * what it is worth and when a response is due. The status, the disposition and
 * both signatures are absent by design — the API refuses to move them through
 * an edit, because a disposition that could be changed by editing the record
 * would make the two-person control decorative.
 */
const NCR_EDIT_FIELDS: readonly EditFieldSpec[] = [
  { key: "title", label: "Title", kind: "text", nullable: false, wide: true },
  { key: "description", label: "What is non-conforming", kind: "textarea", nullable: false },
  {
    key: "severity",
    label: "Severity",
    kind: "select",
    nullable: false,
    options: ["minor", "major", "critical"].map((value) => ({ value, label: labelize(value) })),
  },
  { key: "specClauseRef", label: "Specification clause", kind: "text" },
  { key: "drawingReference", label: "Drawing", kind: "text" },
  { key: "locationText", label: "Location", kind: "text" },
  { key: "quantityAffected", label: "Quantity affected", kind: "number" },
  { key: "unit", label: "Unit", kind: "text" },
  { key: "responseDueDate", label: "Response due", kind: "date" },
  {
    key: "costImpact",
    label: "Cost impact",
    kind: "number",
    hint: "In the currency below. The register buckets by currency and never sums across them.",
  },
  { key: "currency", label: "Currency", kind: "text", nullable: false, placeholder: "GBP" },
  { key: "scheduleImpactDays", label: "Schedule impact (days)", kind: "number" },
];

const PROPOSABLE = ["rework", "repair", "use_as_is", "reject", "return_to_supplier", "regrade"];

const ROOT_CAUSE_METHODS = [
  "five_whys",
  "fishbone",
  "taproot",
  "bowtie",
  "fault_tree",
  "icam",
  "none",
];

export default function NcrDrawer({
  ncrId,
  projectId,
  users,
  onClose,
  onMutated,
}: {
  ncrId: string | null;
  projectId: string;
  users: Map<string, string>;
  onClose: () => void;
  onMutated: () => void;
}) {
  const [nonce, setNonce] = useState(0);
  const detail = useResource<NcrDetail>(
    (signal) => api.get<NcrDetail>(`/api/v1/projects/${projectId}/ncrs/${ncrId}`, { signal }),
    [projectId, ncrId, nonce],
    ncrId !== null,
  );

  function refresh() {
    setNonce((n) => n + 1);
    onMutated();
  }

  return (
    <Drawer
      open={ncrId !== null}
      onClose={onClose}
      size="xl"
      title={detail.data ? `${detail.data.reference} · ${detail.data.title}` : "Non-conformance report"}
      description={
        detail.data
          ? `${labelize(detail.data.severity)} · ${labelize(detail.data.category)} · raised from ${labelize(detail.data.sourceType)}`
          : undefined
      }
      resizable
      resizeStorageKey="quality.ncr.drawer"
    >
      {ncrId === null ? null : detail.error ? (
        <div className="p-4">
          <LoadError message={detail.error} onRetry={detail.reload} title="This NCR could not be loaded" />
        </div>
      ) : detail.loading && !detail.data ? (
        <div className="space-y-3 p-4">
          <Skeleton height={140} />
          <Skeleton height={200} />
          <Skeleton height={160} />
        </div>
      ) : detail.data ? (
        <NcrBody ncr={detail.data} projectId={projectId} users={users} onMutated={refresh} />
      ) : null}
    </Drawer>
  );
}

/* ================================================================== */

function NcrBody({
  ncr,
  projectId,
  users,
  onMutated,
}: {
  ncr: NcrDetail;
  projectId: string;
  users: Map<string, string>;
  onMutated: () => void;
}) {
  const { user } = useAuth();
  const { busy, refusal, clear, run } = useAction();
  const { ask, dialog } = useReason();
  const [proposeOpen, setProposeOpen] = useState(false);
  const [approveOpen, setApproveOpen] = useState(false);
  const [closeOpen, setCloseOpen] = useState(false);
  const [rootCauseOpen, setRootCauseOpen] = useState(false);
  const [editOpen, setEditOpen] = useState(false);

  const base = `/api/v1/projects/${projectId}/ncrs/${ncr.id}`;
  const meIsProposer = user !== null && ncr.dispositionProposedBy === user.id;
  const overdue =
    ncr.responseDueDate !== null && ncr.responseDueDate < todayIso() && ncr.status !== "closed";

  async function verify() {
    const method = await ask({
      title: `Verify the closeout of ${ncr.reference}`,
      description:
        "Verification is a separate person from the one who submitted the evidence. Say how the fix was verified — a re-inspection reference, a witnessed retest, a survey.",
      label: "Verification method",
      confirmLabel: "Record the verification",
    });
    if (!method) return;
    const done = await run("verify", () => api.post(`${base}/verify`, { verificationMethod: method }));
    if (done) onMutated();
  }

  /**
   * SEND BACK is not a rejection of the non-conformance; it is a rejection of
   * the DISPOSITION. It clears the proposal and the approval together, because
   * an approval belongs to the disposition it approved.
   */
  async function sendBack() {
    const reason = await ask({
      title: `Send the disposition on ${ncr.reference} back`,
      description:
        "The proposal returns to under review and both signatures are cleared. Say what is wrong with it — the person re-proposing reads this and nothing else.",
      label: "What needs rethinking?",
      confirmLabel: "Send it back",
    });
    if (!reason) return;
    const done = await run("send-back", () => api.post(`${base}/send-back`, { reason }));
    if (done) onMutated();
  }

  async function voidNcr() {
    const reason = await ask({
      title: `Void ${ncr.reference}`,
      description:
        "Voiding says the non-conformance should never have been raised — a duplicate, a mistake, work that was compliant after all. It is not the same as closing it, and the register keeps the two apart.",
      label: "Why was it raised in error?",
      confirmLabel: "Void it",
      destructive: true,
    });
    if (!reason) return;
    const done = await run("void", () => api.post(`${base}/void`, { reason }));
    if (done) onMutated();
  }

  async function reopen() {
    const reason = await ask({
      title: `Reopen ${ncr.reference}`,
      description:
        "A closed NCR is the record that the non-conformance was fixed and independently verified. Reopening it says that record was wrong, so the reason travels with it.",
      label: "Why is this being reopened?",
      confirmLabel: "Reopen",
      destructive: true,
    });
    if (!reason) return;
    const done = await run("reopen", () => api.post(`${base}/reopen`, { reason }));
    if (done) onMutated();
  }

  return (
    <div className="space-y-5 p-4">
      <RefusalNotice refusal={refusal} onDismiss={clear} />

      {/* -------- headline -------- */}
      <section className="space-y-2.5">
        <div className="flex flex-wrap items-center gap-1.5">
          <Badge tone={NCR_STATUS_TONE[ncr.status] ?? "neutral"} size="sm" dot>
            {labelize(ncr.status)}
          </Badge>
          <Badge tone={NCR_SEVERITY_TONE[ncr.severity] ?? "neutral"} size="sm">
            {labelize(ncr.severity)}
          </Badge>
          {ncr.isBackcharged === 1 ? (
            <Badge tone="warning" size="sm" variant="outline">
              backcharged
            </Badge>
          ) : null}
          {ncr.reopenedCount > 0 ? (
            <Badge tone="warning" size="sm" variant="outline">
              reopened {ncr.reopenedCount}×
            </Badge>
          ) : null}
          {overdue ? (
            <Badge tone="danger" size="sm" variant="solid">
              past its response date
            </Badge>
          ) : null}
        </div>
        <p className="whitespace-pre-wrap text-meta text-content">{ncr.description}</p>
        <Facts
          columns={3}
          items={[
            { label: "Raised by", value: nameOf(users, ncr.createdBy) },
            { label: "Raised from", value: labelize(ncr.sourceType) },
            {
              label: "Detected",
              value: ncr.detectedAt ? dateTime(ncr.detectedAt) : "not recorded",
            },
            {
              label: "Response due",
              value: ncr.responseDueDate ? isoDate(ncr.responseDueDate) : "no date set",
            },
            {
              label: "Against",
              value: ncr.raisedAgainstVendorId ?? "not attributed to a vendor",
            },
            ncr.raisedByOrganisation
              ? { label: "Raised by organisation", value: ncr.raisedByOrganisation }
              : null,
            { label: "Location", value: ncr.locationText ?? "not stated" },
            ncr.specClauseRef ? { label: "Spec clause", value: ncr.specClauseRef } : null,
            ncr.drawingReference ? { label: "Drawing", value: ncr.drawingReference } : null,
            {
              label: "Cost impact",
              value:
                ncr.costImpact === null ? "unmeasured" : money(ncr.costImpact, ncr.currency),
              hint:
                ncr.costImpact === null
                  ? "Not zero — nobody has costed it. It is excluded from every total on this project."
                  : `Recorded in ${ncr.currency}.`,
            },
            {
              label: "Schedule impact",
              value:
                ncr.scheduleImpactDays === null
                  ? "unmeasured"
                  : `${ncr.scheduleImpactDays} ${plural(ncr.scheduleImpactDays, "day")}`,
            },
            {
              label: "Quantity affected",
              value:
                ncr.quantityAffected === null
                  ? "not quantified"
                  : `${ncr.quantityAffected}${ncr.unit ? ` ${ncr.unit}` : ""}`,
            },
          ]}
        />
      </section>

      {/* -------- THE DISPOSITION WORKFLOW -------- */}
      <section className="space-y-3">
        <SectionTitle
          title="Disposition"
          hint="Proposed by one person. Approved by another. That separation is the control."
        />

        <div
          className={cx(
            "rounded-lg border p-3",
            ncr.disposition === "pending"
              ? "border-border bg-surface-raised"
              : cx(
                  toneClass(DISPOSITION_TONE[ncr.disposition] ?? "neutral", "subtle"),
                  toneClass(DISPOSITION_TONE[ncr.disposition] ?? "neutral", "border"),
                ),
          )}
        >
          <div className="flex flex-wrap items-center justify-between gap-2">
            <Badge
              tone={DISPOSITION_TONE[ncr.disposition] ?? "neutral"}
              size="sm"
              variant={CONCESSION_DISPOSITIONS.includes(ncr.disposition) ? "solid" : "subtle"}
            >
              {labelize(ncr.disposition)}
            </Badge>
            {CONCESSION_DISPOSITIONS.includes(ncr.disposition) ? (
              <span className="text-2xs font-medium">
                leaves the departure permanently in the building
              </span>
            ) : null}
          </div>
          {ncr.disposition !== "pending" ? (
            <p className="mt-1.5 text-meta">
              {DISPOSITION_MEANING[ncr.disposition] ?? ""}
            </p>
          ) : (
            <p className="mt-1.5 text-meta text-content-muted">
              Nobody has proposed what should happen to this work yet. Until somebody does, and
              somebody else agrees, there is no decision on the record.
            </p>
          )}
          {ncr.dispositionJustification ? (
            <blockquote className="mt-2 border-l-2 border-current/30 pl-2.5 text-meta">
              {ncr.dispositionJustification}
            </blockquote>
          ) : null}
        </div>

        <div className="grid gap-2.5 sm:grid-cols-2">
          <Step
            index={1}
            title="Proposed"
            tone={ncr.dispositionProposedBy ? "info" : "neutral"}
            done={ncr.dispositionProposedBy !== null}
            who={ncr.dispositionProposedBy ? nameOf(users, ncr.dispositionProposedBy) : null}
            when={ncr.dispositionProposedAt}
            emptyText="No disposition has been proposed."
          />
          <Step
            index={2}
            title="Approved by somebody else"
            tone={ncr.dispositionApprovedBy ? "success" : "warning"}
            done={ncr.dispositionApprovedBy !== null}
            who={ncr.dispositionApprovedBy ? nameOf(users, ncr.dispositionApprovedBy) : null}
            when={ncr.dispositionApprovedAt}
            emptyText={
              ncr.dispositionProposedBy
                ? "Proposed but not approved. Until a second person signs it, nothing independent has happened."
                : "Nothing to approve yet."
            }
          />
        </div>

        {ncr.concessionReference ? (
          <Alert tone="info" size="sm" variant="subtle" title="Concession recorded">
            <p>
              <span className="font-mono">{ncr.concessionReference}</span> — the designer&apos;s
              acceptance that this departure may stay. A use-as-is is not approvable without one.
            </p>
          </Alert>
        ) : null}

        {meIsProposer && ncr.status === "disposition_proposed" ? (
          <Alert
            tone="warning"
            title="You proposed this disposition, so you cannot approve it"
          >
            The API will refuse an approval from you on {ncr.reference}, and that refusal is the
            point of this register: a{" "}
            {CONCESSION_DISPOSITIONS.includes(ncr.disposition)
              ? `"${labelize(ncr.disposition).toLowerCase()}"`
              : "disposition"}{" "}
            approved by the person who proposed it is a decision nobody independent ever made. Hand
            it to the engineer, the designer or the client.
          </Alert>
        ) : null}

        <div className="flex flex-wrap items-center gap-2">
          <Button
            size="sm"
            variant="secondary"
            disabled={!["open", "under_review", "disposition_proposed"].includes(ncr.status)}
            onClick={() => setProposeOpen(true)}
          >
            {ncr.dispositionProposedBy ? "Propose a different disposition" : "Propose a disposition"}
          </Button>
          <Button
            size="sm"
            variant="primary"
            disabled={ncr.status !== "disposition_proposed"}
            onClick={() => setApproveOpen(true)}
          >
            Decide on the proposal
          </Button>
          <Button
            size="sm"
            variant="ghost"
            loading={busy === "send-back"}
            disabled={
              !["disposition_proposed", "disposition_approved", "action_in_progress"].includes(
                ncr.status,
              )
            }
            onClick={sendBack}
          >
            Send the disposition back
          </Button>
        </div>
      </section>

      {/* -------- cause and cure -------- */}
      <section className="space-y-2.5">
        <SectionTitle
          title="Cause and cure"
          hint="Corrective actions live in the project's one action register, not in a second quality-only list."
          actions={
            <Button size="sm" variant="ghost" onClick={() => setRootCauseOpen(true)}>
              Record a root cause
            </Button>
          }
        />
        {ncr.rootCause ? (
          <div className="rounded-md border border-border bg-surface-raised p-2.5">
            <p className="text-label uppercase tracking-wide text-content-subtle">
              Root cause · {labelize(ncr.rootCauseMethod)}
            </p>
            <p className="mt-1 whitespace-pre-wrap text-meta">{ncr.rootCause}</p>
            {ncr.correctiveActionSummary ? (
              <p className="mt-2 text-meta">
                <span className="text-content-subtle">Corrective: </span>
                {ncr.correctiveActionSummary}
              </p>
            ) : null}
            {ncr.preventiveActionSummary ? (
              <p className="mt-1 text-meta">
                <span className="text-content-subtle">Preventive: </span>
                {ncr.preventiveActionSummary}
              </p>
            ) : null}
          </div>
        ) : (
          <p className="text-meta text-content-subtle">
            No root cause is recorded. Without one, the corrective actions below treat the symptom
            and nothing stops the same departure happening on the next pour.
          </p>
        )}
        <ActionList actions={ncr.correctiveActions} users={users} />
        <RaiseAction base={base} onDone={onMutated} />
      </section>

      {/* -------- closeout -------- */}
      <section className="space-y-2.5">
        <SectionTitle
          title="Closeout and verification"
          hint="Evidence is submitted by one person and verified by another. Both names stay on the record."
        />
        <div className="grid gap-2.5 sm:grid-cols-2">
          <Step
            index={1}
            title="Closeout evidence submitted"
            tone={ncr.closedBy ? "info" : "neutral"}
            done={ncr.closedBy !== null}
            who={ncr.closedBy ? nameOf(users, ncr.closedBy) : null}
            when={ncr.closedAt}
            emptyText="No closeout evidence has been submitted."
          />
          <Step
            index={2}
            title="Independently verified"
            tone={ncr.verifiedBy ? "success" : "warning"}
            done={ncr.verifiedBy !== null}
            who={ncr.verifiedBy ? nameOf(users, ncr.verifiedBy) : null}
            when={ncr.verifiedAt}
            emptyText="Not verified. An NCR closed on its own author's word is not closed."
          />
        </div>
        {ncr.closeoutEvidenceDescription ? (
          <div className="rounded-md border border-border bg-surface-raised p-2.5">
            <p className="text-label uppercase tracking-wide text-content-subtle">Evidence</p>
            <p className="mt-1 whitespace-pre-wrap text-meta">{ncr.closeoutEvidenceDescription}</p>
            {ncr.verificationMethod ? (
              <p className="mt-1.5 text-2xs text-content-muted">
                Verified by {ncr.verificationMethod}.
              </p>
            ) : null}
          </div>
        ) : null}
        <div className="flex flex-wrap items-center gap-2">
          <Button
            size="sm"
            variant="secondary"
            disabled={ncr.status === "closed" || ncr.status === "void"}
            onClick={() => setCloseOpen(true)}
          >
            Submit closeout evidence
          </Button>
          <Button
            size="sm"
            variant="primary"
            loading={busy === "verify"}
            disabled={ncr.status !== "verification_pending"}
            onClick={verify}
          >
            Verify and close
          </Button>
          <Button
            size="sm"
            variant="ghost"
            loading={busy === "reopen"}
            disabled={ncr.status !== "closed"}
            onClick={reopen}
          >
            Reopen
          </Button>
          <Button
            size="sm"
            variant="ghost"
            loading={busy === "void"}
            disabled={ncr.status === "closed" || ncr.status === "void"}
            onClick={voidNcr}
          >
            Void — it should not have been raised
          </Button>
          <Button
            size="sm"
            variant="ghost"
            disabled={ncr.status === "void"}
            onClick={() => setEditOpen(true)}
          >
            Correct the record
          </Button>
        </div>

        <EditModal
          open={editOpen}
          onClose={() => setEditOpen(false)}
          title={`Correct ${ncr.reference}`}
          description="What the non-conformance is, where it is and what it is costing. The status, the disposition and the two signatures on it cannot be changed here — they are acts, not fields."
          url={base}
          fields={NCR_EDIT_FIELDS}
          record={ncr as unknown as Record<string, unknown>}
          onSaved={onMutated}
        />
      </section>

      {/* -------- recovering the cost -------- */}
      <section className="space-y-2.5">
        <SectionTitle
          title="Recovering the cost"
          hint="A backcharge is a change event against the responsible subcontractor, raised in the project's own commercial register rather than a quality-only note."
        />
        {ncr.isBackcharged === 1 ? (
          <Alert tone="info" size="sm" variant="subtle" title="Backcharged">
            <p>
              {ncr.backchargeReference
                ? `Reference ${ncr.backchargeReference}. `
                : ""}
              A change event carries the recovery; the amount is argued there, on the evidence in
              this record.
            </p>
          </Alert>
        ) : ncr.raisedAgainstVendorId === null ? (
          <p className="text-meta text-content-subtle">
            This NCR names no responsible vendor, so there is nobody to backcharge. Record the
            subcontractor it is raised against first — the API refuses otherwise, and it is right
            to: a backcharge with no counterparty is a number with nobody to send it to.
          </p>
        ) : (
          <Backcharge base={base} ncr={ncr} onDone={onMutated} />
        )}
      </section>

      <ProposeModal
        open={proposeOpen}
        onClose={() => setProposeOpen(false)}
        base={base}
        currency={ncr.currency}
        onDone={onMutated}
      />
      <ApproveModal
        open={approveOpen}
        onClose={() => setApproveOpen(false)}
        base={base}
        ncr={ncr}
        onDone={onMutated}
      />
      <CloseoutModal
        open={closeOpen}
        onClose={() => setCloseOpen(false)}
        base={base}
        onDone={onMutated}
      />
      <RootCauseModal
        open={rootCauseOpen}
        onClose={() => setRootCauseOpen(false)}
        base={base}
        ncr={ncr}
        onDone={onMutated}
      />
      {dialog}
    </div>
  );
}

/* ================================================================== */

function Step({
  index,
  title,
  tone,
  done,
  who,
  when,
  emptyText,
}: {
  index: number;
  title: string;
  tone: Tone;
  done: boolean;
  who: string | null;
  when: string | null;
  emptyText: string;
}) {
  return (
    <div
      className={cx(
        "rounded-md border p-2.5",
        done
          ? cx(toneClass(tone, "subtle"), toneClass(tone, "border"))
          : "border-dashed border-border bg-surface-raised",
      )}
    >
      <div className="flex items-center gap-1.5">
        <span
          className={cx(
            "inline-flex size-4 items-center justify-center rounded-full text-2xs font-semibold",
            done ? toneClass(tone, "solid") : "bg-neutral-subtle text-content-subtle",
          )}
        >
          {index}
        </span>
        <span className="text-label uppercase tracking-wide">{title}</span>
      </div>
      {done ? (
        <div className="mt-1.5 space-y-0.5 text-2xs">
          <div className="font-medium">{who ?? EM_DASH}</div>
          <div className="tabular-nums opacity-80">{dateTime(when)}</div>
        </div>
      ) : (
        <p className="mt-1.5 text-2xs text-content-muted">{emptyText}</p>
      )}
    </div>
  );
}

function ActionList({
  actions,
  users,
}: {
  actions: readonly CorrectiveAction[];
  users: Map<string, string>;
}) {
  if (actions.length === 0) {
    return (
      <p className="text-meta text-content-subtle">
        No corrective action is raised against this NCR. Actions are rows in the project&apos;s
        shared corrective-action register, so raising one here puts it on the same overdue list as
        every safety action rather than in a second queue nobody reads.
      </p>
    );
  }
  const today = todayIso();
  return (
    <ul className="space-y-1.5">
      {actions.map((a) => {
        const open = !["closed", "cancelled", "verified"].includes(a.status);
        const late = open && a.dueDate < today;
        return (
          <li
            key={a.id}
            className={cx(
              "flex flex-wrap items-center justify-between gap-2 rounded-md border p-2.5",
              late
                ? cx(toneClass("danger", "subtle"), toneClass("danger", "border"))
                : "border-border bg-surface-raised",
            )}
          >
            <div className="min-w-0">
              <span className="font-mono text-2xs text-content-subtle">{a.reference}</span>
              <p className="text-meta font-medium">{a.title}</p>
              <p className="text-2xs text-content-subtle">
                {a.ownerName ?? (a.ownerId ? nameOf(users, a.ownerId) : "unassigned")} · due{" "}
                {isoDate(a.dueDate)}
              </p>
            </div>
            <div className="flex items-center gap-1.5">
              {late ? (
                <Badge tone="danger" size="xs" variant="solid">
                  overdue
                </Badge>
              ) : null}
              <Badge tone={open ? "warning" : "success"} size="xs" dot>
                {labelize(a.status)}
              </Badge>
            </div>
          </li>
        );
      })}
    </ul>
  );
}

/* ================================================================== */
/* Modals                                                              */
/* ================================================================== */

function ProposeModal({
  open,
  onClose,
  base,
  currency,
  onDone,
}: {
  open: boolean;
  onClose: () => void;
  base: string;
  currency: string;
  onDone: () => void;
}) {
  const { busy, refusal, clear, run } = useAction();
  const [disposition, setDisposition] = useState("rework");
  const [justification, setJustification] = useState("");
  const [cost, setCost] = useState("");

  async function submit() {
    const parsed = cost.trim() === "" ? null : Number(cost);
    const done = await run("propose", () =>
      api.post(`${base}/disposition/propose`, {
        disposition,
        justification: justification.trim(),
        ...(parsed !== null && Number.isFinite(parsed) ? { costImpact: parsed, currency } : {}),
      }),
    );
    if (done) {
      onClose();
      setJustification("");
      setCost("");
      onDone();
    }
  }

  const concession = CONCESSION_DISPOSITIONS.includes(disposition);

  return (
    <Modal
      open={open}
      onClose={onClose}
      title="Propose a disposition"
      description="This is a proposal, not a decision. Somebody else has to agree with it before it becomes one."
      footer={
        <div className="flex justify-end gap-2">
          <Button variant="ghost" onClick={onClose}>
            Cancel
          </Button>
          <Button
            variant="primary"
            loading={busy === "propose"}
            disabled={justification.trim().length === 0}
            onClick={submit}
          >
            Propose it
          </Button>
        </div>
      }
    >
      <div className="space-y-3">
        <RefusalNotice refusal={refusal} onDismiss={clear} />
        <Field label="Disposition" required>
          <Select value={disposition} onChange={(e) => setDisposition(e.target.value)}>
            {PROPOSABLE.map((d) => (
              <option key={d} value={d}>
                {labelize(d)}
              </option>
            ))}
          </Select>
        </Field>
        <div
          className={cx(
            "rounded-md border p-2.5 text-meta",
            concession
              ? cx(toneClass("warning", "subtle"), toneClass("warning", "border"))
              : "border-border bg-surface-raised",
          )}
        >
          {DISPOSITION_MEANING[disposition]}
        </div>
        <Field
          label="Justification"
          required
          hint="Read by whoever has to approve it, and by whoever reads the file in five years."
        >
          <Textarea
            rows={4}
            value={justification}
            onChange={(e) => setJustification(e.target.value)}
          />
        </Field>
        <Field label={`Cost impact (${currency})`} hint="Leave blank if nobody has costed it — a blank is honest, a zero is not.">
          <Input
            type="number"
            value={cost}
            onChange={(e) => setCost(e.target.value)}
            placeholder="not costed"
          />
        </Field>
      </div>
    </Modal>
  );
}

function ApproveModal({
  open,
  onClose,
  base,
  ncr,
  onDone,
}: {
  open: boolean;
  onClose: () => void;
  base: string;
  ncr: NcrDetail;
  onDone: () => void;
}) {
  const { busy, refusal, clear, run } = useAction();
  const [decision, setDecision] = useState<"approve" | "reject">("approve");
  const [comments, setComments] = useState("");
  const [concessionReference, setConcessionReference] = useState("");

  const needsConcession = decision === "approve" && ncr.disposition === "use_as_is";

  async function submit() {
    const done = await run("approve", () =>
      api.post(`${base}/disposition/approve`, {
        decision,
        comments: comments.trim() === "" ? null : comments.trim(),
        concessionReference:
          concessionReference.trim() === "" ? null : concessionReference.trim(),
      }),
    );
    if (done) {
      onClose();
      setComments("");
      setConcessionReference("");
      onDone();
    }
  }

  return (
    <Modal
      open={open}
      onClose={onClose}
      title={`Decide on the "${labelize(ncr.disposition)}" proposed for ${ncr.reference}`}
      description="The approver must be somebody other than the proposer. If that is you, the platform will say so — and it will be right to."
      footer={
        <div className="flex justify-end gap-2">
          <Button variant="ghost" onClick={onClose}>
            Cancel
          </Button>
          <Button
            variant={decision === "approve" ? "primary" : "danger"}
            loading={busy === "approve"}
            disabled={needsConcession && concessionReference.trim().length === 0}
            onClick={submit}
          >
            {decision === "approve" ? "Approve the disposition" : "Send it back"}
          </Button>
        </div>
      }
    >
      <div className="space-y-3">
        <RefusalNotice refusal={refusal} onDismiss={clear} />
        <div className="rounded-md border border-border bg-surface-raised p-2.5 text-meta">
          <p className="font-medium">{labelize(ncr.disposition)}</p>
          <p className="mt-0.5 text-content-muted">{DISPOSITION_MEANING[ncr.disposition] ?? ""}</p>
          {ncr.dispositionJustification ? (
            <blockquote className="mt-1.5 border-l-2 border-border pl-2.5 text-content">
              {ncr.dispositionJustification}
            </blockquote>
          ) : null}
        </div>
        <Field label="Decision" required>
          <Select
            value={decision}
            onChange={(e) => setDecision(e.target.value as "approve" | "reject")}
          >
            <option value="approve">Approve — this is what will happen</option>
            <option value="reject">Send it back for a different proposal</option>
          </Select>
        </Field>
        {needsConcession ? (
          <Field
            label="Concession reference"
            required
            hint="A use-as-is leaves non-conforming work permanently in the building. The API will not approve one without the designer's concession on the record."
          >
            <Input
              value={concessionReference}
              onChange={(e) => setConcessionReference(e.target.value)}
              placeholder="e.g. CON-014"
            />
          </Field>
        ) : null}
        <Field label="Comments">
          <Textarea rows={3} value={comments} onChange={(e) => setComments(e.target.value)} />
        </Field>
      </div>
    </Modal>
  );
}

function CloseoutModal({
  open,
  onClose,
  base,
  onDone,
}: {
  open: boolean;
  onClose: () => void;
  base: string;
  onDone: () => void;
}) {
  const { busy, refusal, clear, run } = useAction();
  const [evidence, setEvidence] = useState("");

  async function submit() {
    const done = await run("close", () =>
      api.post(`${base}/close`, { closeoutEvidenceDescription: evidence.trim() }),
    );
    if (done) {
      onClose();
      setEvidence("");
      onDone();
    }
  }

  return (
    <Modal
      open={open}
      onClose={onClose}
      title="Submit closeout evidence"
      description="This does not close the NCR. It moves it to awaiting verification by somebody else — which is what makes a closure defensible."
      footer={
        <div className="flex justify-end gap-2">
          <Button variant="ghost" onClick={onClose}>
            Cancel
          </Button>
          <Button
            variant="primary"
            loading={busy === "close"}
            disabled={evidence.trim().length === 0}
            onClick={submit}
          >
            Submit for verification
          </Button>
        </div>
      }
    >
      <div className="space-y-3">
        <RefusalNotice refusal={refusal} onDismiss={clear} />
        <Field
          label="What was done, and what proves it"
          required
          hint="The API refuses closeout while any corrective action is still open, and before a disposition has been approved by somebody independent."
        >
          <Textarea rows={4} value={evidence} onChange={(e) => setEvidence(e.target.value)} />
        </Field>
      </div>
    </Modal>
  );
}

function RootCauseModal({
  open,
  onClose,
  base,
  ncr,
  onDone,
}: {
  open: boolean;
  onClose: () => void;
  base: string;
  ncr: NcrDetail;
  onDone: () => void;
}) {
  const { busy, refusal, clear, run } = useAction();
  const [rootCause, setRootCause] = useState(ncr.rootCause ?? "");
  const [method, setMethod] = useState(ncr.rootCauseMethod);
  const [corrective, setCorrective] = useState(ncr.correctiveActionSummary ?? "");
  const [preventive, setPreventive] = useState(ncr.preventiveActionSummary ?? "");

  async function submit() {
    const done = await run("rootCause", () =>
      api.post(`${base}/root-cause`, {
        rootCause: rootCause.trim(),
        rootCauseMethod: method,
        correctiveActionSummary: corrective.trim() === "" ? null : corrective.trim(),
        preventiveActionSummary: preventive.trim() === "" ? null : preventive.trim(),
      }),
    );
    if (done) {
      onClose();
      onDone();
    }
  }

  return (
    <Modal
      open={open}
      onClose={onClose}
      title="Record the root cause"
      footer={
        <div className="flex justify-end gap-2">
          <Button variant="ghost" onClick={onClose}>
            Cancel
          </Button>
          <Button
            variant="primary"
            loading={busy === "rootCause"}
            disabled={rootCause.trim().length === 0}
            onClick={submit}
          >
            Record it
          </Button>
        </div>
      }
    >
      <div className="space-y-3">
        <RefusalNotice refusal={refusal} onDismiss={clear} />
        <Field label="Method">
          <Select value={method} onChange={(e) => setMethod(e.target.value)}>
            {ROOT_CAUSE_METHODS.map((m) => (
              <option key={m} value={m}>
                {labelize(m)}
              </option>
            ))}
          </Select>
        </Field>
        <Field label="Root cause" required>
          <Textarea rows={4} value={rootCause} onChange={(e) => setRootCause(e.target.value)} />
        </Field>
        <Field label="Corrective action summary" hint="What fixes this instance.">
          <Textarea rows={2} value={corrective} onChange={(e) => setCorrective(e.target.value)} />
        </Field>
        <Field label="Preventive action summary" hint="What stops the next one.">
          <Textarea rows={2} value={preventive} onChange={(e) => setPreventive(e.target.value)} />
        </Field>
      </div>
    </Modal>
  );
}

/* ================================================================== */
/* Raising a corrective action                                         */
/* ================================================================== */

/**
 * The action goes into the PROJECT's one corrective-action register — the same
 * table safety writes to — rather than a second quality-only list, so an
 * overdue action is overdue in one place and chased once.
 */
function RaiseAction({ base, onDone }: { base: string; onDone: () => void }) {
  const { busy, refusal, clear, run } = useAction();
  const [open, setOpen] = useState(false);
  const [title, setTitle] = useState("");
  const [description, setDescription] = useState("");
  const [kind, setKind] = useState("corrective");
  const [priority, setPriority] = useState("medium");
  const [ownerName, setOwnerName] = useState("");
  const [dueDate, setDueDate] = useState("");

  async function create() {
    const done = await run("action", () =>
      api.post(`${base}/actions`, {
        title: title.trim(),
        description: description.trim() === "" ? null : description.trim(),
        actionKind: kind,
        priority,
        ownerName: ownerName.trim() === "" ? null : ownerName.trim(),
        dueDate,
      }),
    );
    if (done) {
      setOpen(false);
      setTitle("");
      setDescription("");
      setOwnerName("");
      onDone();
    }
  }

  return (
    <>
      <Button size="sm" variant="secondary" onClick={() => setOpen(true)}>
        Raise a corrective action
      </Button>
      <Modal
        open={open}
        onClose={() => setOpen(false)}
        title="Raise a corrective action"
        description="A corrective action fixes this occurrence; a preventive one stops the next. The distinction is the difference between a register that closes NCRs and one that reduces them."
        footer={
          <div className="flex justify-end gap-2">
            <Button variant="ghost" onClick={() => setOpen(false)}>
              Cancel
            </Button>
            <Button
              variant="primary"
              loading={busy === "action"}
              disabled={title.trim() === "" || dueDate === ""}
              onClick={create}
            >
              Raise it
            </Button>
          </div>
        }
      >
        <div className="space-y-3">
          <RefusalNotice refusal={refusal} onDismiss={clear} />
          <Field label="What has to be done" required>
            <Input value={title} onChange={(e) => setTitle(e.target.value)} autoFocus />
          </Field>
          <Field label="Detail">
            <Textarea
              rows={2}
              value={description}
              onChange={(e) => setDescription(e.target.value)}
            />
          </Field>
          <div className="grid gap-3 sm:grid-cols-3">
            <Field label="Kind">
              <Select value={kind} onChange={(e) => setKind(e.target.value)}>
                <option value="corrective">Corrective — fix this one</option>
                <option value="preventive">Preventive — stop the next</option>
                <option value="containment">Containment — stop it spreading</option>
              </Select>
            </Field>
            <Field label="Priority">
              <Select value={priority} onChange={(e) => setPriority(e.target.value)}>
                {["low", "medium", "high", "urgent"].map((p) => (
                  <option key={p} value={p}>
                    {labelize(p)}
                  </option>
                ))}
              </Select>
            </Field>
            <Field label="Due" required hint="An action with no date is a wish.">
              <Input type="date" value={dueDate} onChange={(e) => setDueDate(e.target.value)} />
            </Field>
          </div>
          <Field label="Owner" hint="Who is actually going to do it.">
            <Input value={ownerName} onChange={(e) => setOwnerName(e.target.value)} />
          </Field>
        </div>
      </Modal>
    </>
  );
}

/* ================================================================== */
/* Backcharge                                                          */
/* ================================================================== */

function Backcharge({
  base,
  ncr,
  onDone,
}: {
  base: string;
  ncr: NcrDetail;
  onDone: () => void;
}) {
  const { busy, refusal, clear, run } = useAction();
  const [amount, setAmount] = useState(ncr.costImpact === null ? "" : String(ncr.costImpact));
  const [reference, setReference] = useState("");

  const parsed = amount.trim() === "" ? null : Number(amount);

  return (
    <div className="rounded-md border border-border-subtle p-2.5">
      <RefusalNotice refusal={refusal} onDismiss={clear} />
      <p className="text-2xs text-content-subtle">
        Raising the backcharge creates a change event of type backcharge against the responsible
        subcontractor, carrying this NCR as its origin. The amount defaults to the cost impact
        recorded here — {ncr.costImpact === null ? "which is unmeasured, so type one" : "change it if the recovery differs"}.
      </p>
      <div className="mt-2 grid gap-2 sm:grid-cols-3">
        <Field label={`Amount (${ncr.currency})`}>
          <Input type="number" value={amount} onChange={(e) => setAmount(e.target.value)} />
        </Field>
        <Field label="Backcharge reference">
          <Input value={reference} onChange={(e) => setReference(e.target.value)} />
        </Field>
        <div className="flex items-end">
          <Button
            size="sm"
            variant="secondary"
            loading={busy === "backcharge"}
            disabled={parsed !== null && !Number.isFinite(parsed)}
            onClick={async () => {
              const done = await run("backcharge", () =>
                api.post(`${base}/backcharge`, {
                  ...(parsed !== null && Number.isFinite(parsed) ? { amount: parsed } : {}),
                  ...(reference.trim() === "" ? {} : { backchargeReference: reference.trim() }),
                }),
              );
              if (done) onDone();
            }}
          >
            Raise the backcharge
          </Button>
        </div>
      </div>
    </div>
  );
}
