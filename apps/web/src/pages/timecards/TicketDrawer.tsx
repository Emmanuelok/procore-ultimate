/**
 * ONE T&M TICKET — and the signature block, which is the whole document.
 *
 * The signature panel is the top of this drawer, not a footnote, because on a
 * disputed change the presence or absence of a site signature IS the argument.
 * Capturing it offers three outcomes and refuses to let any of them be
 * recorded thinly:
 *
 *   SIGNED                needs a method, a ROLE and an ORGANISATION.
 *                         "J. Smith" proves nothing; "J. Smith, Resident
 *                         Engineer, Owner's Representative" is the fact that
 *                         makes the signature bind somebody.
 *   SIGNED UNDER PROTEST  needs its protest note. The endorsement is the
 *                         entire difference between a ticket that admits the
 *                         change and one that merely admits the people were
 *                         there.
 *   REFUSED TO SIGN       needs its note: who refused, and the reason given.
 *                         A bare "refused" is an assertion; a recorded reason
 *                         is evidence.
 *
 * A signature block is written ONCE. If the position changes later, that is a
 * superseding ticket, so both records survive.
 */
import { useEffect, useMemo, useState } from "react";
import {
  Alert,
  Badge,
  Button,
  Card,
  CardBody,
  DescriptionList,
  Drawer,
  EmptyState,
  Field,
  Input,
  Select,
  Skeleton,
  Table,
  TBody,
  Td,
  Textarea,
  Th,
  THead,
  Tooltip,
  Tr,
} from "../../ui";
import { IconSignature, IconWarning } from "../../ui/icons";
import { api } from "../../lib/api";
import {
  EM_DASH,
  LINE_KIND_LABEL,
  LoadError,
  RefusalNotice,
  SIGNATURE_LABEL,
  SIGNATURE_TONE,
  SectionHeading,
  dateTime,
  hoursText,
  labelize,
  money,
  useAction,
  type Figure,
  type Loadable,
  type TicketDetail,
} from "./timecardsShared";

type Outcome = "signed" | "signed_under_protest" | "refused";

const METHODS = [
  { value: "on_device", label: "On device" },
  { value: "wet_ink_scanned", label: "Wet ink, scanned" },
  { value: "typed", label: "Typed" },
  { value: "biometric", label: "Biometric" },
  { value: "email_confirmation", label: "Email confirmation" },
] as const;

