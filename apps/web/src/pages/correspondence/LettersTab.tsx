/**
 * LETTERS — the correspondence register (#441, #444–#446).
 *
 * The register answers one question on every row: who owes an answer, and how
 * late is it. Ball-in-court and the response deadline are derived by the API
 * and printed verbatim; a letter with no deadline shows a dash, not a zero.
 *
 * A draft is editable here. An issued letter is not — it is a contractual act
 * — so the drawer offers acknowledge / respond / reply / close / void instead
 * of an edit form.
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
import { IconDownload, IconPlus, IconRefresh, IconSend } from "../../ui/icons";
import {
  DASH,
  DIRECTIONS,
  DueBadge,
  LETTER_STATUSES,
  LoadError,
  LoadingBlock,
  PARTY_TYPES,
  PRIORITIES,
  RECIPIENT_KINDS,
  ReasonList,
  Row,
  ballTone,
  corrApi,
  dateTime,
  days,
  isoDate,
  letterTone,
  titleCase,
  todayIso,
  useAction,
  useContacts,
  useResource,
  useTypes,
  useVendors,
  type Letter,
  type LetterDetail,
  type Paginated,
} from "./correspondenceShared";

export default function LettersTab({
  projectId,
  onChanged,
}: {
  projectId: string;
  onChanged: () => void;
}) {
  const [status, setStatus] = useState("");
  const [direction, setDirection] = useState("");
  const [typeId, setTypeId] = useState("");
  const [scope, setScope] = useState<"" | "awaiting" | "overdue" | "contractual">("");
  const [search, setSearch] = useState("");
  const [creating, setCreating] = useState(false);
  const [openId, setOpenId] = useState<string | null>(null);

  const params = new URLSearchParams({ page: "1", pageSize: "200", sort: "created" });
  if (status) params.set("status", status);
  if (direction) params.set("direction", direction);
  if (typeId) params.set("typeId", typeId);
  if (scope === "awaiting") params.set("awaitingResponse", "true");
  if (scope === "overdue") params.set("overdue", "true");
  if (scope === "contractual") params.set("contractualOnly", "true");
  if (search.trim()) params.set("q", search.trim());

  const list = useResource<Paginated<Letter>>(
    `/api/v1/projects/${projectId}/correspondence/letters?${params.toString()}`,
  );
  const types = useTypes(projectId);
  const action = useAction();

  const columns = useMemo<DataColumns<Letter>>(
    () => [
      { id: "reference", header: "Reference", accessor: "reference", type: "code", width: 110, mono: true },
      { id: "subject", header: "Subject", accessor: "subject", type: "text", width: 320 },
      {
        id: "typeKey",
        header: "Type",
        accessor: (row) => titleCase(row.typeKey),
        type: "text",
        width: 140,
        cell: ({ row }) => (
          <span className="flex items-center gap-1.5">
            {titleCase(row.typeKey)}
            {row.isContractual === 1 ? (
              <Badge tone="accent" size="xs" title="A contractual act — the register a dispute turns on">
                contractual
              </Badge>
            ) : null}
          </span>
        ),
      },
      {
        id: "direction",
        header: "Direction",
        accessor: (row) => titleCase(row.direction),
        type: "text",
        width: 100,
      },
      {
        id: "status",
        header: "Status",
        accessor: "status",
        type: "text",
        width: 130,
        cell: ({ row }) => <StatusPill status={row.status} size="xs" />,
      },
      {
        id: "ball",
        header: "Ball in court",
        accessor: (row) => row.assessment?.ballInCourt ?? "",
        type: "text",
        width: 130,
        cell: ({ row }) => {
          const ball = row.assessment?.ballInCourt ?? "none";
          if (ball === "none") return <span className="text-content-subtle">{DASH}</span>;
          return (
            <Badge tone={ballTone(ball)} size="xs" dot>
              {ball === "us" ? "With us" : "With them"}
            </Badge>
          );
        },
      },
      {
        id: "responseDueDate",
        header: "Response due",
        accessor: (row) => row.responseDueDate ?? "",
        type: "date",
        width: 150,
        cell: ({ row }) => (
          <DueBadge
            date={row.responseDueDate}
            daysOverdue={row.assessment?.daysOverdue}
            dueInDays={row.assessment?.dueInDays}
          />
        ),
      },
      {
        id: "recipients",
        header: "Recipients",
        accessor: (row) => row.recipients?.length ?? 0,
        type: "number",
        align: "right",
        width: 100,
        cell: ({ row }) => {
          const list = row.recipients ?? [];
          if (list.length === 0) return <span className="text-content-subtle">{DASH}</span>;
          const acked = list.filter((r) => r.acknowledgedAt !== null).length;
          return (
            <span title={list.map((r) => `${r.name} (${r.kind})`).join(", ")}>
              {acked}/{list.length}
            </span>
          );
        },
      },
      {
        id: "source",
        header: "Source",
        accessor: (row) => titleCase(row.source),
        type: "text",
        width: 120,
      },
      {
        id: "letterDate",
        header: "Dated",
        accessor: (row) => row.letterDate ?? "",
        type: "date",
        width: 110,
        cell: ({ row }) => isoDate(row.letterDate),
      },
    ],
    [],
  );

  async function runSweeps() {
    const result = await action.run("sweep", () => corrApi.runSweeps(projectId));
    if (result) {
      toast.success(
        `Sweep complete — ${result.responses.raised} response signal(s), ${result.acknowledgements.raised} acknowledgement signal(s) raised.`,
      );
      list.reload();
      onChanged();
    }
  }

  return (
    <div className="space-y-4">
      <Card>
        <CardBody className="flex flex-wrap items-end gap-3">
          <Field label="Status">
            <Select value={status} onChange={(e) => setStatus(e.target.value)} size="sm">
              <option value="">Any</option>
              {LETTER_STATUSES.map((s) => (
                <option key={s} value={s}>
                  {titleCase(s)}
                </option>
              ))}
            </Select>
          </Field>
          <Field label="Direction">
            <Select value={direction} onChange={(e) => setDirection(e.target.value)} size="sm">
              <option value="">Any</option>
              {DIRECTIONS.map((d) => (
                <option key={d} value={d}>
                  {titleCase(d)}
                </option>
              ))}
            </Select>
          </Field>
          <Field label="Type">
            <Select value={typeId} onChange={(e) => setTypeId(e.target.value)} size="sm">
              <option value="">Any</option>
              {(types.data?.items ?? []).map((t) => (
                <option key={t.id} value={t.id}>
                  {t.name}
                </option>
              ))}
            </Select>
          </Field>
          <Field label="Show">
            <Select
              value={scope}
              onChange={(e) => setScope(e.target.value as typeof scope)}
              size="sm"
            >
              <option value="">Everything</option>
              <option value="awaiting">Awaiting a response</option>
              <option value="overdue">Response overdue</option>
              <option value="contractual">Contractual only</option>
            </Select>
          </Field>
          <Field label="Search">
            <Input
              value={search}
              onChange={(e) => setSearch(e.target.value)}
              size="sm"
              placeholder="Reference, subject or body…"
            />
          </Field>
          <div className="ml-auto flex items-end gap-2">
            <Button
              variant="ghost"
              icon={IconRefresh}
              loading={action.busy === "sweep"}
              onClick={runSweeps}
              title="Run the deadline sweeps now instead of waiting for the scheduler"
            >
              Run sweeps
            </Button>
            <Button
              variant="ghost"
              icon={IconDownload}
              onClick={() => {
                window.open(
                  `/api/v1/projects/${projectId}/correspondence/register`,
                  "_blank",
                  "noopener",
                );
              }}
            >
              Export register
            </Button>
            <Button icon={IconPlus} onClick={() => setCreating(true)}>
              New letter
            </Button>
          </div>
        </CardBody>
      </Card>

      {action.error ? <Alert tone="danger" size="sm">{action.error}</Alert> : null}

      {list.error ? (
        <LoadError message={list.error} onRetry={list.reload} />
      ) : (
        <DataTable<Letter>
          tableId="correspondence.letters"
          data={list.data?.items ?? []}
          columns={columns}
          getRowId={(row) => row.id}
          loading={list.loading && !list.data}
          height={540}
          rowHeight={44}
          stickyHeader
          exportFileName="correspondence-letters"
          empty={{
            title: "No correspondence recorded yet",
            description:
              "A letter register is what a dispute is argued from. Start by seeding the correspondence types on the Setup tab, then raise the first letter.",
            action: <Button onClick={() => setCreating(true)}>Write the first letter</Button>,
          }}
          onRowClick={({ row }) => setOpenId(row.id)}
          rowTone={(row) =>
            row.assessment?.overdue ? "danger" : row.assessment?.dueSoon ? "warning" : undefined
          }
          aria-label="Correspondence register"
        />
      )}

      <LetterCreateDrawer
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
      <LetterDrawer
        projectId={projectId}
        letterId={openId}
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
  acknowledgementRequired: false,
});

function LetterCreateDrawer({
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
  const types = useTypes(projectId);
  const vendors = useVendors();
  const contacts = useContacts();
  const [typeId, setTypeId] = useState("");
  const [subject, setSubject] = useState("");
  const [body, setBody] = useState("");
  const [direction, setDirection] = useState("outbound");
  const [priority, setPriority] = useState("normal");
  const [letterDate, setLetterDate] = useState(todayIso());
  const [recipients, setRecipients] = useState<RecipientDraft[]>([emptyRecipient()]);

  const selectedType = (types.data?.items ?? []).find((t) => t.id === typeId) ?? null;

  useEffect(() => {
    if (!open) return;
    setTypeId(types.data?.items[0]?.id ?? "");
    setSubject("");
    setBody("");
    setDirection("outbound");
    setPriority("normal");
    setLetterDate(todayIso());
    setRecipients([emptyRecipient()]);
    action.clear();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [open, types.data]);

  async function submit(e: FormEvent) {
    e.preventDefault();
    const payload: Record<string, unknown> = {
      typeId,
      subject: subject.trim(),
      direction,
      priority,
      letterDate,
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
    if (body.trim()) payload["body"] = body;
    const created = await action.run("create", () => corrApi.createLetter(projectId, payload));
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
      title="New letter"
      description="A draft is editable. Issuing it makes it a record — from that point it can only be answered, closed or voided."
      footer={
        <div className="flex justify-end gap-2">
          <Button variant="ghost" onClick={onClose}>
            Cancel
          </Button>
          <Button type="submit" form="corr-letter-create" loading={action.busy === "create"}>
            Create draft
          </Button>
        </div>
      }
    >
      <form id="corr-letter-create" onSubmit={submit} className="space-y-4">
        {action.error ? <Alert tone="danger" size="sm">{action.error}</Alert> : null}
        {types.data && types.data.items.length === 0 ? (
          <Alert tone="warning" size="sm" title="No correspondence types yet">
            Seed the type library on the Setup tab first — a letter takes its numbering, its response
            period and its contractual status from its type.
          </Alert>
        ) : null}
        <div className="grid gap-3 sm:grid-cols-2">
          <Field label="Type" required hint={selectedType?.description ?? undefined}>
            <Select value={typeId} onChange={(e) => setTypeId(e.target.value)} required>
              <option value="">Choose a type…</option>
              {(types.data?.items ?? []).map((t) => (
                <option key={t.id} value={t.id}>
                  {t.name} ({t.prefix})
                </option>
              ))}
            </Select>
          </Field>
          <Field label="Letter date" required>
            <Input type="date" value={letterDate} onChange={(e) => setLetterDate(e.target.value)} />
          </Field>
        </div>
        {selectedType ? (
          <div className="rounded-md border border-border bg-surface-raised px-3 py-2 text-2xs text-content-muted">
            {selectedType.requiresResponse === 1 && selectedType.responseDays !== null
              ? `A response is expected within ${days(selectedType.responseDays)} of the letter date; the platform will open an obligation and chase it.`
              : "No response is expected for this type, so nothing will be chased."}
            {selectedType.approvalSteps.length > 0
              ? ` It must pass ${selectedType.approvalSteps.length} approval step(s) before it can be issued.`
              : ""}
          </div>
        ) : null}
        <Field label="Subject" required>
          <Input value={subject} onChange={(e) => setSubject(e.target.value)} required maxLength={300} />
        </Field>
        <Field label="Body">
          <Textarea value={body} onChange={(e) => setBody(e.target.value)} rows={8} />
        </Field>
        <div className="grid gap-3 sm:grid-cols-2">
          <Field label="Direction">
            <Select value={direction} onChange={(e) => setDirection(e.target.value)}>
              {DIRECTIONS.map((d) => (
                <option key={d} value={d}>
                  {titleCase(d)}
                </option>
              ))}
            </Select>
          </Field>
          <Field label="Priority">
            <Select value={priority} onChange={(e) => setPriority(e.target.value)}>
              {PRIORITIES.map((p) => (
                <option key={p} value={p}>
                  {titleCase(p)}
                </option>
              ))}
            </Select>
          </Field>
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
            <div
              key={index}
              className="grid gap-2 rounded-md border border-border p-2 sm:grid-cols-[110px_1fr_1fr_90px]"
            >
              <Select
                size="sm"
                value={recipient.partyType}
                onChange={(e) =>
                  setRecipients((rows) =>
                    rows.map((r, i) =>
                      i === index ? { ...r, partyType: e.target.value, partyId: "" } : r,
                    ),
                  )
                }
              >
                {PARTY_TYPES.map((t) => (
                  <option key={t} value={t}>
                    {titleCase(t)}
                  </option>
                ))}
              </Select>
              {recipient.partyType === "contact" ? (
                <Select
                  size="sm"
                  value={recipient.partyId}
                  onChange={(e) =>
                    setRecipients((rows) =>
                      rows.map((r, i) => (i === index ? { ...r, partyId: e.target.value } : r)),
                    )
                  }
                >
                  <option value="">Choose a contact…</option>
                  {(contacts.data?.items ?? []).map((c) => (
                    <option key={c.id} value={c.id}>
                      {c.name}
                    </option>
                  ))}
                </Select>
              ) : recipient.partyType === "vendor" ? (
                <Select
                  size="sm"
                  value={recipient.partyId}
                  onChange={(e) =>
                    setRecipients((rows) =>
                      rows.map((r, i) => (i === index ? { ...r, partyId: e.target.value } : r)),
                    )
                  }
                >
                  <option value="">Choose a vendor…</option>
                  {(vendors.data?.items ?? []).map((v) => (
                    <option key={v.id} value={v.id}>
                      {v.name}
                    </option>
                  ))}
                </Select>
              ) : (
                <Input
                  size="sm"
                  placeholder={recipient.partyType === "user" ? "User id" : "Name"}
                  value={recipient.partyType === "user" ? recipient.partyId : recipient.name}
                  onChange={(e) =>
                    setRecipients((rows) =>
                      rows.map((r, i) =>
                        i === index
                          ? recipient.partyType === "user"
                            ? { ...r, partyId: e.target.value }
                            : { ...r, name: e.target.value }
                          : r,
                      ),
                    )
                  }
                />
              )}
              <Input
                size="sm"
                placeholder="Name or email"
                value={recipient.partyType === "contact" || recipient.partyType === "vendor" ? recipient.name : recipient.email}
                onChange={(e) =>
                  setRecipients((rows) =>
                    rows.map((r, i) =>
                      i === index
                        ? recipient.partyType === "contact" || recipient.partyType === "vendor"
                          ? { ...r, name: e.target.value }
                          : { ...r, email: e.target.value }
                        : r,
                    ),
                  )
                }
              />
              <Select
                size="sm"
                value={recipient.kind}
                onChange={(e) =>
                  setRecipients((rows) =>
                    rows.map((r, i) => (i === index ? { ...r, kind: e.target.value } : r)),
                  )
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
                      rows.map((r, i) =>
                        i === index ? { ...r, acknowledgementRequired: e.target.checked } : r,
                      ),
                    )
                  }
                />
                Ask this recipient to acknowledge receipt
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

function LetterDrawer({
  projectId,
  letterId,
  onClose,
  onChanged,
}: {
  projectId: string;
  letterId: string | null;
  onClose: () => void;
  onChanged: () => void;
}) {
  const detail = useResource<LetterDetail>(
    letterId ? `/api/v1/projects/${projectId}/correspondence/letters/${letterId}` : null,
  );
  const action = useAction();
  const [voidReason, setVoidReason] = useState("");
  const [responseNote, setResponseNote] = useState("");

  useEffect(() => {
    setVoidReason("");
    setResponseNote("");
    action.clear();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [letterId]);

  const letter = detail.data;

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
      open={letterId !== null}
      onClose={onClose}
      size="lg"
      title={letter ? `${letter.reference} · ${letter.subject}` : "Letter"}
      description={
        letter
          ? `${titleCase(letter.direction)} ${titleCase(letter.typeKey)} · ${titleCase(letter.status)}${letter.isContractual === 1 ? " · contractual" : ""}`
          : undefined
      }
    >
      {detail.loading && !letter ? <LoadingBlock /> : null}
      {detail.error ? <LoadError message={detail.error} onRetry={detail.reload} /> : null}
      {letter ? (
        <div className="space-y-5">
          {action.error ? <Alert tone="danger" size="sm">{action.error}</Alert> : null}

          <div className="flex flex-wrap gap-2">
            {letter.status === "draft" || letter.status === "pending_approval" ? (
              <Button
                size="sm"
                icon={IconSend}
                loading={action.busy === "issue"}
                onClick={() =>
                  run(
                    "issue",
                    () => corrApi.issueLetter(projectId, letter.id, {}),
                    `${letter.reference} issued.`,
                  )
                }
              >
                Issue
              </Button>
            ) : null}
            {letter.status === "draft" && (letter.type?.approvalSteps.length ?? 0) > 0 ? (
              <Button
                size="sm"
                variant="secondary"
                loading={action.busy === "submit"}
                onClick={() =>
                  run(
                    "submit",
                    () => corrApi.submitLetter(projectId, letter.id),
                    "Submitted for approval.",
                  )
                }
              >
                Submit for approval
              </Button>
            ) : null}
            {letter.status === "issued" || letter.status === "acknowledged" ? (
              <Button
                size="sm"
                variant="secondary"
                loading={action.busy === "respond"}
                onClick={() =>
                  run(
                    "respond",
                    () => corrApi.respondLetter(projectId, letter.id, { note: responseNote || undefined }),
                    "Response recorded; the obligation is settled.",
                  )
                }
              >
                Record a response
              </Button>
            ) : null}
            <Button
              size="sm"
              variant="ghost"
              loading={action.busy === "reply"}
              onClick={() =>
                run("reply", () => corrApi.replyLetter(projectId, letter.id, {}), "Reply drafted on this thread.")
              }
            >
              Draft a reply
            </Button>
            {letter.status !== "draft" && letter.status !== "closed" && letter.status !== "void" ? (
              <Button
                size="sm"
                variant="ghost"
                loading={action.busy === "close"}
                onClick={() =>
                  run("close", () => corrApi.closeLetter(projectId, letter.id), `${letter.reference} closed.`)
                }
              >
                Close
              </Button>
            ) : null}
          </div>

          {letter.status === "issued" || letter.status === "acknowledged" ? (
            <Field label="Response note" hint="Recorded on the ledger alongside the state change.">
              <Textarea
                rows={2}
                value={responseNote}
                onChange={(e) => setResponseNote(e.target.value)}
                placeholder="How was it answered?"
              />
            </Field>
          ) : null}

          <section>
            <h3 className="mb-1 text-meta font-semibold text-content">Position</h3>
            <dl className="divide-y divide-border">
              <Row label="Status">
                <Badge tone={letterTone(letter.status)} size="xs" dot>
                  {titleCase(letter.status)}
                </Badge>
              </Row>
              <Row label="Ball in court">
                {letter.assessment.ballInCourt === "none" ? (
                  DASH
                ) : (
                  <Badge tone={ballTone(letter.assessment.ballInCourt)} size="xs">
                    {letter.assessment.ballInCourt === "us" ? "With us" : "With the recipient"}
                  </Badge>
                )}
              </Row>
              <Row
                label="Response due"
                hint={
                  letter.responseRequired === 1
                    ? letter.responseDueDate
                      ? undefined
                      : "This type expects a response but no date was set."
                    : "No response expected."
                }
              >
                <DueBadge
                  date={letter.responseDueDate}
                  daysOverdue={letter.assessment.daysOverdue}
                  dueInDays={letter.assessment.dueInDays}
                />
              </Row>
              <Row label="Responded">{dateTime(letter.respondedAt)}</Row>
              <Row label="Cycle time">
                {letter.assessment.responseDays === null ? DASH : days(letter.assessment.responseDays)}
              </Row>
              <Row label="Issued">{dateTime(letter.issuedAt)}</Row>
              <Row label="Obligation" hint="Assurance obligation opened for the response deadline">
                {letter.obligationId ? (
                  <span className="font-mono text-2xs">{letter.obligationId}</span>
                ) : (
                  DASH
                )}
              </Row>
              {letter.voidReason ? <Row label="Voided because">{letter.voidReason}</Row> : null}
            </dl>
          </section>

          {letter.body ? (
            <section>
              <h3 className="mb-1 text-meta font-semibold text-content">Body</h3>
              <p className="whitespace-pre-wrap rounded-md border border-border bg-surface-raised p-3 text-meta text-content">
                {letter.body}
              </p>
            </section>
          ) : null}

          <section>
            <h3 className="mb-1 text-meta font-semibold text-content">
              Recipients ({letter.recipients.length})
            </h3>
            {letter.recipients.length === 0 ? (
              <p className="text-meta text-content-subtle">
                No recipients yet. A letter cannot be issued to nobody.
              </p>
            ) : (
              <ul className="divide-y divide-border">
                {letter.recipients.map((r) => (
                  <li key={r.id} className="flex items-center justify-between gap-3 py-2">
                    <div className="min-w-0">
                      <div className="truncate text-meta text-content">
                        {r.name}{" "}
                        <span className="text-2xs uppercase text-content-subtle">{r.kind}</span>
                      </div>
                      <div className="truncate text-2xs text-content-subtle">
                        {r.email ?? "no address on file"} · {titleCase(r.deliveryStatus)}
                        {r.readCount > 0 ? ` · read ${r.readCount}×` : ""}
                      </div>
                    </div>
                    <div className="flex shrink-0 items-center gap-2">
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
                        <span className="text-2xs text-content-subtle">no acknowledgement asked</span>
                      )}
                    </div>
                  </li>
                ))}
              </ul>
            )}
          </section>

          {letter.approvals.length > 0 ? (
            <section>
              <h3 className="mb-1 text-meta font-semibold text-content">Approval workflow</h3>
              <ul className="divide-y divide-border">
                {letter.approvals.map((a) => (
                  <li key={a.id} className="flex items-center justify-between gap-3 py-2">
                    <div>
                      <div className="text-meta text-content">
                        {a.seq}. {a.name}
                      </div>
                      <div className="text-2xs text-content-subtle">
                        {a.role ? `Requires the ${a.role} role` : a.userId ? "Assigned to a named person" : "Anyone"}
                        {a.comment ? ` · “${a.comment}”` : ""}
                      </div>
                    </div>
                    {a.status === "pending" ? (
                      <div className="flex gap-1">
                        <Button
                          size="xs"
                          loading={action.busy === `approve-${a.id}`}
                          onClick={() =>
                            run(
                              `approve-${a.id}`,
                              () =>
                                corrApi.decideApproval(projectId, letter.id, a.id, {
                                  decision: "approved",
                                }),
                              "Approved.",
                            )
                          }
                        >
                          Approve
                        </Button>
                        <Button
                          size="xs"
                          variant="ghost"
                          loading={action.busy === `reject-${a.id}`}
                          onClick={() =>
                            run(
                              `reject-${a.id}`,
                              () =>
                                corrApi.decideApproval(projectId, letter.id, a.id, {
                                  decision: "rejected",
                                }),
                              "Sent back to draft.",
                            )
                          }
                        >
                          Reject
                        </Button>
                      </div>
                    ) : (
                      <Badge tone={a.status === "approved" ? "success" : "danger"} size="xs">
                        {titleCase(a.status)}
                      </Badge>
                    )}
                  </li>
                ))}
              </ul>
              <p className="mt-1 text-2xs text-content-subtle">
                The author of a letter can never satisfy one of its approval steps.
              </p>
            </section>
          ) : null}

          {letter.thread.length > 1 ? (
            <section>
              <h3 className="mb-1 text-meta font-semibold text-content">Thread</h3>
              <ul className="divide-y divide-border">
                {letter.thread.map((t) => (
                  <li key={t.id} className="flex items-center justify-between gap-3 py-1.5">
                    <span className="truncate text-meta text-content">
                      <span className="font-mono text-2xs">{t.reference}</span> {t.subject}
                    </span>
                    <span className="shrink-0 text-2xs text-content-subtle">
                      {titleCase(t.direction)} · {isoDate(t.letterDate ?? t.createdAt)}
                    </span>
                  </li>
                ))}
              </ul>
            </section>
          ) : null}

          {letter.inboundMessage ? (
            <section>
              <h3 className="mb-1 text-meta font-semibold text-content">Captured from email</h3>
              <dl className="divide-y divide-border">
                <Row label="From">{letter.inboundMessage.fromAddress}</Row>
                <Row label="Received">{dateTime(letter.inboundMessage.receivedAt)}</Row>
                <Row label="Message id">
                  <span className="font-mono text-2xs">{letter.inboundMessage.messageId ?? DASH}</span>
                </Row>
              </dl>
              <ReasonList
                reasons={letter.inboundMessage.routingReason ? [letter.inboundMessage.routingReason] : []}
                className="mt-1"
              />
            </section>
          ) : null}

          {letter.status !== "void" ? (
            <section className="rounded-md border border-danger-border p-3">
              <h3 className="mb-1 text-meta font-semibold text-danger-text">Void this letter</h3>
              <p className="mb-2 text-2xs text-content-muted">
                Voiding keeps the record and its number; it does not delete anything. Say why.
              </p>
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
                      () => corrApi.voidLetter(projectId, letter.id, voidReason.trim()),
                      `${letter.reference} voided.`,
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
