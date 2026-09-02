/**
 * The field escalation ladder and the per-project field settings that drive
 * it — spec #308/#321/#395/#411. Surfaced on the RFI workspace because the
 * ladder is cross-register (RFIs, submittals, punch, observations and
 * missing daily logs all climb the same three rungs).
 *
 * Honesty rules: the rung counts come from `field_escalations` rows, never
 * from a guess; when the caller is not an admin the settings form is
 * read-only and says so rather than failing at save time.
 */
import { useCallback, useState, type FormEvent } from "react";
import { api } from "../../lib/api";
import {
  Alert,
  Badge,
  Button,
  Card,
  CardBody,
  CardHeader,
  EmptyState,
  ErrorAlert,
  Field,
  Input,
  Select,
  Skeleton,
  Stat,
} from "../../ui";
import { formatDateTime, humanize } from "../format";
import { DASH, daysLabel, errorMessage, useFieldResource } from "./fieldShared";

interface EscalationRow {
  id: string;
  recordType: string;
  recordId: string;
  level: number;
  daysOverdue: number;
  notifiedUserIds: string[];
  signalId: string | null;
  notifiedAt: string;
}

interface EscalationList {
  items: EscalationRow[];
  byLevel: Record<string, number>;
  job: string;
}

interface FieldSettings {
  escalation: { stepDays: number; pmUserIds: string[]; notifyResponsible: boolean };
  punch: { requireAfterPhoto: boolean; requireVerifier: boolean };
  submittal: { reviewAllowanceDays: number; atRiskDays: number; inCourtAllowanceDays: number };
  dailyLog: { distribution: string[]; weatherAuto: boolean; reconciliationThresholdPct: number };
  photos: { geofenceKm: number };
}

interface SettingsResponse {
  projectId: string;
  settings: FieldSettings;
  defaults: FieldSettings;
}

const RUNGS: Array<{ level: number; label: string; hint: string; tone: "gray" | "amber" | "red" }> = [
  { level: 1, label: "Rung 1 — responsible notified", hint: "the day the record turned overdue", tone: "gray" },
  { level: 2, label: "Rung 2 — escalated to PM", hint: "after one step interval", tone: "amber" },
  { level: 3, label: "Rung 3 — integrity signal raised", hint: "after two step intervals", tone: "red" },
];

