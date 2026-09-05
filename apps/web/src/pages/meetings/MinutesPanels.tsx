/**
 * MINUTES AS A REAL DOCUMENT — objections, the rendered pack, and delivery.
 *
 * Three things the workspace could not do, each of which broke a control the
 * API already enforced:
 *
 *  1. OBJECTIONS COULD BE RAISED BUT NEVER RESOLVED. Once any objection
 *     existed, /minutes/approve refused for good and the banner told the
 *     reader to "settle them before sign-off" with no control that could.
 *     Sign-off was permanently blocked by a button the page itself offered.
 *  2. THE MINUTES HAD NO DOCUMENT. Deemed acceptance rests on a specific set
 *     of words having reached a specific person; a textarea in a database is
 *     not that. Rendering produces a content-addressed file whose sha256 is
 *     recorded on the meeting and in the hash-chained ledger, so a later
 *     dispute compares hashes rather than recollections.
 *  3. DELIVERY WAS INVISIBLE. The objection period runs from DELIVERY, not
 *     from the moment the minute taker pressed a button — the recipient may
 *     never have received it. The per-recipient record is what makes the
 *     deeming survive challenge, and it belongs on the page.
 */
import { useState } from "react";
import {
  Alert,
  Badge,
  Button,
  Card,
  CardBody,
  Field,
  Table,
  Td,
  Textarea,
  Th,
} from "../../ui";
import { api } from "../../lib/api";
import {
  RefusalPanel,
  dateTime,
  titleCase,
  useAction,
  type MeetingDetail,
} from "./meetingsShared";

interface Objection {
  id?: string;
  note?: string;
  raisedBy?: string;
  raisedAt?: string;
  resolvedAt?: string | null;
  resolvedBy?: string | null;
  resolutionNote?: string | null;
  [k: string]: unknown;
}

const str = (v: unknown): string | null => (typeof v === "string" ? v : null);

/* ================================================================== */
/* Objections                                                          */
/* ================================================================== */

export function ObjectionsPanel({
  projectId,
  meeting,
  onMutated,
}: {
  projectId: string;
  meeting: MeetingDetail;
  onMutated: () => void;
}) {
  const { busy, refusal, clear, run } = useAction();
  const [notes, setNotes] = useState<Record<string, string>>({});
  const objections = (meeting.objections ?? []) as Objection[];
  const history = (meeting.objectionHistory ?? []) as Array<Record<string, unknown>>;

  if (objections.length === 0 && history.length === 0) return null;

  const live = objections.filter((o) => !o.resolvedAt);
  const settled = objections.filter((o) => o.resolvedAt);

  async function resolve(objectionId: string) {
    const note = (notes[objectionId] ?? "").trim();
    if (!note) return;
    const done = await run(`resolve:${objectionId}`, () =>
      api.post(
        `/api/v1/projects/${projectId}/meetings/${meeting.id}/minutes/objections/${objectionId}/resolve`,
        { resolutionNote: note },
      ),
    );
    if (done !== null) {
      setNotes((n) => ({ ...n, [objectionId]: "" }));
      onMutated();
    }
  }

  return (
    <Card>
      <CardBody className="space-y-3">
        <div>
          <h3 className="text-sm font-semibold text-content">Objections</h3>
          <p className="text-2xs text-content-subtle">
            {live.length} unresolved, {settled.length} settled. While any objection is unresolved
            the platform refuses sign-off: an objection is a statement that the record is wrong, and
            approving over it would certify words the objector says the room never agreed.
          </p>
        </div>

        <RefusalPanel refusal={refusal} onDismiss={clear} />

        {live.map((o, i) => {
          const id = str(o.id) ?? `objection-${i}`;
          return (
            <div key={id} className="rounded-md border border-warning-border bg-warning-subtle p-3">
              <div className="flex flex-wrap items-center gap-2 text-2xs text-content-subtle">
                <Badge tone="warning" size="xs">
                  unresolved
                </Badge>
                {o.raisedAt ? <span>raised {dateTime(str(o.raisedAt))}</span> : null}
              </div>
              <p className="mt-1 whitespace-pre-wrap text-sm text-content">
                {str(o.note) ?? "(no note recorded)"}
              </p>
              <div className="mt-2 space-y-2">
                <Field label="How was this settled?">
                  <Textarea
                    rows={2}
                    value={notes[id] ?? ""}
                    onChange={(e) => setNotes((n) => ({ ...n, [id]: e.target.value }))}
                  />
                </Field>
                <Button
                  size="xs"
                  variant="secondary"
                  disabled={(notes[id] ?? "").trim().length === 0 || busy !== null}
                  loading={busy === `resolve:${id}`}
                  onClick={() => void resolve(id)}
                >
                  Resolve the objection
                </Button>
                <p className="text-2xs text-content-subtle">
                  Resolving records who settled it and how. If the minutes themselves were wrong,
                  withdraw and correct them instead — resolving an objection does not change a word
                  of the document the recipients hold.
                </p>
              </div>
            </div>
          );
        })}

        {settled.length > 0 ? (
          <ul className="space-y-1.5">
            {settled.map((o, i) => (
              <li
                key={str(o.id) ?? `settled-${i}`}
                className="rounded-md border border-border-subtle p-2 text-meta"
              >
                <div className="flex flex-wrap items-center gap-2 text-2xs text-content-subtle">
                  <Badge tone="success" size="xs">
                    settled
                  </Badge>
                  <span>{dateTime(str(o.resolvedAt))}</span>
                </div>
                <p className="mt-0.5 whitespace-pre-wrap text-content-muted">{str(o.note)}</p>
                {o.resolutionNote ? (
                  <p className="mt-0.5 whitespace-pre-wrap text-content">
                    <span className="text-content-subtle">Resolution: </span>
                    {str(o.resolutionNote)}
                  </p>
                ) : null}
              </li>
            ))}
          </ul>
        ) : null}

        {history.length > 0 ? (
          <div className="rounded-md bg-surface-subtle p-2 text-2xs text-content-subtle">
            {history.length} earlier version{history.length === 1 ? "" : "s"} of these minutes
            {history.length === 1 ? " was" : " were"} withdrawn for correction. The objections
            raised against them are kept with the version they were raised against, not carried
            forward onto a document their author never saw.
          </div>
        ) : null}
      </CardBody>
    </Card>
  );
}

