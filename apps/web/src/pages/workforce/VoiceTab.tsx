/**
 * WORKER VOICE (#689-691) — the grievance channel the employer does not own.
 *
 * Two things on this screen are load-bearing and easy to get wrong:
 *
 *  1. THE INTAKE TOKEN IS SHOWN ONCE. The platform stores only its sha256, so
 *     a token that could be read back out of the register is a token an
 *     employer with database access could use to work out who reported them.
 *     The screen says so, because somebody will otherwise close the dialog
 *     expecting to find it later.
 *  2. AN UNANSWERED GRIEVANCE REGISTER IS WORSE THAN NO CHANNEL. A report past
 *     its first-response SLA is escalated and signalled, and this tab leads
 *     with that count rather than with the total — the total flatters, the
 *     overdue count is the one a lender's reviewer asks about.
 *
 * Anonymous reports carry no worker id at all, and the register never invites
 * anyone to guess: it shows "anonymous" and stops there.
 */
import { useCallback, useEffect, useState } from "react";
import { api } from "../../lib/api";
import {
  Alert,
  Badge,
  Button,
  Card,
  CardBody,
  EmptyState,
  Field,
  Input,
  Modal,
  Select,
  Spinner,
  Table,
  Td,
  Th,
  Textarea,
} from "../../ui";
import { LoadError, Stat, label, severityTone, type ListResponse } from "./workforceShared";

interface GrievanceRow {
  id: string;
  reference: string;
  category: string;
  severity: string;
  summary: string;
  status: string;
  isAnonymous: boolean;
  vendorId: string | null;
  vendorName: string | null;
  receivedAt: string;
  responseDueAt: string | null;
  firstRespondedAt: string | null;
  closedAt: string | null;
  slaBreached: boolean;
  updates: Array<{ at: string; kind: string; text: string; visibleToReporter: boolean }>;
}

interface ChannelRow {
  id: string;
  name: string;
  tokenPrefix: string;
  languages: string[];
  responseSlaHours: number;
  isActive: number;
  reportCount: number;
  revokedAt: string | null;
}

const STATUSES = [
  "received",
  "acknowledged",
  "investigating",
  "escalated",
  "resolved",
  "closed_no_action",
  "withdrawn",
];

