/**
 * ONE EXTRACTED REQUIREMENT, with its provenance carried on its face.
 *
 * This card is the whole argument of the module in one component. The title of
 * a requirement is never shown without the stamp that says how it got here:
 * a machine reading at 71% confidence and a human-typed row that a second
 * person has confirmed look nothing alike, and that difference is what stops a
 * guess being relied on as a register entry.
 *
 * The three verbs are deliberately unequal:
 *
 *   Confirm       the human step. Refused to whoever extracted or typed the
 *                 row — the API says so in a sentence, and it is printed here
 *                 word for word rather than being turned into "Forbidden".
 *   Not required  needs a written reason, which stays on the record.
 *   Register      refused outright unless the row is confirmed. There is no
 *                 force flag, no admin bypass, and this UI offers none.
 */
import { useState } from "react";
import {
  Alert,
  Badge,
  Button,
  Field,
  Input,
  Modal,
  Textarea,
  Tooltip,
} from "../../ui";
import { cx } from "../../ui/cx";
import { api } from "../../lib/api";
import {
  EM_DASH,
  Provenance,
  REQUIREMENT_STATUS_MEANING,
  REQUIREMENT_STATUS_TONE,
  isoDate,
  titleCase,
  useAction,
  type SpecRequirement,
} from "./specShared";

