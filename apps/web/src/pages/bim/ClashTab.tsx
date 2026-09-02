/**
 * Clash tab — tests over a federation and the persistent result register
 * (spec #240).
 *
 * The register keeps a clash's identity across runs, so "12 new, 40 still
 * there, 8 gone" is a real statement about coordination progress rather than
 * a number that resets. Every run reports its own coverage: how many elements
 * carried no extents and were therefore not tested.
 */
import { useCallback, useEffect, useState, type FormEvent } from "react";
import { toast } from "sonner";
import { DRAWING_DISCIPLINES } from "@constructos/shared";
import { api, ApiClientError } from "../../lib/api";
import {
  Alert,
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
  Th,
} from "../../ui";
import { formatDateTime, humanize } from "../format";
import {
  clashStatusTone,
  type ClashResult,
  type ClashTest,
  type CompanyUser,
  type FederationGroup,
  type ListResponse,
} from "./bimShared";

interface RunSummary {
  new: number;
  persisting: number;
  autoResolved: number;
  comparedPairs: number;
  elementsLeft: number;
  elementsRight: number;
  skippedNoBounds: number;
  method: string;
  truncated: boolean;
  coverageNote: string | null;
}

export default function ClashTab({
  projectId,
  onChanged,
}: {
  projectId: string;
  onChanged: () => void;
}) {
  const [tests, setTests] = useState<ClashTest[] | null>(null);
  const [federations, setFederations] = useState<FederationGroup[]>([]);
  const [selected, setSelected] = useState<ClashTest | null>(null);
  const [results, setResults] = useState<ClashResult[] | null>(null);
  const [byStorey, setByStorey] = useState<Array<{ storey: string; count: number }>>([]);
  const [statusFilter, setStatusFilter] = useState("");
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [lastRun, setLastRun] = useState<RunSummary | null>(null);
  const [checked, setChecked] = useState<Set<string>>(new Set());
  const [users, setUsers] = useState<CompanyUser[]>([]);

  const [createOpen, setCreateOpen] = useState(false);
  const [form, setForm] = useState({
    name: "",
    federationId: "",
    leftDiscipline: "",
    rightDiscipline: "",
    toleranceMm: "10",
    clearanceMm: "0",
  });
  const [createError, setCreateError] = useState<string | null>(null);

  const [issueOpen, setIssueOpen] = useState(false);
  const [issueForm, setIssueForm] = useState({ title: "", assigneeId: "", discipline: "", dueDate: "" });

  const loadTests = useCallback(async () => {
    setError(null);
    try {
      const res = await api.get<{ items: ClashTest[] }>(
        `/api/v1/projects/${projectId}/bim/clash-tests`,
      );
      setTests(res.items);
      if (res.items.length > 0 && !selected) setSelected(res.items[0] ?? null);
    } catch (err) {
      setTests([]);
      setError(err instanceof Error ? err.message : "Failed to load clash tests");
    }
  }, [projectId, selected]);

  useEffect(() => {
    void loadTests();
  }, [loadTests]);

  useEffect(() => {
    api
      .get<{ items: FederationGroup[] }>(`/api/v1/projects/${projectId}/bim/federations`)
      .then((res) => setFederations(res.items))
      .catch(() => setFederations([]));
    api
      .get<ListResponse<CompanyUser>>("/api/v1/company/users?pageSize=200")
      .then((res) => setUsers(res.items))
      .catch(() => setUsers([]));
  }, [projectId]);

  const loadResults = useCallback(async () => {
    if (!selected) {
      setResults(null);
      return;
    }
    try {
      const params = new URLSearchParams({ pageSize: "100" });
      if (statusFilter) params.set("status", statusFilter);
      const res = await api.get<
        ListResponse<ClashResult> & { byStorey: Array<{ storey: string; count: number }> }
      >(`/api/v1/projects/${projectId}/bim/clash-tests/${selected.id}/results?${params}`);
      setResults(res.items);
      setByStorey(res.byStorey);
      setChecked(new Set());
    } catch (err) {
      setResults([]);
      setError(err instanceof Error ? err.message : "Failed to load results");
    }
  }, [projectId, selected, statusFilter]);

  useEffect(() => {
    void loadResults();
  }, [loadResults]);

  async function createTest(e: FormEvent) {
    e.preventDefault();
    setCreateError(null);
    setBusy(true);
    try {
      const payload: Record<string, unknown> = {
        name: form.name.trim(),
        toleranceMm: Number(form.toleranceMm) || 10,
        clearanceMm: Number(form.clearanceMm) || 0,
        ruleKind: form.leftDiscipline || form.rightDiscipline ? "discipline_pair" : "all_pairs",
      };
      if (form.federationId) payload["federationId"] = form.federationId;
      if (form.leftDiscipline) payload["leftFilter"] = { disciplines: [form.leftDiscipline] };
      if (form.rightDiscipline) payload["rightFilter"] = { disciplines: [form.rightDiscipline] };
      const created = await api.post<ClashTest>(
        `/api/v1/projects/${projectId}/bim/clash-tests`,
        payload,
      );
      setCreateOpen(false);
      setForm({
        name: "",
        federationId: "",
        leftDiscipline: "",
        rightDiscipline: "",
        toleranceMm: "10",
        clearanceMm: "0",
      });
      await loadTests();
      setSelected(created);
    } catch (err) {
      setCreateError(err instanceof ApiClientError ? err.message : "Failed to create the test.");
    } finally {
      setBusy(false);
    }
  }

  async function runTest(test: ClashTest) {
    setBusy(true);
    setLastRun(null);
    try {
      const res = await api.post<RunSummary>(
        `/api/v1/projects/${projectId}/bim/clash-tests/${test.id}/run`,
      );
      setLastRun(res);
      toast.success(
        `${res.new} new, ${res.persisting} still open, ${res.autoResolved} cleared since the last run.`,
      );
      await loadTests();
      await loadResults();
      onChanged();
    } catch (err) {
      toast.error(err instanceof ApiClientError ? err.message : "The run failed.");
    } finally {
      setBusy(false);
    }
  }

  async function setResultStatus(result: ClashResult, status: string) {
    setBusy(true);
    try {
      await api.patch(`/api/v1/bim/clash-results/${result.id}`, { status });
      await loadResults();
      onChanged();
    } catch (err) {
      toast.error(err instanceof ApiClientError ? err.message : "The change was refused.");
    } finally {
      setBusy(false);
    }
  }

  async function raiseIssue(e: FormEvent) {
    e.preventDefault();
    if (!selected || checked.size === 0) return;
    setBusy(true);
    try {
      const payload: Record<string, unknown> = { resultIds: [...checked] };
      if (issueForm.title.trim()) payload["title"] = issueForm.title.trim();
      if (issueForm.assigneeId) payload["assigneeId"] = issueForm.assigneeId;
      if (issueForm.discipline) payload["discipline"] = issueForm.discipline;
      if (issueForm.dueDate) payload["dueDate"] = issueForm.dueDate;
      const created = await api.post<{ number: number }>(
        `/api/v1/projects/${projectId}/bim/clash-tests/${selected.id}/raise-issue`,
        payload,
      );
      toast.success(`Coordination issue #${created.number} raised from ${checked.size} clash(es).`);
      setIssueOpen(false);
      setIssueForm({ title: "", assigneeId: "", discipline: "", dueDate: "" });
      await loadResults();
      onChanged();
    } catch (err) {
      toast.error(err instanceof ApiClientError ? err.message : "Could not raise the issue.");
    } finally {
      setBusy(false);
    }
  }

  function toggle(id: string) {
    setChecked((prev) => {
      const next = new Set(prev);
      if (next.has(id)) next.delete(id);
      else next.add(id);
      return next;
    });
  }

  return (
    <div>
      <div className="mb-3 flex flex-wrap items-center justify-between gap-2">
        <div className="flex items-center gap-2">
          <Select
            value={selected?.id ?? ""}
            onChange={(e) => setSelected(tests?.find((t) => t.id === e.target.value) ?? null)}
            className="max-w-xs"
          >
            <option value="">Select a clash test…</option>
            {(tests ?? []).map((t) => (
              <option key={t.id} value={t.id}>
                {t.name}
              </option>
            ))}
          </Select>
          {selected ? (
            <Button disabled={busy} onClick={() => void runTest(selected)}>
              {busy ? "Running…" : "Run test"}
            </Button>
          ) : null}
        </div>
        <Button variant="secondary" onClick={() => setCreateOpen(true)}>
          New clash test
        </Button>
      </div>

      <ErrorAlert message={error} />

      {tests === null ? (
        <Spinner label="Loading clash tests…" />
      ) : tests.length === 0 ? (
        <EmptyState
          title="No clash tests"
          hint="Create a federation of the discipline models that must be coordinated, then run a test over it. Elements are compared by their bounding boxes; anything without extents is reported as untested rather than passed."
          action={<Button onClick={() => setCreateOpen(true)}>Create a clash test</Button>}
        />
      ) : (
        <>
          {selected ? (
            <Card className="mb-3">
              <CardBody>
                <div className="flex flex-wrap items-center justify-between gap-3">
                  <div>
                    <h3 className="text-sm font-semibold text-ink-900">{selected.name}</h3>
                    <p className="text-xs text-ink-500">
                      {selected.toleranceMm} mm tolerance
                      {selected.clearanceMm > 0 ? ` · ${selected.clearanceMm} mm clearance` : ""} ·{" "}
                      {selected.lastRunAt
                        ? `last run ${formatDateTime(selected.lastRunAt)}`
                        : "never run"}
                    </p>
                  </div>
                  <div className="flex flex-wrap gap-2 text-xs">
                    {Object.entries(selected.counts ?? {}).map(([status, n]) => (
                      <Badge key={status} tone={clashStatusTone(status)} size="sm">
                        {n} {status}
                      </Badge>
                    ))}
                  </div>
                </div>
                {selected.lastError ? (
                  <Alert tone="danger" className="mt-2">
                    {selected.lastError}
                  </Alert>
                ) : null}
                {lastRun ? (
                  <p className="mt-2 text-xs text-ink-500">
                    Compared {lastRun.comparedPairs.toLocaleString()} candidate pairs across{" "}
                    {lastRun.elementsLeft.toLocaleString()} / {lastRun.elementsRight.toLocaleString()}{" "}
                    elements using the {humanize(lastRun.method)} method.
                    {lastRun.coverageNote ? ` ${lastRun.coverageNote}.` : ""}
                    {lastRun.truncated ? " The result cap was reached — refine the filters." : ""}
                  </p>
                ) : null}
                {byStorey.length > 0 ? (
                  <p className="mt-1 text-xs text-ink-500">
                    Open by storey:{" "}
                    {byStorey.map((s) => `${s.storey} (${s.count})`).join(" · ")}
                  </p>
                ) : null}
              </CardBody>
            </Card>
          ) : null}

          <div className="mb-2 flex items-center justify-between gap-2">
            <Select
              value={statusFilter}
              onChange={(e) => setStatusFilter(e.target.value)}
              className="max-w-[180px]"
            >
              <option value="">All statuses</option>
              <option value="new">New</option>
              <option value="active">Active</option>
              <option value="resolved">Resolved</option>
              <option value="approved">Approved</option>
              <option value="ignored">Ignored</option>
            </Select>
            <Button
              size="sm"
              disabled={checked.size === 0}
              onClick={() => setIssueOpen(true)}
            >
              Raise issue from {checked.size} selected
            </Button>
          </div>

          {results === null ? (
            <Spinner label="Loading results…" />
          ) : results.length === 0 ? (
            <EmptyState
              title="No clashes in this view"
              hint="Run the test, or clear the status filter."
            />
          ) : (
            <Table>
              <thead>
                <tr>
                  <Th className="w-8" />
                  <Th>Element A</Th>
                  <Th>Element B</Th>
                  <Th>Kind</Th>
                  <Th className="text-right">Penetration</Th>
                  <Th>Storey</Th>
                  <Th>Status</Th>
                  <Th className="text-right">Actions</Th>
                </tr>
              </thead>
              <tbody className="divide-y divide-ink-100">
                {results.map((r) => (
                  <tr key={r.id} className="hover:bg-ink-50/60">
                    <Td>
                      <input
                        type="checkbox"
                        checked={checked.has(r.id)}
                        onChange={() => toggle(r.id)}
                        disabled={!!r.issueId}
                        aria-label={`Select clash ${r.fingerprint}`}
                      />
                    </Td>
                    <Td>
                      <div className="text-sm text-ink-800">{r.nameA ?? r.globalIdA}</div>
                      <div className="text-[11px] text-ink-400">
                        {r.ifcTypeA} · {r.disciplineA ? humanize(r.disciplineA) : "—"}
                      </div>
                    </Td>
                    <Td>
                      <div className="text-sm text-ink-800">{r.nameB ?? r.globalIdB}</div>
                      <div className="text-[11px] text-ink-400">
                        {r.ifcTypeB} · {r.disciplineB ? humanize(r.disciplineB) : "—"}
                      </div>
                    </Td>
                    <Td>
                      <Badge size="sm" tone={r.kind === "hard" ? "danger" : r.kind === "duplicate" ? "warning" : "info"}>
                        {r.kind}
                      </Badge>
                    </Td>
                    <Td className="text-right tabular-nums">
                      {r.penetrationMm !== null
                        ? `${Math.round(r.penetrationMm)} mm`
                        : r.distanceMm !== null
                          ? `${Math.round(r.distanceMm)} mm gap`
                          : "—"}
                    </Td>
                    <Td>{r.storey ?? "—"}</Td>
                    <Td>
                      <Badge tone={clashStatusTone(r.status)} size="sm">
                        {r.status}
                      </Badge>
                      {r.issueId ? (
                        <div className="text-[11px] text-ink-400">on an issue</div>
                      ) : null}
                    </Td>
                    <Td className="text-right">
                      <div className="flex justify-end gap-1">
                        <Button
                          size="sm"
                          variant="ghost"
                          disabled={busy}
                          onClick={() => void setResultStatus(r, "approved")}
                        >
                          Approve
                        </Button>
                        <Button
                          size="sm"
                          variant="ghost"
                          disabled={busy}
                          onClick={() => void setResultStatus(r, "ignored")}
                        >
                          Ignore
                        </Button>
                      </div>
                    </Td>
                  </tr>
                ))}
              </tbody>
            </Table>
          )}
        </>
      )}

      {/* ------------------------------ create ------------------------------ */}
      <Modal open={createOpen} onClose={() => setCreateOpen(false)} title="New clash test">
        <form onSubmit={createTest} className="space-y-3">
          <ErrorAlert message={createError} />
          <Field label="Name">
            <Input
              value={form.name}
              onChange={(e) => setForm({ ...form, name: e.target.value })}
              required
              placeholder="Structure vs mechanical"
            />
          </Field>
          <Field
            label="Federation"
            hint="Without a federation the test runs over every model's current version."
          >
            <Select
              value={form.federationId}
              onChange={(e) => setForm({ ...form, federationId: e.target.value })}
            >
              <option value="">Every current version</option>
              {federations.map((f) => (
                <option key={f.id} value={f.id}>
                  {f.name} ({f.members.length} members)
                </option>
              ))}
            </Select>
          </Field>
          <div className="grid grid-cols-2 gap-3">
            <Field label="Left discipline">
              <Select
                value={form.leftDiscipline}
                onChange={(e) => setForm({ ...form, leftDiscipline: e.target.value })}
              >
                <option value="">Any</option>
                {DRAWING_DISCIPLINES.map((d) => (
                  <option key={d} value={d}>
                    {humanize(d)}
                  </option>
                ))}
              </Select>
            </Field>
            <Field label="Right discipline">
              <Select
                value={form.rightDiscipline}
                onChange={(e) => setForm({ ...form, rightDiscipline: e.target.value })}
              >
                <option value="">Any</option>
                {DRAWING_DISCIPLINES.map((d) => (
                  <option key={d} value={d}>
                    {humanize(d)}
                  </option>
                ))}
              </Select>
            </Field>
          </div>
          <div className="grid grid-cols-2 gap-3">
            <Field label="Tolerance (mm)" hint="Overlaps smaller than this are ignored.">
              <Input
                type="number"
                min={0}
                value={form.toleranceMm}
                onChange={(e) => setForm({ ...form, toleranceMm: e.target.value })}
              />
            </Field>
            <Field label="Clearance (mm)" hint="0 disables clearance checking.">
              <Input
                type="number"
                min={0}
                value={form.clearanceMm}
                onChange={(e) => setForm({ ...form, clearanceMm: e.target.value })}
              />
            </Field>
          </div>
          <div className="flex justify-end gap-2">
            <Button type="button" variant="secondary" onClick={() => setCreateOpen(false)}>
              Cancel
            </Button>
            <Button type="submit" disabled={busy}>
              Create
            </Button>
          </div>
        </form>
      </Modal>

      {/* ---------------------------- raise issue --------------------------- */}
      <Modal
        open={issueOpen}
        onClose={() => setIssueOpen(false)}
        title={`Raise a coordination issue from ${checked.size} clash(es)`}
      >
        <form onSubmit={raiseIssue} className="space-y-3">
          <p className="text-xs text-ink-500">
            The issue carries every involved GlobalId and a viewpoint aimed at the clash centroid,
            so the viewer can restore the view.
          </p>
          <Field label="Title" hint="Defaults to a description of the selected clashes.">
            <Input
              value={issueForm.title}
              onChange={(e) => setIssueForm({ ...issueForm, title: e.target.value })}
            />
          </Field>
          <div className="grid grid-cols-2 gap-3">
            <Field label="Assignee">
              <Select
                value={issueForm.assigneeId}
                onChange={(e) => setIssueForm({ ...issueForm, assigneeId: e.target.value })}
              >
                <option value="">Unassigned</option>
                {users.map((u) => (
                  <option key={u.id} value={u.id}>
                    {u.name}
                  </option>
                ))}
              </Select>
            </Field>
            <Field label="Due date">
              <Input
                type="date"
                value={issueForm.dueDate}
                onChange={(e) => setIssueForm({ ...issueForm, dueDate: e.target.value })}
              />
            </Field>
          </div>
          <Field label="Discipline">
            <Select
              value={issueForm.discipline}
              onChange={(e) => setIssueForm({ ...issueForm, discipline: e.target.value })}
            >
              <option value="">—</option>
              {DRAWING_DISCIPLINES.map((d) => (
                <option key={d} value={d}>
                  {humanize(d)}
                </option>
              ))}
            </Select>
          </Field>
          <div className="flex justify-end gap-2">
            <Button type="button" variant="secondary" onClick={() => setIssueOpen(false)}>
              Cancel
            </Button>
            <Button type="submit" disabled={busy}>
              Raise issue
            </Button>
          </div>
        </form>
      </Modal>
    </div>
  );
}