export default function VoiceTab({ projectId }: { projectId: string }) {
  const [rows, setRows] = useState<GrievanceRow[] | null>(null);
  const [channels, setChannels] = useState<ChannelRow[] | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [openChannelForm, setOpenChannelForm] = useState(false);
  const [issuedToken, setIssuedToken] = useState<{ token: string; name: string } | null>(null);
  const [selected, setSelected] = useState<GrievanceRow | null>(null);

  const load = useCallback(async () => {
    setError(null);
    try {
      const [list, chans] = await Promise.all([
        api.get<ListResponse<GrievanceRow>>(
          `/api/v1/projects/${projectId}/worker-grievances?page=1&pageSize=200`,
        ),
        api.get<{ items: ChannelRow[] }>(`/api/v1/projects/${projectId}/worker-voice/channels`),
      ]);
      setRows(list.items);
      setChannels(chans.items);
    } catch (err) {
      setError(err instanceof Error ? err.message : "The grievance register could not be loaded.");
    }
  }, [projectId]);

  useEffect(() => {
    void load();
  }, [load]);

  if (error) return <LoadError message={error} onRetry={() => void load()} />;
  if (!rows || !channels) return <Spinner />;

  const overdue = rows.filter((r) => r.slaBreached && !r.closedAt).length;
  const open = rows.filter((r) => !r.closedAt).length;
  const unanswered = rows.filter((r) => !r.firstRespondedAt && !r.closedAt).length;

  return (
    <div className="space-y-4">
      <div className="grid gap-3 sm:grid-cols-4">
        <Stat
          label="Past first-response SLA"
          value={String(overdue)}
          tone={overdue > 0 ? "red" : "green"}
          hint="An unanswered grievance register evidences to a reviewer that workers raised something and nobody answered."
        />
        <Stat label="Open reports" value={String(open)} />
        <Stat label="Awaiting a first response" value={String(unanswered)} />
        <Stat
          label="Channels"
          value={String(channels.filter((c) => c.isActive === 1).length)}
          hint="Each channel is a token printed on a worker card."
        />
      </div>

      <Card>
        <CardBody className="space-y-3">
          <div className="flex flex-wrap items-center justify-between gap-2">
            <div>
              <h3 className="text-body font-medium">Intake channels</h3>
              <p className="text-meta text-content-muted">
                A report posted with the token needs no account and no device the employer
                controls. The token is shown once and stored only as a hash.
              </p>
            </div>
            <Button size="sm" variant="primary" onClick={() => setOpenChannelForm(true)}>
              New channel
            </Button>
          </div>
          {channels.length === 0 ? (
            <EmptyState
              title="No channel yet"
              description="Workers cannot report anything until a channel exists and its token is on a card in their own language."
            />
          ) : (
            <Table>
              <thead>
                <tr>
                  <Th>Name</Th>
                  <Th>Token</Th>
                  <Th>Languages</Th>
                  <Th align="right">SLA (h)</Th>
                  <Th align="right">Reports</Th>
                  <Th>State</Th>
                </tr>
              </thead>
              <tbody>
                {channels.map((c) => (
                  <tr key={c.id}>
                    <Td>{c.name}</Td>
                    <Td>
                      <span className="font-mono text-meta">{c.tokenPrefix}…</span>
                    </Td>
                    <Td>{c.languages.length > 0 ? c.languages.join(", ") : "—"}</Td>
                    <Td align="right">{c.responseSlaHours}</Td>
                    <Td align="right">{c.reportCount}</Td>
                    <Td>
                      <Badge tone={c.isActive === 1 ? "green" : "gray"}>
                        {c.isActive === 1 ? "open" : "revoked"}
                      </Badge>
                    </Td>
                  </tr>
                ))}
              </tbody>
            </Table>
          )}
        </CardBody>
      </Card>

      <Card>
        <CardBody className="space-y-3">
          <h3 className="text-body font-medium">Reports</h3>
          {rows.length === 0 ? (
            <EmptyState
              title="No reports"
              description="Nothing has come through the channel. That is a finding in itself if the channel has been open a while: on a project of any size, silence usually means the card never reached anybody."
            />
          ) : (
            <Table>
              <thead>
                <tr>
                  <Th>Ref</Th>
                  <Th>Category</Th>
                  <Th>Summary</Th>
                  <Th>Employer</Th>
                  <Th>Received</Th>
                  <Th>First response</Th>
                  <Th>Status</Th>
                  <Th />
                </tr>
              </thead>
              <tbody>
                {rows.map((r) => (
                  <tr key={r.id}>
                    <Td>
                      <span className="font-mono text-meta">{r.reference}</span>
                    </Td>
                    <Td>
                      <Badge tone={severityTone(r.severity)}>{label(r.category)}</Badge>
                    </Td>
                    <Td className="max-w-[24rem] truncate">{r.summary}</Td>
                    <Td>{r.vendorName ?? (r.isAnonymous ? "not named" : "—")}</Td>
                    <Td>{r.receivedAt.slice(0, 10)}</Td>
                    <Td>
                      {r.firstRespondedAt ? (
                        r.firstRespondedAt.slice(0, 10)
                      ) : r.slaBreached ? (
                        <Badge tone="red">overdue</Badge>
                      ) : (
                        <span className="text-content-muted">
                          due {r.responseDueAt?.slice(0, 10) ?? "—"}
                        </span>
                      )}
                    </Td>
                    <Td>
                      <Badge tone={r.closedAt ? "gray" : "amber"}>{label(r.status)}</Badge>
                    </Td>
                    <Td align="right">
                      <Button size="sm" variant="ghost" onClick={() => setSelected(r)}>
                        Respond
                      </Button>
                    </Td>
                  </tr>
                ))}
              </tbody>
            </Table>
          )}
        </CardBody>
      </Card>

      <ChannelForm
        open={openChannelForm}
        projectId={projectId}
        onClose={() => setOpenChannelForm(false)}
        onIssued={(token, name) => {
          setIssuedToken({ token, name });
          setOpenChannelForm(false);
          void load();
        }}
      />

      <Modal
        open={issuedToken !== null}
        onClose={() => setIssuedToken(null)}
        title="The intake token — shown once"
        footer={
          <Button variant="primary" onClick={() => setIssuedToken(null)}>
            I have copied it
          </Button>
        }
      >
        <div className="space-y-3">
          <Alert tone="warning" title="This is the only time this token is displayed">
            The platform stores only its sha256 hash. A token that could be read back out of the
            database is a token an employer with database access could use to identify a reporter.
          </Alert>
          <p className="break-all rounded-md bg-surface-sunken p-3 font-mono text-body">
            {issuedToken?.token}
          </p>
          <p className="text-meta text-content-muted">
            Print it on the card workers are given for <strong>{issuedToken?.name}</strong>, in
            their own language, with the address of the reporting page.
          </p>
        </div>
      </Modal>

      <RespondForm
        grievance={selected}
        projectId={projectId}
        busy={busy}
        setBusy={setBusy}
        onClose={() => setSelected(null)}
        onDone={() => {
          setSelected(null);
          void load();
        }}
      />
    </div>
  );
}