export default function TicketDrawer({
  projectId,
  ticketId,
  detail,
  onClose,
  onMutated,
}: {
  projectId: string;
  ticketId: string | null;
  detail: Loadable<TicketDetail>;
  onClose: () => void;
  onMutated: () => void;
}) {
  const ticket = detail.data;
  const action = useAction();

  return (
    <Drawer
      open={ticketId !== null}
      onClose={onClose}
      side="right"
      size="lg"
      title={
        ticket ? (
          <span className="flex flex-wrap items-center gap-2">
            <span className="font-mono">{ticket.reference}</span>
            <span className="truncate">{ticket.title}</span>
          </span>
        ) : (
          "T&M ticket"
        )
      }
      description={
        ticket
          ? `${ticket.ticketDate} · ${labelize(ticket.rateBasis)} · ${ticket.currency}`
          : undefined
      }
    >
      {detail.error ? (
        <LoadError message={detail.error} onRetry={detail.reload} />
      ) : detail.loading && !ticket ? (
        <div className="space-y-3">
          <Skeleton height={110} />
          <Skeleton height={160} />
          <Skeleton height={220} />
        </div>
      ) : !ticket ? null : (
        <div className="space-y-5">
          {action.refusal ? (
            <RefusalNotice refusal={action.refusal} onDismiss={action.clear} />
          ) : null}

          <SignatureBlock
            projectId={projectId}
            ticket={ticket}
            busy={action.busy}
            onRun={action.run}
            onDone={() => {
              detail.reload();
              onMutated();
            }}
          />

          {ticket.verbalInstruction ? (
            <Alert
              tone={ticket.verbalInstruction.instructedByName ? "warning" : "danger"}
              title="Instructed verbally"
              icon={IconWarning}
            >
              <p>{ticket.verbalInstruction.note}</p>
              <p className="mt-1.5 text-meta">
                Instructor:{" "}
                <strong>{ticket.verbalInstruction.instructedByName ?? "NOBODY NAMED"}</strong>
                {ticket.verbalInstruction.instructionDate
                  ? ` on ${ticket.verbalInstruction.instructionDate}`
                  : ""}
                {ticket.instructionRef ? ` · reference ${ticket.instructionRef}` : ""}
              </p>
            </Alert>
          ) : null}

          <TotalsBlock ticket={ticket} />

          <LinesBlock ticket={ticket} />

          <div>
            <SectionHeading
              title="Where it goes next"
              hint="A ticket with a client-side response is promotable into the change chain, which keeps the pricing. Between the signature and the change order is where unrecovered cost lives."
            />
            {ticket.incorporatedChangeOrderId ? (
              <Alert tone="success" size="sm" title="Absorbed into the change chain">
                Incorporated {dateTime(ticket.incorporatedAt)} into{" "}
                <span className="font-mono">{ticket.incorporatedChangeOrderId}</span>. A ticket is
                absorbed once, or the same hours are claimed twice.
              </Alert>
            ) : !ticket.signature.hasClientResponse ? (
              <Alert tone="warning" size="sm" title="Nothing here can be promoted yet">
                This ticket carries no client response at all — no signature, no protest and no
                recorded refusal. There is nothing that evidences an instruction, so the change
                chain will refuse it. Present it on site and record what the client&rsquo;s
                representative did, <em>including</em> a refusal.
              </Alert>
            ) : (
              <div className="space-y-2">
                <Alert tone="info" size="sm" title="Ready to promote">
                  {ticket.signature.summary}
                </Alert>
                <Button
                  size="sm"
                  variant="secondary"
                  loading={action.busy === "promote"}
                  onClick={async () => {
                    const result = await action.run("promote", () =>
                      api.post(
                        `/api/v1/projects/${projectId}/tm-tickets/${ticket.id}/promote`,
                        { target: "change_event" },
                      ),
                    );
                    if (result) {
                      detail.reload();
                      onMutated();
                    }
                  }}
                >
                  Promote into a change event
                </Button>
              </div>
            )}
          </div>
        </div>
      )}
    </Drawer>
  );
}

/* ========================================================================== */
/* The signature block                                                         */
/* ========================================================================== */

