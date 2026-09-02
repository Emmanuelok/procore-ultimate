/**
 * Subcontractor labour audit programme (#697-699): scheduled and unannounced
 * audits, findings, and corrective action plans carried as assurance
 * obligations so a missed CAP deadline breaches on the same clock as every
 * other commitment on the project.
 */
import { useCallback, useEffect, useState, type FormEvent } from "react";
import { LABOUR_RISK_INDICATORS } from "@constructos/shared";
import { api, ApiClientError } from "../../lib/api";
import {
  Badge,
  Button,
  Card,
  CardBody,
  EmptyState,
  ErrorAlert,
  Field,
  Input,
  Modal,
  Select,
  Spinner,
  Table,
  Td,
  Textarea,
  Th,
} from "../../ui";
import { formatDate } from "../format";
import {
  LoadError,
  countdownText,
  daysUntil,
  fmtNum,
  isoToday,
  label,
  severityTone,
  type AuditRow,
  type ListResponse,
  type VendorRow,
} from "./workforceShared";

const SEVERITIES = ["low", "medium", "high", "critical"] as const;

interface FindingDraft {
  indicator: string;
  description: string;
  severity: string;
  capDueDate: string;
}

function auditStatusTone(status: string): "blue" | "amber" | "green" | "gray" {
  if (status === "scheduled") return "blue";
  if (status === "in_progress") return "blue";
  if (status === "reported") return "amber";
  if (status === "closed") return "green";
  return "gray";
}

