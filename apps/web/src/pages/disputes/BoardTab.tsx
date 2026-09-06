/**
 * Standing dispute board — DAAB / DAB membership and site visits
 * (spec Vol II Domain E #322-333).
 *
 * A dispute board's value is its independence, so the panel leads with the
 * independence disclosures and names any member who has none: an undeclared
 * connection is what gets an appointment challenged years later.
 */
import { useCallback, useEffect, useState, type FormEvent } from "react";
import { DISPUTE_BOARD_ROLES } from "@constructos/shared";
import { api, ApiClientError } from "../../lib/api";
import {
  Badge,
  Button,
  Card,
  CardBody,
  ErrorAlert,
  Field,
  Input,
  Select,
  Spinner,
  Table,
  Td,
  Textarea,
  Th,
} from "../../ui";
import { formatDate, humanize } from "../format";
import type { DisputeDetail } from "./disputesShared";

interface BoardMember {
  id: string;
  name: string;
  boardRole: string;
  nominatedBy: string | null;
  appointedAt: string | null;
  independenceDisclosure: string | null;
  conflictDeclared: number;
  feeBasis: string | null;
  createdAt: string;
}

interface BoardVisit {
  id: string;
  visitDate: string;
  attendees: string[];
  summary: string | null;
  recommendations: string | null;
  reportFileId: string | null;
  createdAt: string;
}

interface BoardResponse {
  members: BoardMember[];
  visits: BoardVisit[];
  warnings: string[];
}

