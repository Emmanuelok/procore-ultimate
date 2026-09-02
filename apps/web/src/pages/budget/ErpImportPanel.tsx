/**
 * ERP IMPORT (spec #481) — a general-ledger budget export, mapped onto the
 * project's cost codes through the company's GL → cost-code map.
 *
 * The map is edited here too, because an unmapped account is the only
 * reason an ERP import is refused: the dry run names every account the map
 * does not know, the mapping is added, and the same file is run again. Rows
 * are never guessed onto "other".
 */
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { COST_TYPES, type CostType } from "@constructos/shared";
import { Alert, Badge, Button, Card, CardBody, ErrorAlert, Field, Input, Select, Table, Td, Th, Tr, useConfirm } from "../../ui";
import { IconImport, IconPlus } from "../../ui/icons";
import { FileDropzone, type FileDropzoneHandle } from "../../ui/inputs";
import { api } from "../../lib/api";
import {
  SectionHeading,
  count,
  errorMessage,
  labelize,
  money,
  useResource,
  type BudgetDetail,
  type ErpDialect,
  type ErpImportPreview,
  type GlCostCodeMap,
  type ListResponse,
} from "./budgetShared";

export default function ErpImportPanel({
  budget,
  currency,
  onChanged,
}: {
  budget: BudgetDetail;
  currency: string;
  onChanged: () => void;
}) {
  const { confirm, dialog } = useConfirm();
  const dropzone = useRef<FileDropzoneHandle>(null);
  const [system, setSystem] = useState("sage");
  const [mode, setMode] = useState<"create" | "upsert">("create");
  const [csv, setCsv] = useState<string | null>(null);
  const [fileName, setFileName] = useState<string | null>(null);
  const [preview, setPreview] = useState<ErpImportPreview | null>(null);
  const [result, setResult] = useState<ErpImportPreview | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [checking, setChecking] = useState(false);
  const [committing, setCommitting] = useState(false);
  const [mapVersion, setMapVersion] = useState(0);
  const [addingMap, setAddingMap] = useState<{ glAccount: string; glSubAccount: string } | null>(null);

  const dialects = useResource<{ items: ErpDialect[] }>((signal) => api.get<{ items: ErpDialect[] }>("/api/v1/budget-erp/dialects", { signal }), []);
  const maps = useResource<ListResponse<GlCostCodeMap>>(
    (signal) => api.get<ListResponse<GlCostCodeMap>>(`/api/v1/projects/${budget.projectId}/gl-cost-code-maps?page=1&pageSize=200&erpSystem=${system}`, { signal }),
    [budget.projectId, system, mapVersion],
  );
  const dialect = useMemo(() => dialects.data?.items.find((d) => d.system === system) ?? null, [dialects.data, system]);
  const frozen = !budget.planEditable;

  const validate = useCallback(
    async (text: string, nextSystem: string, nextMode: "create" | "upsert") => {
      setChecking(true);
      setError(null);
      setResult(null);
      try {
        const res = await api.post<ErpImportPreview>(`/api/v1/budgets/${budget.id}/lines/import-erp`, { csv: text, erpSystem: nextSystem, dryRun: true, mode: nextMode });
        setPreview(res);
      } catch (err) {
        setError(errorMessage(err, "The export could not be read"));
        setPreview(null);
      } finally {
        setChecking(false);
      }
    },
    [budget.id],
  );

  useEffect(() => {
    if (csv) void validate(csv, system, mode);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [system, mapVersion]);

  async function commit() {
    if (!csv) return;
    if (mode === "upsert") {
      const ok = await confirm({ title: "Overwrite existing lines?", description: "Upsert replaces the original budget on any line whose cost code and cost type already exist on this budget.", confirmLabel: "Overwrite and import", destructive: true });
      if (!ok) return;
    }
    setCommitting(true);
    setError(null);
    try {
      const res = await api.post<ErpImportPreview>(`/api/v1/budgets/${budget.id}/lines/import-erp`, { csv, erpSystem: system, dryRun: false, mode });
      setResult(res);
      setPreview(null);
      onChanged();
    } catch (err) {
      setError(errorMessage(err, "Nothing was written — the import was refused"));
    } finally {
      setCommitting(false);
    }
  }

  async function removeMap(map: GlCostCodeMap) {
    const ok = await confirm({ title: `Remove mapping ${map.glAccount}${map.glSubAccount ? ` / ${map.glSubAccount}` : ""}?`, confirmLabel: "Remove", destructive: true });
    if (!ok) return;
    try {
      await api.del(`/api/v1/gl-cost-code-maps/${map.id}?projectId=${budget.projectId}`);
      setMapVersion((n) => n + 1);
    } catch (err) {
      setError(errorMessage(err, "The mapping could not be removed"));
    }
  }

  const ready = preview !== null && preview.issues.length === 0 && preview.mappedLines > 0;

  return (
    <section className="space-y-4">
      {dialog}
      <SectionHeading
        title="Import from an ERP general-ledger export"
        hint="GL accounts are mapped to cost code × cost type through the company's map. An account the map does not know is reported by row and nothing is written."
        actions={
          <Select value={system} onChange={(e) => setSystem(e.target.value)} size="sm" aria-label="ERP system">
            {(dialects.data?.items ?? [{ system: "other", label: "Generic GL export" } as ErpDialect]).map((d) => (
              <option key={d.system} value={d.system}>
                {d.label}
              </option>
            ))}
          </Select>
        }
      />
      <ErrorAlert message={error} onDismiss={() => setError(null)} />

      <div className="grid gap-4 lg:grid-cols-[1.2fr_1fr]">
        <Card>
          <CardBody className="space-y-3">
            <FileDropzone
              ref={dropzone}
              accept=".csv,text/csv"
              multiple={false}
              maxFiles={1}
              maxSize={4 * 1024 * 1024}
              autoUpload={false}
              showPreviews={false}
              disabled={frozen}
              label={`Drop a ${dialect?.label ?? "GL"} export`}
              hint={dialect ? `Expected headers: ${dialect.template}` : "Recognised headers depend on the ERP system chosen."}
              onFilesAccepted={(files: File[]) => {
                const file = files[0];
                if (!file) return;
                setFileName(file.name);
                file
                  .text()
                  .then((text) => {
                    setCsv(text);
                    void validate(text, system, mode);
                  })
                  .catch(() => setError("That file could not be read from disk."));
              }}
            />
            <div className="flex flex-wrap items-center gap-3">
              <Field label="Mode" className="w-56">
                <Select value={mode} onChange={(e) => setMode(e.target.value as "create" | "upsert")}>
                  <option value="create">Create new lines only</option>
                  <option value="upsert">Upsert onto existing lines</option>
                </Select>
              </Field>
              {fileName ? <span className="text-meta text-content-muted">{fileName}</span> : null}
              {checking ? <span className="text-meta text-content-subtle">Checking…</span> : null}
              <span className="flex-1" />
              <Button leadingIcon={IconImport} onClick={() => void commit()} disabled={!ready || frozen} loading={committing}>
                Import {preview ? `${count(preview.mappedLines)} lines` : ""}
              </Button>
            </div>
            {preview ? (
              <div className="space-y-2">
                <div className="grid grid-cols-2 gap-2 sm:grid-cols-4">
                  <Figure label="Rows parsed" value={count(preview.parsedRows)} />
                  <Figure label="Budget lines" value={count(preview.mappedLines)} />
                  <Figure label="Unmapped rows" value={count(preview.unmappedRows)} tone={preview.unmappedRows > 0 ? "danger" : undefined} />
                  <Figure label="Mapped budget" value={money(preview.totalOriginalBudget, currency)} />
                </div>
                {preview.unknownColumns.length > 0 ? (
                  <p className="text-meta text-content-subtle">Ignored columns: {preview.unknownColumns.join(", ")}</p>
                ) : null}
                {preview.unmapped.length > 0 ? (
                  <Alert tone="danger" size="sm" title={`${count(preview.unmappedRows)} row(s) have no GL → cost-code mapping (${money(preview.unmappedAmount, currency)})`}>
                    <ul className="space-y-1">
                      {preview.unmapped.slice(0, 20).map((u) => (
                        <li key={`${u.rowNumber}`} className="flex flex-wrap items-center justify-between gap-2">
                          <span>
                            Row {u.rowNumber} · account <code className="font-mono">{u.glAccount}</code>
                            {u.glSubAccount ? <code className="font-mono"> / {u.glSubAccount}</code> : null} · {money(u.amount, currency)}
                          </span>
                          <Button size="xs" variant="secondary" onClick={() => setAddingMap({ glAccount: u.glAccount, glSubAccount: u.glSubAccount ?? "" })}>
                            Map it
                          </Button>
                        </li>
                      ))}
                    </ul>
                  </Alert>
                ) : null}
                {preview.issues.filter((i) => i.field !== "account").length > 0 ? (
                  <Alert tone="warning" size="sm" title="Rows the parser refused">
                    <ul className="list-disc pl-4">
                      {preview.issues
                        .filter((i) => i.field !== "account")
                        .slice(0, 20)
                        .map((i, idx) => (
                          <li key={idx}>
                            Row {i.row}: {i.message}
                          </li>
                        ))}
                    </ul>
                  </Alert>
                ) : null}
                {preview.lines.length > 0 ? (
                  <Table dense>
                    <thead>
                      <tr>
                        <Th>Cost code</Th>
                        <Th>Type</Th>
                        <Th>Description</Th>
                        <Th numeric>GL rows</Th>
                        <Th numeric>Original budget</Th>
                      </tr>
                    </thead>
                    <tbody>
                      {preview.lines.slice(0, 30).map((l) => (
                        <Tr key={`${l.costCode}-${l.costType}`}>
                          <Td className="font-mono text-code">{l.costCode}</Td>
                          <Td muted>{labelize(l.costType)}</Td>
                          <Td truncate>{l.description}</Td>
                          <Td numeric muted>{l.glRows}</Td>
                          <Td numeric>{money(l.originalBudget, currency)}</Td>
                        </Tr>
                      ))}
                    </tbody>
                  </Table>
                ) : null}
              </div>
            ) : null}
            {result ? (
              <Alert tone="success" title="Imported">
                {count(result.created ?? 0)} line{(result.created ?? 0) === 1 ? "" : "s"} created, {count(result.updated ?? 0)} updated, from {count(result.parsedRows)} GL rows. Each line records the GL rows that fed it on its provenance.
              </Alert>
            ) : null}
          </CardBody>
        </Card>

        <Card>
          <CardBody className="space-y-2">
            <div className="flex items-center justify-between">
              <p className="text-body font-semibold text-content">GL → cost-code map</p>
              <Button size="xs" variant="secondary" leadingIcon={IconPlus} onClick={() => setAddingMap({ glAccount: "", glSubAccount: "" })}>
                Add mapping
              </Button>
            </div>
            <p className="text-meta text-content-muted">
              {dialect?.label ?? labelize(system)} · company-wide rows apply to every project; a project row wins over the company row for the same account.
            </p>
            {maps.error ? <ErrorAlert message={maps.error} /> : null}
            {(maps.data?.items ?? []).length === 0 ? (
              <p className="text-meta text-content-subtle">No mapping yet for this ERP system.</p>
            ) : (
              <Table dense>
                <thead>
                  <tr>
                    <Th>GL account</Th>
                    <Th>Cost code</Th>
                    <Th>Scope</Th>
                    <Th />
                  </tr>
                </thead>
                <tbody>
                  {(maps.data?.items ?? []).map((m) => (
                    <Tr key={m.id}>
                      <Td>
                        <code className="font-mono">{m.glAccount}</code>
                        {m.glSubAccount ? <code className="font-mono"> / {m.glSubAccount}</code> : null}
                        {m.glDescription ? <span className="block truncate text-meta text-content-subtle">{m.glDescription}</span> : null}
                      </Td>
                      <Td>
                        <code className="font-mono">{m.costCode}</code> <span className="text-content-muted">{labelize(m.costType)}</span>
                        {m.isActive === 0 ? (
                          <Badge tone="neutral" size="xs" className="ml-1">
                            inactive
                          </Badge>
                        ) : null}
                      </Td>
                      <Td muted>{m.projectId ? "this project" : "company"}</Td>
                      <Td>
                        <Button size="xs" variant="ghost" onClick={() => void removeMap(m)}>
                          Remove
                        </Button>
                      </Td>
                    </Tr>
                  ))}
                </tbody>
              </Table>
            )}
          </CardBody>
        </Card>
      </div>

      <AddMapModal
        open={addingMap !== null}
        initial={addingMap}
        projectId={budget.projectId}
        system={system}
        onClose={() => setAddingMap(null)}
        onSaved={() => {
          setAddingMap(null);
          setMapVersion((n) => n + 1);
        }}
      />
    </section>
  );
}

function Figure({ label, value, tone }: { label: string; value: string; tone?: "danger" }) {
  return (
    <div>
      <p className="text-label uppercase text-content-subtle">{label}</p>
      <p className={`text-body font-semibold tabular-nums ${tone === "danger" ? "text-danger-fg" : "text-content"}`}>{value}</p>
    </div>
  );
}

function AddMapModal({
  open,
  initial,
  projectId,
  system,
  onClose,
  onSaved,
}: {
  open: boolean;
  initial: { glAccount: string; glSubAccount: string } | null;
  projectId: string;
  system: string;
  onClose: () => void;
  onSaved: () => void;
}) {
  const [glAccount, setGlAccount] = useState("");
  const [glSubAccount, setGlSubAccount] = useState("");
  const [costCode, setCostCode] = useState("");
  const [costType, setCostType] = useState<CostType>("subcontract");
  const [description, setDescription] = useState("");
  const [projectOnly, setProjectOnly] = useState(false);
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    if (!open) return;
    setGlAccount(initial?.glAccount ?? "");
    setGlSubAccount(initial?.glSubAccount ?? "");
    setCostCode("");
    setCostType("subcontract");
    setDescription("");
    setProjectOnly(false);
    setError(null);
  }, [open, initial]);

  async function submit() {
    if (glAccount.trim() === "" || costCode.trim() === "") {
      setError("A GL account and a cost code are both required.");
      return;
    }
    setSaving(true);
    setError(null);
    try {
      await api.post(`/api/v1/projects/${projectId}/gl-cost-code-maps`, {
        erpSystem: system,
        glAccount: glAccount.trim(),
        glSubAccount: glSubAccount.trim() === "" ? null : glSubAccount.trim(),
        glDescription: description.trim() === "" ? null : description.trim(),
        costCode: costCode.trim(),
        costType,
        projectOnly,
      });
      onSaved();
    } catch (err) {
      setError(errorMessage(err, "The mapping could not be saved"));
    } finally {
      setSaving(false);
    }
  }

  if (!open) return null;
  return (
    <Card className="fixed inset-x-4 bottom-4 z-40 mx-auto max-w-xl shadow-e3">
      <CardBody className="space-y-3">
        <p className="text-body font-semibold text-content">Map a GL account</p>
        <ErrorAlert message={error} />
        <div className="grid gap-3 sm:grid-cols-2">
          <Field label="GL account" required>
            <Input value={glAccount} onChange={(e) => setGlAccount(e.target.value)} autoFocus />
          </Field>
          <Field label="Sub-account / category" optional>
            <Input value={glSubAccount} onChange={(e) => setGlSubAccount(e.target.value)} />
          </Field>
          <Field label="Cost code" required hint="A code on the company list or this project.">
            <Input value={costCode} onChange={(e) => setCostCode(e.target.value)} className="font-mono" />
          </Field>
          <Field label="Cost type" required>
            <Select value={costType} onChange={(e) => setCostType(e.target.value as CostType)}>
              {COST_TYPES.map((t) => (
                <option key={t} value={t}>
                  {labelize(t)}
                </option>
              ))}
            </Select>
          </Field>
          <Field label="Description" optional className="sm:col-span-2">
            <Input value={description} onChange={(e) => setDescription(e.target.value)} />
          </Field>
        </div>
        <label className="flex items-center gap-2 text-meta">
          <input type="checkbox" checked={projectOnly} onChange={(e) => setProjectOnly(e.target.checked)} />
          This project only (otherwise company-wide)
        </label>
        <div className="flex justify-end gap-2">
          <Button variant="secondary" onClick={onClose}>
            Cancel
          </Button>
          <Button onClick={() => void submit()} loading={saving}>
            Save mapping
          </Button>
        </div>
      </CardBody>
    </Card>
  );
}
