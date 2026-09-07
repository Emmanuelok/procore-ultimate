/**
 * Invitations — who was asked, whether they engaged, and where their
 * prequalification actually stands right now.
 *
 * Three things this screen exists to make impossible to miss:
 *
 *  - A SILENT BIDDER. Sent, reminded, never opened. The engagement rail shows
 *    each step so "we invited six" is not mistaken for "six are pricing it".
 *  - A LAPSED PREQUALIFICATION. Flagged here, not at award — they may still
 *    renew before the deadline, and telling them to is the entire point.
 *  - AN UNACKNOWLEDGED ADDENDUM. A bid submitted without acknowledging one was
 *    priced against a different scope.
 *
 * The bidder portal token follows the platform's show-once discipline: the raw
 * value exists in one response at one moment, only its sha256 is stored, and
 * closing the dialog is an explicit acknowledgement that it is gone.
 */
import { useMemo, useState } from "react";
import {
  Alert,
  Badge,
  Button,
  Card,
  CardBody,
  DataTable,
  EmptyState,
  Field,
  Input,
  Modal,
  Select,
  Textarea,
  Tooltip,
} from "../../ui";
import type { DataColumns } from "../../ui";
import { cx } from "../../ui/cx";
import {
  IconCheck,
  IconClose,
  IconEye,
  IconLock,
  IconMail,
  IconPlus,
  IconSend,
  IconUsers,
} from "../../ui/icons";
import { api } from "../../lib/api";
import {
  CapacityNote,
  LoadError,
  LoadingBlock,
  PREQUAL_LABEL,
  PREQUAL_TONE,
  RefusalPanel,
  dateTime,
  invitationTone,
  titleCase,
  useAction,
  useReason,
  useResource,
  useVendors,
} from "./biddingShared";
import type { BidInvitation, InvitationList, PackageDetail } from "./types";

const DECLINE_REASONS = [
  "capacity",
  "scope_mismatch",
  "programme",
  "commercial_terms",
  "risk_allocation",
  "insufficient_time",
  "geography",
  "prequalification_lapsed",
  "no_reason_given",
  "other",
] as const;

