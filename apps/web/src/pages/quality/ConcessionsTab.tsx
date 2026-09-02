/**
 * THE CONCESSION REGISTER — every departure somebody agreed to.
 *
 * The register answers two questions that a text field on an NCR never could:
 * how many concessions has this subcontractor been given, and which of them
 * expire before handover. So the EXPIRY leads, and a granted concession with
 * no expiry is called out by name rather than left to look permanent by
 * accident — because that is exactly what it is.
 */
import { useMemo, useState } from "react";
import {
  Alert,
  Badge,
  Button,
  DataTable,
  Field,
  Input,
  Modal,
  Select,
  Textarea,
  type DataColumns,
} from "../../ui";
import { IconPlus } from "../../ui/icons";
import { api } from "../../lib/api";
import {
  CountTile,
  LoadError,
  NothingHere,
  ReasonList,
  RefusalNotice,
  isoDate,
  labelize,
  nameOf,
  plural,
  useAction,
  type Resource,
} from "./qualityShared";
import type { Concession, ConcessionSummary, Paged } from "./types";

const KINDS = ["concession", "deviation_permit", "waiver", "production_permit"];

const STATUS_TONE: Record<string, "neutral" | "info" | "warning" | "success" | "danger" | "highlight"> = {
  draft: "neutral",
  submitted: "info",
  under_review: "info",
  approved: "success",
  approved_with_conditions: "highlight",
  rejected: "danger",
  withdrawn: "neutral",
  expired: "danger",
  closed: "neutral",
};

const KIND_MEANING: Record<string, string> = {
  concession: "Accepts work already built that does not conform.",
  deviation_permit: "Authorises a departure BEFORE the work is done.",
  waiver: "Releases a verification the plan required.",
  production_permit: "Permits production to continue pending a decision.",
};