export default function AuditsTab({
  projectId,
  vendors,
  onMutate,
}: {
  projectId: string;
  vendors: VendorRow[];
  onMutate: () => void;
}) {
  const base = `/api/v1/projects/${projectId}`;
  const [rows, setRows] = useState<AuditRow[] | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  const load = useCallback(async () => {
    setError(null);
    try {
      const res = await api.get<ListResponse<AuditRow>>(`${base}/labour-audits?pageSize=100`);
      setRows(res.items);
    } catch (err) {
      setRows([]);
      setError(err instanceof Error ? err.message : "Failed to load the audit programme");
    }
  }, [base]);

  useEffect(() => {
    void load();
  }, [load]);

  /* ------------------------------- schedule -------------------------------- */

  const [scheduleOpen, setScheduleOpen] = useState(false);
  const [scheduleError, setScheduleError] = useState<string | null>(null);
  const [sVendor, setSVendor] = useState("");
  const [sDate, setSDate] = useState(isoToday());
  const [sUnannounced, setSUnannounced] = useState(true);

  function openSchedule() {
    setScheduleError(null);
    setSVendor(vendors[0]?.id ?? "");
    setSDate(isoToday());
    setSUnannounced(true);
    setScheduleOpen(true);
  }

  async function onSchedule(e: FormEvent) {
    e.preventDefault();
    setScheduleError(null);
    if (!sVendor) {
      setScheduleError("Choose the subcontractor to audit.");
      return;
    }
    setBusy(true);
    try {
      await api.post(`${base}/labour-audits`, {
        vendorId: sVendor,
        scheduledFor: sDate,
        isUnannounced: sUnannounced,
      });
      setScheduleOpen(false);
      await load();
      onMutate();
    } catch (err) {
      setScheduleError(
        err instanceof ApiClientError ? err.message : "Failed to schedule the audit.",
      );
    } finally {
      setBusy(false);
    }
  }

  /* -------------------------------- detail --------------------------------- */

  const [openId, setOpenId] = useState<string | null>(null);
  const [detail, setDetail] = useState<AuditRow | null>(null);
  const [detailError, setDetailError] = useState<string | null>(null);

  const loadDetail = useCallback(
    async (id: string) => {
      setDetailError(null);
      setDetail(null);
      try {
        setDetail(await api.get<AuditRow>(`${base}/labour-audits/${id}`));
      } catch (err) {
        setDetailError(err instanceof Error ? err.message : "Failed to load the audit");
      }
    },
    [base],
  );

  useEffect(() => {
    if (openId) void loadDetail(openId);
  }, [openId, loadDetail]);

  const [findings, setFindings] = useState<FindingDraft[]>([]);
  const [score, setScore] = useState("");

  function addFinding() {
    setFindings((f) => [
      ...f,
      { indicator: "", description: "", severity: "medium", capDueDate: "" },
    ]);
  }

  async function submitReport() {
    if (!openId) return;
    setBusy(true);
    setDetailError(null);
    try {
      await api.post(`${base}/labour-audits/${openId}/report`, {
        findings: findings
          .filter((f) => f.description.trim())
          .map((f) => ({
            description: f.description.trim(),
            severity: f.severity,
            ...(f.indicator ? { indicator: f.indicator } : {}),
            ...(f.capDueDate ? { capDueDate: f.capDueDate } : {}),
          })),
        ...(score ? { score: Number(score) } : {}),
      });
      setFindings([]);
      setScore("");
      await loadDetail(openId);
      await load();
      onMutate();
    } catch (err) {
      setDetailError(err instanceof ApiClientError ? err.message : "Failed to file the report.");
    } finally {
      setBusy(false);
    }
  }

  async function closeFinding(findingId: string) {
    if (!openId) return;
    setBusy(true);
    setDetailError(null);
    try {
      await api.post(`${base}/labour-audits/${openId}/findings/${findingId}/close`, {
        note: "Corrective action verified on re-inspection",
      });
      await loadDetail(openId);
      await load();
      onMutate();
    } catch (err) {
      setDetailError(err instanceof ApiClientError ? err.message : "Failed to close the finding.");
    } finally {
      setBusy(false);
    }
  }

  /* --------------------------------- render -------------------------------- */

  const overdueTotal = (rows ?? []).reduce((s, r) => s + (r.overdueCaps ?? 0), 0);

  return (
    <div>
      <div className="mb-4 flex flex-wrap items-center justify-between gap-2">
        <p className="text-sm text-ink-500">
          Unannounced audits, findings and corrective action plans — each CAP deadline is a live
          obligation.
        </p>
        <Button onClick={openSchedule}>Schedule audit</Button>
      </div>

      {overdueTotal > 0 ? (
        <div className="mb-3 rounded-md bg-red-50 px-3 py-2 text-sm text-red-700 ring-1 ring-red-100">
          {overdueTotal} corrective action{overdueTotal === 1 ? "" : "s"} past due — the backing
          obligation{overdueTotal === 1 ? " has" : "s have"} been breached.
        </div>
      ) : null}

      <ErrorAlert message={error} />

      {rows !== null && rows.length === 0 && error ? (
        <LoadError message={error} onRetry={() => void load()} />
      ) : rows === null ? (
        <Spinner label="Loading the audit programme…" />
      ) : rows.length === 0 ? (
        <EmptyState
          title="No labour audits scheduled"
          hint="Schedule audits of the subcontractors supplying labour. Unannounced audits are the only ones that see the camp as it really is."
          action={<Button onClick={openSchedule}>Schedule the first audit</Button>}
        />
      ) : (
        <Table>
          <thead>
            <tr>
              <Th>Scheduled</Th>
              <Th>Subcontractor</Th>
              <Th>Type</Th>
              <Th>Status</Th>
              <Th className="text-right">Score</Th>
              <Th className="text-right">Findings</Th>
              <Th className="text-right">Open</Th>
              <Th className="text-right">Overdue CAPs</Th>
            </tr>
          </thead>
          <tbody className="divide-y divide-ink-100">
            {rows.map((a) => (
              <tr key={a.id} className="cursor-pointer hover:bg-ink-50" onClick={() => setOpenId(a.id)}>
                <Td className="tabular-nums text-ink-600">{formatDate(a.scheduledFor)}</Td>
                <Td className="font-medium text-ink-900">{a.vendorName}</Td>
                <Td>
                  {a.isUnannounced === 1 ? (
                    <Badge tone="violet">Unannounced</Badge>
                  ) : (
                    <span className="text-xs text-ink-500">Announced</span>
                  )}
                </Td>
                <Td>
                  <Badge tone={auditStatusTone(a.status)}>{label(a.status)}</Badge>
                </Td>
                <Td className="text-right tabular-nums text-ink-700">{fmtNum(a.score, 0)}</Td>
                <Td className="text-right tabular-nums">{a.findingCount ?? 0}</Td>
                <Td className="text-right tabular-nums">
                  {(a.openFindings ?? 0) > 0 ? (
                    <span className="font-semibold text-amber-700">{a.openFindings}</span>
                  ) : (
                    <span className="text-ink-300">0</span>
                  )}
                </Td>
                <Td className="text-right tabular-nums">
                  {(a.overdueCaps ?? 0) > 0 ? (
                    <span className="font-semibold text-red-700">{a.overdueCaps}</span>
                  ) : (
                    <span className="text-ink-300">0</span>
                  )}
                </Td>
              </tr>
            ))}
          </tbody>
        </Table>
      )}

      {/* ------------------------------ schedule modal --------------------------- */}
      <Modal open={scheduleOpen} title="Schedule labour audit" onClose={() => setScheduleOpen(false)}>
        <ErrorAlert message={scheduleError} />
        <form onSubmit={onSchedule} className="space-y-4">
          <Field label="Subcontractor">
            <Select value={sVendor} onChange={(e) => setSVendor(e.target.value)}>
              <option value="">Choose an employer…</option>
              {vendors.map((v) => (
                <option key={v.id} value={v.id}>
                  {v.name}
                </option>
              ))}
            </Select>
          </Field>
          <Field label="Scheduled for">
            <Input type="date" required value={sDate} onChange={(e) => setSDate(e.target.value)} />
          </Field>
          <label className="flex items-center gap-2 text-sm text-ink-700">
            <input
              type="checkbox"
              checked={sUnannounced}
              onChange={(e) => setSUnannounced(e.target.checked)}
              className="h-4 w-4 rounded border-ink-300 text-brand-600 focus:ring-brand-500"
            />
            Unannounced (#698)
          </label>
          <div className="flex justify-end gap-2">
            <Button variant="secondary" onClick={() => setScheduleOpen(false)}>
              Cancel
            </Button>
            <Button type="submit" disabled={busy}>
              {busy ? "Scheduling…" : "Schedule"}
            </Button>
          </div>
        </form>
      </Modal>

      {/* ------------------------------- detail modal ---------------------------- */}
      <Modal
        open={openId !== null}
        title={detail ? `Labour audit — ${detail.vendorName}` : "Labour audit"}
        onClose={() => {
          setOpenId(null);
          setDetail(null);
          setFindings([]);
        }}
        wide
      >
        <ErrorAlert message={detailError} />
        {detail === null ? (
          <Spinner />
        ) : (
          <div className="space-y-4">
            <div className="flex flex-wrap items-center gap-2 text-xs text-ink-600">
              <Badge tone={auditStatusTone(detail.status)}>{label(detail.status)}</Badge>
              {detail.isUnannounced === 1 ? <Badge tone="violet">Unannounced</Badge> : null}
              <span>scheduled {formatDate(detail.scheduledFor)}</span>
              {detail.completedAt ? <span>· reported {formatDate(detail.completedAt)}</span> : null}
              {detail.score !== null ? (
                <span className="ml-auto text-sm font-semibold tabular-nums text-ink-900">
                  Score {fmtNum(detail.score, 0)} / 100
                </span>
              ) : null}
            </div>

            {detail.status === "scheduled" || detail.status === "in_progress" ? (
              <Card>
                <CardBody className="space-y-3">
                  <div className="flex items-center justify-between">
                    <h3 className="text-sm font-semibold text-ink-900">File the audit report</h3>
                    <div className="flex items-center gap-2">
                      <Input
                        type="number"
                        min="0"
                        max="100"
                        value={score}
                        onChange={(e) => setScore(e.target.value)}
                        placeholder="Score"
                        className="w-24"
                      />
                      <Button size="sm" variant="secondary" onClick={addFinding}>
                        Add finding
                      </Button>
                    </div>
                  </div>
                  {findings.length === 0 ? (
                    <p className="rounded-md border border-dashed border-ink-200 px-3 py-2.5 text-center text-xs text-ink-400">
                      No findings — filing a clean report closes the audit off with nothing
                      outstanding.
                    </p>
                  ) : (
                    <div className="space-y-2">
                      {findings.map((f, i) => (
                        <div key={i} className="space-y-2 rounded-md bg-ink-50 p-2.5">
                          <div className="flex flex-wrap gap-2">
                            <Select
                              className="w-48"
                              value={f.indicator}
                              onChange={(e) =>
                                setFindings((prev) =>
                                  prev.map((x, j) =>
                                    j === i ? { ...x, indicator: e.target.value } : x,
                                  ),
                                )
                              }
                            >
                              <option value="">No indicator</option>
                              {LABOUR_RISK_INDICATORS.map((ind) => (
                                <option key={ind} value={ind}>
                                  {label(ind)}
                                </option>
                              ))}
                            </Select>
                            <Select
                              className="w-32"
                              value={f.severity}
                              onChange={(e) =>
                                setFindings((prev) =>
                                  prev.map((x, j) =>
                                    j === i ? { ...x, severity: e.target.value } : x,
                                  ),
                                )
                              }
                            >
                              {SEVERITIES.map((s) => (
                                <option key={s} value={s}>
                                  {label(s)}
                                </option>
                              ))}
                            </Select>
                            <Input
                              type="date"
                              className="w-40"
                              value={f.capDueDate}
                              title="CAP deadline — creates an obligation"
                              onChange={(e) =>
                                setFindings((prev) =>
                                  prev.map((x, j) =>
                                    j === i ? { ...x, capDueDate: e.target.value } : x,
                                  ),
                                )
                              }
                            />
                            <Button
                              variant="ghost"
                              size="sm"
                              aria-label={`Remove finding ${i + 1}`}
                              onClick={() =>
                                setFindings((prev) => prev.filter((_, j) => j !== i))
                              }
                            >
                              ✕
                            </Button>
                          </div>
                          <Textarea
                            className="min-h-0"
                            rows={2}
                            value={f.description}
                            onChange={(e) =>
                              setFindings((prev) =>
                                prev.map((x, j) =>
                                  j === i ? { ...x, description: e.target.value } : x,
                                ),
                              )
                            }
                            placeholder="What was found, where, and against which standard"
                          />
                        </div>
                      ))}
                    </div>
                  )}
                  <div className="flex justify-end">
                    <Button disabled={busy} onClick={() => void submitReport()}>
                      {busy ? "Filing…" : "File report"}
                    </Button>
                  </div>
                </CardBody>
              </Card>
            ) : null}

            <section>
              <h3 className="mb-1.5 text-xs font-semibold uppercase tracking-wide text-ink-500">
                Findings & corrective action plans
              </h3>
              {detail.findings.length === 0 ? (
                <p className="rounded-md border border-dashed border-ink-200 px-3 py-2 text-xs text-ink-400">
                  {detail.status === "reported" || detail.status === "closed"
                    ? "This audit was reported with no findings."
                    : "No findings recorded yet."}
                </p>
              ) : (
                <ul className="space-y-2">
                  {detail.findings.map((f) => {
                    const overdue = f.capBreachedAt !== null && f.closedAt === null;
                    return (
                      <li
                        key={f.id}
                        className={
                          overdue
                            ? "rounded-md bg-red-50 px-3 py-2 ring-1 ring-red-100"
                            : "rounded-md bg-white px-3 py-2 ring-1 ring-ink-100"
                        }
                      >
                        <div className="flex flex-wrap items-center gap-2 text-xs">
                          <Badge tone={severityTone(f.severity)}>{label(f.severity)}</Badge>
                          {f.indicator ? (
                            <span className="text-ink-600">{label(f.indicator)}</span>
                          ) : null}
                          {f.capDueDate ? (
                            <span className={overdue ? "font-semibold text-red-700" : "text-ink-500"}>
                              CAP due {formatDate(f.capDueDate)}
                            </span>
                          ) : (
                            <span className="text-ink-400">no CAP deadline</span>
                          )}
                          {f.capDueDate && !f.closedAt ? (
                            <CapCountdown due={f.capDueDate} />
                          ) : null}
                          {f.obligation ? (
                            <span
                              className="text-ink-500"
                              title={`Obligation ${f.obligation.id}`}
                            >
                              obligation{" "}
                              <span
                                className={
                                  f.obligation.status === "breached"
                                    ? "font-semibold text-red-700"
                                    : f.obligation.status === "satisfied"
                                      ? "font-semibold text-emerald-700"
                                      : "text-ink-700"
                                }
                              >
                                {f.obligation.status}
                              </span>
                            </span>
                          ) : null}
                          <span className="ml-auto">
                            {f.closedAt ? (
                              <Badge tone="green">Closed</Badge>
                            ) : (
                              <Button size="sm" disabled={busy} onClick={() => void closeFinding(f.id)}>
                                Close finding
                              </Button>
                            )}
                          </span>
                        </div>
                        <p className="mt-1 text-sm text-ink-800">{f.description}</p>
                        {f.closedNote ? (
                          <p className="mt-0.5 text-xs text-ink-500">Closed: {f.closedNote}</p>
                        ) : null}
                      </li>
                    );
                  })}
                </ul>
              )}
            </section>
          </div>
        )}
      </Modal>
    </div>
  );
}

/**
 * How long is left on a corrective action plan, in plain words. A CAP is a
 * promise with a date on it — a bare date makes the reader do the arithmetic,
 * and a reader doing arithmetic is a reader missing the deadline.
 */
function CapCountdown({ due }: { due: string }) {
  const days = daysUntil(due);
  const text = countdownText(due);
  if (days === null || text === null) return null;
  const tone =
    days < 0
      ? "bg-red-50 text-red-700 ring-red-100"
      : days <= 7
        ? "bg-amber-50 text-amber-800 ring-amber-100"
        : "bg-ink-100 text-ink-600 ring-ink-100";
  return (
    <span
      className={`inline-flex items-center rounded-full px-2 py-0.5 text-[11px] font-medium tabular-nums ring-1 ${tone}`}
      title={
        days < 0
          ? "The corrective action is past its deadline and the backing obligation has been breached"
          : "Time remaining before the backing obligation breaches"
      }
    >
      {text}
    </span>
  );
}
