/**
 * Sheet-level segregation (#265, #282). A scope with any rule is restricted
 * to the subjects listed for it; company and drawings admins always see
 * everything. Non-admins see an honest refusal here, not an empty list.
 */
import { useMemo, useState } from "react";
import { Alert, Badge, Button, Card, CardBody, DataTable, EmptyState, Field, Select, useConfirm, type DataColumns } from "../../ui";
import { IconLock } from "../../ui/icons";
import { api, ApiClientError } from "../../lib/api";
import { useResource } from "../../layouts/project/lib";
import { humanize, formatDateTime } from "../format";
import { DISCIPLINES, PERMISSION_TEMPLATES, type CompanyUser, type PermissionRule, type PermissionsResponse } from "./drawingsShared";
import type { ListResponse, SheetListItem } from "./types";

export default function AccessTab({ projectId, version, onChanged }: { projectId: string; version: number; onChanged: () => void }) {
  const rules = useResource<PermissionsResponse>(`/api/v1/projects/${projectId}/drawing-permissions?_v=${version}`);
  const users = useResource<ListResponse<CompanyUser>>("/api/v1/company/users?pageSize=200");
  const sheets = useResource<ListResponse<SheetListItem>>(`/api/v1/projects/${projectId}/sheets?pageSize=500&_v=${version}`);
  const [scope, setScope] = useState<"discipline" | "area" | "sheet">("discipline");
  const [scopeValue, setScopeValue] = useState("");
  const [subjectType, setSubjectType] = useState<"user" | "template">("user");
  const [subjectId, setSubjectId] = useState("");
  const [level, setLevel] = useState<"read" | "standard">("read");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const { confirm, dialog } = useConfirm();

  async function create() {
    setBusy(true);
    setError(null);
    try {
      await api.post(`/api/v1/projects/${projectId}/drawing-permissions`, { scope, scopeValue, subjectType, subjectId, level });
      setScopeValue("");
      setSubjectId("");
      rules.reload();
      onChanged();
    } catch (err) {
      setError(err instanceof ApiClientError ? err.message : "Could not create the rule");
    } finally {
      setBusy(false);
    }
  }

  async function remove(rule: PermissionRule) {
    const ok = await confirm({ title: "Remove this rule?", description: "If it was the last rule on its scope, that scope becomes visible to everyone with drawings access again.", confirmLabel: "Remove", tone: "danger" });
    if (!ok) return;
    try {
      await api.del(`/api/v1/projects/${projectId}/drawing-permissions/${rule.id}`);
      rules.reload();
      onChanged();
    } catch (err) {
      setError(err instanceof ApiClientError ? err.message : "Could not remove the rule");
    }
  }

  const columns = useMemo<DataColumns<PermissionRule>>(
    () => [
      { id: "scope", header: "Scope", accessor: "scope", type: "status", width: 110, groupable: true, cell: ({ row }) => humanize(row.scope) },
      { id: "value", header: "Restricted to", accessor: "scopeLabel", type: "text", width: 180, cell: ({ row }) => <span className={row.scope === "sheet" ? "font-mono" : ""}>{row.scope === "discipline" ? humanize(row.scopeLabel) : row.scopeLabel}</span> },
      { id: "subjectType", header: "Subject", accessor: "subjectType", type: "status", width: 100, cell: ({ row }) => humanize(row.subjectType) },
      { id: "subject", header: "Who", accessor: (r) => r.subjectName ?? r.subjectId, type: "text", width: 220, cell: ({ row }) => (row.subjectType === "template" ? humanize(row.subjectId) : (row.subjectName ?? row.subjectId)) },
      { id: "level", header: "Level", accessor: "level", type: "status", width: 100, cell: ({ row }) => <Badge tone={row.level === "standard" ? "info" : "neutral"} size="xs">{row.level}</Badge> },
      { id: "created", header: "Since", accessor: "createdAt", type: "text", width: 150, cell: ({ row }) => formatDateTime(row.createdAt) },
    ],
    [],
  );

  const forbidden = rules.error && /admin|forbidden|403/i.test(rules.error);
  const areas = rules.data?.areas ?? [];

  return (
    <div className="space-y-4">
      {dialog}
      {forbidden ? (
        <EmptyState icon={IconLock} title="Segregation rules are managed by drawings admins" hint={rules.error ?? undefined} />
      ) : (
        <>
          <Card>
            <CardBody>
              <div className="grid gap-3 md:grid-cols-5">
                <Field label="Scope">
                  <Select value={scope} onChange={(e) => { setScope(e.target.value as typeof scope); setScopeValue(""); }}>
                    <option value="discipline">Discipline</option>
                    <option value="area">Area</option>
                    <option value="sheet">Single sheet</option>
                  </Select>
                </Field>
                <Field label={scope === "discipline" ? "Discipline" : scope === "area" ? "Area" : "Sheet"}>
                  <Select value={scopeValue} onChange={(e) => setScopeValue(e.target.value)}>
                    <option value="">Choose…</option>
                    {scope === "discipline" ? DISCIPLINES.map((d) => <option key={d} value={d}>{humanize(d)}</option>) : scope === "area" ? areas.map((a) => <option key={a} value={a}>{a}</option>) : (sheets.data?.items ?? []).map((s) => <option key={s.id} value={s.id}>{s.number} — {s.title}</option>)}
                  </Select>
                </Field>
                <Field label="Subject">
                  <Select value={subjectType} onChange={(e) => { setSubjectType(e.target.value as typeof subjectType); setSubjectId(""); }}>
                    <option value="user">A person</option>
                    <option value="template">Everyone on a template</option>
                  </Select>
                </Field>
                <Field label={subjectType === "user" ? "Person" : "Template"}>
                  <Select value={subjectId} onChange={(e) => setSubjectId(e.target.value)}>
                    <option value="">Choose…</option>
                    {subjectType === "user" ? (users.data?.items ?? []).map((u) => <option key={u.id} value={u.id}>{u.name}</option>) : PERMISSION_TEMPLATES.map((t) => <option key={t} value={t}>{humanize(t)}</option>)}
                  </Select>
                </Field>
                <Field label="Level" hint="standard lets a reader mark up and pin within the scope">
                  <div className="flex items-end gap-2">
                    <Select value={level} onChange={(e) => setLevel(e.target.value as typeof level)}>
                      <option value="read">read</option>
                      <option value="standard">standard</option>
                    </Select>
                    <Button onClick={() => void create()} disabled={!scopeValue || !subjectId || busy} loading={busy}>Add</Button>
                  </div>
                </Field>
              </div>
              {scope === "area" && areas.length === 0 ? <p className="mt-2 text-xs text-ink-400">No sheet on this project carries an area yet — set one on upload or in the review queue.</p> : null}
            </CardBody>
          </Card>
          {error ? <Alert tone="danger" title="Refused" onDismiss={() => setError(null)}>{error}</Alert> : null}
          {rules.error && !forbidden ? <Alert tone="danger">{rules.error}</Alert> : null}
          {!rules.loading && (rules.data?.items ?? []).length === 0 ? (
            <EmptyState icon={IconLock} title="No segregation rules" hint="Every sheet is visible to everyone with drawings access on this project. Add a rule to restrict a discipline, an area or a single sheet to named people or a whole template." />
          ) : (
            <DataTable<PermissionRule> tableId="drawing-permissions" data={rules.data?.items ?? []} columns={columns} getRowId={(r) => r.id} loading={rules.loading} height={400} stickyHeader gridLines toolbar={false} rowActions={(row) => [{ id: "remove", label: "Remove rule", onSelect: () => void remove(row) }]} empty={{ title: "No rules" }} aria-label="Segregation rules" />
          )}
          {rules.data?.note ? <p className="text-xs text-ink-400">{rules.data.note}</p> : null}
        </>
      )}
    </div>
  );
}