export default function ConcessionsTab({
  concessions,
  summary,
  projectId,
  users,
  onMutated,
}: {
  concessions: Resource<Paged<Concession>>;
  summary: Resource<ConcessionSummary>;
  projectId: string;
  users: Map<string, string>;
  onMutated: () => void;
}) {
  const [createOpen, setCreateOpen] = useState(false);
  const [open, setOpen] = useState<Concession | null>(null);
  const rows = concessions.data?.items ?? [];
  const s = summary.data;

  const columns = useMemo<DataColumns<Concession>>(
    () => [
      {
        id: "reference",
        header: "Reference",
        accessor: "reference",
        type: "text",
        sticky: "start",
        width: 120,
        cell: ({ row }) => (
          <button
            type="button"
            className="font-mono text-2xs font-semibold text-accent underline-offset-2 hover:underline"
            onClick={() => setOpen(row)}
          >
            {row.reference}
          </button>
        ),
      },
      {
        id: "expiry",
        header: "Expires",
        headerTooltip:
          "Work covered by an expired concession is non-conforming again. This column is the reason the register exists.",
        accessor: (row) => row.expiryDate ?? "",
        type: "text",
        width: 190,
        cell: ({ row }) => {
          const days = row.standing.daysToExpiry;
          if (!row.expiryDate) {
            return (
              <Badge tone="warning" size="xs" variant="outline">
                no expiry — permanent
              </Badge>
            );
          }
          if (row.status === "expired" || (days !== null && days < 0)) {
            return (
              <Badge tone="danger" size="xs" variant="solid">
                expired {isoDate(row.expiryDate)}
              </Badge>
            );
          }
          return (
            <span className="text-2xs tabular-nums">
              {isoDate(row.expiryDate)}
              {days !== null ? (
                <span className={days <= 30 ? "ml-1 font-semibold text-warning" : "ml-1 text-content-subtle"}>
                  · {days} {plural(days, "day")}
                </span>
              ) : null}
            </span>
          );
        },
      },
      { id: "title", header: "Title", accessor: "title", type: "text", width: 280 },
      {
        id: "kind",
        header: "Kind",
        accessor: "kind",
        type: "text",
        width: 150,
        cell: ({ row }) => (
          <Badge tone="neutral" size="xs" variant="outline" title={KIND_MEANING[row.kind]}>
            {labelize(row.kind)}
          </Badge>
        ),
      },
      {
        id: "status",
        header: "Status",
        accessor: "status",
        type: "text",
        width: 170,
        cell: ({ row }) => (
          <Badge tone={STATUS_TONE[row.status] ?? "neutral"} size="xs" dot>
            {labelize(row.status)}
          </Badge>
        ),
      },
      {
        id: "approvedBy",
        header: "Approved by",
        accessor: (row) => (row.approvedBy ? nameOf(users, row.approvedBy) : ""),
        type: "text",
        width: 180,
        cell: ({ row }) =>
          row.approvedBy ? (
            <span className="text-2xs">
              {nameOf(users, row.approvedBy)}
              {row.approvalAuthority ? (
                <span className="block text-2xs text-content-subtle">{row.approvalAuthority}</span>
              ) : null}
            </span>
          ) : (
            <span className="text-2xs italic text-content-subtle">nobody yet</span>
          ),
      },
      {
        id: "limit",
        header: "Limit",
        accessor: (row) => row.quantityLimit ?? 0,
        type: "number",
        width: 120,
        align: "right",
        cell: ({ row }) =>
          row.quantityLimit === null ? (
            <span className="text-2xs text-content-subtle">unlimited</span>
          ) : (
            <span className="text-2xs tabular-nums">
              {row.quantityLimit} {row.unit ?? ""}
            </span>
          ),
      },
    ],
    [users],
  );

  return (
    <div className="space-y-4">
      {summary.error ? (
        <LoadError message={summary.error} onRetry={summary.reload} />
      ) : (
        <div className="grid gap-2 sm:grid-cols-2 lg:grid-cols-5">
          <CountTile label="On the register" value={s?.total ?? 0} />
          <CountTile label="Live" value={s?.live ?? 0} tone="highlight" emphasis />
          <CountTile
            label="Expiring in 60 days"
            value={s?.expiring.length ?? 0}
            tone="warning"
            emphasis
            hint="Work relying on them goes back to non-conforming on the day."
          />
          <CountTile label="Expired" value={s?.expired ?? 0} tone="danger" emphasis />
          <CountTile
            label="No expiry recorded"
            value={s?.withoutExpiry ?? 0}
            tone="warning"
            emphasis
            hint="A concession with no end is a permanent change to the specification."
          />
        </div>
      )}

      {s && s.expiring.length > 0 ? (
        <Alert tone="warning" title={`${s.expiring.length} ${plural(s.expiring.length, "concession")} expiring`}>
          <ul className="space-y-0.5 text-meta">
            {s.expiring.map((e) => (
              <li key={e.id}>
                <span className="font-mono">{e.reference}</span> expires {isoDate(e.expiryDate)}
                {e.days !== null ? ` — ${e.days} ${plural(e.days, "day")} away` : ""}.
              </li>
            ))}
          </ul>
        </Alert>
      ) : null}

      <div className="flex flex-wrap items-center justify-between gap-2">
        <p className="text-meta text-content-muted">
          {concessions.data
            ? `${concessions.data.total} ${plural(concessions.data.total, "concession")} on this project`
            : "Loading the register…"}
        </p>
        <Button size="sm" icon={IconPlus} onClick={() => setCreateOpen(true)}>
          Request a concession
        </Button>
      </div>

      {concessions.error ? (
        <LoadError message={concessions.error} onRetry={concessions.reload} />
      ) : rows.length === 0 ? (
        <NothingHere
          title="No concession has been requested on this project"
          reason="A concession is how a departure from the specification is accepted by the designer, with conditions and an expiry. Every use-as-is and repair disposition should have one behind it."
          action={
            <Button size="sm" icon={IconPlus} onClick={() => setCreateOpen(true)}>
              Request the first one
            </Button>
          }
        />
      ) : (
        <DataTable<Concession>
          tableId="quality-concessions"
          data={rows}
          columns={columns}
          getRowId={(row) => row.id}
          height={520}
          stickyHeader
          zebra
          filterRow
          exportFileName="concessions"
          searchPlaceholder="Search concessions"
          aria-label="Concessions"
          rowTone={(row) =>
            row.status === "expired"
              ? "danger"
              : row.standing.daysToExpiry !== null && row.standing.daysToExpiry <= 30 && row.standing.live
                ? "warning"
                : undefined
          }
        />
      )}

      <CreateConcession
        open={createOpen}
        onClose={() => setCreateOpen(false)}
        projectId={projectId}
        onCreated={() => {
          setCreateOpen(false);
          onMutated();
        }}
      />
      <ConcessionModal
        concession={open}
        projectId={projectId}
        users={users}
        onClose={() => setOpen(null)}
        onMutated={() => {
          setOpen(null);
          onMutated();
        }}
      />
    </div>
  );
}

