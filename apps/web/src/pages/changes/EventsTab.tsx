/**
 * THE CHANGE EVENTS REGISTER — the origin record for the whole chain.
 *
 * A change event's evidential value is that it points at the document that
 * caused it: an answered RFI, a superseded drawing, a daily log. The API
 * verifies that link when the event is raised and stores the verification on
 * the row (`detail.origin`), so this screen can do two things no register
 * usually does:
 *
 *   · follow the link through to the originating record, and
 *   · say plainly when the link could NOT be verified, rather than printing
 *     an id and letting the reader assume it resolves.
 *
 * The three cost columns (ROM, estimated, latest) are shown side by side and
 * never collapsed. They are three levels of CONFIDENCE, and a register that
 * shows one of them cannot answer the only question it is asked — is this
 * exposure hardening or softening?
 */
import { useCallback, useMemo, useState } from "react";
import { Link } from "react-router-dom";
import {
  Alert,
  Badge,
  Button,
  Card,
  CardBody,
  CardHeader,
  Divider,
  EmptyState,
  ErrorAlert,
  Field,
  Input,
  Select,
  Textarea,
} from "../../ui";
import {
  ConfirmDialog,
  Drawer,
  DrawerBody,
  DrawerFooter,
  Modal,
  toast,
} from "../../ui/overlays";
import { DataTable, DescriptionList, type DataColumns } from "../../ui/data";
import { NumberInput } from "../../ui/inputs";
import { IconChangeOrder, IconExternal, IconWarning } from "../../ui/icons";
import { api } from "../../lib/api";
import {
  CHANGE_EVENT_ORIGIN_KINDS,
  CHANGE_EVENT_SCOPES,
  CHANGE_EVENT_STATUSES,
  CHANGE_EVENT_TYPES,
  CHANGE_REASONS,
  ComponentValue,
  PanelSkeleton,
  Reasons,
  corTone,
  days,
  errorMessage,
  eventTone,
  isoDate,
  label,
  money,
  originHref,
  pcoTone,
  useResource,
  type ChangeContext,
  type ChangeEventRow,
  type EventDetail,
  type OriginVerification,
} from "./changesShared";

/* ------------------------------------------------------------------ */
/* Provenance                                                          */
/* ------------------------------------------------------------------ */

/** The verification the server performed when the event was raised. */
function originOf(event: ChangeEventRow): OriginVerification | null {
  const raw = event.detail["origin"];
  if (!raw || typeof raw !== "object" || Array.isArray(raw)) return null;
  const rec = raw as Record<string, unknown>;
  return {
    originType: typeof rec["originType"] === "string" ? rec["originType"] : event.originType,
    originId: typeof rec["originId"] === "string" ? rec["originId"] : event.originId,
    verified: rec["verified"] === true,
    label: typeof rec["label"] === "string" ? rec["label"] : null,
    reasons: Array.isArray(rec["reasons"]) ? rec["reasons"].map((r) => String(r)) : [],
  };
}

function OriginCell({ event, projectId }: { event: ChangeEventRow; projectId: string }) {
  const origin = originOf(event);
  const href = originHref(projectId, event.originType, event.originId);
  const text = origin?.label ?? (event.originId ? event.originId : label(event.originType));

  if (event.originType === "manual") {
    return <span className="text-content-muted">Raised manually</span>;
  }

  return (
    <span className="flex min-w-0 flex-col">
      <span className="flex min-w-0 items-center gap-1">
        {href ? (
          <Link
            to={href}
            className="truncate text-accent-text underline-offset-2 hover:underline"
            title={text}
          >
            {text}
          </Link>
        ) : (
          <span className="truncate" title={text}>
            {text}
          </span>
        )}
        {href ? <IconExternal size={11} className="shrink-0 text-content-subtle" /> : null}
      </span>
      <span className="flex items-center gap-1 text-2xs text-content-subtle">
        {label(event.originType)}
        {origin && !origin.verified ? (
          <Badge tone="warning" size="xs" icon={IconWarning}>
            unverified
          </Badge>
        ) : null}
      </span>
    </span>
  );
}

/* ------------------------------------------------------------------ */
/* Create                                                              */
/* ------------------------------------------------------------------ */

interface CreateState {
  title: string;
  description: string;
  eventType: string;
  scope: string;
  reason: string;
  originType: string;
  originId: string;
  primeContractId: string;
  roughOrderOfMagnitude: number | null;
  scheduleImpactDays: number | null;
  identifiedDate: string;
  dueDate: string;
}

