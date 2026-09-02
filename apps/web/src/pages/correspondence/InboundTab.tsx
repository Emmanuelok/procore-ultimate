/**
 * INBOUND EMAIL (#99).
 *
 * Every parsed message this project captured, and — the point of the screen —
 * exactly WHY routing filed it where it did. A message whose subject quoted a
 * reference this project never issued is marked `unmatched` and says so, so
 * nobody has to guess whether the register silently mis-filed something.
 *
 * The capture form here posts the same parsed-email JSON a mail transport
 * would, which is how an operator files something that arrived out of band.
 */
import { useEffect, useMemo, useState, type FormEvent } from "react";
import {
  Alert,
  Badge,
  Button,
  Card,
  CardBody,
  DataTable,
  Drawer,
  Field,
  Input,
  Select,
  StatusPill,
  Textarea,
  toast,
  type DataColumns,
} from "../../ui";
import { IconInbox } from "../../ui/icons";
import {
  DASH,
  LoadError,
  ReasonList,
  Row,
  corrApi,
  dateTime,
  titleCase,
  useAction,
  useResource,
  useTypes,
  type InboundMessage,
  type Paginated,
} from "./correspondenceShared";

const STATUSES = ["captured", "created", "linked", "duplicate", "unmatched", "ignored", "failed"];

export default function InboundTab({
  projectId,
  onChanged,
}: {
  projectId: string;
  onChanged: () => void;
}) {
  const [status, setStatus] = useState("");
  const [capturing, setCapturing] = useState(false);
  const [open, setOpen] = useState<InboundMessage | null>(null);

  const params = new URLSearchParams({ page: "1", pageSize: "200" });
  if (status) params.set("status", status);
  const list = useResource<Paginated<InboundMessage>>(
    `/api/v1/projects/${projectId}/correspondence/inbound?${params.toString()}`,
  );

  const columns = useMemo<DataColumns<InboundMessage>>(
    () => [
      {
        id: "receivedAt",
        header: "Received",
        accessor: (r) => r.receivedAt,
        type: "date",
        width: 170,
        cell: ({ row }) => dateTime(row.receivedAt),
      },
      { id: "fromAddress", header: "From", accessor: "fromAddress", type: "text", width: 220 },
      { id: "subject", header: "Subject", accessor: "subject", type: "text", width: 320 },
      {
        id: "status",
        header: "Routing",
        accessor: "status",
        type: "text",
        width: 130,
        cell: ({ row }) => <StatusPill status={row.status} size="xs" />,
      },
      {
        id: "detectedReference",
        header: "Quoted reference",
        accessor: (r) => r.detectedReference ?? "",
        type: "code",
        width: 150,
        mono: true,
        cell: ({ row }) => row.detectedReference ?? <span className="text-content-subtle">{DASH}</span>,
      },
      {
        id: "sender",
        header: "Sender",
        accessor: (r) => (r.senderUserId ? "user" : r.senderContactId ? "contact" : "external"),
        type: "text",
        width: 110,
        cell: ({ row }) => (
          <Badge
            tone={row.senderUserId ? "success" : row.senderContactId ? "info" : "neutral"}
            size="xs"
          >
            {row.senderUserId ? "Company user" : row.senderContactId ? "Contact" : "External"}
          </Badge>
        ),
      },
      {
        id: "attachments",
        header: "Attachments",
        accessor: (r) => r.attachments.length,
        type: "number",
        align: "right",
        width: 110,
      },
    ],
    [],
  );

  return (
    <div className="space-y-4">
      <Card>
        <CardBody className="flex flex-wrap items-end gap-3">
          <Field label="Routing outcome">
            <Select value={status} onChange={(e) => setStatus(e.target.value)} size="sm">
              <option value="">Any</option>
              {STATUSES.map((s) => (
                <option key={s} value={s}>
                  {titleCase(s)}
                </option>
              ))}
            </Select>
          </Field>
          <p className="max-w-xl pb-1 text-2xs text-content-subtle">
            A mail transport posts parsed email to{" "}
            <code className="font-mono">POST /projects/:id/correspondence/inbound</code>. The same
            message id arriving twice produces one record, not two.
          </p>
          <div className="ml-auto">
            <Button icon={IconInbox} onClick={() => setCapturing(true)}>
              Capture a message
            </Button>
          </div>
        </CardBody>
      </Card>

      {list.error ? (
        <LoadError message={list.error} onRetry={list.reload} />
      ) : (
        <DataTable<InboundMessage>
          tableId="correspondence.inbound"
          data={list.data?.items ?? []}
          columns={columns}
          getRowId={(row) => row.id}
          loading={list.loading && !list.data}
          height={520}
          rowHeight={44}
          stickyHeader
          exportFileName="inbound-correspondence"
          empty={{
            title: "No email captured on this project",
            description:
              "Point a mail transport at the inbound endpoint, or capture a message by hand when something arrives out of band.",
            action: <Button onClick={() => setCapturing(true)}>Capture a message</Button>,
          }}
          onRowClick={({ row }) => setOpen(row)}
          rowTone={(row) => (row.status === "unmatched" || row.status === "failed" ? "warning" : undefined)}
          aria-label="Inbound email"
        />
      )}

      <CaptureDrawer
        projectId={projectId}
        open={capturing}
        onClose={() => setCapturing(false)}
        onCaptured={() => {
          setCapturing(false);
          list.reload();
          onChanged();
        }}
      />

      <Drawer
        open={open !== null}
        onClose={() => setOpen(null)}
        size="md"
        title={open ? open.subject : "Inbound message"}
        description={open ? `From ${open.fromAddress} · ${titleCase(open.status)}` : undefined}
      >
        {open ? (
          <div className="space-y-4">
            <ReasonList reasons={open.routingReason ? [open.routingReason] : []} />
            <dl className="divide-y divide-border">
              <Row label="Received">{dateTime(open.receivedAt)}</Row>
              <Row label="To">{open.toAddresses.join(", ") || DASH}</Row>
              <Row label="Cc">{open.ccAddresses.join(", ") || DASH}</Row>
              <Row label="Message id">
                <span className="font-mono text-2xs">{open.messageId ?? DASH}</span>
              </Row>
              <Row label="In reply to">
                <span className="font-mono text-2xs">{open.inReplyTo ?? DASH}</span>
              </Row>
              <Row label="Quoted reference">{open.detectedReference ?? DASH}</Row>
              <Row label="Filed as letter">
                <span className="font-mono text-2xs">{open.letterId ?? DASH}</span>
              </Row>
              <Row
                label="Transport signature"
                hint="Recorded as the transport reported it; never trusted on its own"
              >
                {open.signatureVerified === null
                  ? DASH
                  : open.signatureVerified === 1
                    ? "Verified"
                    : "Not verified"}
              </Row>
            </dl>
            {open.attachments.length > 0 ? (
              <section>
                <h3 className="mb-1 text-meta font-semibold text-content">Attachments</h3>
                <ul className="text-meta text-content-muted">
                  {open.attachments.map((a, i) => (
                    <li key={i}>
                      {a.filename ?? "(unnamed)"}
                      {a.fileId ? "" : " — not stored by the transport, so it is not on the record"}
                    </li>
                  ))}
                </ul>
              </section>
            ) : null}
            {open.bodyText ? (
              <section>
                <h3 className="mb-1 text-meta font-semibold text-content">Body</h3>
                <p className="whitespace-pre-wrap rounded-md border border-border bg-surface-raised p-3 text-meta text-content">
                  {open.bodyText}
                </p>
              </section>
            ) : null}
          </div>
        ) : null}
      </Drawer>
    </div>
  );
}