/* ================================================================== */

function CreateConcession({
  open,
  onClose,
  projectId,
  onCreated,
}: {
  open: boolean;
  onClose: () => void;
  projectId: string;
  onCreated: () => void;
}) {
  const { busy, refusal, clear, run } = useAction();
  const [title, setTitle] = useState("");
  const [description, setDescription] = useState("");
  const [departure, setDeparture] = useState("");
  const [kind, setKind] = useState("concession");
  const [expiry, setExpiry] = useState("");
  const [quantity, setQuantity] = useState("");
  const [unit, setUnit] = useState("");

  async function create() {
    const parsed = quantity.trim() === "" ? null : Number(quantity);
    const done = await run("create", () =>
      api.post(`/api/v1/projects/${projectId}/concessions`, {
        title: title.trim(),
        description: description.trim(),
        departureFromRequirement: departure.trim() === "" ? null : departure.trim(),
        kind,
        expiryDate: expiry === "" ? null : expiry,
        quantityLimit: parsed !== null && Number.isFinite(parsed) ? parsed : null,
        unit: unit.trim() === "" ? null : unit.trim(),
      }),
    );
    if (done) {
      setTitle("");
      setDescription("");
      setDeparture("");
      setExpiry("");
      setQuantity("");
      setUnit("");
      onCreated();
    }
  }

  return (
    <Modal
      open={open}
      onClose={onClose}
      title="Request a concession"
      description="State the departure, not the outcome. A concession that does not say what it departs from cannot be assessed by the designer, and cannot be checked against the works afterwards."
      footer={
        <div className="flex justify-end gap-2">
          <Button variant="ghost" onClick={onClose}>
            Cancel
          </Button>
          <Button
            variant="primary"
            loading={busy === "create"}
            disabled={title.trim() === "" || description.trim() === ""}
            onClick={create}
          >
            Raise the request
          </Button>
        </div>
      }
    >
      <div className="space-y-3">
        <RefusalNotice refusal={refusal} onDismiss={clear} />
        <Field label="Title" required>
          <Input value={title} onChange={(e) => setTitle(e.target.value)} autoFocus />
        </Field>
        <Field label="Kind" hint={KIND_MEANING[kind]}>
          <Select value={kind} onChange={(e) => setKind(e.target.value)}>
            {KINDS.map((k) => (
              <option key={k} value={k}>
                {labelize(k)}
              </option>
            ))}
          </Select>
        </Field>
        <Field label="What was found" required>
          <Textarea rows={3} value={description} onChange={(e) => setDescription(e.target.value)} />
        </Field>
        <Field
          label="The departure from the requirement"
          hint="Quote the clause or the drawing. Submission is refused without it."
        >
          <Textarea rows={2} value={departure} onChange={(e) => setDeparture(e.target.value)} />
        </Field>
        <div className="grid gap-3 sm:grid-cols-3">
          <Field label="Expires" hint="Leave blank only if it is genuinely permanent.">
            <Input type="date" value={expiry} onChange={(e) => setExpiry(e.target.value)} />
          </Field>
          <Field label="Quantity limit">
            <Input
              type="number"
              value={quantity}
              onChange={(e) => setQuantity(e.target.value)}
              placeholder="e.g. 4"
            />
          </Field>
          <Field label="Unit">
            <Input value={unit} onChange={(e) => setUnit(e.target.value)} placeholder="m2" />
          </Field>
        </div>
      </div>
    </Modal>
  );
}

/* ================================================================== */