function SignatureBlock({
  projectId,
  ticket,
  busy,
  onRun,
  onDone,
}: {
  projectId: string;
  ticket: TicketDetail;
  busy: string | null;
  onRun: <T>(key: string, fn: () => Promise<T>) => Promise<T | null>;
  onDone: () => void;
}) {
  const signature = ticket.signature;
  const [capturing, setCapturing] = useState(false);
  const [outcome, setOutcome] = useState<Outcome>("signed");
  const [name, setName] = useState("");
  const [role, setRole] = useState("");
  const [organisation, setOrganisation] = useState("");
  const [method, setMethod] = useState<string>("on_device");
  const [note, setNote] = useState("");

  useEffect(() => {
    setCapturing(false);
    setOutcome("signed");
    setName("");
    setRole("");
    setOrganisation("");
    setMethod("on_device");
    setNote("");
  }, [ticket.id]);

  const needsIdentity = outcome !== "refused";
  const canSubmit =
    name.trim().length > 0 &&
    (!needsIdentity || (role.trim().length > 0 && organisation.trim().length > 0)) &&
    (outcome === "signed" || note.trim().length > 0);

  return (
    <div>
      <SectionHeading
        title="The signature"
        hint="Signed, signed under protest and refused to sign are three different documents. A dispute later turns on exactly which one this was."
        actions={
          !signature.hasClientResponse && !capturing ? (
            <Button size="sm" icon={IconSignature} onClick={() => setCapturing(true)}>
              Record the client&rsquo;s response
            </Button>
          ) : capturing ? (
            <Button size="sm" variant="ghost" onClick={() => setCapturing(false)}>
              Cancel
            </Button>
          ) : null
        }
      />

      <div
        className={
          signature.state === "signed"
            ? "rounded-lg border border-success-border bg-success-subtle p-4"
            : signature.state === "signed_under_protest"
              ? "rounded-lg border border-warning-border bg-warning-subtle p-4"
              : signature.state === "refused_to_sign"
                ? "rounded-lg border border-danger-border bg-danger-subtle p-4"
                : "rounded-lg border border-dashed border-border bg-surface-sunken p-4"
        }
      >
        <div className="mb-2 flex flex-wrap items-center gap-2">
          <Badge
            tone={SIGNATURE_TONE[signature.state]}
            size="sm"
            dot
            variant={signature.state === "unsigned" ? "outline" : "solid"}
            icon={signature.state === "refused_to_sign" ? IconWarning : undefined}
          >
            {SIGNATURE_LABEL[signature.state]}
          </Badge>
          {signature.state === "signed_under_protest" ? (
            <Badge tone="warning" size="xs" variant="outline">
              acknowledges hours, not liability
            </Badge>
          ) : null}
          {signature.state === "refused_to_sign" ? (
            <Badge tone="danger" size="xs" variant="outline">
              evidence in its own right
            </Badge>
          ) : null}
        </div>
        <p
          className={
            signature.state === "signed"
              ? "text-meta text-success-fg"
              : signature.state === "signed_under_protest"
                ? "text-meta text-warning-fg"
                : signature.state === "refused_to_sign"
                  ? "text-meta text-danger-fg"
                  : "text-meta text-content-muted"
          }
        >
          {signature.summary}
        </p>
        {signature.note ? (
          <blockquote className="mt-2 border-l-2 border-border-strong pl-3 text-meta italic text-content">
            {signature.note}
          </blockquote>
        ) : null}

        {signature.hasClientResponse ? (
          <DescriptionList
            className="mt-3"
            columns={2}
            size="sm"
            items={[
              { label: "Name", value: ticket.signedByName ?? EM_DASH },
              {
                label: "Role and organisation",
                value:
                  ticket.signedByRole || ticket.signedByOrganisation ? (
                    `${ticket.signedByRole ?? "role not recorded"}${
                      ticket.signedByOrganisation ? `, ${ticket.signedByOrganisation}` : ""
                    }`
                  ) : (
                    <Tooltip content="Without a role and an organisation the signature binds nobody in particular. It is the fact that makes the signature worth having.">
                      <span className="text-warning-fg">not recorded</span>
                    </Tooltip>
                  ),
              },
              {
                label: "Method",
                value: labelize(ticket.signatureMethod),
                hint:
                  ticket.signatureLatitude !== null && ticket.signatureLongitude !== null
                    ? `captured at ${ticket.signatureLatitude.toFixed(5)}, ${ticket.signatureLongitude.toFixed(5)}`
                    : "no location captured",
              },
              {
                label: signature.state === "refused_to_sign" ? "Refused at" : "Signed at",
                value: signature.state === "refused_to_sign" ? "on the day" : dateTime(ticket.signedAt),
              },
            ]}
          />
        ) : null}
      </div>

      {capturing ? (
        <Card className="mt-3">
          <CardBody className="space-y-3">
            <Field label="What did the client's representative do?" required>
              <Select
                value={outcome}
                onChange={(event) => setOutcome(event.target.value as Outcome)}
                aria-label="Signature outcome"
              >
                <option value="signed">Signed — unqualified acknowledgement</option>
                <option value="signed_under_protest">
                  Signed under protest — hours only, without prejudice
                </option>
                <option value="refused">Refused to sign</option>
              </Select>
            </Field>

            <Field
              label="Name"
              required
              hint="Who was standing there. A signature block is written once — if the position changes later, raise a superseding ticket."
            >
              <Input
                value={name}
                onChange={(event) => setName(event.target.value)}
                placeholder="J. Smith"
              />
            </Field>

            {needsIdentity ? (
              <div className="grid gap-3 sm:grid-cols-2">
                <Field label="Role" required>
                  <Input
                    value={role}
                    onChange={(event) => setRole(event.target.value)}
                    placeholder="Resident Engineer"
                  />
                </Field>
                <Field label="Organisation" required>
                  <Input
                    value={organisation}
                    onChange={(event) => setOrganisation(event.target.value)}
                    placeholder="Owner's Representative"
                  />
                </Field>
              </div>
            ) : null}

            {needsIdentity ? (
              <Field label="Method" required hint="A scanned wet-ink signature, an on-device capture with GPS and a typed name are three very different exhibits.">
                <Select
                  value={method}
                  onChange={(event) => setMethod(event.target.value)}
                  aria-label="Signature method"
                >
                  {METHODS.map((entry) => (
                    <option key={entry.value} value={entry.value}>
                      {entry.label}
                    </option>
                  ))}
                </Select>
              </Field>
            ) : null}

            {outcome !== "signed" ? (
              <Field
                label={outcome === "refused" ? "Reason given for the refusal" : "Protest note"}
                required
                hint={
                  outcome === "refused"
                    ? "Who refused, and the reason they gave. A bare 'refused' is an assertion; a recorded reason is evidence."
                    : "The endorsement — 'signed for record of hours only, without prejudice to liability' — is the entire difference between a ticket that admits the change and one that merely admits the people were there."
                }
              >
                <Textarea
                  rows={3}
                  value={note}
                  onChange={(event) => setNote(event.target.value)}
                  placeholder={
                    outcome === "refused"
                      ? "Declined to sign: disputes that the works were instructed."
                      : "Signed for record of hours only, without prejudice to liability."
                  }
                />
              </Field>
            ) : null}

            <div className="flex flex-wrap items-center gap-2">
              <Button
                size="sm"
                disabled={!canSubmit}
                loading={busy === "sign"}
                onClick={async () => {
                  const result = await onRun("sign", () =>
                    api.post(`/api/v1/projects/${projectId}/tm-tickets/${ticket.id}/sign`, {
                      outcome,
                      signedByName: name.trim(),
                      ...(needsIdentity
                        ? {
                            signedByRole: role.trim(),
                            signedByOrganisation: organisation.trim(),
                            signatureMethod: method,
                          }
                        : {}),
                      ...(outcome === "signed_under_protest" ? { protestNote: note.trim() } : {}),
                      ...(outcome === "refused" ? { refusalNote: note.trim() } : {}),
                    }),
                  );
                  if (result) {
                    setCapturing(false);
                    onDone();
                  }
                }}
              >
                Record it
              </Button>
              <p className="text-2xs text-content-muted">
                Written once. There is no edit — a changed position is a superseding ticket, so both
                records survive.
              </p>
            </div>
          </CardBody>
        </Card>
      ) : null}
    </div>
  );
}

