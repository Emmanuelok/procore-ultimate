/**
 * Accepted-programme register (spec Vol II Domain C #209-210).
 *
 * Under NEC the Accepted Programme is the instrument that decides delay: a
 * compensation event is assessed as the effect on planned Completion shown on
 * it. A programme not accepted, and not rejected for one of the four reasons
 * in clause 31.3, is a live commercial exposure — so the register records the
 * decision, its due date, and the stated reason.
 */
import { useCallback, useEffect, useState } from "react";
import { api, ApiClientError } from "../../lib/api";
import {
  Badge,
  Button,
  EmptyState,
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
import { programmeTone, todayIso, type ListResponse, type ProgrammeRow } from "./contractsShared";

const REJECTION_REASONS = [
  "plans_not_practicable",
  "does_not_show_information_required",
  "does_not_represent_plans_realistically",
  "does_not_comply_with_scope",
] as const;

export default function ProgrammesTab({
  projectId,
  contractId,
  users,
}: {
  projectId: string;
  contractId: string;
  users: (id: string | null | undefined) => string;
}) {
  const base = `/api/v1/projects/${projectId}/contracts/${contractId}/programmes`;
  const [rows, setRows] = useState<ProgrammeRow[] | null>(null);
  const [acceptedId, setAcceptedId] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [submittedAt, setSubmittedAt] = useState(todayIso());
  const [revision, setRevision] = useState("");
  const [plannedCompletion, setPlannedCompletion] = useState("");
  const [terminalFloat, setTerminalFloat] = useState("");
  const [notes, setNotes] = useState("");
  const [decideFor, setDecideFor] = useState<ProgrammeRow | null>(null);
  const [rejectionReason, setRejectionReason] = useState<string>(REJECTION_REASONS[0]);
  const [rejectionDetail, setRejectionDetail] = useState("");

  const load = useCallback(async () => {
    setError(null);
    try {
      const res = await api.get<
        ListResponse<ProgrammeRow> & { currentAcceptedProgrammeId: string | null }
      >(`${base}?pageSize=100`);
      setRows(res.items);
      setAcceptedId(res.currentAcceptedProgrammeId);
    } catch (err) {
      setRows([]);
      setError(err instanceof Error ? err.message : "Failed to load the programme register");
    }
  }, [base]);

  useEffect(() => {
    void load();
  }, [load]);

  async function act(fn: () => Promise<unknown>) {
    setError(null);
    setBusy(true);
    try {
      await fn();
      await load();
    } catch (err) {
      setError(err instanceof ApiClientError ? err.message : "The action failed");
    } finally {
      setBusy(false);
    }
  }

  return (
    <div>
      <div className="mb-4">
        <h2 className="text-sm font-semibold text-ink-900">Accepted programme register</h2>
        <p className="mt-0.5 text-xs text-ink-500">
          The Project Manager replies within two weeks of submission (31.3); a rejection must state
          one of the four reasons the contract allows.
        </p>
      </div>

      <ErrorAlert message={error} />

      {rows === null ? (
        <Spinner />
      ) : rows.length === 0 ? (
        <EmptyState
          title="No programme submitted"
          hint="Submit the first programme so compensation events can be assessed against planned Completion."
        />
      ) : (
        <Table>
          <thead>
            <tr>
              <Th>No.</Th>
              <Th>Revision</Th>
              <Th>Submitted</Th>
              <Th>Decision due</Th>
              <Th>Decision</Th>
              <Th>Planned completion</Th>
              <Th className="text-right">Terminal float</Th>
              <Th>Status</Th>
              <Th />
            </tr>
          </thead>
          <tbody className="divide-y divide-ink-100">
            {rows.map((p) => {
              const lateDecision =
                p.decisionDueDate != null &&
                (p.decisionAt == null ? todayIso() : p.decisionAt) > p.decisionDueDate;
              return (
                <tr key={p.id} className={p.id === acceptedId ? "bg-emerald-50/50" : ""}>
                  <Td className="whitespace-nowrap font-mono text-xs font-medium">
                    PRG-{String(p.number).padStart(3, "0")}
                  </Td>
                  <Td>{p.revision ?? "—"}</Td>
                  <Td className="whitespace-nowrap text-xs">
                    {formatDate(p.submittedAt)}
                    <span className="block text-ink-400">{users(p.submittedBy)}</span>
                  </Td>
                  <Td className="whitespace-nowrap">
                    {formatDate(p.decisionDueDate)}
                    {lateDecision && p.status === "submitted" ? (
                      <Badge tone="amber" className="ml-1">
                        Overdue
                      </Badge>
                    ) : null}
                  </Td>
                  <Td className="whitespace-nowrap text-xs">
                    {p.decisionAt ? (
                      <>
                        {formatDate(p.decisionAt)}
                        <span className="block text-ink-400">{users(p.decisionBy)}</span>
                      </>
                    ) : (
                      "—"
                    )}
                    {p.rejectionReason ? (
                      <span className="block text-red-700" title={p.rejectionDetail ?? undefined}>
                        {humanize(p.rejectionReason)}
                      </span>
                    ) : null}
                  </Td>
                  <Td className="whitespace-nowrap">{formatDate(p.plannedCompletion)}</Td>
                  <Td className="text-right tabular-nums">
                    {p.terminalFloatDays == null ? "—" : `${p.terminalFloatDays}d`}
                  </Td>
                  <Td>
                    <Badge tone={programmeTone(p.status)}>{humanize(p.status)}</Badge>
                    {p.id === acceptedId ? (
                      <Badge tone="green" className="ml-1">
                        Current
                      </Badge>
                    ) : null}
                  </Td>
                  <Td className="whitespace-nowrap text-right">
                    {p.status === "submitted" ? (
                      <div className="flex justify-end gap-2">
                        <button
                          type="button"
                          disabled={busy}
                          className="text-xs font-medium text-brand-700 hover:text-brand-900"
                          onClick={() =>
                            void act(() =>
                              api.post(`${base}/${p.id}/decide`, { decision: "accepted" }),
                            )
                          }
                        >
                          Accept
                        </button>
                        <button
                          type="button"
                          className="text-xs font-medium text-red-600 hover:text-red-800"
                          onClick={() => setDecideFor(p)}
                        >
                          Reject…
                        </button>
                      </div>
                    ) : null}
                  </Td>
                </tr>
              );
            })}
          </tbody>
        </Table>
      )}

      <div className="mt-5 rounded-md bg-ink-50 p-3">
        <div className="mb-2 text-xs font-semibold uppercase tracking-wide text-ink-500">
          Submit a programme
        </div>
        <div className="grid grid-cols-2 gap-2 sm:grid-cols-4">
          <Field label="Submitted on">
            <Input
              type="date"
              value={submittedAt}
              onChange={(e) => setSubmittedAt(e.target.value)}
            />
          </Field>
          <Field label="Revision">
            <Input value={revision} onChange={(e) => setRevision(e.target.value)} placeholder="C" />
          </Field>
          <Field label="Planned completion">
            <Input
              type="date"
              value={plannedCompletion}
              onChange={(e) => setPlannedCompletion(e.target.value)}
            />
          </Field>
          <Field label="Terminal float (days)">
            <Input
              value={terminalFloat}
              inputMode="numeric"
              onChange={(e) => setTerminalFloat(e.target.value)}
            />
          </Field>
        </div>
        <Field label="Notes" className="mt-2">
          <Textarea rows={2} value={notes} onChange={(e) => setNotes(e.target.value)} />
        </Field>
        <div className="mt-2 flex justify-end">
          <Button
            size="sm"
            disabled={busy || !submittedAt}
            onClick={() =>
              void act(async () => {
                await api.post(base, {
                  submittedAt,
                  revision: revision || null,
                  plannedCompletion: plannedCompletion || null,
                  terminalFloatDays: terminalFloat ? Number(terminalFloat) : null,
                  notes: notes || null,
                });
                setRevision("");
                setPlannedCompletion("");
                setTerminalFloat("");
                setNotes("");
              })
            }
          >
            Submit programme
          </Button>
        </div>
      </div>

      {decideFor ? (
        <div className="mt-4 rounded-md bg-red-50 p-3 ring-1 ring-red-100">
          <div className="mb-2 text-xs font-semibold uppercase tracking-wide text-red-700">
            Reject PRG-{String(decideFor.number).padStart(3, "0")} — NEC 31.3 reason required
          </div>
          <div className="grid grid-cols-1 gap-2 sm:grid-cols-2">
            <Field label="Reason">
              <Select value={rejectionReason} onChange={(e) => setRejectionReason(e.target.value)}>
                {REJECTION_REASONS.map((r) => (
                  <option key={r} value={r}>
                    {humanize(r)}
                  </option>
                ))}
              </Select>
            </Field>
            <Field label="Detail">
              <Input
                value={rejectionDetail}
                onChange={(e) => setRejectionDetail(e.target.value)}
              />
            </Field>
          </div>
          <div className="mt-2 flex justify-end gap-2">
            <Button variant="secondary" size="sm" onClick={() => setDecideFor(null)}>
              Cancel
            </Button>
            <Button
              variant="danger"
              size="sm"
              disabled={busy}
              onClick={() =>
                void act(async () => {
                  await api.post(`${base}/${decideFor.id}/decide`, {
                    decision: "rejected",
                    rejectionReason,
                    rejectionDetail: rejectionDetail || null,
                  });
                  setDecideFor(null);
                  setRejectionDetail("");
                })
              }
            >
              Reject programme
            </Button>
          </div>
        </div>
      ) : null}
    </div>
  );
}