function ConcessionModal({
  concession,
  projectId,
  users,
  onClose,
  onMutated,
}: {
  concession: Concession | null;
  projectId: string;
  users: Map<string, string>;
  onClose: () => void;
  onMutated: () => void;
}) {
  const { busy, refusal, clear, run } = useAction();
  const [authority, setAuthority] = useState("");
  const [conditions, setConditions] = useState("");
  const [expiry, setExpiry] = useState("");
  if (!concession) return null;
  const base = `/api/v1/projects/${projectId}/concessions/${concession.id}`;
  const days = concession.standing.daysToExpiry;

  async function decide(decision: "approve" | "approve_with_conditions" | "reject") {
    const done = await run(decision, () =>
      api.post(`${base}/approve`, {
        decision,
        approvalAuthority: authority.trim() === "" ? "Designer" : authority.trim(),
        conditions: conditions.trim() === "" ? null : conditions.trim(),
        expiryDate: expiry === "" ? null : expiry,
      }),
    );
    if (done) onMutated();
  }

  return (
    <Modal
      open
      onClose={onClose}
      title={`${concession.reference} — ${concession.title}`}
      description={KIND_MEANING[concession.kind]}
      size="lg"
      footer={
        <div className="flex flex-wrap justify-end gap-2">
          <Button variant="ghost" onClick={onClose}>
            Close
          </Button>
          {concession.status === "draft" ? (
            <Button
              variant="secondary"
              loading={busy === "submit"}
              onClick={async () => {
                const done = await run("submit", () => api.post(`${base}/submit`, {}));
                if (done) onMutated();
              }}
            >
              Submit to the designer
            </Button>
          ) : null}
          {concession.status === "submitted" || concession.status === "under_review" ? (
            <>
              <Button variant="ghost" loading={busy === "reject"} onClick={() => decide("reject")}>
                Reject
              </Button>
              <Button
                variant="secondary"
                loading={busy === "approve_with_conditions"}
                onClick={() => decide("approve_with_conditions")}
              >
                Approve with conditions
              </Button>
              <Button variant="primary" loading={busy === "approve"} onClick={() => decide("approve")}>
                Approve
              </Button>
            </>
          ) : null}
        </div>
      }
    >
      <div className="space-y-3 text-meta">
        <RefusalNotice refusal={refusal} onDismiss={clear} />
        <div className="flex flex-wrap gap-1.5">
          <Badge tone={STATUS_TONE[concession.status] ?? "neutral"} size="xs" dot>
            {labelize(concession.status)}
          </Badge>
          {concession.expiryDate ? (
            <Badge tone={days !== null && days < 0 ? "danger" : "neutral"} size="xs" variant="outline">
              expires {isoDate(concession.expiryDate)}
            </Badge>
          ) : (
            <Badge tone="warning" size="xs" variant="outline">
              no expiry
            </Badge>
          )}
        </div>
        <p className="whitespace-pre-wrap text-content">{concession.description}</p>
        {concession.departureFromRequirement ? (
          <div className="rounded-md border border-border-subtle bg-surface-sunken p-2.5">
            <div className="text-label uppercase tracking-wide text-content-subtle">
              Departure from the requirement
            </div>
            <p className="mt-0.5 whitespace-pre-wrap">{concession.departureFromRequirement}</p>
          </div>
        ) : null}
        {concession.conditions ? (
          <div className="rounded-md border border-border-subtle p-2.5">
            <div className="text-label uppercase tracking-wide text-content-subtle">Conditions</div>
            <p className="mt-0.5 whitespace-pre-wrap">{concession.conditions}</p>
          </div>
        ) : null}
        <ReasonList reasons={concession.standing.reasons} />
        <div className="grid gap-2 sm:grid-cols-2">
          <div>
            <div className="text-label uppercase tracking-wide text-content-subtle">Requested by</div>
            <div>{nameOf(users, concession.requestedBy)}</div>
          </div>
          <div>
            <div className="text-label uppercase tracking-wide text-content-subtle">Approved by</div>
            <div>
              {concession.approvedBy ? nameOf(users, concession.approvedBy) : "—"}
              {concession.approvalAuthority ? ` · ${concession.approvalAuthority}` : ""}
            </div>
          </div>
        </div>
        {concession.status === "submitted" || concession.status === "under_review" ? (
          <div className="space-y-2 rounded-md border border-border-subtle p-2.5">
            <p className="text-2xs text-content-subtle">
              The decision is segregated: the API refuses it from the person who asked for the
              departure.
            </p>
            <Field label="Approval authority" required>
              <Input
                value={authority}
                onChange={(e) => setAuthority(e.target.value)}
                placeholder="e.g. Structural engineer"
              />
            </Field>
            <Field label="Conditions" hint="Required when approving with conditions.">
              <Textarea rows={2} value={conditions} onChange={(e) => setConditions(e.target.value)} />
            </Field>
            <Field label="Expiry" hint="A concession with an end date is one somebody has to revisit.">
              <Input type="date" value={expiry} onChange={(e) => setExpiry(e.target.value)} />
            </Field>
          </div>
        ) : null}
      </div>
    </Modal>
  );
}
