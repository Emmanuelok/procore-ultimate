/**
 * Registers tab — the two REFERENCE registers the detector programme reads.
 *
 * Both of these existed only as API routes, which meant two shipped detectors
 * could never get their data:
 *
 *   • `authority_limit_breach` (Domain A #41) skips itself with "no
 *     delegation-of-authority limits are recorded", and nothing could record
 *     one, so the detector never fired at all;
 *   • `undeclared_conflict` (Domain A #42-52) reads the conflict register, and
 *     with an empty register every approver→vendor path is reported as
 *     undeclared forever, with no way for anyone to declare an interest and
 *     clear it — a false-positive generator rather than a detector.
 *
 * So this is not decoration: it is the input side of two controls. Ending a
 * declaration or deleting a limit is never a hard delete of history — a
 * declaration that was in force while the approvals were made keeps its
 * `declaredAt`/`endedAt` window on the record.
 */
import { useCallback, useEffect, useMemo, useState, type FormEvent } from "react";
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
import { formatDateTime } from "../format";
import { type EntityRow, type ListResponse } from "./assuranceShared";

interface ConflictDeclarationRow {
  id: string;
  userId: string;
  entityId: string;
  nature: string;
  declaredAt: string;
  endedAt: string | null;
  notes: string | null;
  recordedBy: string;
}

interface AuthorityLimitRow {
  id: string;
  projectId: string | null;
  userId: string;
  objectType: string;
  maxAmount: number;
  currency: string;
  effectiveFrom: string | null;
  effectiveTo: string | null;
  grantedBy: string;
  notes: string | null;
  createdAt: string;
}

interface CompanyUser {
  id: string;
  name: string;
  email: string;
}

interface ProjectLite {
  id: string;
  name: string;
}

const LIMIT_OBJECT_TYPES = [
  "any",
  "commitment",
  "invoice",
  "change_order",
  "payment",
  "purchase_order",
] as const;