const EMPTY_CREATE: CreateState = {
  title: "",
  description: "",
  eventType: "other",
  scope: "tbd",
  reason: "",
  originType: "manual",
  originId: "",
  primeContractId: "",
  roughOrderOfMagnitude: null,
  scheduleImpactDays: null,
  identifiedDate: "",
  dueDate: "",
};

function CreateEventModal({
  open,
  onClose,
  projectId,
  context,
  onCreated,
}: {
  open: boolean;
  onClose: () => void;
  projectId: string;
  context: ChangeContext;
  onCreated: () => void;
}) {
  const [form, setForm] = useState<CreateState>(EMPTY_CREATE);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [originResult, setOriginResult] = useState<OriginVerification | null>(null);

  const set = <K extends keyof CreateState>(key: K, value: CreateState[K]) =>
    setForm((prev) => ({ ...prev, [key]: value }));

  const needsOriginId = form.originType !== "manual";

  async function submit() {
    setBusy(true);
    setError(null);
    setOriginResult(null);
    try {
      const body: Record<string, unknown> = {
        title: form.title.trim(),
        eventType: form.eventType,
        scope: form.scope,
        originType: form.originType,
      };
      if (form.description.trim()) body["description"] = form.description.trim();
      if (form.reason) body["reason"] = form.reason;
      if (form.originId.trim()) body["originId"] = form.originId.trim();
      if (form.primeContractId) body["primeContractId"] = form.primeContractId;
      if (form.roughOrderOfMagnitude !== null) {
        body["roughOrderOfMagnitude"] = form.roughOrderOfMagnitude;
      }
      if (form.scheduleImpactDays !== null) {
        body["scheduleImpactDays"] = form.scheduleImpactDays;
      }
      if (form.identifiedDate) body["identifiedDate"] = form.identifiedDate;
      if (form.dueDate) body["dueDate"] = form.dueDate;

      const created = await api.post<{ event: ChangeEventRow; origin: OriginVerification }>(
        `/api/v1/projects/${projectId}/change-events`,
        body,
      );
      if (!created.origin.verified && created.origin.originType !== "manual") {
        setOriginResult(created.origin);
        toast.warning(
          `${created.event.reference} raised — its provenance link is recorded but unverified.`,
        );
      } else {
        toast.success(`${created.event.reference} raised.`);
      }
      setForm(EMPTY_CREATE);
      onCreated();
      if (created.origin.verified || created.origin.originType === "manual") onClose();
    } catch (err) {
      setError(errorMessage(err, "Could not raise this change event"));
    } finally {
      setBusy(false);
    }
  }

  return (
    <Modal
      open={open}
      onClose={onClose}
      title="Raise a change event"
      description="The origin record for the chain. Raise it the moment the condition arises — exposure that is never raised is never priced."
      size="lg"
      footer={
        <>
          <Button variant="ghost" onClick={onClose} disabled={busy}>
            Cancel
          </Button>
          <Button onClick={() => void submit()} loading={busy} disabled={!form.title.trim()}>
            Raise change event
          </Button>
        </>
      }
    >
      <div className="space-y-3">
        <ErrorAlert message={error} />
        {originResult ? (
          <Reasons
            reasons={originResult.reasons}
            tone="warning"
            title="Provenance recorded but not verified"
          />
        ) : null}

        <Field label="Title" required>
          <Input
            value={form.title}
            onChange={(e) => set("title", e.target.value)}
            placeholder="Slab thickening at grid E/4 following RFI answer"
          />
        </Field>

        <Field label="What happened" hint="The narrative a claim will be read from in two years.">
          <Textarea
            rows={3}
            value={form.description}
            onChange={(e) => set("description", e.target.value)}
          />
        </Field>

        <div className="grid gap-3 sm:grid-cols-3">
          <Field label="Cause" hint="Drives entitlement.">
            <Select value={form.eventType} onChange={(e) => set("eventType", e.target.value)}>
              {CHANGE_EVENT_TYPES.map((t) => (
                <option key={t} value={t}>
                  {label(t)}
                </option>
              ))}
            </Select>
          </Field>
          <Field label="Scope" hint="`TBD` is the honest default.">
            <Select value={form.scope} onChange={(e) => set("scope", e.target.value)}>
              {CHANGE_EVENT_SCOPES.map((s) => (
                <option key={s} value={s}>
                  {label(s)}
                </option>
              ))}
            </Select>
          </Field>
          <Field label="Contractual reason" optional>
            <Select value={form.reason} onChange={(e) => set("reason", e.target.value)}>
              <option value="">Not stated</option>
              {CHANGE_REASONS.map((r) => (
                <option key={r} value={r}>
                  {label(r)}
                </option>
              ))}
            </Select>
          </Field>
        </div>

        <div className="grid gap-3 sm:grid-cols-2">
          <Field
            label="Origin"
            hint="The record that caused this. `Manual` is for a change nobody can point at a document for."
          >
            <Select value={form.originType} onChange={(e) => set("originType", e.target.value)}>
              {CHANGE_EVENT_ORIGIN_KINDS.map((k) => (
                <option key={k} value={k}>
                  {label(k)}
                </option>
              ))}
            </Select>
          </Field>
          <Field
            label="Origin record id"
            required={needsOriginId}
            hint={
              needsOriginId
                ? "Checked server-side: an id that does not resolve on this project is refused."
                : "Not required for a manually raised event."
            }
          >
            <Input
              value={form.originId}
              onChange={(e) => set("originId", e.target.value)}
              disabled={!needsOriginId}
              placeholder="rfi_…"
            />
          </Field>
        </div>

        <div className="grid gap-3 sm:grid-cols-2">
          <Field label="Prime contract" optional hint="Which contract this will be billed under.">
            <Select
              value={form.primeContractId}
              onChange={(e) => set("primeContractId", e.target.value)}
            >
              <option value="">Not attributed yet</option>
              {context.contracts.map((c) => (
                <option key={c.id} value={c.id}>
                  {c.reference} — {c.title} ({c.currency})
                </option>
              ))}
            </Select>
          </Field>
          <Field
            label="Rough order of magnitude"
            optional
            hint="The first guess. It is kept beside the priced position, never overwritten by it."
          >
            <NumberInput
              value={form.roughOrderOfMagnitude}
              onChange={(v) => set("roughOrderOfMagnitude", v)}
              precision={2}
              step={100}
              align="right"
            />
          </Field>
        </div>

        <div className="grid gap-3 sm:grid-cols-3">
          <Field label="Days claimed" optional>
            <NumberInput
              value={form.scheduleImpactDays}
              onChange={(v) => set("scheduleImpactDays", v)}
              min={0}
              precision={0}
              suffix="d"
            />
          </Field>
          <Field label="Identified on" optional>
            <Input
              type="date"
              value={form.identifiedDate}
              onChange={(e) => set("identifiedDate", e.target.value)}
            />
          </Field>
          <Field label="Response due" optional>
            <Input
              type="date"
              value={form.dueDate}
              onChange={(e) => set("dueDate", e.target.value)}
            />
          </Field>
        </div>
      </div>
    </Modal>
  );
}