export default function InvitationsTab({
  projectId,
  packageId,
  pkg,
  loading,
  onMutated,
}: {
  projectId: string;
  packageId: string;
  pkg: PackageDetail | null;
  loading: boolean;
  onMutated: () => void;
}) {
  const [version, setVersion] = useState(0);
  const list = useResource<InvitationList>(
    packageId
      ? `/api/v1/projects/${projectId}/bid-packages/${packageId}/invitations?page=1&pageSize=200&_v=${version}`
      : null,
  );
  const action = useAction();
  const { ask, dialog } = useReason();
  const [inviteOpen, setInviteOpen] = useState(false);
  const [revealed, setRevealed] = useState<{ token: string; vendor: string } | null>(null);
  const [acknowledged, setAcknowledged] = useState(false);
  const [copied, setCopied] = useState(false);

  function refresh() {
    setVersion((n) => n + 1);
    onMutated();
  }

  const rows = list.data?.items ?? [];
  const summary = list.data?.summary;

  async function post(key: string, id: string, path: string, body?: unknown) {
    const done = await action.run(`${key}:${id}`, () =>
      api.post(`/api/v1/bid-invitations/${id}/${path}`, body ?? {}),
    );
    if (done) refresh();
  }

  const [declineFor, setDeclineFor] = useState<BidInvitation | null>(null);

  async function mintToken(inv: BidInvitation) {
    const res = await action.run(`token:${inv.id}`, () =>
      api.post<{ token: string }>(`/api/v1/bid-invitations/${inv.id}/portal-token`, {}),
    );
    if (res) {
      setAcknowledged(false);
      setCopied(false);
      setRevealed({ token: res.token, vendor: inv.vendorName ?? inv.vendorId });
      refresh();
    }
  }

  const columns: DataColumns<BidInvitation> = useMemo(
    () => [
      {
        id: "vendor",
        header: "Bidder",
        accessor: (row) => row.vendorName ?? row.vendorId,
        type: "text",
        width: 220,
        sticky: "start",
        cell: ({ row }) => (
          <div className="min-w-0">
            <p className="truncate font-medium">{row.vendorName ?? row.vendorId}</p>
            {row.contactName || row.contactEmail ? (
              <p className="truncate text-2xs text-content-subtle">
                {[row.contactName, row.contactEmail].filter(Boolean).join(" · ")}
              </p>
            ) : null}
          </div>
        ),
      },
      {
        id: "status",
        header: "Status",
        accessor: "status",
        type: "status",
        width: 130,
        groupable: true,
        cell: ({ row }) => (
          <Badge tone={invitationTone(row.status)} size="xs" dot variant="subtle">
            {titleCase(row.status)}
          </Badge>
        ),
      },
      {
        id: "engagement",
        header: "Engagement",
        accessor: (row) =>
          [row.engagement.sent, row.engagement.delivered, row.engagement.viewed, row.engagement.downloaded, row.engagement.responded].filter(
            Boolean,
          ).length,
        width: 210,
        cell: ({ row }) => <EngagementRail invitation={row} />,
      },
      {
        id: "prequal",
        header: "Prequalification",
        accessor: (row) => row.prequalification.state,
        type: "text",
        width: 260,
        groupable: true,
        cell: ({ row }) => (
          <div className="min-w-0 py-0.5">
            <Badge tone={PREQUAL_TONE[row.prequalification.state]} size="xs" dot variant="subtle">
              {PREQUAL_LABEL[row.prequalification.state]}
            </Badge>
            <p className="mt-0.5 whitespace-normal text-2xs leading-snug text-content-muted">
              {row.prequalification.flag ?? row.prequalification.note}
            </p>
          </div>
        ),
      },
      {
        id: "capacity",
        header: "Capacity for this package",
        accessor: (row) => row.capacity.severity,
        width: 260,
        cell: ({ row }) => <CapacityNote check={row.capacity} compact />,
      },
      {
        id: "addenda",
        header: "Addenda outstanding",
        accessor: (row) => row.outstandingAddenda.length,
        type: "number",
        width: 170,
        cell: ({ row }) =>
          row.outstandingAddenda.length === 0 ? (
            <span className="text-2xs text-content-subtle">none</span>
          ) : (
            <Tooltip
              content={`A bid submitted without acknowledging ${row.outstandingAddenda.join(", ")} was priced against a different scope.`}
            >
              <span>
                <Badge tone="warning" size="xs">
                  {row.outstandingAddenda.join(", ")}
                </Badge>
              </span>
            </Tooltip>
          ),
      },
      {
        id: "reminders",
        header: "Reminders",
        accessor: "remindersSent",
        type: "number",
        width: 100,
        align: "right",
      },
      {
        id: "portal",
        header: "Portal",
        accessor: (row) => (row.portalAccessIssued ? "issued" : "none"),
        width: 110,
        cell: ({ row }) =>
          row.portalAccessIssued ? (
            <Badge tone="info" size="xs" variant="subtle">
              token issued
            </Badge>
          ) : (
            <span className="text-2xs text-content-subtle">no access</span>
          ),
      },
    ],
    [],
  );

  if (loading && !pkg) return <LoadingBlock rows={5} />;
  if (list.error) return <LoadError message={list.error} onRetry={list.reload} />;

  return (
    <div className="space-y-4">
      <RefusalPanel refusal={action.refusal} onDismiss={action.clear} />

      {summary ? (
        <div className="grid gap-3 sm:grid-cols-3">
          <SummaryTile
            label="Standing flagged"
            value={summary.flagged}
            tone={summary.flagged > 0 ? "danger" : "success"}
            hint={
              summary.flagged > 0
                ? "These bidders' prequalification is lapsed, undecided, suspended, rejected or absent. Awarding to one is refused or warned at award — telling them to renew now is the point of flagging it here."
                : "Every invited bidder's prequalification stands clean today."
            }
          />
          <SummaryTile
            label="Declined"
            value={summary.declined}
            tone={summary.declined > 0 ? "warning" : "neutral"}
            hint="A pattern in the coded reasons is a finding about our own tender, not about them."
          />
          <SummaryTile
            label="Silent after a reminder"
            value={summary.silent}
            tone={summary.silent > 0 ? "warning" : "neutral"}
            hint="Sent and chased, never opened. A silent bidder is not a bidder."
          />
        </div>
      ) : null}

      <div className="flex flex-wrap items-center justify-between gap-3">
        <p className="max-w-3xl text-meta leading-relaxed text-content-muted">
          Every bidder is a directory vendor — that binding is what carries prequalification,
          insurance and bonding onto the bid.
        </p>
        <Button
          icon={IconPlus}
          onClick={() => setInviteOpen(true)}
          disabled={!pkg || pkg.status === "cancelled"}
        >
          Invite bidders
        </Button>
      </div>

      {rows.length === 0 ? (
        <EmptyState
          icon={IconUsers}
          title="Nobody has been invited to this package"
          hint="An invitation binds a directory vendor to this tender and starts the engagement record — sent, delivered, viewed, downloaded, responded. Until then there is no market for this package, only an intention to create one."
          action={
            <Button icon={IconPlus} onClick={() => setInviteOpen(true)}>
              Invite bidders
            </Button>
          }
        />
      ) : (
        <DataTable<BidInvitation>
          tableId="bidding.invitations"
          data={rows}
          columns={columns}
          getRowId={(row) => row.id}
          height={520}
          stickyHeader
          rowHeight={62}
          filterRow
          searchPlaceholder="Search bidders…"
          exportFileName="bid-invitations"
          rowTone={(row) =>
            row.prequalification.ok === false
              ? "danger"
              : row.engagement.silent
                ? "warning"
                : undefined
          }
          rowActions={(row) => [
            {
              id: "send",
              label: "Mark sent",
              icon: IconSend,
              hidden: row.status !== "draft",
              onSelect: () => void post("send", row.id, "send"),
            },
            {
              id: "delivered",
              label: "Mark delivered",
              icon: IconMail,
              hidden: !row.engagement.sent || row.engagement.delivered,
              onSelect: () => void post("delivery", row.id, "delivery", { delivered: true }),
            },
            {
              id: "viewed",
              label: "Record a view",
              icon: IconEye,
              onSelect: () => void post("view", row.id, "view"),
            },
            {
              id: "download",
              label: "Record a download",
              onSelect: () => void post("download", row.id, "download"),
            },
            {
              id: "intent",
              label: "Record intent to bid",
              icon: IconCheck,
              onSelect: () => void post("intent", row.id, "intent", { intentToBid: true }),
            },
            {
              id: "remind",
              label: "Record a reminder",
              onSelect: () => void post("remind", row.id, "remind"),
            },
            {
              id: "decline",
              label: "Record a decline",
              icon: IconClose,
              onSelect: () => setDeclineFor(row),
            },
            {
              id: "token",
              label: row.portalAccessIssued ? "Re-issue portal token" : "Issue portal token",
              icon: IconLock,
              onSelect: () => void mintToken(row),
            },
            {
              id: "disqualify",
              label: "Disqualify",
              destructive: true,
              hidden: row.status === "disqualified",
              onSelect: () => {
                void (async () => {
                  const reason = await ask({
                    title: `Disqualify ${row.vendorName ?? row.vendorId}`,
                    description:
                      "Disqualification ends this bidder's participation. The reason travels with the record and is what they are told.",
                    confirmLabel: "Disqualify",
                    destructive: true,
                  });
                  if (reason) await post("disqualify", row.id, "disqualify", { reason });
                })();
              },
            },
          ]}
          empty={{
            title: "No invitations match",
            description: "Every invitation on this package is filtered out by the current filters.",
          }}
        />
      )}

      <InviteModal
        open={inviteOpen}
        projectId={projectId}
        packageId={packageId}
        onClose={() => setInviteOpen(false)}
        onCreated={refresh}
        onDone={() => {
          setInviteOpen(false);
          refresh();
        }}
      />

      <DeclineModal
        invitation={declineFor}
        onClose={() => setDeclineFor(null)}
        onSubmit={async (reason, note) => {
          const inv = declineFor;
          setDeclineFor(null);
          if (inv) await post("decline", inv.id, "decline", { reason, note: note || null });
        }}
      />

      {/* ------------------------- show once ------------------------- */}
      <Modal
        open={revealed !== null}
        title={revealed ? `Bidder portal token — ${revealed.vendor}` : "Portal token"}
        onClose={() => {
          if (acknowledged) setRevealed(null);
        }}
        dismissible={acknowledged}
        closeOnOverlayClick={false}
        tone="warning"
        footer={
          <div className="flex justify-end gap-2">
            <Button disabled={!acknowledged} onClick={() => setRevealed(null)}>
              I have stored it — close
            </Button>
          </div>
        }
      >
        {revealed ? (
          <div className="space-y-4">
            <Alert tone="danger" title="This is the only time this token will ever be shown">
              Only its SHA-256 is stored, exactly as this platform's API tokens are. Nobody —
              including us — can read it back. Losing it means issuing a new one, which revokes
              this one immediately.
            </Alert>
            <div className="flex items-center gap-2">
              <code className="block flex-1 select-all break-all rounded-md bg-surface-inverse p-3 font-mono text-sm text-surface-inverse-fg">
                {revealed.token}
              </code>
              <Button
                variant="secondary"
                onClick={() => {
                  navigator.clipboard
                    ?.writeText(revealed.token)
                    .then(() => setCopied(true))
                    .catch(() => setCopied(false));
                }}
              >
                {copied ? "Copied" : "Copy"}
              </Button>
            </div>
            <label className="flex items-start gap-2 text-meta">
              <input
                type="checkbox"
                className="mt-0.5"
                checked={acknowledged}
                onChange={(e) => setAcknowledged(e.target.checked)}
              />
              <span>
                I have given this token to the bidder and stored it somewhere safe. I understand it
                cannot be shown again.
              </span>
            </label>
          </div>
        ) : null}
      </Modal>

      {dialog}
    </div>
  );
}

