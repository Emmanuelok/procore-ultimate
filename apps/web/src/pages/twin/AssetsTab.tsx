/**
 * Asset register tab — tagged assets with forward-only lifecycle, warranty
 * horizon and BIM element links (spec Domain L #627-629, #642, #658).
 */
import { useCallback, useEffect, useState, type FormEvent } from "react";
import { ASSET_CRITICALITY } from "@constructos/shared";
import { api, ApiClientError } from "../../lib/api";
import {
  Badge,
  Button,
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
import { formatDate, humanize } from "../format";
import {
  ASSET_STATUSES,
  assetNextStatuses,
  assetStatusTone,
  criticalityTone,
  warrantyEnd,
  type Asset,
  type AssetDetail,
  type ListResponse,
} from "./twinShared";

interface AssetForm {
  tagCode: string;
  name: string;
  category: string;
  manufacturer: string;
  modelNumber: string;
  serialNumber: string;
  criticality: string;
  warrantyStart: string;
  warrantyMonths: string;
}

const emptyForm: AssetForm = {
  tagCode: "",
  name: "",
  category: "",
  manufacturer: "",
  modelNumber: "",
  serialNumber: "",
  criticality: "medium",
  warrantyStart: "",
  warrantyMonths: "",
};

export default function AssetsTab({ projectId }: { projectId: string }) {
  const [items, setItems] = useState<Asset[] | null>(null);
  const [total, setTotal] = useState(0);
  const [search, setSearch] = useState("");
  const [statusFilter, setStatusFilter] = useState("");
  const [error, setError] = useState<string | null>(null);

  const [formOpen, setFormOpen] = useState(false);
  const [editing, setEditing] = useState<Asset | null>(null);
  const [form, setForm] = useState<AssetForm>(emptyForm);
  const [formError, setFormError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  const [detail, setDetail] = useState<AssetDetail | null>(null);
  const [detailId, setDetailId] = useState<string | null>(null);
  const [detailError, setDetailError] = useState<string | null>(null);

  const load = useCallback(async () => {
    setError(null);
    try {
      const params = new URLSearchParams({ pageSize: "100" });
      if (search.trim()) params.set("search", search.trim());
      if (statusFilter) params.set("status", statusFilter);
      const res = await api.get<ListResponse<Asset>>(
        `/api/v1/projects/${projectId}/assets?${params}`,
      );
      setItems(res.items);
      setTotal(res.total);
    } catch (err) {
      setItems([]);
      setError(err instanceof Error ? err.message : "Failed to load assets");
    }
  }, [projectId, search, statusFilter]);

  useEffect(() => {
    const t = setTimeout(() => void load(), search ? 250 : 0);
    return () => clearTimeout(t);
  }, [load, search]);

  const loadDetail = useCallback(async (assetId: string) => {
    setDetailError(null);
    setDetail(null);
    setDetailId(assetId);
    try {
      const res = await api.get<AssetDetail>(`/api/v1/assets/${assetId}`);
      setDetail(res);
    } catch (err) {
      setDetailError(err instanceof Error ? err.message : "Failed to load the asset");
    }
  }, []);

  function openCreate() {
    setEditing(null);
    setForm(emptyForm);
    setFormError(null);
    setFormOpen(true);
  }

  function openEdit(asset: Asset) {
    setEditing(asset);
    setForm({
      tagCode: asset.tagCode,
      name: asset.name,
      category: asset.category ?? "",
      manufacturer: asset.manufacturer ?? "",
      modelNumber: asset.modelNumber ?? "",
      serialNumber: asset.serialNumber ?? "",
      criticality: asset.criticality,
      warrantyStart: asset.warrantyStart ?? "",
      warrantyMonths: asset.warrantyMonths !== null ? String(asset.warrantyMonths) : "",
    });
    setFormError(null);
    setFormOpen(true);
  }

  async function onSubmit(e: FormEvent) {
    e.preventDefault();
    setFormError(null);
    setBusy(true);
    try {
      const payload: Record<string, unknown> = {
        tagCode: form.tagCode.trim(),
        name: form.name.trim(),
        criticality: form.criticality,
        category: form.category.trim() || null,
        manufacturer: form.manufacturer.trim() || null,
        modelNumber: form.modelNumber.trim() || null,
        serialNumber: form.serialNumber.trim() || null,
        warrantyStart: form.warrantyStart || null,
        warrantyMonths: form.warrantyMonths ? Number(form.warrantyMonths) : null,
      };
      if (editing) {
        await api.patch(`/api/v1/assets/${editing.id}`, payload);
        if (detailId === editing.id) await loadDetail(editing.id);
      } else {
        await api.post(`/api/v1/projects/${projectId}/assets`, payload);
      }
      setFormOpen(false);
      await load();
    } catch (err) {
      setFormError(err instanceof ApiClientError ? err.message : "Failed to save the asset.");
    } finally {
      setBusy(false);
    }
  }

  async function onStatusChange(assetId: string, status: string) {
    if (!status) return;
    setDetailError(null);
    try {
      await api.patch(`/api/v1/assets/${assetId}`, { status });
      await Promise.all([load(), detailId === assetId ? loadDetail(assetId) : Promise.resolve()]);
    } catch (err) {
      setDetailError(err instanceof ApiClientError ? err.message : "Status change failed.");
    }
  }

  return (
    <div>
      <div className="mb-4 flex flex-wrap items-center gap-3">
        <div className="w-64">
          <Input
            placeholder="Search tag, name or serial…"
            value={search}
            onChange={(e) => setSearch(e.target.value)}
          />
        </div>
        <div className="w-48">
          <Select value={statusFilter} onChange={(e) => setStatusFilter(e.target.value)}>
            <option value="">All statuses</option>
            {ASSET_STATUSES.map((s) => (
              <option key={s} value={s}>
                {humanize(s)}
              </option>
            ))}
          </Select>
        </div>
        <span className="text-xs text-ink-400">
          {total} asset{total === 1 ? "" : "s"}
        </span>
        <div className="ml-auto">
          <Button onClick={openCreate}>New asset</Button>
        </div>
      </div>

      <ErrorAlert message={error} />

      {items === null ? (
        <Spinner label="Loading assets…" />
      ) : items.length === 0 ? (
        <EmptyState
          title={search || statusFilter ? "No assets match the filter" : "No assets registered"}
          hint="Register assets during construction — or create them straight from BIM elements in the model viewer — to build the digital twin."
          action={
            !search && !statusFilter ? (
              <Button onClick={openCreate}>Register the first asset</Button>
            ) : undefined
          }
        />
      ) : (
        <Table>
          <thead>
            <tr>
              <Th>Tag</Th>
              <Th>Name</Th>
              <Th>Category</Th>
              <Th>Status</Th>
              <Th>Criticality</Th>
              <Th>Warranty ends</Th>
              <Th className="text-right">Actions</Th>
            </tr>
          </thead>
          <tbody className="divide-y divide-ink-100">
            {items.map((a) => {
              const end = warrantyEnd(a.warrantyStart, a.warrantyMonths);
              const expired = end !== null && end < new Date().toISOString().slice(0, 10);
              return (
                <tr key={a.id} className="hover:bg-ink-50/60">
                  <Td>
                    <button
                      type="button"
                      className="font-mono text-xs font-semibold text-brand-700 hover:text-brand-800"
                      onClick={() => void loadDetail(a.id)}
                    >
                      {a.tagCode}
                    </button>
                  </Td>
                  <Td className="font-medium">{a.name}</Td>
                  <Td>{a.category ?? "—"}</Td>
                  <Td>
                    <Badge tone={assetStatusTone(a.status)}>{humanize(a.status)}</Badge>
                  </Td>
                  <Td>
                    <Badge tone={criticalityTone(a.criticality)}>{humanize(a.criticality)}</Badge>
                  </Td>
                  <Td className={expired ? "font-medium text-red-600" : ""}>
                    {end ? formatDate(end) : "—"}
                  </Td>
                  <Td className="text-right">
                    <div className="flex justify-end gap-1.5">
                      <Button size="sm" variant="secondary" onClick={() => openEdit(a)}>
                        Edit
                      </Button>
                      <Button size="sm" variant="secondary" onClick={() => void loadDetail(a.id)}>
                        Details
                      </Button>
                    </div>
                  </Td>
                </tr>
              );
            })}
          </tbody>
        </Table>
      )}

      {/* ------------------------------ detail drawer ---------------------------- */}
      {detailId && (
        <div className="fixed inset-0 z-40" role="dialog" aria-label="Asset detail">
          <div
            className="absolute inset-0 bg-ink-950/30"
            onClick={() => {
              setDetailId(null);
              setDetail(null);
            }}
          />
          <div className="absolute inset-y-0 right-0 flex w-full max-w-md flex-col overflow-y-auto bg-white shadow-xl ring-1 ring-ink-200">
            <div className="flex items-center justify-between border-b border-ink-100 px-4 py-3">
              <h3 className="text-sm font-semibold text-ink-900">Asset detail</h3>
              <button
                type="button"
                className="rounded p-1 text-ink-400 hover:bg-ink-100 hover:text-ink-700"
                onClick={() => {
                  setDetailId(null);
                  setDetail(null);
                }}
                aria-label="Close"
              >
                ✕
              </button>
            </div>
            <div className="flex-1 p-4">
              <ErrorAlert message={detailError} />
              {!detail ? (
                <Spinner />
              ) : (
                <div className="space-y-4">
                  <div>
                    <div className="font-mono text-xs font-semibold text-brand-700">
                      {detail.tagCode}
                    </div>
                    <div className="text-base font-semibold text-ink-900">{detail.name}</div>
                    <div className="mt-1 flex flex-wrap items-center gap-2">
                      <Badge tone={assetStatusTone(detail.status)}>
                        {humanize(detail.status)}
                      </Badge>
                      <Badge tone={criticalityTone(detail.criticality)}>
                        {humanize(detail.criticality)} criticality
                      </Badge>
                    </div>
                  </div>

                  {assetNextStatuses(detail.status).length > 0 && (
                    <div className="rounded-md bg-ink-50 p-3">
                      <div className="mb-1 text-xs font-medium text-ink-600">
                        Lifecycle transition (forward-only)
                      </div>
                      <Select
                        value=""
                        onChange={(e) => void onStatusChange(detail.id, e.target.value)}
                      >
                        <option value="">Move to…</option>
                        {assetNextStatuses(detail.status).map((s) => (
                          <option key={s} value={s}>
                            {humanize(s)}
                          </option>
                        ))}
                      </Select>
                    </div>
                  )}

                  <dl className="grid grid-cols-2 gap-x-3 gap-y-2 text-xs">
                    <DetailRow label="Category" value={detail.category} />
                    <DetailRow label="Manufacturer" value={detail.manufacturer} />
                    <DetailRow label="Model no." value={detail.modelNumber} />
                    <DetailRow label="Serial no." value={detail.serialNumber} />
                    <DetailRow label="Installed" value={formatDate(detail.installedAt)} />
                    <DetailRow label="Commissioned" value={formatDate(detail.commissionedAt)} />
                    <DetailRow label="Warranty start" value={formatDate(detail.warrantyStart)} />
                    <DetailRow
                      label="Warranty ends"
                      value={formatDate(warrantyEnd(detail.warrantyStart, detail.warrantyMonths))}
                    />
                  </dl>

                  <section>
                    <h4 className="mb-1.5 text-xs font-semibold uppercase tracking-wide text-ink-400">
                      BIM element links ({detail.elementLinks.length})
                    </h4>
                    {detail.elementLinks.length === 0 ? (
                      <p className="text-xs text-ink-400">
                        Not linked to model geometry. Use “Create issue / asset from element” in
                        the model viewer to bind this asset to an IFC GlobalId.
                      </p>
                    ) : (
                      <ul className="space-y-1">
                        {detail.elementLinks.map((l) => (
                          <li
                            key={l.id}
                            className="rounded border border-ink-100 bg-ink-50/50 px-2 py-1 font-mono text-[11px] text-ink-700"
                          >
                            {l.globalId}
                          </li>
                        ))}
                      </ul>
                    )}
                  </section>

                  <section>
                    <h4 className="mb-1.5 text-xs font-semibold uppercase tracking-wide text-ink-400">
                      Warranties ({detail.warranties.length})
                    </h4>
                    {detail.warranties.length === 0 ? (
                      <p className="text-xs text-ink-400">No warranty records.</p>
                    ) : (
                      <ul className="space-y-1 text-xs text-ink-700">
                        {detail.warranties.map((w) => (
                          <li key={w.id} className="rounded border border-ink-100 px-2 py-1">
                            <span className="font-medium">{w.provider}</span> —{" "}
                            {formatDate(w.startDate)} → {formatDate(w.endDate)}
                          </li>
                        ))}
                      </ul>
                    )}
                  </section>

                  <section>
                    <h4 className="mb-1.5 text-xs font-semibold uppercase tracking-wide text-ink-400">
                      Sensors ({detail.sensors.length})
                    </h4>
                    {detail.sensors.length === 0 ? (
                      <p className="text-xs text-ink-400">No sensor channels bound.</p>
                    ) : (
                      <ul className="space-y-1 text-xs text-ink-700">
                        {detail.sensors.map((s) => (
                          <li key={s.id} className="rounded border border-ink-100 px-2 py-1">
                            <span className="font-medium">{s.name}</span> · {humanize(s.kind)} (
                            {s.unit})
                          </li>
                        ))}
                      </ul>
                    )}
                  </section>

                  <Button size="sm" variant="secondary" onClick={() => openEdit(detail)}>
                    Edit asset
                  </Button>
                </div>
              )}
            </div>
          </div>
        </div>
      )}

      {/* ------------------------------- form modal ------------------------------ */}
      <Modal
        open={formOpen}
        title={editing ? `Edit asset — ${editing.tagCode}` : "Register asset"}
        onClose={() => setFormOpen(false)}
        wide
      >
        <ErrorAlert message={formError} />
        <form onSubmit={onSubmit} className="space-y-4">
          <div className="grid grid-cols-1 gap-4 sm:grid-cols-2">
            <Field label="Tag code" hint="Unique persistent identifier used on site.">
              <Input
                required
                value={form.tagCode}
                onChange={(e) => setForm((f) => ({ ...f, tagCode: e.target.value }))}
                placeholder="AHU-L3-01"
              />
            </Field>
            <Field label="Name">
              <Input
                required
                value={form.name}
                onChange={(e) => setForm((f) => ({ ...f, name: e.target.value }))}
                placeholder="Air handling unit — Level 3"
              />
            </Field>
            <Field label="Category">
              <Input
                value={form.category}
                onChange={(e) => setForm((f) => ({ ...f, category: e.target.value }))}
                placeholder="HVAC"
              />
            </Field>
            <Field label="Criticality">
              <Select
                value={form.criticality}
                onChange={(e) => setForm((f) => ({ ...f, criticality: e.target.value }))}
              >
                {ASSET_CRITICALITY.map((c) => (
                  <option key={c} value={c}>
                    {humanize(c)}
                  </option>
                ))}
              </Select>
            </Field>
            <Field label="Manufacturer">
              <Input
                value={form.manufacturer}
                onChange={(e) => setForm((f) => ({ ...f, manufacturer: e.target.value }))}
              />
            </Field>
            <Field label="Model number">
              <Input
                value={form.modelNumber}
                onChange={(e) => setForm((f) => ({ ...f, modelNumber: e.target.value }))}
              />
            </Field>
            <Field label="Serial number">
              <Input
                value={form.serialNumber}
                onChange={(e) => setForm((f) => ({ ...f, serialNumber: e.target.value }))}
              />
            </Field>
            <div className="grid grid-cols-2 gap-3">
              <Field label="Warranty start">
                <Input
                  type="date"
                  value={form.warrantyStart}
                  onChange={(e) => setForm((f) => ({ ...f, warrantyStart: e.target.value }))}
                />
              </Field>
              <Field label="Warranty months">
                <Input
                  type="number"
                  min="0"
                  step="1"
                  value={form.warrantyMonths}
                  onChange={(e) => setForm((f) => ({ ...f, warrantyMonths: e.target.value }))}
                />
              </Field>
            </div>
          </div>
          <div className="flex justify-end gap-2">
            <Button variant="secondary" onClick={() => setFormOpen(false)}>
              Cancel
            </Button>
            <Button type="submit" disabled={busy || !form.tagCode.trim() || !form.name.trim()}>
              {busy ? "Saving…" : editing ? "Save changes" : "Register asset"}
            </Button>
          </div>
        </form>
      </Modal>
    </div>
  );
}

function DetailRow({ label, value }: { label: string; value: string | null | undefined }) {
  return (
    <div>
      <dt className="text-ink-400">{label}</dt>
      <dd className="text-ink-800">{value || "—"}</dd>
    </div>
  );
}
