/**
 * TRANSMITTALS (#442–#443).
 *
 * The register's job is to make acknowledgement visible. Every row shows how
 * many of the recipients who were ASKED to acknowledge actually have; a
 * transmittal where nobody was asked shows a dash and says so, because 0% and
 * "not applicable" are different facts.
 *
 * Item revisions are copied from the register that owns them at the moment of
 * issue, so what the drawer shows is what was actually sent.
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
  Progress,
  Select,
  StatusPill,
  Textarea,
  toast,
  type DataColumns,
} from "../../ui";
import { IconPlus, IconSend } from "../../ui/icons";
import {
  DASH,
  DueBadge,
  LoadError,
  LoadingBlock,
  PARTY_TYPES,
  RECIPIENT_KINDS,
  ReasonList,
  Row,
  TRANSMITTAL_ITEM_TYPES,
  TRANSMITTAL_METHODS,
  TRANSMITTAL_PURPOSES,
  TRANSMITTAL_STATUSES,
  addDays,
  corrApi,
  count,
  dateTime,
  days,
  isoDate,
  pct,
  titleCase,
  todayIso,
  transmittalTone,
  useAction,
  useContacts,
  useResource,
  useVendors,
  type Paginated,
  type Transmittal,
  type TransmittalDetail,
} from "./correspondenceShared";

export default function TransmittalsTab({
  projectId,
  onChanged,
}: {
  projectId: string;
  onChanged: () => void;
}) {
  const [status, setStatus] = useState("");
  const [purpose, setPurpose] = useState("");
  const [outstandingOnly, setOutstandingOnly] = useState(false);
  const [search, setSearch] = useState("");
  const [creating, setCreating] = useState(false);
  const [openId, setOpenId] = useState<string | null>(null);

  const params = new URLSearchParams({ page: "1", pageSize: "200" });
  if (status) params.set("status", status);
  if (purpose) params.set("purpose", purpose);
  if (outstandingOnly) params.set("outstandingOnly", "true");
  if (search.trim()) params.set("q", search.trim());

  const list = useResource<Paginated<Transmittal>>(
    `/api/v1/projects/${projectId}/correspondence/transmittals?${params.toString()}`,
  );

  const columns = useMemo<DataColumns<Transmittal>>(
    () => [
      { id: "reference", header: "Reference", accessor: "reference", type: "code", width: 100, mono: true },
      { id: "subject", header: "Subject", accessor: "subject", type: "text", width: 300 },
      {
        id: "purpose",
        header: "Purpose",
        accessor: (row) => titleCase(row.purpose),
        type: "text",
        width: 160,
        cell: ({ row }) => (
          <Badge tone={row.purpose === "for_construction" ? "accent" : "neutral"} size="xs">
            {titleCase(row.purpose)}
          </Badge>
        ),
      },
      {
        id: "status",
        header: "Status",
        accessor: "status",
        type: "text",
        width: 160,
        cell: ({ row }) => <StatusPill status={row.status} size="xs" />,
      },
      {
        id: "items",
        header: "Items",
        accessor: "itemCount",
        type: "number",
        align: "right",
        width: 80,
      },
      {
        id: "ack",
        header: "Acknowledged",
        accessor: (row) => row.acknowledgedCount,
        type: "number",
        align: "right",
        width: 140,
        cell: ({ row }) =>
          row.ackRequiredCount === 0 ? (
            <span className="text-content-subtle" title="Nobody on this transmittal was asked to acknowledge receipt.">
              {DASH}
            </span>
          ) : (
            <span className="tabular-nums">
              {row.acknowledgedCount}/{row.ackRequiredCount}
            </span>
          ),
      },
      {
        id: "ackDueDate",
        header: "Ack due",
        accessor: (row) => row.ackDueDate ?? "",
        type: "date",
        width: 140,
        cell: ({ row }) => (
          <DueBadge
            date={row.ackDueDate}
            daysOverdue={row.overdue && row.ackDueDate ? 1 : null}
          />
        ),
      },
      {
        id: "method",
        header: "Method",
        accessor: (row) => titleCase(row.method),
        type: "text",
        width: 100,
      },
      {
        id: "issuedAt",
        header: "Issued",
        accessor: (row) => row.issuedAt ?? "",
        type: "date",
        width: 120,
        cell: ({ row }) => isoDate(row.issuedAt),
      },
    ],
    [],
  );

  return (
    <div className="space-y-4">
      <Card>
        <CardBody className="flex flex-wrap items-end gap-3">
          <Field label="Status">
            <Select value={status} onChange={(e) => setStatus(e.target.value)} size="sm">
              <option value="">Any</option>
              {TRANSMITTAL_STATUSES.map((s) => (
                <option key={s} value={s}>
                  {titleCase(s)}
                </option>
              ))}
            </Select>
          </Field>
          <Field label="Purpose">
            <Select value={purpose} onChange={(e) => setPurpose(e.target.value)} size="sm">
              <option value="">Any</option>
              {TRANSMITTAL_PURPOSES.map((p) => (
                <option key={p} value={p}>
                  {titleCase(p)}
                </option>
              ))}
            </Select>
          </Field>
          <Field label="Search">
            <Input
              value={search}
              onChange={(e) => setSearch(e.target.value)}
              size="sm"
              placeholder="Reference or subject…"
            />
          </Field>
          <label className="flex items-center gap-2 pb-1 text-meta text-content-muted">
            <input
              type="checkbox"
              checked={outstandingOnly}
              onChange={(e) => setOutstandingOnly(e.target.checked)}
            />
            Outstanding acknowledgements only
          </label>
          <div className="ml-auto">
            <Button icon={IconPlus} onClick={() => setCreating(true)}>
              New transmittal
            </Button>
          </div>
        </CardBody>
      </Card>

      {list.error ? (
        <LoadError message={list.error} onRetry={list.reload} />
      ) : (
        <DataTable<Transmittal>
          tableId="correspondence.transmittals"
          data={list.data?.items ?? []}
          columns={columns}
          getRowId={(row) => row.id}
          loading={list.loading && !list.data}
          height={540}
          rowHeight={44}
          stickyHeader
          exportFileName="transmittals"
          empty={{
            title: "Nothing has been transmitted yet",
            description:
              "A transmittal records what was issued, for what purpose and to whom — the fact a claim about “we never received it” turns on.",
            action: <Button onClick={() => setCreating(true)}>Raise a transmittal</Button>,
          }}
          onRowClick={({ row }) => setOpenId(row.id)}
          rowTone={(row) => (row.overdue ? "danger" : undefined)}
          aria-label="Transmittal register"
        />
      )}

      <TransmittalCreateDrawer
        projectId={projectId}
        open={creating}
        onClose={() => setCreating(false)}
        onCreated={(id) => {
          setCreating(false);
          list.reload();
          onChanged();
          setOpenId(id);
        }}
      />
      <TransmittalDrawer
        projectId={projectId}
        transmittalId={openId}
        onClose={() => setOpenId(null)}
        onChanged={() => {
          list.reload();
          onChanged();
        }}
      />
    </div>
  );
}

/* ================================= Create ================================= */

