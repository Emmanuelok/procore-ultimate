/**
 * Company assurance register (spec Vol II Domain A/S) — portfolio-wide
 * signal stats, the counterparty entity register with relationship graph,
 * and the shared-identifier collusion scan.
 */
import { useCallback, useEffect, useMemo, useState, type FormEvent } from "react";
import { Link, useSearchParams } from "react-router-dom";
import {
  ENTITY_KINDS,
  ENTITY_RELATIONSHIP_KINDS,
  SCREENING_DISPOSITIONS,
  SIGNAL_DISPOSITIONS,
  SIGNAL_SEVERITIES,
} from "@constructos/shared";
import { api } from "../../lib/api";
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
  PageHeader,
  Select,
  Spinner,
  Table,
  Td,
  Textarea,
  Th,
} from "../../ui";
import { formatDateTime, humanize } from "../format";
import {
  dispositionTone,
  pct,
  severityTone,
  StatCard,
  TabBar,
  truncateMiddle,
  type EntityRelationshipRow,
  type EntityRow,
  type ListResponse,
  type SignalRow,
} from "./assuranceShared";
import CasesTab from "./CasesTab";
import DetectorsTab from "./DetectorsTab";
import IntegrityTab from "./IntegrityTab";
import RegistersTab from "./RegistersTab";

const COMPANY_TABS = [
  { key: "signals", label: "Signals" },
  { key: "detectors", label: "Detectors" },
  { key: "integrity", label: "Integrity scores" },
  { key: "cases", label: "Cases" },
  { key: "entities", label: "Entity register" },
  { key: "registers", label: "Conflicts & authority" },
];

interface SignalStats {
  total: number;
  bySeverity: Record<string, number>;
  byDisposition: Record<string, number>;
}

interface ScanResult {
  entitiesScanned: number;
  relationshipsCreated: number;
  signalsCreated: number;
  findings: { fromEntityId: string; toEntityId: string; kind: string; identifier: string; value: string }[];
}

interface GraphResponse {
  root: string;
  depth: number;
  nodes: (EntityRow & { distance: number | null })[];
  edges: EntityRelationshipRow[];
}

interface ScreeningRow {
  id: string;
  list: string;
  matchScore: number;
  matchedName: string | null;
  matchedRef: string | null;
  listSource: string;
  listSnapshotHash: string;
  disposition: string;
  screenedAt: string;
}

interface ExposurePath {
  targetId: string;
  targetName: string | null;
  hops: number;
  vendorId: string | null;
  userId: string | null;
  declared: boolean | null;
  citations: {
    relationshipId: string;
    fromName: string | null;
    toName: string | null;
    kind: string;
    source: string | null;
  }[];
}

interface ExposureResponse {
  root: { id: string; name: string };
  depth: number;
  paths: ExposurePath[];
  note: string;
}

const IDENTIFIER_KEYS = ["bank_account", "address", "email_domain", "phone", "registration"] as const;

interface EntityForm {
  kind: string;
  name: string;
  jurisdiction: string;
  identifiers: Record<string, string>;
}

const emptyEntity: EntityForm = {
  kind: "company",
  name: "",
  jurisdiction: "",
  identifiers: {},
};