/* ========================================================================== */
/* Totals                                                                      */
/* ========================================================================== */

function TotalsBlock({ ticket }: { ticket: TicketDetail }) {
  const totals = ticket.totals;
  const categories: Array<{ label: string; figure: Figure }> = [
    { label: "Labour", figure: totals.labourTotal },
    { label: "Equipment", figure: totals.equipmentTotal },
    { label: "Material", figure: totals.materialTotal },
    { label: "Subcontract", figure: totals.subcontractTotal },
    { label: "Other", figure: totals.otherTotal },
  ];

  return (
    <div>
      <SectionHeading
        title="What is claimed"
        hint="Hours survive a missing price. A ticket with no total still evidences the labour that was expended, which is exactly what the client's representative signed for."
      />

      <div className="grid grid-cols-2 gap-2 sm:grid-cols-4">
        <Tile
          label="Labour hours"
          value={hoursText(totals.totalLabourHours, 1)}
          hint="the figure the signature is really about"
        />
        <Tile
          label="Net"
          value={figureText(totals.netTotal, totals.currency)}
          reasons={totals.netTotal.reasons}
        />
        <Tile
          label={`Markup${totals.markupPercent !== null ? ` ${totals.markupPercent}%` : ""}`}
          value={figureText(totals.markupTotal, totals.currency)}
          reasons={totals.markupTotal.reasons}
        />
        <Tile
          label="Total claimed"
          value={figureText(totals.total, totals.currency)}
          reasons={totals.total.reasons}
          strong
        />
      </div>

      {!ticket.totalsAreComplete ? (
        <Alert tone="warning" size="sm" title="This ticket has no stated total" className="mt-3">
          <p>
            {totals.unpricedLineCount} line{totals.unpricedLineCount === 1 ? "" : "s"} carry hours
            with no rate, so the categories they belong to — and everything downstream of them — are
            left null rather than understated. The hours stand; the money does not.
          </p>
          <ul className="mt-2 space-y-1">
            {totals.total.reasons.map((reason, index) => (
              <li key={index} className="flex items-start gap-1.5 text-meta">
                <span aria-hidden className="mt-0.5 text-content-disabled">
                  ▪
                </span>
                <span>{reason}</span>
              </li>
            ))}
          </ul>
        </Alert>
      ) : null}

      {totals.notes.length > 0 ? (
        <div className="mt-3 rounded-lg border border-border bg-surface-sunken p-3">
          <p className="mb-1.5 text-label uppercase tracking-wide text-content-subtle">
            Worth knowing
          </p>
          <ul className="space-y-1">
            {totals.notes.map((note, index) => (
              <li key={index} className="flex items-start gap-1.5 text-meta text-content-muted">
                <span aria-hidden className="mt-0.5 text-content-disabled">
                  ▪
                </span>
                <span>{note}</span>
              </li>
            ))}
          </ul>
        </div>
      ) : null}

      <div className="mt-3 flex flex-wrap gap-2">
        {categories
          .filter((entry) => entry.figure.value !== null || entry.figure.reasons.length > 0)
          .map((entry) => (
            <Badge
              key={entry.label}
              tone={entry.figure.value === null ? "warning" : "neutral"}
              size="xs"
              variant="outline"
            >
              {entry.label}: {figureText(entry.figure, totals.currency)}
            </Badge>
          ))}
        {totals.disputedLineCount > 0 ? (
          <Badge tone="danger" size="xs">
            {totals.disputedLineCount} line{totals.disputedLineCount === 1 ? "" : "s"} struck by the
            client
          </Badge>
        ) : null}
      </div>

      {totals.agreedTotal.value !== null && totals.agreedTotal.value !== totals.total.value ? (
        <Alert tone="info" size="sm" title="Agreed differs from claimed" className="mt-3">
          The client accepted {money(totals.agreedTotal.value, totals.currency)} against{" "}
          {figureText(totals.total, totals.currency)} claimed. Both figures stay on the record —
          the difference is the argument, and deleting either side of it removes the argument
          rather than settling it.
        </Alert>
      ) : null}
    </div>
  );
}

