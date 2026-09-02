/**
 * Assets tab — the register, the hierarchy and the binding to geometry
 * (spec Domain L #627-629, #658).
 *
 * The drawer is the asset's whole record: where it is, who owns it, what it
 * is bound to in the model, what covers it, what has gone wrong with it, and
 * what hangs off it. Every write here is the same route the API tests cover,
 * so nothing in this tab describes an action the product does not have.
 */
import { useCallback, useEffect, useState, type FormEvent } from "react";
import { Link } from "react-router-dom";
import { toast } from "sonner";
import { ASSET_CRITICALITY } from "@constructos/shared";
import { api, ApiClientError } from "../../lib/api";
import {
  Badge,
  Button,
  Card,
  CardBody,
  Drawer,
  DrawerBody,
  EmptyState,
  ErrorAlert,
  Field,
  Input,
  Modal,
  SegmentedControl,
  Select,
  Spinner,
  Table,
  Td,
  Textarea,
  Th,
} from "../../ui";
import { formatDate, humanize } from "../format";
import {
  assetNextStatuses,
  assetStatusTone,
  criticalityTone,
  ASSET_STATUSES,
  type AssetDetail,
  type AssetRow,
  type AssetTreeNode,
  type CompanyUser,
  type ListResponse,
} from "./twinShared";

type View = "register" | "tree";