export default function BoardTab({
  projectId,
  dispute,
  onChanged,
}: {
  projectId: string;
  dispute: DisputeDetail;
  onChanged: () => void;
}) {
  const base = `/api/v1/projects/${projectId}`;
  const [data, setData] = useState<BoardResponse | null>(null);
  const [error, setError] = useState<string | null>(null);

  const load = useCallback(async () => {
    setError(null);
    try {
      setData(await api.get<BoardResponse>(`${base}/disputes/${dispute.id}/board`));
    } catch (err) {
      setData({ members: [], visits: [], warnings: [] });
      setError(err instanceof ApiClientError ? err.message : "Could not load the dispute board");
    }
  }, [base, dispute.id]);

  useEffect(() => {
    void load();
  }, [load]);

  /* ------------------------------- add member ------------------------------- */

  const [mOpen, setMOpen] = useState(false);
  const [mName, setMName] = useState("");
  const [mRole, setMRole] = useState<string>("member");
  const [mNominated, setMNominated] = useState<string>("agreed");
  const [mAppointed, setMAppointed] = useState("");
  const [mDisclosure, setMDisclosure] = useState("");
  const [mConflict, setMConflict] = useState(false);
  const [mError, setMError] = useState<string | null>(null);
  const [mBusy, setMBusy] = useState(false);

  async function addMember(e: FormEvent) {
    e.preventDefault();
    setMError(null);
    setMBusy(true);
    try {
      await api.post(`${base}/disputes/${dispute.id}/board-members`, {
        name: mName.trim(),
        boardRole: mRole,
        nominatedBy: mNominated,
        conflictDeclared: mConflict,
        ...(mAppointed ? { appointedAt: mAppointed } : {}),
        ...(mDisclosure.trim() ? { independenceDisclosure: mDisclosure.trim() } : {}),
      });
      setMOpen(false);
      setMName("");
      setMDisclosure("");
      setMConflict(false);
      await load();
      onChanged();
    } catch (err) {
      setMError(err instanceof ApiClientError ? err.message : "Could not add the board member");
    } finally {
      setMBusy(false);
    }
  }

  /* -------------------------------- add visit -------------------------------- */

  const [vOpen, setVOpen] = useState(false);
  const [vDate, setVDate] = useState("");
  const [vAttendees, setVAttendees] = useState("");
  const [vSummary, setVSummary] = useState("");
  const [vRecommendations, setVRecommendations] = useState("");
  const [vError, setVError] = useState<string | null>(null);
  const [vBusy, setVBusy] = useState(false);

  async function addVisit(e: FormEvent) {
    e.preventDefault();
    setVError(null);
    setVBusy(true);
    try {
      await api.post(`${base}/disputes/${dispute.id}/board-visits`, {
        visitDate: vDate,
        attendees: vAttendees
          .split(/[,\n]/)
          .map((a) => a.trim())
          .filter(Boolean),
        ...(vSummary.trim() ? { summary: vSummary.trim() } : {}),
        ...(vRecommendations.trim() ? { recommendations: vRecommendations.trim() } : {}),
      });
      setVOpen(false);
      setVDate("");
      setVAttendees("");
      setVSummary("");
      setVRecommendations("");
      await load();
      onChanged();
    } catch (err) {
      setVError(err instanceof ApiClientError ? err.message : "Could not record the visit");
    } finally {
      setVBusy(false);
    }
  }

  if (data === null) return <Spinner label="Loading dispute board…" />;

  return (
    <div className="space-y-5">
      <ErrorAlert message={error} />

      {data.warnings.length > 0 ? (
        <ul className="list-disc space-y-1 rounded-md bg-amber-50 px-5 py-2 text-xs leading-5 text-amber-800 ring-1 ring-amber-200">
          {data.warnings.map((w) => (
            <li key={w}>{w}</li>
          ))}
        </ul>
      ) : null}

      {/* --------------------------------- members --------------------------------- */}
      <div>
        <div className="mb-2 flex items-center justify-between">
          <h4 className="text-sm font-semibold text-ink-900">Board members</h4>
          <Button variant="secondary" size="sm" onClick={() => setMOpen((v) => !v)}>
            {mOpen ? "Cancel" : "Add member"}
          </Button>
        </div>

        {mOpen ? (
          <Card className="mb-3">
            <CardBody>
              <form onSubmit={addMember} className="space-y-3">
                <ErrorAlert message={mError} />
                <div className="grid grid-cols-1 gap-3 sm:grid-cols-4">
                  <Field label="Name">
                    <Input required value={mName} onChange={(e) => setMName(e.target.value)} />
                  </Field>
                  <Field label="Role">
                    <Select value={mRole} onChange={(e) => setMRole(e.target.value)}>
                      {DISPUTE_BOARD_ROLES.map((r) => (
                        <option key={r} value={r}>
                          {humanize(r)}
                        </option>
                      ))}
                    </Select>
                  </Field>
                  <Field label="Nominated by">
                    <Select value={mNominated} onChange={(e) => setMNominated(e.target.value)}>
                      <option value="employer">Employer</option>
                      <option value="contractor">Contractor</option>
                      <option value="agreed">Agreed</option>
                      <option value="institution">Institution</option>
                    </Select>
                  </Field>
                  <Field label="Appointed">
                    <Input
                      type="date"
                      value={mAppointed}
                      onChange={(e) => setMAppointed(e.target.value)}
                    />
                  </Field>
                </div>
                <Field
                  label="Independence disclosure"
                  hint="Prior engagements with either party, and anything else a challenge would rest on."
                >
                  <Textarea
                    value={mDisclosure}
                    onChange={(e) => setMDisclosure(e.target.value)}
                    className="min-h-16 text-xs"
                  />
                </Field>
                <label className="flex items-center gap-2 text-xs text-ink-700">
                  <input
                    type="checkbox"
                    className="h-4 w-4 accent-brand-600"
                    checked={mConflict}
                    onChange={(e) => setMConflict(e.target.checked)}
                  />
                  A conflict has been declared
                </label>
                <div className="flex justify-end">
                  <Button type="submit" size="sm" disabled={mBusy}>
                    {mBusy ? "Adding…" : "Add member"}
                  </Button>
                </div>
              </form>
            </CardBody>
          </Card>
        ) : null}

        {data.members.length === 0 ? (
          <p className="rounded-md bg-ink-50 px-3 py-2 text-xs text-ink-500 ring-1 ring-ink-100">
            No standing board is appointed on this dispute.
          </p>
        ) : (
          <Table>
            <thead>
              <tr>
                <Th>Member</Th>
                <Th>Role</Th>
                <Th>Nominated by</Th>
                <Th>Appointed</Th>
                <Th>Independence</Th>
              </tr>
            </thead>
            <tbody className="divide-y divide-ink-100">
              {data.members.map((m) => (
                <tr key={m.id}>
                  <Td className="text-sm font-medium text-ink-900">{m.name}</Td>
                  <Td>
                    <Badge tone={m.boardRole === "chair" ? "violet" : "gray"}>
                      {humanize(m.boardRole)}
                    </Badge>
                  </Td>
                  <Td className="text-xs">{m.nominatedBy ? humanize(m.nominatedBy) : "—"}</Td>
                  <Td className="whitespace-nowrap text-xs">
                    {m.appointedAt ? formatDate(m.appointedAt) : "—"}
                  </Td>
                  <Td className="text-xs">
                    {m.conflictDeclared === 1 ? (
                      <Badge tone="red">conflict declared</Badge>
                    ) : m.independenceDisclosure ? (
                      <span className="text-ink-600">{m.independenceDisclosure}</span>
                    ) : (
                      <span className="font-medium text-amber-700">no disclosure on record</span>
                    )}
                  </Td>
                </tr>
              ))}
            </tbody>
          </Table>
        )}
      </div>

      {/* --------------------------------- visits ---------------------------------- */}
      <div>
        <div className="mb-2 flex items-center justify-between">
          <h4 className="text-sm font-semibold text-ink-900">Site visits &amp; reports</h4>
          <Button variant="secondary" size="sm" onClick={() => setVOpen((v) => !v)}>
            {vOpen ? "Cancel" : "Record visit"}
          </Button>
        </div>

        {vOpen ? (
          <Card className="mb-3">
            <CardBody>
              <form onSubmit={addVisit} className="space-y-3">
                <ErrorAlert message={vError} />
                <div className="grid grid-cols-1 gap-3 sm:grid-cols-2">
                  <Field label="Visit date">
                    <Input
                      type="date"
                      required
                      value={vDate}
                      onChange={(e) => setVDate(e.target.value)}
                    />
                  </Field>
                  <Field label="Attendees" hint="Comma separated.">
                    <Input value={vAttendees} onChange={(e) => setVAttendees(e.target.value)} />
                  </Field>
                </div>
                <Field label="Summary">
                  <Textarea
                    value={vSummary}
                    onChange={(e) => setVSummary(e.target.value)}
                    className="min-h-16 text-xs"
                  />
                </Field>
                <Field label="Recommendations">
                  <Textarea
                    value={vRecommendations}
                    onChange={(e) => setVRecommendations(e.target.value)}
                    className="min-h-16 text-xs"
                  />
                </Field>
                <div className="flex justify-end">
                  <Button type="submit" size="sm" disabled={vBusy}>
                    {vBusy ? "Recording…" : "Record visit"}
                  </Button>
                </div>
              </form>
            </CardBody>
          </Card>
        ) : null}

        {data.visits.length === 0 ? (
          <p className="rounded-md bg-ink-50 px-3 py-2 text-xs text-ink-500 ring-1 ring-ink-100">
            No board visits recorded. A standing board that never visits is a board in name only.
          </p>
        ) : (
          <ul className="divide-y divide-ink-100">
            {data.visits.map((v) => (
              <li key={v.id} className="py-2.5">
                <div className="flex flex-wrap items-center gap-2">
                  <span className="text-sm font-semibold text-ink-900">
                    {formatDate(v.visitDate)}
                  </span>
                  {v.attendees.length > 0 ? (
                    <span className="text-xs text-ink-500">{v.attendees.join(", ")}</span>
                  ) : null}
                </div>
                {v.summary ? (
                  <p className="mt-1 whitespace-pre-wrap text-xs leading-5 text-ink-700">
                    {v.summary}
                  </p>
                ) : null}
                {v.recommendations ? (
                  <p className="mt-1 rounded-md bg-brand-50 px-2 py-1 text-xs leading-5 text-brand-900">
                    <strong>Recommendations:</strong> {v.recommendations}
                  </p>
                ) : null}
              </li>
            ))}
          </ul>
        )}
      </div>
    </div>
  );
}