interface ItemDraft {
  itemType: string;
  itemId: string;
  title: string;
  revision: string;
  copies: number;
}

const emptyItem = (): ItemDraft => ({ itemType: "other", itemId: "", title: "", revision: "", copies: 1 });

interface RecipientDraft {
  partyType: string;
  partyId: string;
  name: string;
  email: string;
  kind: string;
  acknowledgementRequired: boolean;
}

const emptyRecipient = (): RecipientDraft => ({
  partyType: "external",
  partyId: "",
  name: "",
  email: "",
  kind: "to",
  acknowledgementRequired: true,
});

function TransmittalCreateDrawer({
  projectId,
  open,
  onClose,
  onCreated,
}: {
  projectId: string;
  open: boolean;
  onClose: () => void;
  onCreated: (id: string) => void;
}) {
  const action = useAction();
  const vendors = useVendors();
  const contacts = useContacts();
  const [subject, setSubject] = useState("");
  const [purpose, setPurpose] = useState("for_information");
  const [method, setMethod] = useState("email");
  const [coverNote, setCoverNote] = useState("");
  const [ackRequired, setAckRequired] = useState(true);
  const [ackDueDate, setAckDueDate] = useState(addDays(todayIso(), 7));
  const [items, setItems] = useState<ItemDraft[]>([emptyItem()]);
  const [recipients, setRecipients] = useState<RecipientDraft[]>([emptyRecipient()]);

  useEffect(() => {
    if (!open) return;
    setSubject("");
    setPurpose("for_information");
    setMethod("email");
    setCoverNote("");
    setAckRequired(true);
    setAckDueDate(addDays(todayIso(), 7));
    setItems([emptyItem()]);
    setRecipients([emptyRecipient()]);
    action.clear();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [open]);

  async function submit(e: FormEvent) {
    e.preventDefault();
    const payload: Record<string, unknown> = {
      subject: subject.trim(),
      purpose,
      method,
      ackRequired,
      ackDueDate: ackRequired ? ackDueDate : null,
      items: items
        .filter((i) => i.title.trim() !== "" || i.itemId.trim() !== "")
        .map((i) => ({
          itemType: i.itemType,
          itemId: i.itemId.trim() || null,
          title: i.title.trim() || undefined,
          revision: i.revision.trim() || undefined,
          copies: i.copies,
        })),
      recipients: recipients
        .filter((r) => r.name.trim() !== "" || r.partyId !== "")
        .map((r) => ({
          partyType: r.partyType,
          partyId: r.partyId || null,
          name: r.name.trim() || undefined,
          email: r.email.trim() || undefined,
          kind: r.kind,
          acknowledgementRequired: r.acknowledgementRequired,
        })),
    };
    if (coverNote.trim()) payload["coverNote"] = coverNote;
    const created = await action.run("create", () => corrApi.createTransmittal(projectId, payload));
    if (created) {
      toast.success(`${created.reference} created as a draft.`);
      onCreated(created.id);
    }
  }

  return (
    <Drawer
      open={open}
      onClose={onClose}
      size="lg"
      title="New transmittal"
      description="What is being issued, for what purpose, and to whom. Issuing freezes the contents and the revision of every item."
      footer={
        <div className="flex justify-end gap-2">
          <Button variant="ghost" onClick={onClose}>
            Cancel
          </Button>
          <Button type="submit" form="corr-transmittal-create" loading={action.busy === "create"}>
            Create draft
          </Button>
        </div>
      }
    >
      <form id="corr-transmittal-create" onSubmit={submit} className="space-y-4">
        {action.error ? <Alert tone="danger" size="sm">{action.error}</Alert> : null}
        <Field label="Subject" required>
          <Input value={subject} onChange={(e) => setSubject(e.target.value)} required maxLength={300} />
        </Field>
        <div className="grid gap-3 sm:grid-cols-3">
          <Field label="Purpose" required hint="The fact a claim turns on">
            <Select value={purpose} onChange={(e) => setPurpose(e.target.value)}>
              {TRANSMITTAL_PURPOSES.map((p) => (
                <option key={p} value={p}>
                  {titleCase(p)}
                </option>
              ))}
            </Select>
          </Field>
          <Field label="Method">
            <Select value={method} onChange={(e) => setMethod(e.target.value)}>
              {TRANSMITTAL_METHODS.map((m) => (
                <option key={m} value={m}>
                  {titleCase(m)}
                </option>
              ))}
            </Select>
          </Field>
          <Field label="Acknowledgement due" hint={ackRequired ? undefined : "No acknowledgement asked"}>
            <Input
              type="date"
              value={ackDueDate}
              disabled={!ackRequired}
              onChange={(e) => setAckDueDate(e.target.value)}
            />
          </Field>
        </div>
        <label className="flex items-center gap-2 text-meta text-content-muted">
          <input
            type="checkbox"
            checked={ackRequired}
            onChange={(e) => setAckRequired(e.target.checked)}
          />
          Ask recipients to acknowledge receipt (opens an obligation and chases it)
        </label>
        <Field label="Cover note">
          <Textarea value={coverNote} onChange={(e) => setCoverNote(e.target.value)} rows={3} />
        </Field>

        <div className="space-y-2">
          <div className="flex items-center justify-between">
            <span className="text-meta font-semibold text-content">Items</span>
            <Button size="sm" variant="ghost" icon={IconPlus} onClick={() => setItems((r) => [...r, emptyItem()])}>
              Add
            </Button>
          </div>
          <p className="text-2xs text-content-subtle">
            Give a record id (a drawing sheet, file, submittal or spec section) and the title and
            revision are taken from that register rather than typed.
          </p>
          {items.map((item, index) => (
            <div key={index} className="grid gap-2 rounded-md border border-border p-2 sm:grid-cols-[130px_1fr_1fr_70px]">
              <Select
                size="sm"
                value={item.itemType}
                onChange={(e) =>
                  setItems((rows) => rows.map((r, i) => (i === index ? { ...r, itemType: e.target.value } : r)))
                }
              >
                {TRANSMITTAL_ITEM_TYPES.map((t) => (
                  <option key={t} value={t}>
                    {titleCase(t)}
                  </option>
                ))}
              </Select>
              <Input
                size="sm"
                placeholder="Record id (optional)"
                value={item.itemId}
                onChange={(e) =>
                  setItems((rows) => rows.map((r, i) => (i === index ? { ...r, itemId: e.target.value } : r)))
                }
              />
              <Input
                size="sm"
                placeholder="Title (required when there is no id)"
                value={item.title}
                onChange={(e) =>
                  setItems((rows) => rows.map((r, i) => (i === index ? { ...r, title: e.target.value } : r)))
                }
              />
              <Input
                size="sm"
                type="number"
                min={1}
                value={item.copies}
                onChange={(e) =>
                  setItems((rows) =>
                    rows.map((r, i) => (i === index ? { ...r, copies: Number(e.target.value) || 1 } : r)),
                  )
                }
              />
            </div>
          ))}
        </div>

        <div className="space-y-2">
          <div className="flex items-center justify-between">
            <span className="text-meta font-semibold text-content">Recipients</span>
            <Button
              size="sm"
              variant="ghost"
              icon={IconPlus}
              onClick={() => setRecipients((r) => [...r, emptyRecipient()])}
            >
              Add
            </Button>
          </div>
          {recipients.map((recipient, index) => (
            <div key={index} className="grid gap-2 rounded-md border border-border p-2 sm:grid-cols-[110px_1fr_1fr_80px]">
              <Select
                size="sm"
                value={recipient.partyType}
                onChange={(e) =>
                  setRecipients((rows) =>
                    rows.map((r, i) => (i === index ? { ...r, partyType: e.target.value, partyId: "" } : r)),
                  )
                }
              >
                {PARTY_TYPES.map((t) => (
                  <option key={t} value={t}>
                    {titleCase(t)}
                  </option>
                ))}
              </Select>
              {recipient.partyType === "contact" || recipient.partyType === "vendor" ? (
                <Select
                  size="sm"
                  value={recipient.partyId}
                  onChange={(e) =>
                    setRecipients((rows) => rows.map((r, i) => (i === index ? { ...r, partyId: e.target.value } : r)))
                  }
                >
                  <option value="">Choose…</option>
                  {(recipient.partyType === "contact"
                    ? (contacts.data?.items ?? []).map((c) => ({ id: c.id, name: c.name }))
                    : (vendors.data?.items ?? []).map((v) => ({ id: v.id, name: v.name }))
                  ).map((o) => (
                    <option key={o.id} value={o.id}>
                      {o.name}
                    </option>
                  ))}
                </Select>
              ) : (
                <Input
                  size="sm"
                  placeholder={recipient.partyType === "user" ? "User id" : "Email"}
                  value={recipient.partyType === "user" ? recipient.partyId : recipient.email}
                  onChange={(e) =>
                    setRecipients((rows) =>
                      rows.map((r, i) =>
                        i === index
                          ? recipient.partyType === "user"
                            ? { ...r, partyId: e.target.value }
                            : { ...r, email: e.target.value }
                          : r,
                      ),
                    )
                  }
                />
              )}
              <Input
                size="sm"
                placeholder="Name"
                value={recipient.name}
                onChange={(e) =>
                  setRecipients((rows) => rows.map((r, i) => (i === index ? { ...r, name: e.target.value } : r)))
                }
              />
              <Select
                size="sm"
                value={recipient.kind}
                onChange={(e) =>
                  setRecipients((rows) => rows.map((r, i) => (i === index ? { ...r, kind: e.target.value } : r)))
                }
              >
                {RECIPIENT_KINDS.map((k) => (
                  <option key={k} value={k}>
                    {k.toUpperCase()}
                  </option>
                ))}
              </Select>
              <label className="flex items-center gap-2 text-2xs text-content-muted sm:col-span-4">
                <input
                  type="checkbox"
                  checked={recipient.acknowledgementRequired}
                  onChange={(e) =>
                    setRecipients((rows) =>
                      rows.map((r, i) => (i === index ? { ...r, acknowledgementRequired: e.target.checked } : r)),
                    )
                  }
                />
                Must acknowledge receipt
                {recipients.length > 1 ? (
                  <button
                    type="button"
                    className="ml-auto text-danger-text hover:underline"
                    onClick={() => setRecipients((rows) => rows.filter((_, i) => i !== index))}
                  >
                    Remove
                  </button>
                ) : null}
              </label>
            </div>
          ))}
        </div>
      </form>
    </Drawer>
  );
}

/* ================================= Detail ================================= */

function TransmittalDrawer({
  projectId,
  transmittalId,
  onClose,
  onChanged,
}: {
  projectId: string;
  transmittalId: string | null;
  onClose: () => void;
  onChanged: () => void;
}) {
  const detail = useResource<TransmittalDetail>(
    transmittalId ? `/api/v1/projects/${projectId}/correspondence/transmittals/${transmittalId}` : null,
  );
  const action = useAction();
  const [voidReason, setVoidReason] = useState("");

  useEffect(() => {
    setVoidReason("");
    action.clear();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [transmittalId]);

  const record = detail.data;

  async function run(key: string, fn: () => Promise<unknown>, message: string) {
    const result = await action.run(key, fn);
    if (result) {
      toast.success(message);
      detail.reload();
      onChanged();
    }
  }

  return (
    <Drawer
      open={transmittalId !== null}
      onClose={onClose}
      size="lg"
      title={record ? `${record.reference} · ${record.subject}` : "Transmittal"}
      description={record ? `${titleCase(record.purpose)} · ${titleCase(record.status)}` : undefined}
    >
      {detail.loading && !record ? <LoadingBlock /> : null}
      {detail.error ? <LoadError message={detail.error} onRetry={detail.reload} /> : null}
      {record ? (
        <div className="space-y-5">
          {action.error ? <Alert tone="danger" size="sm">{action.error}</Alert> : null}

          <div className="flex flex-wrap gap-2">
            {record.status === "draft" ? (
              <Button
                size="sm"
                icon={IconSend}
                loading={action.busy === "issue"}
                onClick={() =>
                  run("issue", () => corrApi.issueTransmittal(projectId, record.id, {}), `${record.reference} issued.`)
                }
              >
                Issue
              </Button>
            ) : null}
            {record.status !== "draft" && record.status !== "closed" && record.status !== "void" ? (
              <Button
                size="sm"
                variant="ghost"
                loading={action.busy === "close"}
                onClick={() =>
                  run("close", () => corrApi.closeTransmittal(projectId, record.id), `${record.reference} closed.`)
                }
              >
                Close
              </Button>
            ) : null}
          </div>

          <section>
            <h3 className="mb-1 text-meta font-semibold text-content">Acknowledgement</h3>
            {record.position.percent === null ? (
              <ReasonList reasons={record.position.reasons} />
            ) : (
              <>
                <Progress
                  value={record.position.percent}
                  tone={record.position.overdue ? "danger" : record.position.percent === 100 ? "success" : "warning"}
                  label={`${record.position.acknowledged} of ${record.position.required} acknowledged`}
                />
                <dl className="mt-2 divide-y divide-border">
                  <Row label="Rate">{pct(record.position.percent)}</Row>
                  <Row label="Outstanding" hint={record.position.outstandingNames.join(", ") || undefined}>
                    {count(record.position.outstanding)}
                  </Row>
                  <Row label="Read receipts">{count(record.position.read)}</Row>
                  <Row label="Due">
                    <DueBadge date={record.ackDueDate} daysOverdue={record.position.daysOverdue} />
                  </Row>
                </dl>
                <ReasonList reasons={record.position.reasons} className="mt-1" />
              </>
            )}
          </section>

          <section>
            <h3 className="mb-1 text-meta font-semibold text-content">Items ({record.items.length})</h3>
            {record.items.length === 0 ? (
              <p className="text-meta text-content-subtle">
                Nothing on this transmittal yet — it cannot be issued empty.
              </p>
            ) : (
              <ul className="divide-y divide-border">
                {record.items.map((item) => (
                  <li key={item.id} className="flex items-center justify-between gap-3 py-2">
                    <div className="min-w-0">
                      <div className="truncate text-meta text-content">
                        {item.seq}. {item.title}
                      </div>
                      <div className="text-2xs text-content-subtle">
                        {titleCase(item.itemType)}
                        {item.revision ? ` · revision ${item.revision}` : " · no revision recorded"}
                        {item.copies > 1 ? ` · ${item.copies} copies` : ""}
                      </div>
                    </div>
                    {record.status === "draft" ? (
                      <Button
                        size="xs"
                        variant="ghost"
                        loading={action.busy === `item-${item.id}`}
                        onClick={() =>
                          run(
                            `item-${item.id}`,
                            () => corrApi.removeTransmittalItem(projectId, record.id, item.id),
                            "Item removed.",
                          )
                        }
                      >
                        Remove
                      </Button>
                    ) : null}
                  </li>
                ))}
              </ul>
            )}
          </section>

          <section>
            <h3 className="mb-1 text-meta font-semibold text-content">
              Recipients ({record.recipients.length})
            </h3>
            <ul className="divide-y divide-border">
              {record.recipients.map((r) => (
                <li key={r.id} className="flex items-center justify-between gap-3 py-2">
                  <div className="min-w-0">
                    <div className="truncate text-meta text-content">
                      {r.name} <span className="text-2xs uppercase text-content-subtle">{r.kind}</span>
                    </div>
                    <div className="truncate text-2xs text-content-subtle">
                      {r.email ?? "no address on file"} · {titleCase(r.deliveryStatus)}
                      {r.firstReadAt ? ` · first read ${dateTime(r.firstReadAt)}` : ""}
                    </div>
                  </div>
                  <div className="shrink-0">
                    {r.acknowledgedAt ? (
                      <Badge tone="success" size="xs" dot title={dateTime(r.acknowledgedAt)}>
                        Acknowledged
                      </Badge>
                    ) : r.acknowledgementRequired === 1 ? (
                      <Button
                        size="xs"
                        variant="ghost"
                        loading={action.busy === `ack-${r.id}`}
                        onClick={() =>
                          run(
                            `ack-${r.id}`,
                            () => corrApi.acknowledge(projectId, r.id),
                            `${r.name} acknowledged receipt.`,
                          )
                        }
                      >
                        Record acknowledgement
                      </Button>
                    ) : (
                      <span className="text-2xs text-content-subtle">not asked</span>
                    )}
                  </div>
                </li>
              ))}
            </ul>
          </section>

          <section>
            <h3 className="mb-1 text-meta font-semibold text-content">Record</h3>
            <dl className="divide-y divide-border">
              <Row label="Status">
                <Badge tone={transmittalTone(record.status)} size="xs" dot>
                  {titleCase(record.status)}
                </Badge>
              </Row>
              <Row label="Issued">{dateTime(record.issuedAt)}</Row>
              <Row label="Method">{titleCase(record.method)}</Row>
              <Row label="Obligation">
                {record.obligationId ? (
                  <span className="font-mono text-2xs">{record.obligationId}</span>
                ) : (
                  DASH
                )}
              </Row>
              <Row label="Age">
                {record.issuedAt
                  ? days(
                      Math.round(
                        (Date.now() - Date.parse(record.issuedAt)) / 86_400_000,
                      ),
                    )
                  : DASH}
              </Row>
            </dl>
            {record.coverNote ? (
              <p className="mt-2 whitespace-pre-wrap rounded-md border border-border bg-surface-raised p-3 text-meta text-content">
                {record.coverNote}
              </p>
            ) : null}
          </section>

          {record.status !== "void" ? (
            <section className="rounded-md border border-danger-border p-3">
              <h3 className="mb-1 text-meta font-semibold text-danger-text">Void this transmittal</h3>
              <div className="flex gap-2">
                <Input
                  size="sm"
                  value={voidReason}
                  onChange={(e) => setVoidReason(e.target.value)}
                  placeholder="Reason"
                />
                <Button
                  size="sm"
                  variant="danger"
                  disabled={voidReason.trim().length < 3}
                  loading={action.busy === "void"}
                  onClick={() =>
                    run(
                      "void",
                      () => corrApi.voidTransmittal(projectId, record.id, voidReason.trim()),
                      `${record.reference} voided.`,
                    )
                  }
                >
                  Void
                </Button>
              </div>
            </section>
          ) : null}
        </div>
      ) : null}
    </Drawer>
  );
}