/* ------------------------------------------------------------------ */
/* Detail                                                              */
/* ------------------------------------------------------------------ */

function EventDrawer({
  projectId,
  eventId,
  onClose,
  onChanged,
  context,
}: {
  projectId: string;
  eventId: string;
  onClose: () => void;
  onChanged: () => void;
  context: ChangeContext;
}) {
  const detail = useResource<EventDetail>(
    `/api/v1/projects/${projectId}/change-events/${eventId}`,
  );
  const [statusTarget, setStatusTarget] = useState<string | null>(null);
  const [actionError, setActionError] = useState<string | null>(null);

  const event = detail.data?.event ?? null;
  const currency = context.contractCurrency(event?.primeContractId ?? null);
  const origin = event ? originOf(event) : null;

  const move = useCallback(
    async (status: string) => {
      setActionError(null);
      try {
        await api.post(
          `/api/v1/projects/${projectId}/change-events/${eventId}/status`,
          { status },
        );
        toast.success(`Change event moved to ${label(status).toLowerCase()}.`);
        detail.reload();
        onChanged();
        return true;
      } catch (err) {
        setActionError(errorMessage(err, "The transition was refused"));
        return false;
      }
    },
    [projectId, eventId, detail, onChanged],
  );

  return (
    <Drawer
      open
      onClose={onClose}
      size="xl"
      title={event ? `${event.reference} — ${event.title}` : "Change event"}
      description={
        event
          ? `${label(event.eventType)} · ${label(event.scope)} · raised ${isoDate(event.createdAt)}`
          : undefined
      }
      icon={IconChangeOrder}
      footer={
        <DrawerFooter align="between">
          <span className="text-2xs text-content-subtle">
            Closing an event over live PCOs or CORs is refused by the API — that is the control
            working, not an error.
          </span>
          <span className="flex gap-2">
            {event && (event.status === "open" || event.status === "pending") ? (
              <>
                <Button size="sm" variant="secondary" onClick={() => setStatusTarget("closed")}>
                  Close event
                </Button>
                <Button size="sm" variant="danger" onClick={() => setStatusTarget("void")}>
                  Void
                </Button>
              </>
            ) : null}
            {event && event.status === "closed" ? (
              <Button size="sm" variant="secondary" onClick={() => void move("pending")}>
                Reopen as pending
              </Button>
            ) : null}
          </span>
        </DrawerFooter>
      }
    >
      <DrawerBody>
        {detail.loading && !detail.data ? (
          <PanelSkeleton rows={6} />
        ) : detail.error ? (
          <ErrorAlert message={detail.error} />
        ) : detail.data && event ? (
          <div className="space-y-4">
            <ErrorAlert message={actionError} />

            <div className="flex flex-wrap items-center gap-2">
              <Badge tone={eventTone(event.status)}>{label(event.status)}</Badge>
              <Badge tone="neutral" variant="outline">
                {label(event.eventType)}
              </Badge>
              {event.reason ? (
                <Badge tone="neutral" variant="outline">
                  {label(event.reason)}
                </Badge>
              ) : null}
              {event.tier ? (
                <Badge tone="neutral" variant="outline">
                  {label(event.tier)}
                </Badge>
              ) : null}
            </div>

            {event.description ? (
              <p className="whitespace-pre-wrap text-body text-content-muted">
                {event.description}
              </p>
            ) : null}

            {/* ---- provenance ---- */}
            <Card>
              <CardHeader
                title="Provenance"
                subtitle="Where this change came from, and whether the platform could prove it."
              />
              <CardBody className="space-y-2">
                <DescriptionList
                  columns={2}
                  items={[
                    { label: "Origin type", value: label(event.originType) },
                    {
                      label: "Origin record",
                      value:
                        event.originType === "manual" ? (
                          "Raised manually"
                        ) : (
                          <OriginCell event={event} projectId={projectId} />
                        ),
                    },
                  ]}
                />
                {origin && !origin.verified && origin.reasons.length > 0 ? (
                  <Reasons
                    reasons={origin.reasons}
                    tone="warning"
                    title="This provenance link is recorded but unverified"
                  />
                ) : origin?.verified && event.originType !== "manual" ? (
                  <Alert tone="success" variant="subtle" size="sm">
                    Verified when the event was raised: the record exists on this project.
                  </Alert>
                ) : null}
              </CardBody>
            </Card>

            {/* ---- the three cost columns ---- */}
            <Card>
              <CardHeader
                title="Exposure, at three levels of confidence"
                subtitle="ROM is what somebody typed the day it was raised. Estimated is the priced position rolled up from live PCOs. Latest is the best number available. They are never collapsed."
              />
              <CardBody>
                <DescriptionList
                  columns={3}
                  items={[
                    {
                      label: "Rough order of magnitude",
                      value: money(detail.data.rollup.roughOrderOfMagnitude, currency),
                      hint: "typed at identification",
                    },
                    {
                      label: "Estimated cost",
                      value: money(detail.data.rollup.estimatedCost, currency),
                      hint: `Σ of ${detail.data.rollup.pcoCount} PCO(s) still alive`,
                    },
                    {
                      label: "Latest cost",
                      value: money(detail.data.rollup.latestCost, currency),
                      hint: "executed where executed, priced where priced",
                    },
                    {
                      label: "Estimated revenue",
                      value: money(detail.data.rollup.estimatedRevenue, currency),
                      hint: `${detail.data.rollup.corCount} COR(s) with the owner`,
                    },
                    {
                      label: "Approved revenue",
                      value: money(detail.data.rollup.approvedRevenue, currency),
                      hint: `${detail.data.rollup.executedPackageCount} executed package(s)`,
                    },
                    {
                      label: "Margin",
                      value: (
                        <ComponentValue
                          component={detail.data.rollup.margin}
                          format="percent"
                          dp={2}
                        />
                      ),
                    },
                    {
                      label: "Days claimed",
                      value: days(event.scheduleImpactDays),
                    },
                    { label: "Identified", value: isoDate(event.identifiedDate) },
                    { label: "Response due", value: isoDate(event.dueDate) },
                  ]}
                />
              </CardBody>
            </Card>

            {/* ---- cost lines ---- */}
            <Card>
              <CardHeader
                title="Cost lines on the event"
                subtitle="The first breakdown, before a PCO exists. Copied forward rather than retyped."
              />
              <CardBody>
                {detail.data.lines.length === 0 ? (
                  <EmptyState
                    size="sm"
                    title="No cost lines on this event"
                    hint="An event may legitimately carry none — the pricing usually lives on the PCO."
                  />
                ) : (
                  <div className="overflow-x-auto">
                    <table className="w-full min-w-[36rem] text-meta">
                      <thead>
                        <tr className="border-b border-border text-2xs uppercase tracking-wide text-content-subtle">
                          <th className="py-1.5 pr-3 text-left font-semibold">Description</th>
                          <th className="py-1.5 pr-3 text-left font-semibold">Cost type</th>
                          <th className="py-1.5 pr-3 text-right font-semibold">Cost</th>
                          <th className="py-1.5 text-right font-semibold">Revenue</th>
                        </tr>
                      </thead>
                      <tbody className="divide-y divide-border-subtle">
                        {detail.data.lines.map((line) => (
                          <tr key={line.id}>
                            <td className="py-1.5 pr-3 text-content">{line.description}</td>
                            <td className="py-1.5 pr-3 text-content-muted">
                              {label(line.costType)}
                            </td>
                            <td className="py-1.5 pr-3 text-right tabular-nums text-content">
                              {money(line.costAmount, currency)}
                            </td>
                            <td className="py-1.5 text-right tabular-nums text-content">
                              {money(line.revenueAmount, currency)}
                            </td>
                          </tr>
                        ))}
                      </tbody>
                      <tfoot className="border-t border-border font-medium">
                        <tr>
                          <td className="py-1.5 pr-3 text-content">Subtotal</td>
                          <td />
                          <td className="py-1.5 pr-3 text-right tabular-nums text-content">
                            {money(detail.data.lineTotals.costSubtotal, currency)}
                          </td>
                          <td className="py-1.5 text-right tabular-nums text-content">
                            {money(detail.data.lineTotals.revenueSubtotal, currency)}
                          </td>
                        </tr>
                      </tfoot>
                    </table>
                  </div>
                )}
              </CardBody>
            </Card>

            {/* ---- the chain from here ---- */}
            <Card>
              <CardHeader title="Down the chain" subtitle="What exists underneath this event." />
              <CardBody className="space-y-3">
                <div>
                  <p className="mb-1.5 text-2xs font-semibold uppercase tracking-wide text-content-subtle">
                    Potential change orders
                  </p>
                  {detail.data.potentialChangeOrders.length === 0 ? (
                    <p className="text-meta text-content-muted">
                      Nothing priced yet. Identified-and-never-priced is the commonest gap in the
                      chain.
                    </p>
                  ) : (
                    <ul className="space-y-1">
                      {detail.data.potentialChangeOrders.map((pco) => (
                        <li
                          key={pco.id}
                          className="flex flex-wrap items-center justify-between gap-2 rounded-md border border-border-subtle px-2.5 py-1.5 text-meta"
                        >
                          <span className="flex items-center gap-2">
                            <span className="font-mono text-2xs text-content-subtle">
                              {pco.reference}
                            </span>
                            <span className="text-content">{pco.title}</span>
                            <Badge tone={pcoTone(pco.status)} size="xs">
                              {label(pco.status)}
                            </Badge>
                          </span>
                          <span className="tabular-nums text-content">
                            {money(
                              pco.amount,
                              context.commitmentCurrency(pco.commitmentId) ?? currency,
                            )}
                          </span>
                        </li>
                      ))}
                    </ul>
                  )}
                </div>
                <Divider />
                <div>
                  <p className="mb-1.5 text-2xs font-semibold uppercase tracking-wide text-content-subtle">
                    Change order requests
                  </p>
                  {detail.data.changeOrderRequests.length === 0 ? (
                    <p className="text-meta text-content-muted">Nothing put to the owner yet.</p>
                  ) : (
                    <ul className="space-y-1">
                      {detail.data.changeOrderRequests.map((cor) => (
                        <li
                          key={cor.id}
                          className="flex flex-wrap items-center justify-between gap-2 rounded-md border border-border-subtle px-2.5 py-1.5 text-meta"
                        >
                          <span className="flex items-center gap-2">
                            <span className="font-mono text-2xs text-content-subtle">
                              {cor.reference}
                            </span>
                            <span className="text-content">{cor.title}</span>
                            <Badge tone={corTone(cor.status)} size="xs">
                              {label(cor.status)}
                            </Badge>
                          </span>
                          <span className="tabular-nums text-content">
                            asked {money(cor.amount, context.contractCurrency(cor.primeContractId))}
                            {" · granted "}
                            {money(
                              cor.approvedAmount,
                              context.contractCurrency(cor.primeContractId),
                            )}
                          </span>
                        </li>
                      ))}
                    </ul>
                  )}
                </div>
              </CardBody>
            </Card>
          </div>
        ) : null}
      </DrawerBody>

      <ConfirmDialog
        open={statusTarget !== null}
        onClose={() => setStatusTarget(null)}
        title={
          statusTarget === "void" ? "Void this change event?" : "Close this change event?"
        }
        description={
          statusTarget === "void"
            ? "Voiding removes the event from every rollup and funnel. It stays on the register and in the ledger — but it stops counting as exposure. If the change is real and simply absorbed, close it instead."
            : "Closing declares the change resolved. The API refuses to close over a live PCO or an open COR, and will name them."
        }
        destructive={statusTarget === "void"}
        confirmLabel={statusTarget === "void" ? "Void event" : "Close event"}
        onConfirm={async () => {
          if (!statusTarget) return false;
          const ok = await move(statusTarget);
          if (ok) setStatusTarget(null);
          return ok;
        }}
      />
    </Drawer>
  );
}