export default function RequirementCard({
  projectId,
  requirement,
  onMutated,
  showSection = false,
}: {
  projectId: string;
  requirement: SpecRequirement;
  onMutated: () => void;
  showSection?: boolean;
}) {
  const { busy, refusal, clear, run } = useAction();
  const [expanded, setExpanded] = useState(false);
  const [declineOpen, setDeclineOpen] = useState(false);
  const [registerOpen, setRegisterOpen] = useState(false);

  const r = requirement;
  const path = `/api/v1/projects/${projectId}/spec-requirements/${r.id}`;

  async function confirmIt() {
    const done = await run("confirm", () => api.post(`${path}/confirm`, {}));
    if (done !== null) onMutated();
  }

  return (
    <div
      className={cx(
        "rounded-lg border p-3",
        r.status === "identified"
          ? "border-warning-border bg-warning-subtle/40"
          : "border-border bg-surface-raised",
      )}
    >
      <div className="flex flex-wrap items-start justify-between gap-2">
        <div className="min-w-0">
          <div className="flex flex-wrap items-center gap-2">
            {showSection ? (
              <span className="font-mono text-2xs text-content-subtle">{r.sectionCode}</span>
            ) : null}
            <span className="font-mono text-2xs text-content-subtle">
              {r.paragraphRef ?? "no paragraph"}
            </span>
            <span className="text-sm font-semibold text-content">{r.title}</span>
          </div>
          <div className="mt-1.5 flex flex-wrap items-center gap-1.5">
            <Tooltip content={REQUIREMENT_STATUS_MEANING[r.status] ?? r.status}>
              <span>
                <Badge tone={REQUIREMENT_STATUS_TONE[r.status] ?? "neutral"} size="xs" dot>
                  {titleCase(r.status)}
                </Badge>
              </span>
            </Tooltip>
            <Badge tone="neutral" size="xs" variant="outline">
              {titleCase(r.submittalType)}
            </Badge>
            {r.isDeferred === 1 ? (
              <Badge tone="info" size="xs">
                Deferred submittal
              </Badge>
            ) : null}
            <Provenance provenance={r.provenance} />
          </div>
        </div>
        <div className="flex shrink-0 flex-wrap items-center gap-1.5">
          {r.status === "identified" ? (
            <Button size="xs" loading={busy === "confirm"} onClick={() => void confirmIt()}>
              Confirm
            </Button>
          ) : null}
          {r.status === "confirmed" ? (
            <Button size="xs" onClick={() => setRegisterOpen(true)}>
              Register as a submittal
            </Button>
          ) : null}
          {r.status === "identified" || r.status === "confirmed" ? (
            <Button size="xs" variant="ghost" onClick={() => setDeclineOpen(true)}>
              Not required
            </Button>
          ) : null}
          <Button size="xs" variant="ghost" onClick={() => setExpanded((v) => !v)}>
            {expanded ? "Less" : "Clause"}
          </Button>
        </div>
      </div>

      {refusal ? (
        <Alert
          tone={refusal.status === 403 ? "warning" : "danger"}
          size="sm"
          className="mt-2"
          title={
            refusal.status === 403
              ? "Segregation of duties — this control did its job"
              : refusal.status === 400
                ? "Refused: this requirement is not eligible"
                : "The server refused this"
          }
          onDismiss={clear}
        >
          <p className="whitespace-pre-wrap">{refusal.message}</p>
        </Alert>
      ) : null}

      {r.status === "not_required" && r.notRequiredReason ? (
        <p className="mt-2 text-meta text-content-muted">
          <span className="font-medium text-content">Ruled out:</span> {r.notRequiredReason}
        </p>
      ) : null}

      {r.registeredSubmittalId ? (
        <p className="mt-2 text-meta text-content-muted">
          Registered as submittal{" "}
          <span className="font-mono text-content">{r.registeredSubmittalId}</span>
          {r.registeredAt ? ` on ${isoDate(r.registeredAt)}` : ""}. This requirement is frozen —
          the submittal is the live record now.
        </p>
      ) : null}

      {expanded ? (
        <div className="mt-3 space-y-3">
          <Provenance provenance={r.provenance} size="full" />
          {r.description ? (
            <p className="text-meta text-content-muted">{r.description}</p>
          ) : null}
          {r.clauseText ? (
            <blockquote className="border-l-2 border-border-strong bg-surface-sunken px-3 py-2 text-meta text-content">
              <p className="whitespace-pre-wrap">{r.clauseText}</p>
              <footer className="mt-1.5 text-2xs text-content-subtle">
                Verbatim clause text, not a paraphrase — this is the citation the requirement rests
                on.
              </footer>
            </blockquote>
          ) : (
            <p className="text-2xs italic text-content-subtle">
              No clause text was captured for this requirement, so there is nothing to cite. Confirm
              it against the section text itself.
            </p>
          )}
          <dl className="grid grid-cols-2 gap-x-4 gap-y-1 text-2xs sm:grid-cols-4">
            <Detail label="Copies demanded" value={r.requiredCopies?.toString() ?? EM_DASH} />
            <Detail label="Required before" value={r.requiredBefore ?? EM_DASH} />
            <Detail
              label="Review allowance"
              value={r.reviewDays !== null ? `${r.reviewDays} days` : EM_DASH}
            />
            <Detail
              label="Lead time"
              value={r.leadTimeDays !== null ? `${r.leadTimeDays} days` : EM_DASH}
            />
          </dl>
        </div>
      ) : null}

      <DeclineModal
        open={declineOpen}
        path={path}
        onClose={() => setDeclineOpen(false)}
        onDone={() => {
          setDeclineOpen(false);
          onMutated();
        }}
      />
      <RegisterModal
        open={registerOpen}
        path={path}
        requirement={r}
        onClose={() => setRegisterOpen(false)}
        onDone={() => {
          setRegisterOpen(false);
          onMutated();
        }}
      />
    </div>
  );
}

function Detail({ label, value }: { label: string; value: string }) {
  return (
    <div className="contents">
      <dt className="text-content-subtle">{label}</dt>
      <dd className="text-content">{value}</dd>
    </div>
  );
}