export default function EscalationsPanel({
  projectId,
  isAdmin,
  users,
  nameOf,
}: {
  projectId: string | undefined;
  isAdmin: boolean;
  users: Array<{ id: string; name: string }>;
  nameOf: (id: string | null | undefined) => string;
}) {
  const base = projectId ? `/api/v1/projects/${projectId}/field` : null;
  const [version, setVersion] = useState(0);
  const refresh = useCallback(() => setVersion((n) => n + 1), []);
  const list = useFieldResource<EscalationList>(base ? `${base}/escalations?limit=100` : null, [version]);
  const settings = useFieldResource<SettingsResponse>(base ? `${base}/settings` : null, [version]);

  const [runBusy, setRunBusy] = useState(false);
  const [runError, setRunError] = useState<string | null>(null);
  const [runResult, setRunResult] = useState<string | null>(null);

  async function runNow() {
    if (!base) return;
    setRunBusy(true);
    setRunError(null);
    setRunResult(null);
    try {
      const res = await api.post<{ candidates: number; notified: number; escalatedToPm: number; signals: number }>(
        `${base}/escalations/run`,
      );
      setRunResult(
        `${res.candidates} overdue record(s) examined · ${res.notified} notified · ${res.escalatedToPm} escalated to PM · ${res.signals} signal(s) raised.`,
      );
      refresh();
    } catch (err) {
      setRunError(errorMessage(err));
    } finally {
      setRunBusy(false);
    }
  }

  const byLevel = list.data?.byLevel ?? {};

  return (
    <div className="space-y-4">
      <Card>
        <CardHeader
          title="Overdue escalation ladder"
          subtitle={list.data ? `Scheduler job ${list.data.job} — runs daily and can be run on demand.` : "Cross-register: RFIs, submittals, punch, observations and missing daily logs."}
          actions={
            isAdmin ? (
              <Button size="sm" disabled={runBusy} onClick={() => void runNow()}>
                {runBusy ? "Running…" : "Run the ladder now"}
              </Button>
            ) : null
          }
        />
        <CardBody>
          <ErrorAlert message={runError} />
          {runResult ? <Alert tone="success" className="mb-3">{runResult}</Alert> : null}
          {list.error ? (
            <ErrorAlert message={list.error} onRetry={list.reload} />
          ) : list.loading && !list.data ? (
            <Skeleton height={72} />
          ) : (
            <div className="grid grid-cols-1 gap-4 sm:grid-cols-3">
              {RUNGS.map((r) => (
                <Stat
                  key={r.level}
                  label={r.label}
                  value={byLevel[String(r.level)] ?? 0}
                  size="sm"
                  tone={r.level === 3 && (byLevel["3"] ?? 0) > 0 ? "danger" : "neutral"}
                  hint={r.hint}
                />
              ))}
            </div>
          )}
        </CardBody>
      </Card>

      <Card>
        <CardHeader title="Escalation log" subtitle="One row per record per rung — the ladder never repeats a rung it has already climbed." />
        <CardBody>
          {list.error ? null : list.data && list.data.items.length === 0 ? (
            <EmptyState
              title="Nothing has been escalated"
              hint="Records appear here once they pass their due date and the daily sweep notifies someone."
            />
          ) : list.data ? (
            <div className="overflow-x-auto">
              <table className="w-full text-sm">
                <thead className="text-left text-xs uppercase tracking-wide text-ink-400">
                  <tr>
                    <th className="py-1.5">When</th>
                    <th>Register</th>
                    <th>Record</th>
                    <th>Rung</th>
                    <th>Overdue</th>
                    <th>Notified</th>
                    <th>Signal</th>
                  </tr>
                </thead>
                <tbody className="divide-y divide-ink-100">
                  {list.data.items.map((row) => (
                    <tr key={row.id} className="hover:bg-ink-50/60">
                      <td className="py-2 whitespace-nowrap text-ink-600">{formatDateTime(row.notifiedAt)}</td>
                      <td>{humanize(row.recordType)}</td>
                      <td className="font-mono text-xs text-ink-500">{row.recordId}</td>
                      <td>
                        <Badge tone={RUNGS.find((r) => r.level === row.level)?.tone ?? "gray"} size="xs">
                          {row.level}
                        </Badge>
                      </td>
                      <td className="tabular-nums">{daysLabel(row.daysOverdue)}</td>
                      <td className="text-ink-600">
                        {row.notifiedUserIds.length === 0 ? DASH : row.notifiedUserIds.map((id) => nameOf(id)).join(", ")}
                      </td>
                      <td className="font-mono text-xs text-ink-500">{row.signalId ?? DASH}</td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          ) : (
            <Skeleton height={140} />
          )}
        </CardBody>
      </Card>

      <SettingsCard
        base={base}
        isAdmin={isAdmin}
        users={users}
        data={settings.data}
        loading={settings.loading}
        error={settings.error}
        onRetry={settings.reload}
        onSaved={refresh}
      />
    </div>
  );
}

function SettingsCard({
  base,
  isAdmin,
  users,
  data,
  loading,
  error,
  onRetry,
  onSaved,
}: {
  base: string | null;
  isAdmin: boolean;
  users: Array<{ id: string; name: string }>;
  data: SettingsResponse | null;
  loading: boolean;
  error: string | null;
  onRetry: () => void;
  onSaved: () => void;
}) {
  const [draft, setDraft] = useState<FieldSettings | null>(null);
  const [busy, setBusy] = useState(false);
  const [saveError, setSaveError] = useState<string | null>(null);
  const [saved, setSaved] = useState(false);
  const value = draft ?? data?.settings ?? null;

  function edit(patch: (s: FieldSettings) => FieldSettings) {
    if (!value) return;
    setSaved(false);
    setDraft(patch(structuredClone(value)));
  }

  async function save(e: FormEvent) {
    e.preventDefault();
    if (!base || !value) return;
    setBusy(true);
    setSaveError(null);
    try {
      await api.put(`${base}/settings`, value);
      setSaved(true);
      setDraft(null);
      onSaved();
    } catch (err) {
      setSaveError(errorMessage(err));
    } finally {
      setBusy(false);
    }
  }

  if (error) {
    return (
      <Card>
        <CardBody>
          <ErrorAlert message={error} onRetry={onRetry} />
        </CardBody>
      </Card>
    );
  }
  if (loading && !value) {
    return (
      <Card>
        <CardBody>
          <Skeleton height={180} />
        </CardBody>
      </Card>
    );
  }
  if (!value) return null;

  const num = (v: string, fallback: number) => (v === "" ? fallback : Number(v));

  return (
    <Card>
      <CardHeader
        title="Field settings for this project"
        subtitle={isAdmin ? "These knobs drive the ladder, the punch closure gates, submittal allowances and daily-log distribution." : "Read-only — changing these needs admin access to the RFI tool."}
      />
      <CardBody>
        <ErrorAlert message={saveError} />
        {saved ? <Alert tone="success" className="mb-3">Settings saved.</Alert> : null}
        <form onSubmit={save} className="space-y-5">
          <section>
            <h4 className="mb-2 text-xs font-semibold uppercase tracking-wide text-ink-400">Escalation ladder</h4>
            <div className="grid grid-cols-1 gap-4 sm:grid-cols-3">
              <Field label="Days between rungs">
                <Input
                  type="number"
                  min="1"
                  max="30"
                  step="1"
                  disabled={!isAdmin}
                  value={String(value.escalation.stepDays)}
                  onChange={(e) => edit((s) => ({ ...s, escalation: { ...s.escalation, stepDays: num(e.target.value, 3) } }))}
                />
              </Field>
              <Field label="Notify the responsible person at rung 1">
                <Select
                  disabled={!isAdmin}
                  value={value.escalation.notifyResponsible ? "yes" : "no"}
                  onChange={(e) => edit((s) => ({ ...s, escalation: { ...s.escalation, notifyResponsible: e.target.value === "yes" } }))}
                >
                  <option value="yes">Yes</option>
                  <option value="no">No — start at the PM rung</option>
                </Select>
              </Field>
              <Field label="Project managers" hint="Empty = members holding a PM template plus company admins.">
                <select
                  multiple
                  disabled={!isAdmin}
                  className="h-24 w-full rounded-md border border-ink-200 bg-white px-2 py-1 text-sm disabled:bg-ink-50"
                  value={value.escalation.pmUserIds}
                  onChange={(e) =>
                    edit((s) => ({ ...s, escalation: { ...s.escalation, pmUserIds: Array.from(e.target.selectedOptions).map((o) => o.value) } }))
                  }
                >
                  {users.map((u) => (
                    <option key={u.id} value={u.id}>{u.name}</option>
                  ))}
                </select>
              </Field>
            </div>
          </section>

          <section>
            <h4 className="mb-2 text-xs font-semibold uppercase tracking-wide text-ink-400">Punch closure gates</h4>
            <div className="grid grid-cols-1 gap-4 sm:grid-cols-2">
              <Field label="Require an after photo" hint="Blocks ready-for-review and closure without one (#403).">
                <Select
                  disabled={!isAdmin}
                  value={value.punch.requireAfterPhoto ? "yes" : "no"}
                  onChange={(e) => edit((s) => ({ ...s, punch: { ...s.punch, requireAfterPhoto: e.target.value === "yes" } }))}
                >
                  <option value="no">No</option>
                  <option value="yes">Yes</option>
                </Select>
              </Field>
              <Field label="Require a verifier before review" hint="Two hands on every closure (#408).">
                <Select
                  disabled={!isAdmin}
                  value={value.punch.requireVerifier ? "yes" : "no"}
                  onChange={(e) => edit((s) => ({ ...s, punch: { ...s.punch, requireVerifier: e.target.value === "yes" } }))}
                >
                  <option value="no">No</option>
                  <option value="yes">Yes</option>
                </Select>
              </Field>
            </div>
          </section>

          <section>
            <h4 className="mb-2 text-xs font-semibold uppercase tracking-wide text-ink-400">Submittal allowances</h4>
            <div className="grid grid-cols-1 gap-4 sm:grid-cols-3">
              <Field label="Review allowance (days)" hint="Backward scheduling from required-on-site (#337).">
                <Input type="number" min="0" max="120" step="1" disabled={!isAdmin} value={String(value.submittal.reviewAllowanceDays)} onChange={(e) => edit((s) => ({ ...s, submittal: { ...s.submittal, reviewAllowanceDays: num(e.target.value, 14) } }))} />
              </Field>
              <Field label="At-risk window (days)" hint="Flagged when submit-by falls inside this window (#339).">
                <Input type="number" min="1" max="60" step="1" disabled={!isAdmin} value={String(value.submittal.atRiskDays)} onChange={(e) => edit((s) => ({ ...s, submittal: { ...s.submittal, atRiskDays: num(e.target.value, 7) } }))} />
              </Field>
              <Field label="In-court allowance (days)" hint="A reviewer holding longer than this is overdue (#347).">
                <Input type="number" min="1" max="90" step="1" disabled={!isAdmin} value={String(value.submittal.inCourtAllowanceDays)} onChange={(e) => edit((s) => ({ ...s, submittal: { ...s.submittal, inCourtAllowanceDays: num(e.target.value, 10) } }))} />
              </Field>
            </div>
          </section>

          <section>
            <h4 className="mb-2 text-xs font-semibold uppercase tracking-wide text-ink-400">Daily logs & photos</h4>
            <div className="grid grid-cols-1 gap-4 sm:grid-cols-4">
              <Field label="Weather auto-capture" hint="Open-Meteo archive; needs project coordinates.">
                <Select disabled={!isAdmin} value={value.dailyLog.weatherAuto ? "yes" : "no"} onChange={(e) => edit((s) => ({ ...s, dailyLog: { ...s.dailyLog, weatherAuto: e.target.value === "yes" } }))}>
                  <option value="yes">On</option>
                  <option value="no">Off</option>
                </Select>
              </Field>
              <Field label="Reconciliation threshold (%)" hint="Manpower vs timecards variance that raises a signal.">
                <Input type="number" min="0" max="100" step="1" disabled={!isAdmin} value={String(value.dailyLog.reconciliationThresholdPct)} onChange={(e) => edit((s) => ({ ...s, dailyLog: { ...s.dailyLog, reconciliationThresholdPct: num(e.target.value, 15) } }))} />
              </Field>
              <Field label="Photo geofence (km)" hint="GPS beyond this from the project raises an integrity signal.">
                <Input type="number" min="0.1" max="500" step="0.1" disabled={!isAdmin} value={String(value.photos.geofenceKm)} onChange={(e) => edit((s) => ({ ...s, photos: { ...s.photos, geofenceKm: num(e.target.value, 5) } }))} />
              </Field>
              <Field label="Daily-log distribution" hint="Notified on submit and on approval.">
                <select
                  multiple
                  disabled={!isAdmin}
                  className="h-24 w-full rounded-md border border-ink-200 bg-white px-2 py-1 text-sm disabled:bg-ink-50"
                  value={value.dailyLog.distribution}
                  onChange={(e) => edit((s) => ({ ...s, dailyLog: { ...s.dailyLog, distribution: Array.from(e.target.selectedOptions).map((o) => o.value) } }))}
                >
                  {users.map((u) => (
                    <option key={u.id} value={u.id}>{u.name}</option>
                  ))}
                </select>
              </Field>
            </div>
          </section>

          {isAdmin ? (
            <div className="flex justify-end gap-2">
              <Button variant="secondary" disabled={busy || draft === null} onClick={() => { setDraft(null); setSaved(false); }}>
                Discard changes
              </Button>
              <Button type="submit" disabled={busy || draft === null}>{busy ? "Saving…" : "Save settings"}</Button>
            </div>
          ) : null}
        </form>
      </CardBody>
    </Card>
  );
}