export default function CompanyAssurancePage() {
  const [searchParams, setSearchParams] = useSearchParams();
  const [tab, setTab] = useState(() => {
    const t = searchParams.get("tab");
    return t && COMPANY_TABS.some((x) => x.key === t) ? t : "signals";
  });
  const [stats, setStats] = useState<SignalStats | null>(null);
  const [signals, setSignals] = useState<SignalRow[] | null>(null);
  const [severity, setSeverity] = useState("");
  const [disposition, setDisposition] = useState("");
  const [error, setError] = useState<string | null>(null);

  const [entities, setEntities] = useState<EntityRow[] | null>(null);
  const [entityError, setEntityError] = useState<string | null>(null);
  const [selectedEntity, setSelectedEntity] = useState<EntityRow | null>(null);
  const [relationships, setRelationships] = useState<EntityRelationshipRow[] | null>(null);
  const [graph, setGraph] = useState<GraphResponse | null>(null);
  const [panelError, setPanelError] = useState<string | null>(null);

  const [createOpen, setCreateOpen] = useState(false);
  const [form, setForm] = useState<EntityForm>(emptyEntity);
  const [createError, setCreateError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  const [relOpen, setRelOpen] = useState(false);
  const [relTo, setRelTo] = useState("");
  const [relKind, setRelKind] = useState<string>(ENTITY_RELATIONSHIP_KINDS[0]);
  const [relError, setRelError] = useState<string | null>(null);
  const [relBusy, setRelBusy] = useState(false);

  const [screening, setScreening] = useState<ScreeningRow[] | null>(null);
  const [screenBusy, setScreenBusy] = useState(false);
  const [screenError, setScreenError] = useState<string | null>(null);
  const [exposure, setExposure] = useState<ExposureResponse | null>(null);

  const [scanBusy, setScanBusy] = useState(false);
  const [scan, setScan] = useState<ScanResult | null>(null);
  const [scanError, setScanError] = useState<string | null>(null);

  // Entity lifecycle: edit, soft-remove (with a mandatory reason) and restore.
  const [includeDeleted, setIncludeDeleted] = useState(false);
  const [editOpen, setEditOpen] = useState(false);
  const [editForm, setEditForm] = useState<EntityForm>(emptyEntity);
  const [editBusy, setEditBusy] = useState(false);
  const [editError, setEditError] = useState<string | null>(null);
  const [removeOpen, setRemoveOpen] = useState(false);
  const [removeReason, setRemoveReason] = useState("");
  const [removeBusy, setRemoveBusy] = useState(false);
  const [removeError, setRemoveError] = useState<string | null>(null);
  const [screenDispBusy, setScreenDispBusy] = useState<string | null>(null);

  const loadSignals = useCallback(async () => {
    setError(null);
    try {
      const params = new URLSearchParams({ pageSize: "50" });
      if (severity) params.set("severity", severity);
      if (disposition) params.set("disposition", disposition);
      const [st, list] = await Promise.all([
        api.get<SignalStats>("/api/v1/signals/stats"),
        api.get<ListResponse<SignalRow>>(`/api/v1/signals?${params}`),
      ]);
      setStats(st);
      setSignals(list.items);
    } catch (err) {
      setSignals([]);
      setError(err instanceof Error ? err.message : "Failed to load signals");
    }
  }, [severity, disposition]);

  const loadEntities = useCallback(async () => {
    setEntityError(null);
    try {
      const res = await api.get<ListResponse<EntityRow>>(
        `/api/v1/entities?pageSize=200${includeDeleted ? "&includeDeleted=true" : ""}`,
      );
      setEntities(res.items);
    } catch (err) {
      setEntities([]);
      setEntityError(err instanceof Error ? err.message : "Failed to load entities");
    }
  }, [includeDeleted]);

  useEffect(() => {
    void loadSignals();
  }, [loadSignals]);
  useEffect(() => {
    void loadEntities();
  }, [loadEntities]);

  const entityById = useMemo(
    () => new Map((entities ?? []).map((e) => [e.id, e])),
    [entities],
  );

  const selectEntity = useCallback(async (e: EntityRow) => {
    setSelectedEntity(e);
    setRelationships(null);
    setGraph(null);
    setScreening(null);
    setExposure(null);
    setPanelError(null);
    setScreenError(null);
    try {
      const [rels, g, scr, exp] = await Promise.all([
        api.get<{ items: EntityRelationshipRow[] }>(`/api/v1/entities/${e.id}/relationships`),
        api.get<GraphResponse>(`/api/v1/entities/${e.id}/graph?depth=2`),
        api.get<{ items: ScreeningRow[] }>(`/api/v1/entities/${e.id}/screening`),
        api.get<ExposureResponse>(`/api/v1/entities/${e.id}/exposure?depth=3`),
      ]);
      setRelationships(rels.items);
      setGraph(g);
      setScreening(scr.items);
      setExposure(exp);
    } catch (err) {
      setRelationships([]);
      setPanelError(err instanceof Error ? err.message : "Failed to load entity detail");
    }
  }, []);

  async function screenEntity(entityId: string) {
    setScreenBusy(true);
    setScreenError(null);
    try {
      await api.post(`/api/v1/entities/${entityId}/screen`, {});
      const [scr, list] = await Promise.all([
        api.get<{ items: ScreeningRow[] }>(`/api/v1/entities/${entityId}/screening`),
        api.get<ListResponse<EntityRow>>("/api/v1/entities?pageSize=200"),
      ]);
      setScreening(scr.items);
      setEntities(list.items);
      const refreshed = list.items.find((e) => e.id === entityId);
      if (refreshed) setSelectedEntity(refreshed);
    } catch (err) {
      setScreenError(err instanceof Error ? err.message : "Screening failed");
    } finally {
      setScreenBusy(false);
    }
  }

  async function onCreateEntity(e: FormEvent) {
    e.preventDefault();
    setBusy(true);
    setCreateError(null);
    try {
      const identifiers: Record<string, string> = {};
      for (const k of IDENTIFIER_KEYS) {
        const v = (form.identifiers[k] ?? "").trim();
        if (v) identifiers[k] = v;
      }
      const payload: Record<string, unknown> = {
        kind: form.kind,
        name: form.name.trim(),
        identifiers,
      };
      if (form.jurisdiction.trim()) payload["jurisdiction"] = form.jurisdiction.trim();
      await api.post("/api/v1/entities", payload);
      setCreateOpen(false);
      setForm(emptyEntity);
      await loadEntities();
    } catch (err) {
      setCreateError(err instanceof Error ? err.message : "Failed to create the entity");
    } finally {
      setBusy(false);
    }
  }

  /**
   * Record a reviewer's judgement on one screening hit.
   *
   * A match against a sanctions or PEP list is a question, not a finding —
   * names collide. Without this control every hit stayed `pending` forever and
   * the entity's screening status could never be cleared or escalated by a
   * human, which is the only thing that turns a fuzzy name match into a fact.
   */
  async function setScreeningDisposition(resultId: string, disposition: string) {
    if (!selectedEntity) return;
    setScreenDispBusy(resultId);
    setScreenError(null);
    try {
      await api.patch(`/api/v1/screening-results/${resultId}`, { disposition });
      const scr = await api.get<{ items: ScreeningRow[] }>(
        `/api/v1/entities/${selectedEntity.id}/screening`,
      );
      setScreening(scr.items);
    } catch (err) {
      setScreenError(
        err instanceof Error ? err.message : "Failed to record the screening disposition",
      );
    } finally {
      setScreenDispBusy(null);
    }
  }

  function openEdit() {
    if (!selectedEntity) return;
    setEditForm({
      kind: selectedEntity.kind,
      name: selectedEntity.name,
      jurisdiction: selectedEntity.jurisdiction ?? "",
      identifiers: { ...(selectedEntity.identifiers ?? {}) },
    });
    setEditError(null);
    setEditOpen(true);
  }

  async function onEditEntity(e: FormEvent) {
    e.preventDefault();
    if (!selectedEntity) return;
    setEditBusy(true);
    setEditError(null);
    try {
      const identifiers: Record<string, string> = {};
      for (const k of IDENTIFIER_KEYS) {
        const v = (editForm.identifiers[k] ?? "").trim();
        if (v) identifiers[k] = v;
      }
      const updated = await api.patch<EntityRow>(`/api/v1/entities/${selectedEntity.id}`, {
        kind: editForm.kind,
        name: editForm.name.trim(),
        jurisdiction: editForm.jurisdiction.trim() || null,
        identifiers,
      });
      setEditOpen(false);
      await loadEntities();
      await selectEntity(updated);
    } catch (err) {
      setEditError(err instanceof Error ? err.message : "Failed to update the entity");
    } finally {
      setEditBusy(false);
    }
  }

  async function onRemoveEntity(e: FormEvent) {
    e.preventDefault();
    if (!selectedEntity || !removeReason.trim()) return;
    setRemoveBusy(true);
    setRemoveError(null);
    try {
      await api.del(
        `/api/v1/entities/${selectedEntity.id}?reason=${encodeURIComponent(removeReason.trim())}`,
      );
      setRemoveOpen(false);
      setRemoveReason("");
      setSelectedEntity(null);
      await loadEntities();
    } catch (err) {
      setRemoveError(err instanceof Error ? err.message : "Failed to remove the entity");
    } finally {
      setRemoveBusy(false);
    }
  }

  async function onRestoreEntity() {
    if (!selectedEntity) return;
    setPanelError(null);
    try {
      const restored = await api.post<EntityRow>(
        `/api/v1/entities/${selectedEntity.id}/restore`,
        {},
      );
      await loadEntities();
      await selectEntity(restored);
    } catch (err) {
      setPanelError(err instanceof Error ? err.message : "Failed to restore the entity");
    }
  }

  async function onCreateRelationship(e: FormEvent) {
    e.preventDefault();
    if (!selectedEntity || !relTo) return;
    setRelBusy(true);
    setRelError(null);
    try {
      await api.post(`/api/v1/entities/${selectedEntity.id}/relationships`, {
        toEntityId: relTo,
        kind: relKind,
      });
      setRelOpen(false);
      setRelTo("");
      await selectEntity(selectedEntity);
    } catch (err) {
      setRelError(err instanceof Error ? err.message : "Failed to create the relationship");
    } finally {
      setRelBusy(false);
    }
  }

  async function runScan() {
    setScanBusy(true);
    setScanError(null);
    try {
      const res = await api.post<ScanResult>("/api/v1/entities/scan");
      setScan(res);
      await loadSignals();
      if (selectedEntity) await selectEntity(selectedEntity);
    } catch (err) {
      setScanError(err instanceof Error ? err.message : "Scan failed");
    } finally {
      setScanBusy(false);
    }
  }

  const nameOf = (id: string) => entityById.get(id)?.name ?? truncateMiddle(id, 6);

  return (
    <div>
      <PageHeader
        title="Company assurance"
        subtitle="Portfolio-wide integrity signals and the counterparty entity register"
        actions={
          <Button variant="secondary" onClick={() => void runScan()} disabled={scanBusy}>
            {scanBusy ? "Scanning…" : "Run collusion scan"}
          </Button>
        }
      />

      <TabBar
        tabs={COMPANY_TABS}
        active={tab}
        onSelect={(key) => {
          setTab(key);
          setSearchParams({ tab: key }, { replace: true });
        }}
      />

      {tab === "detectors" ? <DetectorsTab /> : null}
      {tab === "integrity" ? <IntegrityTab /> : null}
      {tab === "cases" ? <CasesTab /> : null}
      {tab === "registers" ? <RegistersTab /> : null}

      <div hidden={tab !== "entities"}>
      <ErrorAlert message={scanError} />
      {scan ? (
        <div className="mb-4 rounded-md bg-brand-50 px-4 py-3 text-sm text-brand-900 ring-1 ring-brand-200">
          <span className="font-semibold">Scan complete.</span> {scan.entitiesScanned} entities
          scanned · {scan.relationshipsCreated} hidden relationship
          {scan.relationshipsCreated === 1 ? "" : "s"} inferred · {scan.signalsCreated} signal
          {scan.signalsCreated === 1 ? "" : "s"} raised.
          {scan.findings.length > 0 ? (
            <ul className="mt-1 list-inside list-disc text-xs">
              {scan.findings.slice(0, 5).map((f, i) => (
                <li key={i}>
                  {nameOf(f.fromEntityId)} ↔ {nameOf(f.toEntityId)} share {humanize(f.identifier)}{" "}
                  <span className="font-mono">"{f.value}"</span>
                </li>
              ))}
            </ul>
          ) : null}
        </div>
      ) : null}

      </div>

      <div hidden={tab !== "signals"}>
      {stats ? (
        <div className="mb-4 grid grid-cols-2 gap-3 sm:grid-cols-5">
          <StatCard label="Total signals" value={stats.total} />
          <StatCard
            label="Critical"
            value={stats.bySeverity["critical"] ?? 0}
            tone={(stats.bySeverity["critical"] ?? 0) > 0 ? "red" : "default"}
          />
          <StatCard
            label="High"
            value={stats.bySeverity["high"] ?? 0}
            tone={(stats.bySeverity["high"] ?? 0) > 0 ? "red" : "default"}
          />
          <StatCard
            label="Medium"
            value={stats.bySeverity["medium"] ?? 0}
            tone={(stats.bySeverity["medium"] ?? 0) > 0 ? "amber" : "default"}
          />
          <StatCard
            label="Awaiting review"
            value={(stats.byDisposition["new"] ?? 0) + (stats.byDisposition["under_review"] ?? 0)}
          />
        </div>
      ) : null}

      <div className="mb-4 flex flex-wrap items-center gap-3">
        <div className="w-44">
          <Select value={severity} onChange={(e) => setSeverity(e.target.value)}>
            <option value="">All severities</option>
            {SIGNAL_SEVERITIES.map((s) => (
              <option key={s} value={s}>
                {humanize(s)}
              </option>
            ))}
          </Select>
        </div>
        <div className="w-44">
          <Select value={disposition} onChange={(e) => setDisposition(e.target.value)}>
            <option value="">All dispositions</option>
            {SIGNAL_DISPOSITIONS.map((d) => (
              <option key={d} value={d}>
                {humanize(d)}
              </option>
            ))}
          </Select>
        </div>
      </div>

      <ErrorAlert message={error} />

      {signals === null ? (
        <Spinner />
      ) : signals.length === 0 ? (
        <EmptyState
          title="No signals across the portfolio"
          hint="Run detectors from a project's Assurance tab, or the collusion scan above."
        />
      ) : (
        <Table>
          <thead>
            <tr>
              <Th>Severity</Th>
              <Th>Detector</Th>
              <Th>Title</Th>
              <Th>Project</Th>
              <Th>Confidence</Th>
              <Th>Disposition</Th>
              <Th>Created</Th>
            </tr>
          </thead>
          <tbody className="divide-y divide-ink-100">
            {signals.map((s) => (
              <tr key={s.id} className="hover:bg-ink-50/60">
                <Td>
                  <Badge tone={severityTone(s.severity)}>{humanize(s.severity)}</Badge>
                </Td>
                <Td className="whitespace-nowrap font-mono text-xs">{s.detector}</Td>
                <Td className="max-w-md">
                  <span className="line-clamp-2">{s.title}</span>
                </Td>
                <Td>
                  {s.projectId ? (
                    <Link
                      to={`/projects/${s.projectId}/assurance`}
                      className="font-mono text-xs text-brand-700 hover:text-brand-800"
                    >
                      {truncateMiddle(s.projectId, 6)}
                    </Link>
                  ) : (
                    <Badge tone="gray">company</Badge>
                  )}
                </Td>
                <Td className="tabular-nums">{pct(s.confidence)}</Td>
                <Td>
                  <Badge tone={dispositionTone(s.disposition)}>{humanize(s.disposition)}</Badge>
                </Td>
                <Td className="whitespace-nowrap text-xs text-ink-500">
                  {formatDateTime(s.createdAt)}
                </Td>
              </tr>
            ))}
          </tbody>
        </Table>
      )}

      </div>

      {/* ------------------------- Entity register ------------------------- */}

      <div hidden={tab !== "entities"}>
      <div className="mb-3 mt-8 flex items-center justify-between">
        <div>
          <h2 className="text-base font-semibold text-ink-900">Entity register</h2>
          <p className="text-xs text-ink-500">
            Counterparties, their identifiers, and the relationship graph between them.
          </p>
        </div>
        <div className="flex items-center gap-3">
          <label className="flex items-center gap-1.5 text-xs text-ink-600">
            <input
              type="checkbox"
              checked={includeDeleted}
              onChange={(e) => setIncludeDeleted(e.target.checked)}
            />
            Show removed
          </label>
          <Button onClick={() => setCreateOpen(true)}>New entity</Button>
        </div>
      </div>

      <ErrorAlert message={entityError} />

      <div className="grid grid-cols-1 gap-4 lg:grid-cols-2">
        <div>
          {entities === null ? (
            <Spinner />
          ) : entities.length === 0 ? (
            <EmptyState
              title="No entities registered"
              hint="Register subcontractors, suppliers and their principals to enable network analysis."
              action={<Button onClick={() => setCreateOpen(true)}>Register the first entity</Button>}
            />
          ) : (
            <Table>
              <thead>
                <tr>
                  <Th>Name</Th>
                  <Th>Kind</Th>
                  <Th>Jurisdiction</Th>
                  <Th>Identifiers</Th>
                  <Th>Screening</Th>
                </tr>
              </thead>
              <tbody className="divide-y divide-ink-100">
                {entities.map((e) => (
                  <tr
                    key={e.id}
                    className={`cursor-pointer ${
                      selectedEntity?.id === e.id ? "bg-brand-50/60" : "hover:bg-ink-50/60"
                    }`}
                    onClick={() => void selectEntity(e)}
                  >
                    <Td className="font-medium text-ink-900">
                      {e.name}
                      {e.deletedAt ? (
                        <Badge tone="gray" className="ml-2">
                          removed
                        </Badge>
                      ) : null}
                    </Td>
                    <Td>
                      <Badge tone="blue">{humanize(e.kind)}</Badge>
                    </Td>
                    <Td className="text-xs">{e.jurisdiction ?? "—"}</Td>
                    <Td className="text-xs text-ink-500">
                      {Object.keys(e.identifiers ?? {}).length > 0
                        ? Object.keys(e.identifiers).map((k) => humanize(k)).join(", ")
                        : "—"}
                    </Td>
                    <Td>
                      {e.screeningStatus ? (
                        <Badge tone={e.screeningStatus === "clear" ? "green" : "red"}>
                          {humanize(e.screeningStatus)}
                        </Badge>
                      ) : (
                        <span className="text-xs text-ink-400">—</span>
                      )}
                    </Td>
                  </tr>
                ))}
              </tbody>
            </Table>
          )}
        </div>

        <div>
          {selectedEntity ? (
            <Card>
              <CardBody>
                <div className="mb-2 flex items-center justify-between gap-2">
                  <div>
                    <div className="text-sm font-semibold text-ink-900">{selectedEntity.name}</div>
                    <div className="text-xs text-ink-400">
                      {humanize(selectedEntity.kind)}
                      {selectedEntity.jurisdiction ? ` · ${selectedEntity.jurisdiction}` : ""}
                    </div>
                  </div>
                  <div className="flex flex-wrap justify-end gap-2">
                    <Button size="sm" variant="secondary" onClick={() => setRelOpen(true)}>
                      Add relationship
                    </Button>
                    <Button size="sm" variant="secondary" onClick={openEdit}>
                      Edit
                    </Button>
                    {selectedEntity.deletedAt ? (
                      <Button size="sm" variant="secondary" onClick={() => void onRestoreEntity()}>
                        Restore
                      </Button>
                    ) : (
                      <Button
                        size="sm"
                        variant="secondary"
                        onClick={() => {
                          setRemoveReason("");
                          setRemoveError(null);
                          setRemoveOpen(true);
                        }}
                      >
                        Remove
                      </Button>
                    )}
                  </div>
                </div>

                {selectedEntity.deletedAt ? (
                  <div className="mb-3 rounded-md bg-ink-50 px-3 py-2 text-xs text-ink-600 ring-1 ring-ink-200">
                    Removed {formatDateTime(selectedEntity.deletedAt)}
                    {selectedEntity.deleteReason ? ` — "${selectedEntity.deleteReason}"` : ""}. The
                    row and every relationship it had are retained: a scan-inferred edge is the
                    evidence, so removal hides it from the register without destroying it.
                  </div>
                ) : null}

                {Object.keys(selectedEntity.identifiers ?? {}).length > 0 ? (
                  <dl className="mb-3 grid grid-cols-2 gap-x-4 gap-y-1 rounded-md bg-ink-50 p-3 text-xs">
                    {Object.entries(selectedEntity.identifiers).map(([k, v]) => (
                      <div key={k} className="contents">
                        <dt className="text-ink-500">{humanize(k)}</dt>
                        <dd className="font-mono text-ink-800">{v}</dd>
                      </div>
                    ))}
                  </dl>
                ) : null}

                <ErrorAlert message={panelError} />

                <div className="mb-1 text-xs font-semibold uppercase tracking-wide text-ink-400">
                  Relationships
                </div>
                {relationships === null ? (
                  <Spinner />
                ) : relationships.length === 0 ? (
                  <p className="mb-3 text-xs text-ink-400">No recorded relationships.</p>
                ) : (
                  <ul className="mb-3 space-y-1">
                    {relationships.map((r) => (
                      <li key={r.id} className="flex items-center gap-2 text-sm text-ink-700">
                        <Badge tone={r.source?.startsWith("scan:") ? "red" : "gray"}>
                          {humanize(r.kind)}
                        </Badge>
                        <span className="truncate">
                          {nameOf(r.fromEntityId)} → {nameOf(r.toEntityId)}
                        </span>
                        {r.confidence !== null ? (
                          <span className="text-xs tabular-nums text-ink-400">{pct(r.confidence)}</span>
                        ) : null}
                      </li>
                    ))}
                  </ul>
                )}

                <div className="mb-1 flex items-center justify-between">
                  <span className="text-xs font-semibold uppercase tracking-wide text-ink-400">
                    Screening
                  </span>
                  <Button
                    size="sm"
                    variant="secondary"
                    disabled={screenBusy}
                    onClick={() => void screenEntity(selectedEntity.id)}
                  >
                    {screenBusy ? "Screening…" : "Screen now"}
                  </Button>
                </div>
                <ErrorAlert message={screenError} />
                {screening === null ? (
                  <p className="mb-3 text-xs text-ink-400">—</p>
                ) : screening.length === 0 ? (
                  <p className="mb-3 text-xs text-ink-400">
                    Never screened. A negative result is only meaningful against a stated list
                    snapshot, so nothing is claimed until it has been run.
                  </p>
                ) : (
                  <ul className="mb-3 space-y-1 text-xs">
                    {screening.slice(0, 6).map((r) => (
                      <li key={r.id} className="rounded border border-ink-100 px-2 py-1">
                        <div className="flex items-center gap-2">
                          <Badge tone={r.matchedName ? "red" : "green"}>{humanize(r.list)}</Badge>
                          <span className="text-ink-700">
                            {r.matchedName ? `${r.matchedName} (${pct(r.matchScore)})` : "no match"}
                          </span>
                          <div className="ml-auto w-36">
                            {/* A fuzzy name match is a question. Someone has to answer it. */}
                            <Select
                              aria-label="Screening disposition"
                              value={r.disposition}
                              disabled={screenDispBusy === r.id}
                              onChange={(e) =>
                                void setScreeningDisposition(r.id, e.target.value)
                              }
                            >
                              {SCREENING_DISPOSITIONS.map((d) => (
                                <option key={d} value={d}>
                                  {humanize(d)}
                                </option>
                              ))}
                            </Select>
                          </div>
                        </div>
                        <div
                          className="mt-0.5 truncate text-[11px] text-ink-400"
                          title={r.listSource}
                        >
                          snapshot {truncateMiddle(r.listSnapshotHash, 8)} · {r.listSource}
                        </div>
                      </li>
                    ))}
                  </ul>
                )}

                <div className="mb-1 text-xs font-semibold uppercase tracking-wide text-ink-400">
                  Exposure paths
                </div>
                {exposure === null ? (
                  <p className="mb-3 text-xs text-ink-400">—</p>
                ) : exposure.paths.length === 0 ? (
                  <p className="mb-3 text-xs text-ink-400">
                    No entity is reachable from this one within three hops.
                  </p>
                ) : (
                  <ul className="mb-3 space-y-1 text-xs">
                    {exposure.paths.slice(0, 8).map((p) => (
                      <li key={p.targetId} className="rounded border border-ink-100 px-2 py-1">
                        <div className="flex items-center gap-2">
                          <span className="font-medium text-ink-800">
                            {p.targetName ?? p.targetId}
                          </span>
                          <span className="text-ink-400">
                            {p.hops} hop{p.hops === 1 ? "" : "s"}
                          </span>
                          {p.declared === true ? (
                            <Badge tone="green">declared</Badge>
                          ) : p.declared === false ? (
                            <Badge tone="red">undeclared</Badge>
                          ) : null}
                        </div>
                        <div className="mt-0.5 text-[11px] text-ink-500">
                          {p.citations
                            .map(
                              (c) =>
                                `${c.fromName ?? "?"} —${humanize(c.kind)}→ ${c.toName ?? "?"}`,
                            )
                            .join("; ")}
                        </div>
                      </li>
                    ))}
                  </ul>
                )}

                <div className="mb-1 text-xs font-semibold uppercase tracking-wide text-ink-400">
                  Network (depth 2)
                </div>
                {graph && graph.nodes.length > 1 ? (
                  <EntityGraphSvg graph={graph} />
                ) : (
                  <p className="text-xs text-ink-400">
                    No connected entities within two hops.
                  </p>
                )}
              </CardBody>
            </Card>
          ) : (
            <EmptyState
              title="Select an entity"
              hint="Click an entity on the left to inspect its identifiers, relationships and network graph."
            />
          )}
        </div>
      </div>

      </div>

      {/* Create entity modal */}
      <Modal open={createOpen} title="New entity" onClose={() => setCreateOpen(false)}>
        <ErrorAlert message={createError} />
        <form onSubmit={onCreateEntity} className="space-y-4">
          <div className="grid grid-cols-1 gap-4 sm:grid-cols-3">
            <Field label="Kind">
              <Select
                value={form.kind}
                onChange={(e) => setForm((f) => ({ ...f, kind: e.target.value }))}
              >
                {ENTITY_KINDS.map((k) => (
                  <option key={k} value={k}>
                    {humanize(k)}
                  </option>
                ))}
              </Select>
            </Field>
            <div className="sm:col-span-2">
              <Field label="Name">
                <Input
                  required
                  value={form.name}
                  onChange={(e) => setForm((f) => ({ ...f, name: e.target.value }))}
                  placeholder="Apex Groundworks Ltd"
                />
              </Field>
            </div>
          </div>
          <Field label="Jurisdiction">
            <Input
              value={form.jurisdiction}
              onChange={(e) => setForm((f) => ({ ...f, jurisdiction: e.target.value }))}
              placeholder="GB / US-NY / AE-DU…"
            />
          </Field>
          <div className="grid grid-cols-1 gap-4 sm:grid-cols-2">
            {IDENTIFIER_KEYS.map((k) => (
              <Field key={k} label={humanize(k)}>
                <Input
                  value={form.identifiers[k] ?? ""}
                  onChange={(e) =>
                    setForm((f) => ({
                      ...f,
                      identifiers: { ...f.identifiers, [k]: e.target.value },
                    }))
                  }
                  placeholder={
                    k === "bank_account"
                      ? "GB29NWBK60161331926819"
                      : k === "email_domain"
                        ? "apexgroundworks.com"
                        : ""
                  }
                />
              </Field>
            ))}
          </div>
          <p className="text-xs text-ink-400">
            Shared identifiers across nominally independent entities are what the collusion scan
            detects — capture them faithfully.
          </p>
          <div className="flex justify-end gap-2">
            <Button variant="secondary" onClick={() => setCreateOpen(false)}>
              Cancel
            </Button>
            <Button type="submit" disabled={busy}>
              {busy ? "Creating…" : "Create entity"}
            </Button>
          </div>
        </form>
      </Modal>

      {/* Edit entity modal */}
      <Modal
        open={editOpen}
        title={`Edit ${selectedEntity?.name ?? "entity"}`}
        onClose={() => setEditOpen(false)}
      >
        <ErrorAlert message={editError} />
        <form onSubmit={onEditEntity} className="space-y-4">
          <div className="grid grid-cols-1 gap-4 sm:grid-cols-3">
            <Field label="Kind">
              <Select
                value={editForm.kind}
                onChange={(e) => setEditForm((f) => ({ ...f, kind: e.target.value }))}
              >
                {ENTITY_KINDS.map((k) => (
                  <option key={k} value={k}>
                    {humanize(k)}
                  </option>
                ))}
              </Select>
            </Field>
            <div className="sm:col-span-2">
              <Field label="Name">
                <Input
                  required
                  value={editForm.name}
                  onChange={(e) => setEditForm((f) => ({ ...f, name: e.target.value }))}
                />
              </Field>
            </div>
          </div>
          <Field label="Jurisdiction">
            <Input
              value={editForm.jurisdiction}
              onChange={(e) => setEditForm((f) => ({ ...f, jurisdiction: e.target.value }))}
            />
          </Field>
          <div className="grid grid-cols-1 gap-4 sm:grid-cols-2">
            {IDENTIFIER_KEYS.map((k) => (
              <Field key={k} label={humanize(k)}>
                <Input
                  value={editForm.identifiers[k] ?? ""}
                  onChange={(e) =>
                    setEditForm((f) => ({
                      ...f,
                      identifiers: { ...f.identifiers, [k]: e.target.value },
                    }))
                  }
                />
              </Field>
            ))}
          </div>
          <p className="text-xs text-ink-400">
            The previous values are kept: every edit stores the row BEFORE and after it in the
            ledger, so an overwritten bank account is always recoverable.
          </p>
          <div className="flex justify-end gap-2">
            <Button variant="secondary" onClick={() => setEditOpen(false)}>
              Cancel
            </Button>
            <Button type="submit" disabled={editBusy}>
              {editBusy ? "Saving…" : "Save changes"}
            </Button>
          </div>
        </form>
      </Modal>

      {/* Remove entity modal — a reason is mandatory */}
      <Modal
        open={removeOpen}
        title={`Remove ${selectedEntity?.name ?? "entity"} from the register`}
        onClose={() => setRemoveOpen(false)}
      >
        <ErrorAlert message={removeError} />
        <form onSubmit={onRemoveEntity} className="space-y-4">
          <p className="text-sm text-ink-600">
            This is a soft removal. The entity, its identifiers and every relationship — including
            the ones the collusion scan inferred — are retained and remain visible under “Show
            removed”, because those relationships are frequently the evidence.
          </p>
          <Field label="Reason" hint="Recorded against the removal in the ledger.">
            <Textarea
              required
              rows={3}
              value={removeReason}
              onChange={(e) => setRemoveReason(e.target.value)}
              placeholder="Duplicate record superseded by ENT-… / counterparty never engaged"
            />
          </Field>
          <div className="flex justify-end gap-2">
            <Button variant="secondary" onClick={() => setRemoveOpen(false)}>
              Cancel
            </Button>
            <Button type="submit" disabled={removeBusy || !removeReason.trim()}>
              {removeBusy ? "Removing…" : "Remove"}
            </Button>
          </div>
        </form>
      </Modal>

      {/* Add relationship modal */}
      <Modal
        open={relOpen}
        title={`Relationship from ${selectedEntity?.name ?? ""}`}
        onClose={() => setRelOpen(false)}
      >
        <ErrorAlert message={relError} />
        <form onSubmit={onCreateRelationship} className="space-y-4">
          <Field label="Kind">
            <Select value={relKind} onChange={(e) => setRelKind(e.target.value)}>
              {ENTITY_RELATIONSHIP_KINDS.map((k) => (
                <option key={k} value={k}>
                  {humanize(k)}
                </option>
              ))}
            </Select>
          </Field>
          <Field label="Related entity">
            <Select required value={relTo} onChange={(e) => setRelTo(e.target.value)}>
              <option value="">Choose entity…</option>
              {(entities ?? [])
                .filter((e) => e.id !== selectedEntity?.id)
                .map((e) => (
                  <option key={e.id} value={e.id}>
                    {e.name}
                  </option>
                ))}
            </Select>
          </Field>
          <div className="flex justify-end gap-2">
            <Button variant="secondary" onClick={() => setRelOpen(false)}>
              Cancel
            </Button>
            <Button type="submit" disabled={relBusy || !relTo}>
              {relBusy ? "Saving…" : "Add relationship"}
            </Button>
          </div>
        </form>
      </Modal>
    </div>
  );
}

/* ----------------------------- Graph rendering ----------------------------- */

function EntityGraphSvg({ graph }: { graph: GraphResponse }) {
  const W = 460;
  const H = 300;
  const cx = W / 2;
  const cy = H / 2;
  const R = Math.min(W, H) / 2 - 46;

  const others = graph.nodes.filter((n) => n.id !== graph.root);
  const pos = new Map<string, { x: number; y: number }>();
  pos.set(graph.root, { x: cx, y: cy });
  others.forEach((n, i) => {
    const angle = (2 * Math.PI * i) / Math.max(others.length, 1) - Math.PI / 2;
    pos.set(n.id, { x: cx + R * Math.cos(angle), y: cy + R * Math.sin(angle) });
  });

  const nodeById = new Map(graph.nodes.map((n) => [n.id, n]));

  return (
    <div className="overflow-x-auto rounded-md border border-ink-100 bg-ink-50/50">
      <svg viewBox={`0 0 ${W} ${H}`} className="h-72 w-full min-w-[420px]">
        {graph.edges.map((e) => {
          const a = pos.get(e.fromEntityId);
          const b = pos.get(e.toEntityId);
          if (!a || !b) return null;
          const mx = (a.x + b.x) / 2;
          const my = (a.y + b.y) / 2;
          const inferred = e.source?.startsWith("scan:");
          return (
            <g key={e.id}>
              <line
                x1={a.x}
                y1={a.y}
                x2={b.x}
                y2={b.y}
                stroke={inferred ? "#dc2626" : "#94a3b8"}
                strokeWidth={1.2}
                strokeDasharray={inferred ? "4 3" : undefined}
              />
              <text
                x={mx}
                y={my - 4}
                textAnchor="middle"
                fontSize={7.5}
                fill={inferred ? "#b91c1c" : "#64748b"}
              >
                {e.kind.replace(/_/g, " ")}
              </text>
            </g>
          );
        })}
        {[...pos.entries()].map(([id, p]) => {
          const n = nodeById.get(id);
          const isRoot = id === graph.root;
          return (
            <g key={id}>
              <circle
                cx={p.x}
                cy={p.y}
                r={isRoot ? 14 : 10}
                fill={isRoot ? "#1d4ed8" : "#ffffff"}
                stroke={isRoot ? "#1e40af" : "#64748b"}
                strokeWidth={1.5}
              />
              <text
                x={p.x}
                y={p.y + (isRoot ? 26 : 21)}
                textAnchor="middle"
                fontSize={9}
                fontWeight={isRoot ? 600 : 400}
                fill="#0f172a"
              >
                {(n?.name ?? id).slice(0, 20)}
              </text>
            </g>
          );
        })}
      </svg>
    </div>
  );
}