/* ------------------------------------------------------------------ */
/* Register                                                            */
/* ------------------------------------------------------------------ */

export default function EventsTab({
  projectId,
  events,
  loading,
  error,
  reload,
  context,
  selectedEventId,
  onSelectEvent,
}: {
  projectId: string;
  events: ChangeEventRow[];
  loading: boolean;
  error: string | null;
  reload: () => void;
  context: ChangeContext;
  selectedEventId: string | null;
  onSelectEvent: (id: string | null) => void;
}) {
  const [creating, setCreating] = useState(false);

  const columns = useMemo<DataColumns<ChangeEventRow>>(
    () => [
      {
        id: "reference",
        header: "Number",
        accessor: "reference",
        type: "code",
        width: 110,
        sticky: "start",
      },
      { id: "title", header: "Title", accessor: "title", type: "text", width: 300 },
      {
        id: "eventType",
        header: "Cause",
        accessor: "eventType",
        type: "enum",
        width: 160,
        groupable: true,
        options: CHANGE_EVENT_TYPES.map((t) => ({ value: t, text: label(t), label: label(t) })),
        cell: (ctx) => label(ctx.row.eventType),
      },
      {
        id: "reason",
        header: "Contractual reason",
        accessor: "reason",
        type: "enum",
        width: 180,
        defaultHidden: true,
        options: CHANGE_REASONS.map((r) => ({ value: r, text: label(r), label: label(r) })),
        cell: (ctx) => (ctx.row.reason ? label(ctx.row.reason) : "—"),
      },
      {
        id: "scope",
        header: "Scope",
        accessor: "scope",
        type: "enum",
        width: 120,
        options: CHANGE_EVENT_SCOPES.map((s) => ({ value: s, text: label(s), label: label(s) })),
        cell: (ctx) => (
          <Badge
            tone={
              ctx.row.scope === "out_of_scope"
                ? "warning"
                : ctx.row.scope === "in_scope"
                  ? "success"
                  : "neutral"
            }
            size="xs"
          >
            {label(ctx.row.scope)}
          </Badge>
        ),
      },
      {
        id: "origin",
        header: "Origin",
        headerText: "Origin",
        accessor: "originType",
        type: "custom",
        width: 240,
        interactive: true,
        cell: (ctx) => <OriginCell event={ctx.row} projectId={projectId} />,
        toCsv: (ctx) =>
          ctx.row.originType === "manual"
            ? "manual"
            : `${ctx.row.originType}:${ctx.row.originId ?? "unresolved"}`,
      },
      {
        id: "status",
        header: "Status",
        accessor: "status",
        type: "status",
        width: 120,
        groupable: true,
        options: CHANGE_EVENT_STATUSES.map((s) => ({
          value: s,
          text: label(s),
          label: label(s),
          tone: eventTone(s),
        })),
      },
      {
        id: "rom",
        header: "ROM",
        headerTooltip: "Rough order of magnitude — what was typed the day it was raised.",
        accessor: "roughOrderOfMagnitude",
        type: "currency",
        width: 130,
        aggregate: "sum",
        cell: (ctx) => money(ctx.row.roughOrderOfMagnitude, context.contractCurrency(ctx.row.primeContractId)),
      },
      {
        id: "estimatedCost",
        header: "Estimated",
        headerTooltip: "The priced position — Σ of the live PCOs underneath this event.",
        accessor: "estimatedCost",
        type: "currency",
        width: 130,
        aggregate: "sum",
        cell: (ctx) => money(ctx.row.estimatedCost, context.contractCurrency(ctx.row.primeContractId)),
      },
      {
        id: "latestCost",
        header: "Latest",
        headerTooltip:
          "The best number available: executed where executed, priced where priced, ROM where there is nothing else.",
        accessor: "latestCost",
        type: "currency",
        width: 130,
        aggregate: "sum",
        cell: (ctx) => money(ctx.row.latestCost, context.contractCurrency(ctx.row.primeContractId)),
      },
      {
        id: "approvedRevenue",
        header: "Approved revenue",
        accessor: "approvedRevenue",
        type: "currency",
        width: 150,
        defaultHidden: true,
        aggregate: "sum",
        cell: (ctx) => money(ctx.row.approvedRevenue, context.contractCurrency(ctx.row.primeContractId)),
      },
      {
        id: "scheduleImpactDays",
        header: "Days claimed",
        accessor: "scheduleImpactDays",
        type: "number",
        width: 120,
        aggregate: "sum",
      },
      {
        id: "currency",
        header: "Currency",
        headerText: "Currency",
        accessor: (row: ChangeEventRow) => context.contractCurrency(row.primeContractId) ?? "",
        type: "text",
        width: 100,
        defaultHidden: true,
        cell: (ctx) =>
          context.contractCurrency(ctx.row.primeContractId) ?? (
            <span
              className="text-content-subtle"
              title="No prime contract is attached, so nothing on the record says what currency this is in."
            >
              unknown
            </span>
          ),
      },
      {
        id: "identifiedDate",
        header: "Identified",
        accessor: "identifiedDate",
        type: "date",
        width: 120,
      },
      { id: "dueDate", header: "Due", accessor: "dueDate", type: "date", width: 120 },
    ],
    [projectId, context],
  );

  const mixedCurrency = context.currencies.length > 1;

  return (
    <div className="space-y-3">
      <ErrorAlert message={error} />
      {mixedCurrency ? (
        <Alert tone="warning" variant="subtle" size="sm" title="This project bills in more than one currency">
          {context.currencies.join(", ")} are all in use. Column totals in the footer add rows that
          are not in the same currency, so read them per contract — the change log reconciles them
          separately and is the figure to quote.
        </Alert>
      ) : null}

      <DataTable<ChangeEventRow>
        tableId={`changes:events:${projectId}`}
        data={events}
        columns={columns}
        getRowId={(row) => row.id}
        loading={loading}
        error={error}
        onRetry={reload}
        height={620}
        stickyHeader
        showFooter={!mixedCurrency}
        filterRow
        savedViews
        exportFileName={`change-events-${projectId}`}
        searchPlaceholder="Search change events…"
        aria-label="Change events register"
        defaultSort={[{ id: "reference", desc: true }]}
        onRowClick={(ctx) => onSelectEvent(ctx.row.id)}
        rowTone={(row) => eventTone(row.status)}
        empty={{
          icon: IconChangeOrder,
          title: "No change events raised",
          description:
            "The chain starts here. Raise an event the moment a condition arises — before anybody knows what it costs.",
          action: <Button onClick={() => setCreating(true)}>Raise a change event</Button>,
        }}
        toolbarActions={<Button onClick={() => setCreating(true)}>Raise change event</Button>}
      />

      <CreateEventModal
        open={creating}
        onClose={() => setCreating(false)}
        projectId={projectId}
        context={context}
        onCreated={reload}
      />

      {selectedEventId ? (
        <EventDrawer
          projectId={projectId}
          eventId={selectedEventId}
          onClose={() => onSelectEvent(null)}
          onChanged={reload}
          context={context}
        />
      ) : null}
    </div>
  );
}