export default function AssetsTab({
  projectId,
  onChanged,
}: {
  projectId: string;
  onChanged: () => void;
}) {
  const [view, setView] = useState<View>("register");
  const [rows, setRows] = useState<AssetRow[] | null>(null);
  const [total, setTotal] = useState(0);
  const [page, setPage] = useState(1);
  const [search, setSearch] = useState("");
  const [status, setStatus] = useState("");
  const [unlinked, setUnlinked] = useState(false);
  const [tree, setTree] = useState<AssetTreeNode[] | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [users, setUsers] = useState<CompanyUser[]>([]);
  const [busy, setBusy] = useState(false);

  const [createOpen, setCreateOpen] = useState(false);
  const [form, setForm] = useState({
    tagCode: "",
    name: "",
    category: "",
    classificationCode: "",
    manufacturer: "",
    modelNumber: "",
    serialNumber: "",
    criticality: "medium",
    ownerId: "",
    installedAt: "",
  });
  const [formError, setFormError] = useState<string | null>(null);

  const [detail, setDetail] = useState<AssetDetail | null>(null);
  const [detailError, setDetailError] = useState<string | null>(null);
  const [linkGuid, setLinkGuid] = useState("");
  const [warrantyForm, setWarrantyForm] = useState({
    provider: "",
    startDate: "",
    endDate: "",
    description: "",
  });
  const [claimForm, setClaimForm] = useState({ warrantyId: "", title: "", description: "" });

  const load = useCallback(async () => {
    setError(null);
    try {
      const params = new URLSearchParams({ page: String(page), pageSize: "50" });
      if (search.trim()) params.set("search", search.trim());
      if (status) params.set("status", status);
      if (unlinked) params.set("unlinked", "1");
      const res = await api.get<ListResponse<AssetRow>>(
        `/api/v1/projects/${projectId}/assets?${params}`,
      );
      setRows(res.items);
      setTotal(res.total);
    } catch (err) {
      setRows([]);
      setError(err instanceof Error ? err.message : "Failed to load the asset register");
    }
  }, [projectId, page, search, status, unlinked]);

  useEffect(() => {
    const t = setTimeout(() => void load(), search ? 250 : 0);
    return () => clearTimeout(t);
  }, [load, search]);

  useEffect(() => {
    if (view !== "tree") return;
    api
      .get<{ items: AssetTreeNode[] }>(`/api/v1/projects/${projectId}/assets/tree`)
      .then((res) => setTree(res.items))
      .catch(() => setTree([]));
  }, [view, projectId]);

  useEffect(() => {
    api
      .get<ListResponse<CompanyUser>>("/api/v1/company/users?pageSize=200")
      .then((res) => setUsers(res.items))
      .catch(() => setUsers([]));
  }, []);

  async function openDetail(assetId: string) {
    setDetail(null);
    setDetailError(null);
    try {
      setDetail(await api.get<AssetDetail>(`/api/v1/assets/${assetId}`));
    } catch (err) {
      setDetailError(err instanceof Error ? err.message : "Failed to load the asset");
    }
  }

  async function refreshDetail(assetId: string) {
    try {
      setDetail(await api.get<AssetDetail>(`/api/v1/assets/${assetId}`));
    } catch {
      /* the register is still accurate */
    }
  }

  async function createAsset(e: FormEvent) {
    e.preventDefault();
    setFormError(null);
    setBusy(true);
    try {
      const payload: Record<string, unknown> = {
        tagCode: form.tagCode.trim(),
        name: form.name.trim(),
        criticality: form.criticality,
      };
      for (const key of [
        "category",
        "classificationCode",
        "manufacturer",
        "modelNumber",
        "serialNumber",
        "installedAt",
        "ownerId",
      ] as const) {
        const value = form[key].trim();
        if (value) payload[key] = value;
      }
      await api.post(`/api/v1/projects/${projectId}/assets`, payload);
      setCreateOpen(false);
      setForm({
        tagCode: "",
        name: "",
        category: "",
        classificationCode: "",
        manufacturer: "",
        modelNumber: "",
        serialNumber: "",
        criticality: "medium",
        ownerId: "",
        installedAt: "",
      });
      await load();
      onChanged();
    } catch (err) {
      setFormError(err instanceof ApiClientError ? err.message : "Failed to create the asset.");
    } finally {
      setBusy(false);
    }
  }

  async function patchAsset(assetId: string, patch: Record<string, unknown>, message: string) {
    setBusy(true);
    try {
      await api.patch(`/api/v1/assets/${assetId}`, patch);
      toast.success(message);
      await load();
      await refreshDetail(assetId);
      onChanged();
    } catch (err) {
      toast.error(err instanceof ApiClientError ? err.message : "The change was refused.");
    } finally {
      setBusy(false);
    }
  }

  async function linkElement(assetId: string) {
    if (!linkGuid.trim()) return;
    setBusy(true);
    try {
      await api.post(`/api/v1/assets/${assetId}/elements`, { globalId: linkGuid.trim() });
      setLinkGuid("");
      toast.success("Element linked.");
      await refreshDetail(assetId);
      await load();
      onChanged();
    } catch (err) {
      toast.error(err instanceof ApiClientError ? err.message : "Linking failed.");
    } finally {
      setBusy(false);
    }
  }

  async function unlinkElement(assetId: string, globalId: string) {
    setBusy(true);
    try {
      await api.del(`/api/v1/assets/${assetId}/elements/${globalId}`);
      await refreshDetail(assetId);
      await load();
      onChanged();
    } catch (err) {
      toast.error(err instanceof ApiClientError ? err.message : "Unlinking failed.");
    } finally {
      setBusy(false);
    }
  }

  async function addWarranty(assetId: string, e: FormEvent) {
    e.preventDefault();
    setBusy(true);
    try {
      await api.post(`/api/v1/assets/${assetId}/warranties`, {
        provider: warrantyForm.provider.trim(),
        startDate: warrantyForm.startDate,
        endDate: warrantyForm.endDate,
        ...(warrantyForm.description.trim() ? { description: warrantyForm.description.trim() } : {}),
      });
      setWarrantyForm({ provider: "", startDate: "", endDate: "", description: "" });
      toast.success("Warranty recorded — the expiry sweep will raise its obligation.");
      await refreshDetail(assetId);
      onChanged();
    } catch (err) {
      toast.error(err instanceof ApiClientError ? err.message : "The warranty was refused.");
    } finally {
      setBusy(false);
    }
  }

  async function lodgeClaim(e: FormEvent) {
    e.preventDefault();
    if (!detail || !claimForm.warrantyId) return;
    setBusy(true);
    try {
      await api.post(`/api/v1/warranties/${claimForm.warrantyId}/claims`, {
        title: claimForm.title.trim(),
        ...(claimForm.description.trim() ? { description: claimForm.description.trim() } : {}),
      });
      setClaimForm({ warrantyId: "", title: "", description: "" });
      toast.success("Claim lodged.");
      await refreshDetail(detail.id);
      onChanged();
    } catch (err) {
      toast.error(err instanceof ApiClientError ? err.message : "The claim was refused.");
    } finally {
      setBusy(false);
    }
  }

  async function deleteAsset(assetId: string) {
    if (!window.confirm("Delete this asset? Children are re-parented, links and warranties go with it.")) {
      return;
    }
    setBusy(true);
    try {
      const res = await api.del<{ childrenReparented: number }>(`/api/v1/assets/${assetId}`);
      toast.success(
        res.childrenReparented > 0
          ? `Asset deleted; ${res.childrenReparented} child asset(s) re-parented.`
          : "Asset deleted.",
      );
      setDetail(null);
      await load();
      onChanged();
    } catch (err) {
      toast.error(
        err instanceof ApiClientError ? err.message : "Delete failed — it needs twin admin.",
      );
    } finally {
      setBusy(false);
    }
  }

  const totalPages = Math.max(1, Math.ceil(total / 50));

  return (
    <div>
      <div className="mb-3 flex flex-wrap items-center justify-between gap-2">
        <SegmentedControl<View>
          options={[
            { value: "register", label: "Register" },
            { value: "tree", label: "Hierarchy" },
          ]}
          value={view}
          onChange={setView}
          aria-label="Asset view"
        />
        <div className="flex flex-wrap items-center gap-2">
          <Input
            value={search}
            onChange={(e) => {
              setSearch(e.target.value);
              setPage(1);
            }}
            placeholder="Search tag, name or serial…"
            className="max-w-xs"
          />
          <Select
            value={status}
            onChange={(e) => {
              setStatus(e.target.value);
              setPage(1);
            }}
            className="max-w-[160px]"
          >
            <option value="">All statuses</option>
            {ASSET_STATUSES.map((s) => (
              <option key={s} value={s}>
                {humanize(s)}
              </option>
            ))}
          </Select>
          <label className="flex items-center gap-1.5 text-xs text-ink-600">
            <input
              type="checkbox"
              checked={unlinked}
              onChange={(e) => {
                setUnlinked(e.target.checked);
                setPage(1);
              }}
            />
            No geometry
          </label>
          <Button onClick={() => setCreateOpen(true)}>New asset</Button>
        </div>
      </div>

      <ErrorAlert message={error} />

      {view === "tree" ? (
        <Card>
          <CardBody>
            {tree === null ? (
              <Spinner label="Loading hierarchy…" />
            ) : tree.length === 0 ? (
              <EmptyState title="No assets" hint="Register an asset to build the hierarchy." />
            ) : (
              <TreeList nodes={tree} onOpen={(id) => void openDetail(id)} depth={0} />
            )}
          </CardBody>
        </Card>
      ) : rows === null ? (
        <Spinner label="Loading assets…" />
      ) : rows.length === 0 ? (
        <EmptyState
          title="No assets yet"
          hint="Register assets by hand, or instantiate them from model elements in the BIM viewer."
          action={<Button onClick={() => setCreateOpen(true)}>Register an asset</Button>}
        />
      ) : (
        <>
          <Table>
            <thead>
              <tr>
                <Th>Tag</Th>
                <Th>Asset</Th>
                <Th>Status</Th>
                <Th>Criticality</Th>
                <Th>Manufacturer</Th>
                <Th className="text-right">Geometry</Th>
                <Th className="text-right">Sensors</Th>
                <Th>Warranty</Th>
              </tr>
            </thead>
            <tbody className="divide-y divide-ink-100">
              {rows.map((a) => {
                const nextWarranty = [...a.warranties].sort((x, y) =>
                  x.endDate.localeCompare(y.endDate),
                )[0];
                return (
                  <tr
                    key={a.id}
                    className="cursor-pointer hover:bg-ink-50/60"
                    onClick={() => void openDetail(a.id)}
                  >
                    <Td className="font-mono text-xs">{a.tagCode}</Td>
                    <Td>
                      <span className="font-medium text-ink-900">{a.name}</span>
                      {a.category ? (
                        <div className="text-[11px] text-ink-400">{a.category}</div>
                      ) : null}
                    </Td>
                    <Td>
                      <Badge tone={assetStatusTone(a.status)} size="sm">
                        {humanize(a.status)}
                      </Badge>
                    </Td>
                    <Td>
                      <Badge tone={criticalityTone(a.criticality)} size="sm">
                        {a.criticality}
                      </Badge>
                    </Td>
                    <Td>{a.manufacturer ?? "—"}</Td>
                    <Td className="text-right tabular-nums">
                      {a.elementLinkCount > 0 ? a.elementLinkCount : "—"}
                    </Td>
                    <Td className="text-right tabular-nums">
                      {a.sensorCount > 0 ? a.sensorCount : "—"}
                    </Td>
                    <Td className="text-xs">
                      {nextWarranty ? (
                        <span
                          className={
                            nextWarranty.endDate < new Date().toISOString().slice(0, 10)
                              ? "text-red-600"
                              : "text-ink-600"
                          }
                        >
                          to {formatDate(nextWarranty.endDate)}
                        </span>
                      ) : (
                        <span className="text-ink-300">none</span>
                      )}
                    </Td>
                  </tr>
                );
              })}
            </tbody>
          </Table>
          <div className="mt-3 flex items-center justify-between text-xs text-ink-500">
            <span>
              {total} asset{total === 1 ? "" : "s"} · page {page} of {totalPages}
            </span>
            <div className="flex gap-2">
              <Button size="sm" variant="secondary" disabled={page <= 1} onClick={() => setPage((p) => p - 1)}>
                Previous
              </Button>
              <Button
                size="sm"
                variant="secondary"
                disabled={page >= totalPages}
                onClick={() => setPage((p) => p + 1)}
              >
                Next
              </Button>
            </div>
          </div>
        </>
      )}

      {/* ------------------------------ create ------------------------------ */}
      <Modal open={createOpen} onClose={() => setCreateOpen(false)} title="Register an asset" wide>
        <form onSubmit={createAsset} className="space-y-3">
          <ErrorAlert message={formError} />
          <div className="grid grid-cols-2 gap-3">
            <Field label="Tag code" hint="Unique on the project.">
              <Input
                required
                value={form.tagCode}
                onChange={(e) => setForm({ ...form, tagCode: e.target.value })}
                placeholder="AHU-01"
              />
            </Field>
            <Field label="Name">
              <Input
                required
                value={form.name}
                onChange={(e) => setForm({ ...form, name: e.target.value })}
              />
            </Field>
          </div>
          <div className="grid grid-cols-2 gap-3">
            <Field label="Category">
              <Input
                value={form.category}
                onChange={(e) => setForm({ ...form, category: e.target.value })}
                placeholder="HVAC"
              />
            </Field>
            <Field label="Classification code" hint="Uniclass, Omniclass or SFG20.">
              <Input
                value={form.classificationCode}
                onChange={(e) => setForm({ ...form, classificationCode: e.target.value })}
              />
            </Field>
          </div>
          <div className="grid grid-cols-3 gap-3">
            <Field label="Manufacturer">
              <Input
                value={form.manufacturer}
                onChange={(e) => setForm({ ...form, manufacturer: e.target.value })}
              />
            </Field>
            <Field label="Model">
              <Input
                value={form.modelNumber}
                onChange={(e) => setForm({ ...form, modelNumber: e.target.value })}
              />
            </Field>
            <Field label="Serial">
              <Input
                value={form.serialNumber}
                onChange={(e) => setForm({ ...form, serialNumber: e.target.value })}
              />
            </Field>
          </div>
          <div className="grid grid-cols-3 gap-3">
            <Field label="Criticality">
              <Select
                value={form.criticality}
                onChange={(e) => setForm({ ...form, criticality: e.target.value })}
              >
                {ASSET_CRITICALITY.map((c) => (
                  <option key={c} value={c}>
                    {humanize(c)}
                  </option>
                ))}
              </Select>
            </Field>
            <Field label="Owner" hint="Alerts and warranty notices go here.">
              <Select
                value={form.ownerId}
                onChange={(e) => setForm({ ...form, ownerId: e.target.value })}
              >
                <option value="">Unassigned</option>
                {users.map((u) => (
                  <option key={u.id} value={u.id}>
                    {u.name}
                  </option>
                ))}
              </Select>
            </Field>
            <Field label="Installed on">
              <Input
                type="date"
                value={form.installedAt}
                onChange={(e) => setForm({ ...form, installedAt: e.target.value })}
              />
            </Field>
          </div>
          <div className="flex justify-end gap-2">
            <Button type="button" variant="secondary" onClick={() => setCreateOpen(false)}>
              Cancel
            </Button>
            <Button type="submit" disabled={busy}>
              Register
            </Button>
          </div>
        </form>
      </Modal>

      {/* ------------------------------ detail ------------------------------ */}
      <Drawer
        open={detail !== null || detailError !== null}
        onOpenChange={(open) => {
          if (!open) {
            setDetail(null);
            setDetailError(null);
          }
        }}
        title={detail ? `${detail.tagCode} — ${detail.name}` : "Asset"}
        size="lg"
      >
        <DrawerBody>
          <ErrorAlert message={detailError} />
          {detail === null ? (
            <Spinner label="Loading asset…" />
          ) : (
            <div className="space-y-4">
              <div className="flex flex-wrap items-center gap-2">
                <Badge tone={assetStatusTone(detail.status)}>{humanize(detail.status)}</Badge>
                <Badge tone={criticalityTone(detail.criticality)}>{detail.criticality}</Badge>
                {detail.location ? <Badge tone="neutral">{detail.location.name}</Badge> : null}
                {detail.openAlerts.length > 0 ? (
                  <Badge tone="danger">{detail.openAlerts.length} open alert(s)</Badge>
                ) : null}
              </div>

              <Card>
                <CardBody className="space-y-3">
                  <div className="grid grid-cols-2 gap-3">
                    <Field label="Owner">
                      <Select
                        value={detail.ownerId ?? ""}
                        onChange={(e) =>
                          void patchAsset(
                            detail.id,
                            { ownerId: e.target.value || null },
                            "Owner updated.",
                          )
                        }
                      >
                        <option value="">Unassigned</option>
                        {users.map((u) => (
                          <option key={u.id} value={u.id}>
                            {u.name}
                          </option>
                        ))}
                      </Select>
                    </Field>
                    <Field label="Status">
                      <Select
                        value=""
                        onChange={(e) =>
                          e.target.value &&
                          void patchAsset(
                            detail.id,
                            { status: e.target.value },
                            `Asset ${e.target.value}.`,
                          )
                        }
                      >
                        <option value="">Advance the lifecycle…</option>
                        {assetNextStatuses(detail.status).map((s) => (
                          <option key={s} value={s}>
                            {humanize(s)}
                          </option>
                        ))}
                      </Select>
                    </Field>
                  </div>
                  <div className="grid grid-cols-3 gap-3 text-xs text-ink-600">
                    <div>
                      <div className="text-ink-400">Manufacturer</div>
                      {detail.manufacturer ?? "—"}
                    </div>
                    <div>
                      <div className="text-ink-400">Model</div>
                      {detail.modelNumber ?? "—"}
                    </div>
                    <div>
                      <div className="text-ink-400">Serial</div>
                      {detail.serialNumber ?? "—"}
                    </div>
                    <div>
                      <div className="text-ink-400">Installed</div>
                      {formatDate(detail.installedAt)}
                    </div>
                    <div>
                      <div className="text-ink-400">Commissioned</div>
                      {formatDate(detail.commissionedAt)}
                    </div>
                    <div>
                      <div className="text-ink-400">Classification</div>
                      {detail.classificationCode ?? "—"}
                    </div>
                  </div>
                </CardBody>
              </Card>

              <Card>
                <CardBody>
                  <h3 className="mb-2 text-xs font-semibold uppercase tracking-wide text-ink-500">
                    Model geometry ({detail.elementLinks.length})
                  </h3>
                  {detail.elementLinks.length === 0 ? (
                    <p className="mb-2 text-xs text-ink-400">
                      Not bound to any element. Bind it here by GlobalId, or from the model viewer
                      (<Link className="underline" to={`/projects/${projectId}/bim`}>BIM workspace</Link>).
                    </p>
                  ) : (
                    <ul className="mb-2 space-y-1 text-xs">
                      {detail.elementLinks.map((l) => (
                        <li key={l.id} className="flex items-center justify-between">
                          <span className="font-mono">{l.globalId}</span>
                          <Button
                            size="sm"
                            variant="ghost"
                            disabled={busy}
                            onClick={() => void unlinkElement(detail.id, l.globalId)}
                          >
                            Unlink
                          </Button>
                        </li>
                      ))}
                    </ul>
                  )}
                  <div className="flex gap-2">
                    <Input
                      value={linkGuid}
                      onChange={(e) => setLinkGuid(e.target.value)}
                      placeholder="IFC GlobalId"
                      className="font-mono text-xs"
                    />
                    <Button size="sm" disabled={busy} onClick={() => void linkElement(detail.id)}>
                      Link
                    </Button>
                  </div>
                </CardBody>
              </Card>

              <Card>
                <CardBody>
                  <h3 className="mb-2 text-xs font-semibold uppercase tracking-wide text-ink-500">
                    Warranties ({detail.warranties.length})
                  </h3>
                  {detail.warranties.length === 0 ? (
                    <p className="mb-2 text-xs text-ink-400">No warranty recorded.</p>
                  ) : (
                    <Table>
                      <thead>
                        <tr>
                          <Th>Provider</Th>
                          <Th>From</Th>
                          <Th>To</Th>
                          <Th>Status</Th>
                        </tr>
                      </thead>
                      <tbody className="divide-y divide-ink-100">
                        {detail.warranties.map((w) => (
                          <tr key={w.id}>
                            <Td>{w.provider}</Td>
                            <Td>{formatDate(w.startDate)}</Td>
                            <Td>{formatDate(w.endDate)}</Td>
                            <Td>
                              <Badge
                                size="sm"
                                tone={
                                  w.status === "expired"
                                    ? "danger"
                                    : w.status === "claimed"
                                      ? "warning"
                                      : "success"
                                }
                              >
                                {w.status ?? "active"}
                              </Badge>
                            </Td>
                          </tr>
                        ))}
                      </tbody>
                    </Table>
                  )}
                  <form onSubmit={(e) => void addWarranty(detail.id, e)} className="mt-3 grid grid-cols-2 gap-2">
                    <Input
                      value={warrantyForm.provider}
                      onChange={(e) => setWarrantyForm({ ...warrantyForm, provider: e.target.value })}
                      placeholder="Provider"
                      required
                    />
                    <Input
                      value={warrantyForm.description}
                      onChange={(e) =>
                        setWarrantyForm({ ...warrantyForm, description: e.target.value })
                      }
                      placeholder="Cover (optional)"
                    />
                    <Input
                      type="date"
                      value={warrantyForm.startDate}
                      onChange={(e) => setWarrantyForm({ ...warrantyForm, startDate: e.target.value })}
                      required
                    />
                    <Input
                      type="date"
                      value={warrantyForm.endDate}
                      onChange={(e) => setWarrantyForm({ ...warrantyForm, endDate: e.target.value })}
                      required
                    />
                    <div className="col-span-2 flex justify-end">
                      <Button size="sm" type="submit" disabled={busy}>
                        Add warranty
                      </Button>
                    </div>
                  </form>
                </CardBody>
              </Card>

              {detail.warranties.length > 0 ? (
                <Card>
                  <CardBody>
                    <h3 className="mb-2 text-xs font-semibold uppercase tracking-wide text-ink-500">
                      Claims ({detail.warrantyClaims.length})
                    </h3>
                    {detail.warrantyClaims.length > 0 ? (
                      <ul className="mb-2 space-y-1 text-xs">
                        {detail.warrantyClaims.map((c) => (
                          <li key={c.id} className="flex items-center justify-between">
                            <span>
                              #{c.number} {c.title}
                            </span>
                            <Badge size="sm" tone={c.status === "closed" ? "success" : "warning"}>
                              {humanize(c.status)}
                            </Badge>
                          </li>
                        ))}
                      </ul>
                    ) : null}
                    <form onSubmit={lodgeClaim} className="space-y-2">
                      <Select
                        value={claimForm.warrantyId}
                        onChange={(e) => setClaimForm({ ...claimForm, warrantyId: e.target.value })}
                      >
                        <option value="">Claim against…</option>
                        {detail.warranties.map((w) => (
                          <option key={w.id} value={w.id}>
                            {w.provider} (to {w.endDate})
                          </option>
                        ))}
                      </Select>
                      <Input
                        value={claimForm.title}
                        onChange={(e) => setClaimForm({ ...claimForm, title: e.target.value })}
                        placeholder="What has failed?"
                      />
                      <Textarea
                        rows={2}
                        value={claimForm.description}
                        onChange={(e) => setClaimForm({ ...claimForm, description: e.target.value })}
                        placeholder="Detail (optional)"
                      />
                      <div className="flex justify-end">
                        <Button
                          size="sm"
                          type="submit"
                          disabled={busy || !claimForm.warrantyId || !claimForm.title.trim()}
                        >
                          Lodge claim
                        </Button>
                      </div>
                    </form>
                  </CardBody>
                </Card>
              ) : null}

              {detail.sensors.length > 0 ? (
                <Card>
                  <CardBody>
                    <h3 className="mb-2 text-xs font-semibold uppercase tracking-wide text-ink-500">
                      Sensors ({detail.sensors.length})
                    </h3>
                    <ul className="space-y-1 text-xs">
                      {detail.sensors.map((s) => (
                        <li key={s.id} className="flex items-center justify-between">
                          <span>
                            {s.name} · {humanize(s.kind)}
                          </span>
                          <span className="text-ink-400">
                            {s.lastValue === null ? "no readings" : `${s.lastValue} ${s.unit}`}
                          </span>
                        </li>
                      ))}
                    </ul>
                  </CardBody>
                </Card>
              ) : null}

              {detail.children.length > 0 ? (
                <Card>
                  <CardBody>
                    <h3 className="mb-2 text-xs font-semibold uppercase tracking-wide text-ink-500">
                      Children ({detail.children.length})
                    </h3>
                    <ul className="space-y-1 text-xs">
                      {detail.children.map((c) => (
                        <li key={c.id}>
                          <button
                            type="button"
                            className="text-brand-700 underline"
                            onClick={() => void openDetail(c.id)}
                          >
                            {c.tagCode} — {c.name}
                          </button>
                        </li>
                      ))}
                    </ul>
                  </CardBody>
                </Card>
              ) : null}

              <div className="flex justify-end">
                <Button variant="danger" disabled={busy} onClick={() => void deleteAsset(detail.id)}>
                  Delete asset
                </Button>
              </div>
            </div>
          )}
        </DrawerBody>
      </Drawer>
    </div>
  );
}

function TreeList({
  nodes,
  onOpen,
  depth,
}: {
  nodes: AssetTreeNode[];
  onOpen: (id: string) => void;
  depth: number;
}) {
  return (
    <ul className={depth === 0 ? "space-y-1" : "mt-1 space-y-1 border-l border-ink-100 pl-3"}>
      {nodes.map((node) => (
        <li key={node.id}>
          <button
            type="button"
            onClick={() => onOpen(node.id)}
            className="flex w-full items-center gap-2 rounded px-1.5 py-1 text-left text-xs hover:bg-ink-50"
          >
            <span className="font-mono text-ink-500">{node.tagCode}</span>
            <span className="text-ink-800">{node.name}</span>
            <Badge tone={assetStatusTone(node.status)} size="sm" className="ml-auto">
              {humanize(node.status)}
            </Badge>
          </button>
          {node.children.length > 0 ? (
            <TreeList nodes={node.children} onOpen={onOpen} depth={depth + 1} />
          ) : null}
        </li>
      ))}
    </ul>
  );
}