function Tile({
  label,
  value,
  hint,
  reasons,
  strong = false,
}: {
  label: string;
  value: string;
  hint?: string;
  reasons?: readonly string[];
  strong?: boolean;
}) {
  const body = (
    <div className="rounded-lg border border-border bg-surface-raised p-3">
      <div className="text-2xs uppercase tracking-wide text-content-subtle">{label}</div>
      <div
        className={
          strong
            ? "mt-0.5 text-display-xs font-semibold tabular-nums text-content"
            : "mt-0.5 text-body font-semibold tabular-nums text-content"
        }
      >
        {value}
      </div>
      {hint ? <div className="mt-0.5 text-2xs text-content-subtle">{hint}</div> : null}
    </div>
  );
  if (!reasons || reasons.length === 0) return body;
  return (
    <Tooltip
      content={
        <span className="block max-w-sm space-y-1">
          {reasons.map((reason, index) => (
            <span key={index} className="block">
              {reason}
            </span>
          ))}
        </span>
      }
    >
      {body}
    </Tooltip>
  );
}

function figureText(figure: Figure, currency: string): string {
  if (figure.value === null) return "Not available";
  return money(figure.value, currency);
}

/* ========================================================================== */
/* Lines                                                                       */
/* ========================================================================== */

function LinesBlock({ ticket }: { ticket: TicketDetail }) {
  const priced = useMemo(() => new Map(ticket.totals.lines.map((line) => [line.position, line])), [
    ticket.totals.lines,
  ]);

  if (ticket.lines.length === 0) {
    return (
      <div>
        <SectionHeading title="Lines" />
        <EmptyState
          size="sm"
          title="This ticket carries no lines"
          hint="A T&M ticket with no lines records that something happened and nothing else. It cannot be priced, it cannot be checked against the timecards that paid for the same hours, and it evidences no quantity of work."
        />
      </div>
    );
  }

  return (
    <div>
      <SectionHeading
        title="Lines"
        hint="Each labour line ideally points back at the timecard allocation that paid the same hour. Without that link a ticket is an assertion with nothing behind it."
      />
      <Table dense tableClassName="min-w-[720px] text-meta">
          <THead>
            <Tr>
              <Th>#</Th>
              <Th>Kind</Th>
              <Th>Description</Th>
              <Th align="right">Hours</Th>
              <Th align="right">Rate</Th>
              <Th align="right">Amount</Th>
              <Th>Basis</Th>
            </Tr>
          </THead>
          <TBody>
            {ticket.lines.map((line, index) => {
              const price = priced.get(index + 1);
              return (
                <Tr key={line.id} className={line.isDisputed === 1 ? "bg-danger-subtle" : ""}>
                  <Td numeric className="text-content-subtle">{index + 1}</Td>
                  <Td>
                    <Badge tone="neutral" size="xs" variant="outline">
                      {LINE_KIND_LABEL[line.lineKind] ?? labelize(line.lineKind)}
                    </Badge>
                  </Td>
                  <Td>
                    <div className="text-content">{line.description}</div>
                    <div className="flex flex-wrap gap-1 pt-0.5">
                      {line.timecardAllocationId ? (
                        <Tooltip content="This line is sourced from a timecard allocation — the hour we paid a worker is the hour we are billing the client for, and the platform holds the join.">
                          <span>
                            <Badge tone="success" size="xs" variant="outline">
                              from a timecard
                            </Badge>
                          </span>
                        </Tooltip>
                      ) : line.lineKind === "labour" ? (
                        <Tooltip content="This labour line names no timecard allocation, so nothing on the platform connects the hours billed to the hours paid.">
                          <span>
                            <Badge tone="warning" size="xs">
                              unsourced
                            </Badge>
                          </span>
                        </Tooltip>
                      ) : null}
                      {line.isDisputed === 1 ? (
                        <Tooltip content={line.disputeNote ?? "The client struck this line."}>
                          <span>
                            <Badge tone="danger" size="xs">
                              struck
                            </Badge>
                          </span>
                        </Tooltip>
                      ) : null}
                    </div>
                  </Td>
                  <Td align="right" numeric>
                    {line.hours === null ? EM_DASH : hoursText(line.hours, 2)}
                  </Td>
                  <Td align="right" numeric>
                    {line.rate === null ? (
                      <span className="text-content-subtle italic">to be agreed</span>
                    ) : (
                      money(line.rate, line.currency)
                    )}
                  </Td>
                  <Td align="right" numeric>
                    {price?.amount === null || price?.amount === undefined ? (
                      <Tooltip
                        content={
                          <span className="block max-w-xs space-y-1">
                            {(price?.reasons ?? [
                              "This line states hours but no rate, which is the normal daywork case. It keeps its hours and contributes nothing to the total.",
                            ]).map((reason, reasonIndex) => (
                              <span key={reasonIndex} className="block">
                                {reason}
                              </span>
                            ))}
                          </span>
                        }
                      >
                        <span className="inline-flex items-center gap-1 text-content-muted">
                          <span>Unpriced</span>
                          <Badge tone="warning" size="xs">
                            why
                          </Badge>
                        </span>
                      </Tooltip>
                    ) : (
                      money(price.amount, line.currency)
                    )}
                  </Td>
                  <Td>
                    <span className="text-2xs text-content-subtle">
                      {price ? labelize(price.basis) : EM_DASH}
                    </span>
                  </Td>
                </Tr>
              );
            })}
          </TBody>
        </Table>
    </div>
  );
}