/* ================================================================== */
/* The rendered document and its deliveries                            */
/* ================================================================== */

export function MinutesDocumentPanel({
  projectId,
  meeting,
  onMutated,
}: {
  projectId: string;
  meeting: MeetingDetail;
  onMutated: () => void;
}) {
  const { busy, refusal, clear, run } = useAction();
  const [preview, setPreview] = useState<string | null>(null);
  const base = `/api/v1/projects/${projectId}/meetings/${meeting.id}/minutes`;
  const doc = meeting.minutesDocument ?? null;
  const pack = meeting.agendaPack ?? null;
  const deliveries = meeting.deliveries;

  async function render(kind: "minutes" | "agenda_pack") {
    const done = await run(`render:${kind}`, () => api.post(`${base}/render`, { kind }));
    if (done !== null) onMutated();
  }

  async function open(kind: "minutes" | "agenda_pack") {
    /* The route serves the STORED bytes as text/html, so the client gets a
       string back rather than JSON — never a fresh render, so what is shown is
       what was hashed. */
    const html = await run(`open:${kind}`, () =>
      api.get<string>(`${base}/document?kind=${kind}`),
    );
    if (typeof html === "string") setPreview(html);
  }

  async function acknowledge(deliveryId: string) {
    const done = await run(`ack:${deliveryId}`, () =>
      api.post(`${base}/deliveries/${deliveryId}/acknowledge`, {}),
    );
    if (done !== null) onMutated();
  }

  return (
    <Card>
      <CardBody className="space-y-3">
        <div>
          <h3 className="text-sm font-semibold text-content">The document, and who received it</h3>
          <p className="text-2xs text-content-subtle">
            Deemed acceptance rests on a specific set of words having reached a specific person.
            Rendering stores a content-addressed file and records its sha256 on the meeting and in
            the ledger, so a later copy that differs by a single byte will not match.
          </p>
        </div>

        <RefusalPanel refusal={refusal} onDismiss={clear} />

        <div className="flex flex-wrap gap-2">
          <Button
            size="xs"
            variant="secondary"
            disabled={busy !== null}
            loading={busy === "render:agenda_pack"}
            onClick={() => void render("agenda_pack")}
          >
            Render the agenda pack
          </Button>
          <Button
            size="xs"
            variant="secondary"
            disabled={busy !== null || (!meeting.minutesBody && !doc)}
            loading={busy === "render:minutes"}
            onClick={() => void render("minutes")}
          >
            {doc ? "Re-render the minutes" : "Render the minutes"}
          </Button>
          {doc ? (
            <Button
              size="xs"
              variant="ghost"
              disabled={busy !== null}
              loading={busy === "open:minutes"}
              onClick={() => void open("minutes")}
            >
              Preview the stored minutes
            </Button>
          ) : null}
          {pack ? (
            <Button
              size="xs"
              variant="ghost"
              disabled={busy !== null}
              loading={busy === "open:agenda_pack"}
              onClick={() => void open("agenda_pack")}
            >
              Preview the agenda pack
            </Button>
          ) : null}
        </div>

        {doc ? (
          <dl className="grid grid-cols-[auto_1fr] gap-x-3 gap-y-1 text-2xs">
            <dt className="text-content-subtle">Version</dt>
            <dd className="text-content">v{doc.minutesVersion}</dd>
            <dt className="text-content-subtle">Rendered</dt>
            <dd className="text-content">{dateTime(doc.renderedAt)}</dd>
            <dt className="text-content-subtle">SHA-256</dt>
            <dd className="break-all font-mono text-content">{doc.sha256 ?? "—"}</dd>
          </dl>
        ) : (
          <p className="text-meta text-content-subtle">
            No minutes document has been rendered. Until one exists there is nothing whose delivery
            can be evidenced, and the objection period runs from the issue timestamp alone.
          </p>
        )}

        {deliveries && deliveries.total > 0 ? (
          <div className="space-y-2">
            <p className="text-meta text-content-muted">
              {deliveries.delivered} of {deliveries.total} delivered ·{" "}
              {deliveries.acknowledged} acknowledged
              {deliveries.failed > 0 ? ` · ${deliveries.failed} failed` : ""}
            </p>
            <Table>
              <thead>
                <tr>
                  <Th>Recipient</Th>
                  <Th>Channel</Th>
                  <Th>Status</Th>
                  <Th>Delivered</Th>
                  <Th />
                </tr>
              </thead>
              <tbody>
                {deliveries.items.map((d) => (
                  <tr key={d.id}>
                    <Td>
                      <div className="text-content">{d.recipientName}</div>
                      {d.email ? (
                        <div className="text-2xs text-content-subtle">{d.email}</div>
                      ) : null}
                    </Td>
                    <Td className="text-meta">{titleCase(d.channel)}</Td>
                    <Td>
                      <Badge
                        size="xs"
                        tone={
                          d.status === "acknowledged"
                            ? "success"
                            : d.status === "delivered"
                              ? "info"
                              : d.status === "failed"
                                ? "danger"
                                : "neutral"
                        }
                      >
                        {titleCase(d.status)}
                      </Badge>
                      {d.failureReason ? (
                        <div className="mt-0.5 max-w-xs text-2xs text-danger">
                          {d.failureReason}
                        </div>
                      ) : null}
                    </Td>
                    <Td className="text-meta">{d.deliveredAt ? dateTime(d.deliveredAt) : "—"}</Td>
                    <Td>
                      {d.status !== "acknowledged" ? (
                        <Button
                          size="xs"
                          variant="ghost"
                          disabled={busy !== null}
                          loading={busy === `ack:${d.id}`}
                          onClick={() => void acknowledge(d.id)}
                        >
                          Acknowledge
                        </Button>
                      ) : null}
                    </Td>
                  </tr>
                ))}
              </tbody>
            </Table>
            <p className="text-2xs text-content-subtle">
              Only the recipient may acknowledge their own copy — an acknowledgement somebody else
              pressed is not evidence of anything.
            </p>
          </div>
        ) : meeting.minutesIssuedAt ? (
          <Alert tone="warning" variant="subtle" size="sm">
            These minutes were issued but no delivery was recorded against any recipient, so the
            objection period runs from the issue timestamp rather than from receipt. A clock that
            starts when the sender clicks a button binds a recipient who may never have got the
            document.
          </Alert>
        ) : null}

        {preview !== null ? (
          <div className="rounded-md border border-border-subtle">
            <div className="flex items-center justify-between border-b border-border-subtle px-2 py-1">
              <span className="text-2xs text-content-subtle">
                The stored bytes, served from the file register — never a fresh render
              </span>
              <Button size="xs" variant="ghost" onClick={() => setPreview(null)}>
                Close
              </Button>
            </div>
            <iframe
              title="Minutes preview"
              srcDoc={preview}
              className="h-[520px] w-full rounded-b-md bg-white"
              sandbox=""
            />
          </div>
        ) : null}
      </CardBody>
    </Card>
  );
}