function CaptureDrawer({
  projectId,
  open,
  onClose,
  onCaptured,
}: {
  projectId: string;
  open: boolean;
  onClose: () => void;
  onCaptured: () => void;
}) {
  const action = useAction();
  const types = useTypes(projectId);
  const [from, setFrom] = useState("");
  const [subject, setSubject] = useState("");
  const [text, setText] = useState("");
  const [messageId, setMessageId] = useState("");
  const [typeId, setTypeId] = useState("");

  useEffect(() => {
    if (!open) return;
    setFrom("");
    setSubject("");
    setText("");
    setMessageId("");
    setTypeId("");
    action.clear();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [open]);

  async function submit(e: FormEvent) {
    e.preventDefault();
    const payload: Record<string, unknown> = {
      email: {
        from: from.trim(),
        subject: subject.trim(),
        text,
        messageId: messageId.trim() || undefined,
      },
    };
    if (typeId) payload["typeId"] = typeId;
    const result = await action.run("capture", () => corrApi.captureInbound(projectId, payload));
    if (result) {
      toast.success(
        result.action === "reply"
          ? `Filed onto an existing thread as ${result.reference}.`
          : result.action === "duplicate"
            ? "Already captured — nothing was created."
            : `Captured as ${result.reference} (${result.action}).`,
      );
      onCaptured();
    }
  }

  return (
    <Drawer
      open={open}
      onClose={onClose}
      size="md"
      title="Capture an inbound message"
      description="The same payload a mail transport posts. Routing decides whether this answers an existing letter."
      footer={
        <div className="flex justify-end gap-2">
          <Button variant="ghost" onClick={onClose}>
            Cancel
          </Button>
          <Button type="submit" form="corr-inbound" loading={action.busy === "capture"}>
            Capture
          </Button>
        </div>
      }
    >
      <form id="corr-inbound" onSubmit={submit} className="space-y-4">
        {action.error ? <Alert tone="danger" size="sm">{action.error}</Alert> : null}
        <Field label="From" required hint='e.g. "Jane Doe &lt;jane@sub.example&gt;"'>
          <Input value={from} onChange={(e) => setFrom(e.target.value)} required />
        </Field>
        <Field
          label="Subject"
          required
          hint="If it quotes a reference this project issued (LTR-007), the message is filed onto that thread."
        >
          <Input value={subject} onChange={(e) => setSubject(e.target.value)} required />
        </Field>
        <Field label="Body">
          <Textarea value={text} onChange={(e) => setText(e.target.value)} rows={6} />
        </Field>
        <div className="grid gap-3 sm:grid-cols-2">
          <Field label="Message id" hint="Redelivery of the same id is a no-op">
            <Input value={messageId} onChange={(e) => setMessageId(e.target.value)} />
          </Field>
          <Field label="File a new letter as" hint="Only used when the message starts a new thread">
            <Select value={typeId} onChange={(e) => setTypeId(e.target.value)}>
              <option value="">General letter</option>
              {(types.data?.items ?? []).map((t) => (
                <option key={t.id} value={t.id}>
                  {t.name}
                </option>
              ))}
            </Select>
          </Field>
        </div>
      </form>
    </Drawer>
  );
}