/* ================================================================== */
/* Engagement                                                          */
/* ================================================================== */

const STEPS = [
  { key: "sent", label: "Sent" },
  { key: "delivered", label: "Delivered" },
  { key: "viewed", label: "Viewed" },
  { key: "downloaded", label: "Downloaded" },
  { key: "responded", label: "Responded" },
] as const;

function EngagementRail({ invitation }: { invitation: BidInvitation }) {
  const e = invitation.engagement;
  const state: Record<string, boolean> = {
    sent: e.sent,
    delivered: e.delivered,
    viewed: e.viewed,
    downloaded: e.downloaded,
    responded: e.responded,
  };
  return (
    <div className="py-0.5">
      <div className="flex items-center gap-1">
        {STEPS.map((s) => (
          <Tooltip
            key={s.key}
            content={
              state[s.key]
                ? `${s.label}${s.key === "sent" && invitation.sentAt ? ` ${dateTime(invitation.sentAt)}` : ""}`
                : `Not ${s.label.toLowerCase()}`
            }
          >
            <span
              className={cx(
                "h-1.5 w-8 rounded-full",
                state[s.key] ? "bg-success-solid" : "bg-neutral-subtle",
              )}
            />
          </Tooltip>
        ))}
      </div>
      <p className="mt-1 text-2xs leading-snug text-content-subtle">
        {e.silent ? (
          <span className="font-medium text-warning-fg">
            Chased {e.remindersSent}× and still silent — never viewed.
          </span>
        ) : e.responded ? (
          `Responded ${dateTime(invitation.respondedAt)}`
        ) : e.downloaded ? (
          `Downloaded ${invitation.downloadCount}×, no response yet`
        ) : e.viewed ? (
          "Viewed, not downloaded"
        ) : e.sent ? (
          "Sent, not yet opened"
        ) : (
          "Not sent"
        )}
      </p>
    </div>
  );
}