function ChannelForm({
  open,
  projectId,
  onClose,
  onIssued,
}: {
  open: boolean;
  projectId: string;
  onClose: () => void;
  onIssued: (token: string, name: string) => void;
}) {
  const [name, setName] = useState("Worker voice — main gate");
  const [languages, setLanguages] = useState("en");
  const [sla, setSla] = useState("72");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  async function submit() {
    setBusy(true);
    setError(null);
    try {
      const res = await api.post<{ token: string; name: string }>(
        `/api/v1/projects/${projectId}/worker-voice/channels`,
        {
          name: name.trim(),
          languages: languages
            .split(",")
            .map((s) => s.trim())
            .filter(Boolean),
          responseSlaHours: Number(sla),
        },
      );
      onIssued(res.token, res.name);
    } catch (err) {
      setError(err instanceof Error ? err.message : "The channel could not be created.");
    } finally {
      setBusy(false);
    }
  }

  return (
    <Modal
      open={open}
      onClose={onClose}
      title="Open a worker voice channel"
      description="Workers report through a token printed on a card, with no account and no device the employer controls."
      footer={
        <div className="flex justify-end gap-2">
          <Button variant="ghost" onClick={onClose}>
            Cancel
          </Button>
          <Button variant="primary" loading={busy} onClick={submit}>
            Issue the token
          </Button>
        </div>
      }
    >
      <div className="space-y-3">
        {error ? <Alert tone="danger">{error}</Alert> : null}
        <Field label="Name" required>
          <Input value={name} onChange={(e) => setName(e.target.value)} />
        </Field>
        <Field label="Languages" hint="Comma separated. The card has to be readable to be used.">
          <Input value={languages} onChange={(e) => setLanguages(e.target.value)} />
        </Field>
        <Field
          label="First-response SLA (hours)"
          hint="After this a report is escalated and signalled — which is the only thing that makes a channel real."
        >
          <Input type="number" value={sla} onChange={(e) => setSla(e.target.value)} />
        </Field>
      </div>
    </Modal>
  );
}

function RespondForm({
  grievance,
  projectId,
  busy,
  setBusy,
  onClose,
  onDone,
}: {
  grievance: GrievanceRow | null;
  projectId: string;
  busy: boolean;
  setBusy: (v: boolean) => void;
  onClose: () => void;
  onDone: () => void;
}) {
  const [text, setText] = useState("");
  const [status, setStatus] = useState("");
  const [visible, setVisible] = useState(true);
  const [error, setError] = useState<string | null>(null);

  async function submit() {
    if (!grievance) return;
    setBusy(true);
    setError(null);
    try {
      await api.post(`/api/v1/projects/${projectId}/worker-grievances/${grievance.id}/updates`, {
        kind: "response",
        text: text.trim(),
        visibleToReporter: visible,
        ...(status ? { status } : {}),
      });
      setText("");
      setStatus("");
      onDone();
    } catch (err) {
      setError(err instanceof Error ? err.message : "The response could not be recorded.");
    } finally {
      setBusy(false);
    }
  }

  return (
    <Modal
      open={grievance !== null}
      onClose={onClose}
      title={grievance ? `${grievance.reference} — ${label(grievance.category)}` : ""}
      description={grievance?.summary}
      footer={
        <div className="flex justify-end gap-2">
          <Button variant="ghost" onClick={onClose}>
            Close
          </Button>
          <Button variant="primary" loading={busy} disabled={text.trim() === ""} onClick={submit}>
            Record the response
          </Button>
        </div>
      }
    >
      <div className="space-y-3">
        {error ? <Alert tone="danger">{error}</Alert> : null}
        {grievance?.isAnonymous ? (
          <Alert tone="info" title="Anonymous report">
            No worker identity was given and none may be inferred. A response marked visible
            reaches the reporter through the tracking code they hold — not through us.
          </Alert>
        ) : null}
        {grievance && grievance.updates.length > 0 ? (
          <div className="space-y-2 rounded-md border border-border p-3">
            {grievance.updates.map((u, i) => (
              <div key={i} className="text-meta">
                <span className="text-content-muted">
                  {u.at.slice(0, 10)} · {label(u.kind)}
                  {u.visibleToReporter ? " · visible to the reporter" : " · internal"}
                </span>
                <p>{u.text}</p>
              </div>
            ))}
          </div>
        ) : null}
        <Field label="Response" required>
          <Textarea rows={4} value={text} onChange={(e) => setText(e.target.value)} />
        </Field>
        <div className="grid gap-3 sm:grid-cols-2">
          <Field label="Move it to" optional>
            <Select value={status} onChange={(e) => setStatus(e.target.value)}>
              <option value="">— leave the status —</option>
              {STATUSES.map((s) => (
                <option key={s} value={s}>
                  {label(s)}
                </option>
              ))}
            </Select>
          </Field>
          <label className="flex items-end gap-2 pb-2 text-meta">
            <input
              type="checkbox"
              checked={visible}
              onChange={(e) => setVisible(e.target.checked)}
            />
            The reporter can read this
          </label>
        </div>
      </div>
    </Modal>
  );
}