function DeclineModal({
  open,
  path,
  onClose,
  onDone,
}: {
  open: boolean;
  path: string;
  onClose: () => void;
  onDone: () => void;
}) {
  const { busy, refusal, clear, run } = useAction();
  const [reason, setReason] = useState("");

  async function submit() {
    const done = await run("decline", () =>
      api.post(`${path}/not-required`, { reason: reason.trim() }),
    );
    if (done !== null) {
      setReason("");
      onDone();
    }
  }

  return (
    <Modal
      open={open}
      onClose={onClose}
      title="Rule this requirement out"
      footer={
        <div className="flex justify-end gap-2">
          <Button variant="ghost" onClick={onClose}>
            Cancel
          </Button>
          <Button
            variant="danger"
            disabled={reason.trim().length === 0 || busy !== null}
            loading={busy === "decline"}
            onClick={() => void submit()}
          >
            Mark not required
          </Button>
        </div>
      }
    >
      <div className="space-y-3">
        {refusal ? (
          <Alert tone="danger" size="sm" title="Refused" onDismiss={clear}>
            <p className="whitespace-pre-wrap">{refusal.message}</p>
          </Alert>
        ) : null}
        <p className="text-meta text-content-muted">
          The row is kept, not deleted. A requirement the spec demands and the project decided not to
          produce is exactly the thing somebody asks about eighteen months later, so the reason has
          to travel with it.
        </p>
        <Field
          label="Why is this not required?"
          required
          hint="Stored on the record and in the ledger, and shown to everyone who reads it afterwards."
        >
          <Textarea
            rows={3}
            value={reason}
            onChange={(e) => setReason(e.target.value)}
            placeholder="Scope not in our contract — the section is let to the fit-out package."
            autoFocus
          />
        </Field>
      </div>
    </Modal>
  );
}

function RegisterModal({
  open,
  path,
  requirement,
  onClose,
  onDone,
}: {
  open: boolean;
  path: string;
  requirement: SpecRequirement;
  onClose: () => void;
  onDone: () => void;
}) {
  const { busy, refusal, clear, run } = useAction();
  const [title, setTitle] = useState(requirement.title);
  const [requiredOnSite, setRequiredOnSite] = useState("");
  const [leadTimeDays, setLeadTimeDays] = useState(
    requirement.leadTimeDays !== null ? String(requirement.leadTimeDays) : "",
  );

  async function submit() {
    const lead = leadTimeDays.trim() === "" ? null : Number(leadTimeDays);
    const done = await run("register", () =>
      api.post(`${path}/register`, {
        title: title.trim() || requirement.title,
        requiredOnSite: requiredOnSite || null,
        leadTimeDays: lead !== null && Number.isFinite(lead) ? lead : null,
      }),
    );
    if (done !== null) onDone();
  }

  return (
    <Modal
      open={open}
      onClose={onClose}
      title="Register this requirement as a submittal"
      size="lg"
      footer={
        <div className="flex justify-end gap-2">
          <Button variant="ghost" onClick={onClose}>
            Cancel
          </Button>
          <Button
            disabled={busy !== null}
            loading={busy === "register"}
            onClick={() => void submit()}
          >
            Create the submittal
          </Button>
        </div>
      }
    >
      <div className="space-y-3">
        {refusal ? (
          <Alert
            tone={refusal.status === 400 ? "warning" : "danger"}
            size="sm"
            title="Registration refused"
            onDismiss={clear}
          >
            <p className="whitespace-pre-wrap">{refusal.message}</p>
          </Alert>
        ) : null}
        <Alert tone="info" variant="subtle" size="sm" title="What this creates">
          A real submittal, carrying this section code and a link back to the requirement it was
          built from. From then on the requirement is frozen and the submittal is the live record.
          If you give a required-on-site date, the submit-by date is worked backwards from it using
          the lead time and the section's own review allowance
          {requirement.reviewDays !== null ? ` (${requirement.reviewDays} days)` : ""} — no date is
          invented when the inputs are missing.
        </Alert>
        <Provenance provenance={requirement.provenance} size="full" />
        <div className="grid gap-3 sm:grid-cols-2">
          <Field label="Submittal title" className="sm:col-span-2">
            <Input value={title} onChange={(e) => setTitle(e.target.value)} />
          </Field>
          <Field
            label="Required on site"
            hint="Leave blank if it is not known. A guessed date would drive a guessed submit-by date."
          >
            <Input
              type="date"
              value={requiredOnSite}
              onChange={(e) => setRequiredOnSite(e.target.value)}
            />
          </Field>
          <Field label="Lead time (days)">
            <Input
              type="number"
              min={0}
              value={leadTimeDays}
              onChange={(e) => setLeadTimeDays(e.target.value)}
            />
          </Field>
        </div>
      </div>
    </Modal>
  );
}