function SummaryTile({
  label,
  value,
  tone,
  hint,
}: {
  label: string;
  value: number;
  tone: "success" | "warning" | "danger" | "neutral";
  hint: string;
}) {
  return (
    <Card accent={tone}>
      <CardBody>
        <div className="text-label uppercase text-content-subtle">{label}</div>
        <div className="mt-0.5 text-xl font-semibold tabular-nums">{value}</div>
        <p className="mt-1 text-2xs leading-snug text-content-subtle">{hint}</p>
      </CardBody>
    </Card>
  );
}

/* ================================================================== */
/* Invite                                                              */
/* ================================================================== */

function InviteModal({
  open,
  projectId,
  packageId,
  onClose,
  onCreated,
  onDone,
}: {
  open: boolean;
  projectId: string;
  packageId: string;
  onClose: () => void;
  /** Fired on every successful write, notes or no notes. */
  onCreated: () => void;
  onDone: () => void;
}) {
  const vendors = useVendors();
  const action = useAction();
  const [selected, setSelected] = useState<string[]>([]);
  const [warnings, setWarnings] = useState<string[]>([]);
  const [query, setQuery] = useState("");

  const list = (vendors.data?.items ?? []).filter((v) =>
    query.trim() ? v.name.toLowerCase().includes(query.trim().toLowerCase()) : true,
  );

  async function submit() {
    const res = await action.run("invite", () =>
      api.post<{ warnings?: string[] }>(
        `/api/v1/projects/${projectId}/bid-packages/${packageId}/invitations`,
        { invitations: selected.map((vendorId) => ({ vendorId })) },
      ),
    );
    if (res) {
      /*
       * THE LIST REFRESHES WHETHER OR NOT THERE WERE NOTES.
       *
       * Refreshing only on the clean path meant that an invitation issued to a
       * vendor whose prequalification was expiring — the case a buyer most
       * needs to see — was created on the server and then not shown, because
       * the warning kept the modal open and the footer's Close never
       * refreshed. The write happened; the register must show it.
       */
      setWarnings(res.warnings ?? []);
      setSelected([]);
      onCreated();
      if ((res.warnings ?? []).length === 0) onDone();
    }
  }

  return (
    <Modal
      open={open}
      onClose={onClose}
      title="Invite bidders"
      size="lg"
      description="Every bidder is a vendor in this company's directory."
      footer={
        <div className="flex justify-end gap-2">
          <Button variant="ghost" onClick={onClose}>
            Close
          </Button>
          <Button
            onClick={() => void submit()}
            loading={action.busy === "invite"}
            disabled={selected.length === 0}
          >
            Invite {selected.length || ""}
          </Button>
        </div>
      }
    >
      <div className="space-y-3">
        <RefusalPanel refusal={action.refusal} onDismiss={action.clear} />
        {warnings.length > 0 ? (
          <Alert tone="warning" title="Invited, with these standings named">
            <ul className="mt-1 space-y-1 text-meta">
              {warnings.map((w, i) => (
                <li key={i}>{w}</li>
              ))}
            </ul>
            <p className="mt-2 text-meta">
              An invitation to a lapsed vendor is flagged, not refused — they may renew before the
              deadline, and telling them to is the point.
            </p>
          </Alert>
        ) : null}
        <Field label="Search the directory">
          <Input value={query} onChange={(e) => setQuery(e.target.value)} placeholder="Vendor name" />
        </Field>
        <div className="max-h-72 space-y-1 overflow-y-auto rounded-md border border-border p-2">
          {vendors.loading ? (
            <p className="p-2 text-meta text-content-subtle">Loading the directory…</p>
          ) : list.length === 0 ? (
            <p className="p-2 text-meta text-content-subtle">
              No vendor in this company's directory matches. Bidders are added in the Directory
              first — that binding is what carries prequalification onto the bid.
            </p>
          ) : (
            list.map((v) => (
              <label
                key={v.id}
                className="flex cursor-pointer items-center gap-2 rounded px-2 py-1.5 text-sm hover:bg-surface-hover"
              >
                <input
                  type="checkbox"
                  checked={selected.includes(v.id)}
                  onChange={() =>
                    setSelected((prev) =>
                      prev.includes(v.id) ? prev.filter((x) => x !== v.id) : [...prev, v.id],
                    )
                  }
                />
                <span className="flex-1 truncate">{v.name}</span>
                <Badge tone="neutral" size="xs">
                  {titleCase(v.status)}
                </Badge>
              </label>
            ))
          )}
        </div>
      </div>
    </Modal>
  );
}