export default function RegistersTab() {
  const [users, setUsers] = useState<CompanyUser[]>([]);
  const [entities, setEntities] = useState<EntityRow[]>([]);
  const [projects, setProjects] = useState<ProjectLite[]>([]);

  const [declarations, setDeclarations] = useState<ConflictDeclarationRow[] | null>(null);
  const [declError, setDeclError] = useState<string | null>(null);
  const [declOpen, setDeclOpen] = useState(false);
  const [declBusy, setDeclBusy] = useState(false);
  const [declFormError, setDeclFormError] = useState<string | null>(null);
  const [declForm, setDeclForm] = useState({ userId: "", entityId: "", nature: "", notes: "" });

  const [limits, setLimits] = useState<AuthorityLimitRow[] | null>(null);
  const [limitError, setLimitError] = useState<string | null>(null);
  const [limitOpen, setLimitOpen] = useState(false);
  const [limitBusy, setLimitBusy] = useState(false);
  const [limitFormError, setLimitFormError] = useState<string | null>(null);
  const [limitForm, setLimitForm] = useState({
    userId: "",
    projectId: "",
    objectType: "any",
    maxAmount: "",
    currency: "USD",
    effectiveFrom: "",
    effectiveTo: "",
    notes: "",
  });

  const loadDeclarations = useCallback(async () => {
    setDeclError(null);
    try {
      const res = await api.get<ListResponse<ConflictDeclarationRow>>(
        "/api/v1/conflict-declarations?pageSize=200",
      );
      setDeclarations(res.items);
    } catch (err) {
      setDeclarations([]);
      setDeclError(err instanceof Error ? err.message : "Failed to load the conflict register");
    }
  }, []);

  const loadLimits = useCallback(async () => {
    setLimitError(null);
    try {
      const res = await api.get<ListResponse<AuthorityLimitRow>>(
        "/api/v1/authority-limits?pageSize=200",
      );
      setLimits(res.items);
    } catch (err) {
      setLimits([]);
      setLimitError(
        err instanceof ApiClientError && err.status === 403
          ? "Reading the delegation-of-authority register needs an assurance grant, or company owner/admin."
          : err instanceof Error
            ? err.message
            : "Failed to load authority limits",
      );
    }
  }, []);

  useEffect(() => {
    void loadDeclarations();
    void loadLimits();
    api
      .get<ListResponse<CompanyUser>>("/api/v1/company/users?page=1&pageSize=200")
      .then((r) => setUsers(r.items))
      .catch(() => {
        /* names are a courtesy; ids still render and the id field still works */
      });
    api
      .get<ListResponse<EntityRow>>("/api/v1/entities?pageSize=200")
      .then((r) => setEntities(r.items))
      .catch(() => {
        /* the entity picker degrades to "no entities registered" */
      });
    api
      .get<ListResponse<ProjectLite>>("/api/v1/projects?pageSize=200")
      .then((r) => setProjects(r.items))
      .catch(() => {
        /* a limit with no project applies everywhere, which is the default */
      });
  }, [loadDeclarations, loadLimits]);

  const userName = useMemo(() => {
    const m = new Map(users.map((u) => [u.id, u.name || u.email]));
    return (id: string) => m.get(id) ?? id;
  }, [users]);
  const entityName = useMemo(() => {
    const m = new Map(entities.map((e) => [e.id, e.name]));
    return (id: string) => m.get(id) ?? id;
  }, [entities]);
  const projectName = useMemo(() => {
    const m = new Map(projects.map((p) => [p.id, p.name]));
    return (id: string | null) => (id === null ? "every project" : (m.get(id) ?? id));
  }, [projects]);

  async function onDeclare(e: FormEvent) {
    e.preventDefault();
    setDeclBusy(true);
    setDeclFormError(null);
    try {
      const payload: Record<string, unknown> = {
        entityId: declForm.entityId,
        nature: declForm.nature.trim(),
      };
      if (declForm.userId) payload["userId"] = declForm.userId;
      if (declForm.notes.trim()) payload["notes"] = declForm.notes.trim();
      await api.post("/api/v1/conflict-declarations", payload);
      setDeclOpen(false);
      setDeclForm({ userId: "", entityId: "", nature: "", notes: "" });
      await loadDeclarations();
    } catch (err) {
      setDeclFormError(
        err instanceof ApiClientError && err.status === 403
          ? "You may declare your OWN interest; declaring one on someone else's behalf is an administrative act needing owner/admin or an assurance grant."
          : err instanceof Error
            ? err.message
            : "Failed to record the declaration",
      );
    } finally {
      setDeclBusy(false);
    }
  }

  async function endDeclaration(id: string) {
    setDeclError(null);
    try {
      await api.del(`/api/v1/conflict-declarations/${id}`);
      await loadDeclarations();
    } catch (err) {
      setDeclError(err instanceof Error ? err.message : "Failed to end the declaration");
    }
  }

  async function onCreateLimit(e: FormEvent) {
    e.preventDefault();
    setLimitBusy(true);
    setLimitFormError(null);
    try {
      const amount = Number(limitForm.maxAmount);
      if (!Number.isFinite(amount) || amount < 0) throw new Error("Enter a limit amount");
      const payload: Record<string, unknown> = {
        userId: limitForm.userId,
        objectType: limitForm.objectType,
        maxAmount: amount,
        currency: limitForm.currency.trim().toUpperCase() || "USD",
      };
      if (limitForm.projectId) payload["projectId"] = limitForm.projectId;
      if (limitForm.effectiveFrom) payload["effectiveFrom"] = limitForm.effectiveFrom;
      if (limitForm.effectiveTo) payload["effectiveTo"] = limitForm.effectiveTo;
      if (limitForm.notes.trim()) payload["notes"] = limitForm.notes.trim();
      await api.post("/api/v1/authority-limits", payload);
      setLimitOpen(false);
      setLimitForm({
        userId: "",
        projectId: "",
        objectType: "any",
        maxAmount: "",
        currency: "USD",
        effectiveFrom: "",
        effectiveTo: "",
        notes: "",
      });
      await loadLimits();
    } catch (err) {
      setLimitFormError(
        err instanceof ApiClientError && err.status === 403
          ? "Recording a delegation-of-authority limit is a company owner/admin act."
          : err instanceof Error
            ? err.message
            : "Failed to record the limit",
      );
    } finally {
      setLimitBusy(false);
    }
  }

  async function deleteLimit(id: string) {
    setLimitError(null);
    try {
      await api.del(`/api/v1/authority-limits/${id}`);
      await loadLimits();
    } catch (err) {
      setLimitError(err instanceof Error ? err.message : "Failed to delete the limit");
    }
  }

  return (
    <div className="space-y-6">
      {/* ---------------------- Conflicts of interest ---------------------- */}
      <Card>
        <CardBody>
          <div className="mb-3 flex flex-wrap items-start justify-between gap-3">
            <div>
              <h2 className="text-base font-semibold text-ink-900">Conflicts of interest</h2>
              <p className="mt-0.5 max-w-3xl text-xs text-ink-500">
                Who is connected to which counterparty, and how. The{" "}
                <span className="font-mono">undeclared_conflict</span> detector walks the entity
                graph from approvers to the vendors they approved and reports every path that is
                NOT in this register — so an empty register means every path reads as undeclared.
                Declaring an interest here is what clears it.
              </p>
            </div>
            <Button onClick={() => setDeclOpen(true)}>Declare an interest</Button>
          </div>

          <ErrorAlert message={declError} />

          {declarations === null ? (
            <Spinner />
          ) : declarations.length === 0 ? (
            <EmptyState
              title="Nothing declared"
              hint="Until an interest is declared here, any approver→vendor relationship the graph finds is reported as undeclared."
              action={<Button onClick={() => setDeclOpen(true)}>Declare the first interest</Button>}
            />
          ) : (
            <Table>
              <thead>
                <tr>
                  <Th>Person</Th>
                  <Th>Counterparty</Th>
                  <Th>Nature</Th>
                  <Th>Declared</Th>
                  <Th>Status</Th>
                  <Th />
                </tr>
              </thead>
              <tbody className="divide-y divide-ink-100">
                {declarations.map((d) => (
                  <tr key={d.id} className={d.endedAt ? "opacity-60" : undefined}>
                    <Td className="text-sm font-medium text-ink-900">{userName(d.userId)}</Td>
                    <Td className="text-sm">{entityName(d.entityId)}</Td>
                    <Td className="max-w-md text-sm text-ink-700">{d.nature}</Td>
                    <Td className="whitespace-nowrap text-xs text-ink-500">
                      {formatDateTime(d.declaredAt)}
                    </Td>
                    <Td>
                      {d.endedAt ? (
                        <Badge tone="gray">ended {formatDateTime(d.endedAt)}</Badge>
                      ) : (
                        <Badge tone="green">current</Badge>
                      )}
                    </Td>
                    <Td className="whitespace-nowrap">
                      {d.endedAt ? null : (
                        <button
                          type="button"
                          className="text-xs text-brand-700 underline"
                          onClick={() => void endDeclaration(d.id)}
                        >
                          End
                        </button>
                      )}
                    </Td>
                  </tr>
                ))}
              </tbody>
            </Table>
          )}
          <p className="mt-2 text-xs text-ink-400">
            Ending a declaration never removes it: the window it was in force for is exactly what an
            investigator needs when asking whether an approval was covered at the time.
          </p>
        </CardBody>
      </Card>

      {/* ---------------------- Authority limits ---------------------- */}
      <Card>
        <CardBody>
          <div className="mb-3 flex flex-wrap items-start justify-between gap-3">
            <div>
              <h2 className="text-base font-semibold text-ink-900">Delegation of authority</h2>
              <p className="mt-0.5 max-w-3xl text-xs text-ink-500">
                The amount each approver may commit, per object type and optionally per project. The{" "}
                <span className="font-mono">authority_limit_breach</span> detector (Domain A #41)
                compares approved amounts against these rows and skips itself entirely while the
                register is empty — an unrecorded limit cannot be breached.
              </p>
            </div>
            <Button onClick={() => setLimitOpen(true)}>Record a limit</Button>
          </div>

          <ErrorAlert message={limitError} />

          {limits === null ? (
            <Spinner />
          ) : limits.length === 0 ? (
            <EmptyState
              title="No delegation-of-authority limits recorded"
              hint="The authority_limit_breach detector reports itself as skipped until at least one limit exists."
              action={<Button onClick={() => setLimitOpen(true)}>Record the first limit</Button>}
            />
          ) : (
            <Table>
              <thead>
                <tr>
                  <Th>Approver</Th>
                  <Th>Applies to</Th>
                  <Th>Scope</Th>
                  <Th className="text-right">Limit</Th>
                  <Th>Effective</Th>
                  <Th />
                </tr>
              </thead>
              <tbody className="divide-y divide-ink-100">
                {limits.map((l) => (
                  <tr key={l.id}>
                    <Td className="text-sm font-medium text-ink-900">{userName(l.userId)}</Td>
                    <Td className="text-xs">
                      <Badge tone="blue">{l.objectType}</Badge>
                    </Td>
                    <Td className="text-xs text-ink-600">{projectName(l.projectId)}</Td>
                    <Td className="whitespace-nowrap text-right text-sm tabular-nums">
                      {l.maxAmount.toLocaleString()} {l.currency}
                    </Td>
                    <Td className="whitespace-nowrap text-xs text-ink-500">
                      {l.effectiveFrom ?? "—"} → {l.effectiveTo ?? "open"}
                    </Td>
                    <Td className="whitespace-nowrap">
                      <button
                        type="button"
                        className="text-xs text-brand-700 underline"
                        onClick={() => void deleteLimit(l.id)}
                      >
                        Delete
                      </button>
                    </Td>
                  </tr>
                ))}
              </tbody>
            </Table>
          )}
        </CardBody>
      </Card>

      {/* ---------------------- Modals ---------------------- */}
      <Modal open={declOpen} title="Declare an interest" onClose={() => setDeclOpen(false)}>
        <ErrorAlert message={declFormError} />
        <form onSubmit={onDeclare} className="space-y-4">
          <Field
            label="Person"
            hint="Leave blank to declare your own interest. Declaring for someone else needs owner/admin or an assurance grant."
          >
            <Select
              value={declForm.userId}
              onChange={(e) => setDeclForm((f) => ({ ...f, userId: e.target.value }))}
            >
              <option value="">Myself</option>
              {users.map((u) => (
                <option key={u.id} value={u.id}>
                  {u.name || u.email}
                </option>
              ))}
            </Select>
          </Field>
          <Field label="Counterparty">
            <Select
              required
              value={declForm.entityId}
              onChange={(e) => setDeclForm((f) => ({ ...f, entityId: e.target.value }))}
            >
              <option value="">Choose a registered entity…</option>
              {entities.map((en) => (
                <option key={en.id} value={en.id}>
                  {en.name}
                </option>
              ))}
            </Select>
          </Field>
          <Field label="Nature of the interest">
            <Input
              required
              value={declForm.nature}
              onChange={(e) => setDeclForm((f) => ({ ...f, nature: e.target.value }))}
              placeholder="Director · shareholder · former employer · family member"
            />
          </Field>
          <Field label="Notes">
            <Textarea
              rows={3}
              value={declForm.notes}
              onChange={(e) => setDeclForm((f) => ({ ...f, notes: e.target.value }))}
              placeholder="Anything a reviewer would need to judge whether the interest was managed."
            />
          </Field>
          <div className="flex justify-end gap-2">
            <Button variant="secondary" onClick={() => setDeclOpen(false)}>
              Cancel
            </Button>
            <Button type="submit" disabled={declBusy || !declForm.entityId}>
              {declBusy ? "Recording…" : "Record declaration"}
            </Button>
          </div>
        </form>
      </Modal>

      <Modal
        open={limitOpen}
        title="Record a delegation-of-authority limit"
        onClose={() => setLimitOpen(false)}
      >
        <ErrorAlert message={limitFormError} />
        <form onSubmit={onCreateLimit} className="space-y-4">
          <Field label="Approver">
            <Select
              required
              value={limitForm.userId}
              onChange={(e) => setLimitForm((f) => ({ ...f, userId: e.target.value }))}
            >
              <option value="">Choose a user…</option>
              {users.map((u) => (
                <option key={u.id} value={u.id}>
                  {u.name || u.email}
                </option>
              ))}
            </Select>
          </Field>
          <div className="grid grid-cols-1 gap-4 sm:grid-cols-2">
            <Field label="Applies to">
              <Select
                value={limitForm.objectType}
                onChange={(e) => setLimitForm((f) => ({ ...f, objectType: e.target.value }))}
              >
                {LIMIT_OBJECT_TYPES.map((t) => (
                  <option key={t} value={t}>
                    {t}
                  </option>
                ))}
              </Select>
            </Field>
            <Field label="Project" hint="Blank = applies on every project.">
              <Select
                value={limitForm.projectId}
                onChange={(e) => setLimitForm((f) => ({ ...f, projectId: e.target.value }))}
              >
                <option value="">Every project</option>
                {projects.map((p) => (
                  <option key={p.id} value={p.id}>
                    {p.name}
                  </option>
                ))}
              </Select>
            </Field>
          </div>
          <div className="grid grid-cols-1 gap-4 sm:grid-cols-2">
            <Field label="Maximum amount">
              <Input
                required
                type="number"
                min="0"
                step="any"
                value={limitForm.maxAmount}
                onChange={(e) => setLimitForm((f) => ({ ...f, maxAmount: e.target.value }))}
                placeholder="50000"
              />
            </Field>
            <Field label="Currency" hint="Limits are never compared across currencies.">
              <Input
                value={limitForm.currency}
                maxLength={3}
                onChange={(e) => setLimitForm((f) => ({ ...f, currency: e.target.value }))}
                placeholder="USD"
              />
            </Field>
          </div>
          <div className="grid grid-cols-1 gap-4 sm:grid-cols-2">
            <Field label="Effective from">
              <Input
                type="date"
                value={limitForm.effectiveFrom}
                onChange={(e) => setLimitForm((f) => ({ ...f, effectiveFrom: e.target.value }))}
              />
            </Field>
            <Field label="Effective to">
              <Input
                type="date"
                value={limitForm.effectiveTo}
                onChange={(e) => setLimitForm((f) => ({ ...f, effectiveTo: e.target.value }))}
              />
            </Field>
          </div>
          <Field label="Notes">
            <Textarea
              rows={2}
              value={limitForm.notes}
              onChange={(e) => setLimitForm((f) => ({ ...f, notes: e.target.value }))}
              placeholder="Board minute reference, scheme of delegation clause…"
            />
          </Field>
          <div className="flex justify-end gap-2">
            <Button variant="secondary" onClick={() => setLimitOpen(false)}>
              Cancel
            </Button>
            <Button type="submit" disabled={limitBusy || !limitForm.userId}>
              {limitBusy ? "Recording…" : "Record limit"}
            </Button>
          </div>
        </form>
      </Modal>
    </div>
  );
}