/* ================================================================== */
/* Decline                                                             */
/* ================================================================== */

function DeclineModal({
  invitation,
  onClose,
  onSubmit,
}: {
  invitation: BidInvitation | null;
  onClose: () => void;
  onSubmit: (reason: string, note: string) => Promise<void>;
}) {
  const [reason, setReason] = useState<string>("no_reason_given");
  const [note, setNote] = useState("");
  return (
    <Modal
      open={invitation !== null}
      onClose={onClose}
      title={`Record a decline — ${invitation?.vendorName ?? ""}`}
      footer={
        <div className="flex justify-end gap-2">
          <Button variant="ghost" onClick={onClose}>
            Cancel
          </Button>
          <Button
            onClick={() => {
              void onSubmit(reason, note);
              setNote("");
            }}
          >
            Record the decline
          </Button>
        </div>
      }
    >
      <div className="space-y-3">
        <p className="text-meta leading-relaxed text-content-muted">
          The reason is a coded value rather than free text, because the pattern is the finding: a
          package where four of six bidders cite <em>insufficient time</em> is a procurement
          failure on our side, and that is only visible if the reason is a value.
        </p>
        <Field label="Reason" required>
          <Select value={reason} onChange={(e) => setReason(e.target.value)}>
            {DECLINE_REASONS.map((r) => (
              <option key={r} value={r}>
                {titleCase(r)}
              </option>
            ))}
          </Select>
        </Field>
        <Field label="Note" optional hint="Anything the coded reason cannot carry.">
          <Textarea rows={3} value={note} onChange={(e) => setNote(e.target.value)} />
        </Field>
      </div>
    </Modal>
  );
}
