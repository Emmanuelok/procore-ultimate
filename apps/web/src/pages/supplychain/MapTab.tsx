/**
 * MAP — who supplies whom, tier by tier (#913–916). A node carries the
 * engine's latest risk verdict; a link can be declared sole-source, which
 * is the single fact the risk engine most wants to know.
 */
import { useMemo, useState, type FormEvent } from "react";
import { toast } from "sonner";
import { SUPPLY_CRITICALITIES, SUPPLY_LINK_KINDS, SUPPLY_NODE_KINDS } from "@constructos/shared";
import { Alert, Badge, Button, Card, CardBody, Checkbox, Drawer, EmptyState, Field, Input, Select, Skeleton, Textarea } from "../../ui";
import { DataTable, type DataColumns } from "../../ui/data";
import { IconPlus } from "../../ui/icons";
import { api } from "../../lib/api";
import {
  CRITICALITY_TONE,
  EM_DASH,
  KeyValue,
  LONG_LEAD_RISK_TONE,
  LoadError,
  ReasonList,
  RefusalNotice,
  SUPPLIER_RISK_TONE,
  SectionHeading,
  dateTime,
  labelize,
  num,
  optionList,
  useAction,
  useResource,
  type Lookups,
  type MapResponse,
  type NodeDetail,
  type NodeRow,
} from "./supplychainShared";

export default function MapTab({ projectId, lookups, onChanged }: { projectId: string; lookups: Lookups; onChanged: () => void }) {
  const base = `/api/v1/projects/${projectId}/supply-chain`;
  const map = useResource<MapResponse>(`${base}/map`);
  const [createOpen, setCreateOpen] = useState(false);
  const [openNode, setOpenNode] = useState<string | null>(null);
  const detail = useResource<NodeDetail>(openNode ? `${base}/nodes/${openNode}` : null);
  const nodeName = useMemo(() => new Map((map.data?.nodes ?? []).map((n) => [n.id, n.name])), [map.data]);

  function changed() {
    map.reload();
    detail.reload();
    onChanged();
  }

  const columns = useMemo<DataColumns<NodeRow>>(
    () => [
      { id: "tier", header: "Tier", accessor: "tier", type: "number", width: 70, groupable: true },
      { id: "name", header: "Node", accessor: "name", type: "text", sticky: "start", width: 220 },
      { id: "kind", header: "Kind", accessor: "kind", type: "enum", width: 140, groupable: true, cell: ({ row }) => labelize(row.kind) },
      { id: "country", header: "Country", accessor: (row) => row.country ?? "", type: "text", width: 90, groupable: true, cell: ({ row }) => row.country ?? <span className="italic text-content-subtle">unknown</span> },
      { id: "criticality", header: "Criticality", accessor: "criticality", type: "status", width: 120, groupable: true, cell: ({ row }) => <Badge tone={CRITICALITY_TONE[row.criticality] ?? "neutral"} size="xs" dot>{labelize(row.criticality)}</Badge> },
      {
        id: "risk",
        header: "Risk",
        accessor: (row) => row.riskLevel ?? "not_assessed",
        type: "status",
        width: 150,
        groupable: true,
        cell: ({ row }) =>
          row.riskLevel ? (
            <span className="inline-flex items-center gap-1.5">
              <Badge tone={SUPPLIER_RISK_TONE[row.riskLevel] ?? "neutral"} size="xs" dot>
                {labelize(row.riskLevel)}
              </Badge>
              {row.riskScore !== null ? <span className="text-2xs tabular-nums text-content-muted">{num(row.riskScore)}</span> : null}
            </span>
          ) : (
            <span className="text-2xs italic text-content-subtle">not assessed</span>
          ),
      },
      { id: "categories", header: "Supplies", accessor: (row) => row.categories.join(", "), type: "text", width: 200 },
      { id: "leadTimeDays", header: "Lead time (d)", accessor: (row) => row.leadTimeDays ?? null, type: "number", width: 110 },
      { id: "status", header: "Status", accessor: "status", type: "status", width: 100, cell: ({ row }) => <Badge tone={row.status === "active" ? "success" : "neutral"} size="xs">{labelize(row.status)}</Badge> },
    ],
    [],
  );

  const stats = map.data?.stats;

  return (
    <div className="space-y-4">
      {map.error ? <LoadError message={map.error} onRetry={map.reload} /> : null}
      {(map.data?.truncated ?? []).length > 0 ? (
        <Alert tone="warning" title="This map is a lower bound">
          <ReasonList reasons={map.data?.truncated ?? []} tone="danger" />
        </Alert>
      ) : null}
      <div className="grid grid-cols-2 gap-3 md:grid-cols-4">
        <StatCard label="Nodes" value={stats ? num(stats.nodes) : EM_DASH} hint={stats ? `${stats.maxTier} tier${stats.maxTier === 1 ? "" : "s"} deep · ${stats.links} link${stats.links === 1 ? "" : "s"}` : undefined} />
        <StatCard label="Sole-source links" value={stats ? num(stats.soleSourceLinks) : EM_DASH} hint="Declared by the buyer: no alternative source" tone={stats && stats.soleSourceLinks > 0 ? "warning" : undefined} />
        <StatCard label="Countries" value={stats ? num(Object.keys(stats.byCountry).filter((c) => c !== "unknown").length) : EM_DASH} hint={stats && stats.byCountry["unknown"] ? `${stats.byCountry["unknown"]} node(s) with no country` : undefined} />
        <StatCard label="Critical / high risk" value={stats ? `${stats.byRiskLevel["critical"] ?? 0} / ${stats.byRiskLevel["high"] ?? 0}` : EM_DASH} hint={stats?.lastRiskRunAt ? `engine ran ${dateTime(stats.lastRiskRunAt)}` : "engine has not run"} tone={stats && (stats.byRiskLevel["critical"] ?? 0) > 0 ? "danger" : undefined} />
      </div>

      <Card>
        <CardBody>
          <SectionHeading
            title="Supply chain map"
            hint="Tier 1 is contracted directly; tier 2 supplies tier 1; and so on. Open a node to see who feeds it, what it feeds, and why the engine rated it."
            actions={
              <Button size="sm" leadingIcon={IconPlus} onClick={() => setCreateOpen(true)}>
                Add node
              </Button>
            }
          />
          <DataTable<NodeRow>
            tableId="supply-chain-map"
            data={map.data?.nodes ?? []}
            columns={columns}
            getRowId={(row) => row.id}
            loading={map.loading && !map.data}
            height={520}
            stickyHeader
            filterRow
            exportFileName="supply-chain-map"
            searchPlaceholder="Search nodes by name…"
            defaultSort={[{ id: "tier", desc: false }]}
            onRowClick={({ row }) => setOpenNode(row.id)}
            rowTone={(row) => (row.riskLevel === "critical" ? "danger" : undefined)}
            empty={{ title: "No nodes on the map", description: "Start with the tier-1 suppliers and fabricators, then add who supplies them.", action: <Button size="sm" onClick={() => setCreateOpen(true)}>Add the first node</Button> }}
          />
        </CardBody>
      </Card>

      <NodeForm projectId={projectId} open={createOpen} lookups={lookups} onClose={() => setCreateOpen(false)} onCreated={() => { setCreateOpen(false); changed(); }} />
      <NodeDrawer projectId={projectId} nodeId={openNode} detail={detail} nodes={map.data?.nodes ?? []} nodeName={nodeName} lookups={lookups} onClose={() => setOpenNode(null)} onChanged={changed} />
    </div>
  );
}

function StatCard({ label, value, hint, tone }: { label: string; value: string; hint?: string; tone?: "warning" | "danger" }) {
  return (
    <Card>
      <CardBody>
        <div className="text-label uppercase text-content-subtle">{label}</div>
        <div className={`text-display-xs font-semibold tabular-nums ${tone === "danger" ? "text-danger-fg" : tone === "warning" ? "text-warning-fg" : "text-content"}`}>{value}</div>
        {hint ? <div className="text-2xs text-content-muted">{hint}</div> : null}
      </CardBody>
    </Card>
  );
}

function NodeForm({ projectId, open, lookups, onClose, onCreated }: { projectId: string; open: boolean; lookups: Lookups; onClose: () => void; onCreated: () => void }) {
  const action = useAction();
  const [name, setName] = useState("");
  const [kind, setKind] = useState("vendor");
  const [tier, setTier] = useState("1");
  const [country, setCountry] = useState("");
  const [city, setCity] = useState("");
  const [criticality, setCriticality] = useState("medium");
  const [categories, setCategories] = useState("");
  const [vendorId, setVendorId] = useState("");
  const [leadTimeDays, setLeadTimeDays] = useState("");
  const [notes, setNotes] = useState("");

  async function submit(e: FormEvent) {
    e.preventDefault();
    const payload: Record<string, unknown> = { name: name.trim(), kind, tier: Number(tier), criticality, categories: categories.split(",").map((c) => c.trim()).filter(Boolean) };
    if (country.trim()) payload["country"] = country.trim();
    if (city.trim()) payload["city"] = city.trim();
    if (vendorId) payload["vendorId"] = vendorId;
    if (leadTimeDays.trim()) payload["leadTimeDays"] = Number(leadTimeDays);
    if (notes.trim()) payload["notes"] = notes.trim();
    const r = await action.run("create", () => api.post<NodeRow>(`/api/v1/projects/${projectId}/supply-chain/nodes`, payload));
    if (r) {
      toast.success(`${r.name} added to the map`);
      setName("");
      setCategories("");
      setVendorId("");
      onCreated();
    }
  }

  return (
    <Drawer open={open} onClose={onClose} title="Add a supply chain node" description="A tier-3 mill is often known only by name and country; link the vendor record when there is one." size="md">
      <form onSubmit={(e) => void submit(e)} className="space-y-3">
        {action.refusal ? <RefusalNotice refusal={action.refusal} onDismiss={action.clear} /> : null}
        <Field label="Name" required>
          <Input value={name} onChange={(e) => setName(e.target.value)} required maxLength={200} />
        </Field>
        <div className="grid grid-cols-2 gap-3">
          <Field label="Kind">
            <Select value={kind} onChange={(e) => setKind(e.target.value)}>
              {SUPPLY_NODE_KINDS.map((k) => (
                <option key={k} value={k}>
                  {labelize(k)}
                </option>
              ))}
            </Select>
          </Field>
          <Field label="Tier" hint="1 = contracted directly">
            <Input type="number" min={1} max={6} value={tier} onChange={(e) => setTier(e.target.value)} />
          </Field>
          <Field label="Country" hint="ISO alpha-2">
            <Input value={country} onChange={(e) => setCountry(e.target.value)} maxLength={3} placeholder="GB" />
          </Field>
          <Field label="City">
            <Input value={city} onChange={(e) => setCity(e.target.value)} maxLength={120} />
          </Field>
          <Field label="Criticality" hint="critical = single-source on the critical path">
            <Select value={criticality} onChange={(e) => setCriticality(e.target.value)}>
              {SUPPLY_CRITICALITIES.map((c) => (
                <option key={c} value={c}>
                  {labelize(c)}
                </option>
              ))}
            </Select>
          </Field>
          <Field label="Lead time (days)">
            <Input type="number" min={0} value={leadTimeDays} onChange={(e) => setLeadTimeDays(e.target.value)} />
          </Field>
        </div>
        <Field label="Vendor record" hint={lookups.vendors.length === 0 ? "No vendors in the directory (or the directory could not be read)." : "Links the directory record so prequalification financials and screening feed the risk engine."}>
          <Select value={vendorId} onChange={(e) => setVendorId(e.target.value)}>
            {optionList(lookups.vendors, (v) => v.name).map((o) => (
              <option key={o.value} value={o.value}>
                {o.label}
              </option>
            ))}
          </Select>
        </Field>
        <Field label="What they supply" hint="Comma-separated categories or trade codes">
          <Input value={categories} onChange={(e) => setCategories(e.target.value)} placeholder="steel, cladding" />
        </Field>
        <Field label="Notes">
          <Textarea value={notes} onChange={(e) => setNotes(e.target.value)} rows={3} />
        </Field>
        <div className="flex justify-end gap-2">
          <Button type="button" variant="ghost" onClick={onClose}>
            Cancel
          </Button>
          <Button type="submit" loading={action.busy === "create"}>
            Add node
          </Button>
        </div>
      </form>
    </Drawer>
  );
}

interface NodeEdit {
  name: string;
  kind: string;
  tier: string;
  country: string;
  city: string;
  criticality: string;
  categories: string;
  vendorId: string;
  leadTimeDays: string;
  notes: string;
}

const EMPTY_EDIT: NodeEdit = { name: "", kind: "vendor", tier: "1", country: "", city: "", criticality: "medium", categories: "", vendorId: "", leadTimeDays: "", notes: "" };

function NodeDrawer({ projectId, nodeId, detail, nodes, nodeName, lookups, onClose, onChanged }: { projectId: string; nodeId: string | null; detail: { data: NodeDetail | null; loading: boolean; error: string | null; reload: () => void }; nodes: NodeRow[]; nodeName: Map<string, string>; lookups: Lookups; onClose: () => void; onChanged: () => void }) {
  const base = `/api/v1/projects/${projectId}/supply-chain`;
  const action = useAction();
  const d = detail.data;
  const [linkTo, setLinkTo] = useState("");
  const [linkKind, setLinkKind] = useState("supplies");
  const [linkCategory, setLinkCategory] = useState("");
  const [soleSource, setSoleSource] = useState(false);
  const [direction, setDirection] = useState<"downstream" | "upstream">("downstream");
  const [editing, setEditing] = useState(false);
  const [edit, setEdit] = useState<NodeEdit>(EMPTY_EDIT);

  function startEditing() {
    if (!d) return;
    setEdit({
      name: d.name,
      kind: d.kind,
      tier: String(d.tier),
      country: d.country ?? "",
      city: d.city ?? "",
      criticality: d.criticality,
      categories: d.categories.join(", "),
      vendorId: d.vendorId ?? "",
      leadTimeDays: d.leadTimeDays === null ? "" : String(d.leadTimeDays),
      notes: d.notes ?? "",
    });
    setEditing(true);
  }

  /**
   * Everything the create form collects stays editable. A tier or a lead time
   * typed wrong at registration drives the risk engine and the long-lead
   * order-by date; cancelling and re-creating the node would orphan every
   * record that names it.
   */
  async function saveEdit(e: FormEvent) {
    e.preventDefault();
    if (!d) return;
    const payload: Record<string, unknown> = {
      name: edit.name.trim(),
      kind: edit.kind,
      tier: Number(edit.tier),
      criticality: edit.criticality,
      categories: edit.categories.split(",").map((c) => c.trim()).filter(Boolean),
      country: edit.country.trim() ? edit.country.trim() : null,
      city: edit.city.trim() ? edit.city.trim() : null,
      vendorId: edit.vendorId ? edit.vendorId : null,
      leadTimeDays: edit.leadTimeDays.trim() ? Number(edit.leadTimeDays) : null,
      notes: edit.notes.trim() ? edit.notes.trim() : null,
    };
    const r = await action.run("edit", () => api.patch<NodeRow>(`${base}/nodes/${d.id}`, payload));
    if (r) {
      toast.success(`${r.name} updated`);
      setEditing(false);
      onChanged();
    }
  }

  async function addLink(e: FormEvent) {
    e.preventDefault();
    if (!d || !linkTo) return;
    const payload = {
      fromNodeId: direction === "downstream" ? d.id : linkTo,
      toNodeId: direction === "downstream" ? linkTo : d.id,
      kind: linkKind,
      category: linkCategory.trim() || null,
      isSoleSource: soleSource,
    };
    const r = await action.run("link", () => api.post(`${base}/links`, payload));
    if (r) {
      toast.success("Link added");
      setLinkTo("");
      setLinkCategory("");
      setSoleSource(false);
      onChanged();
    }
  }

  async function removeLink(id: string) {
    const r = await action.run(`unlink:${id}`, () => api.del(`${base}/links/${id}`));
    if (r !== null) {
      toast.success("Link removed");
      onChanged();
    }
  }

  async function setStatus(status: string) {
    if (!d) return;
    const r = await action.run("status", () => api.patch(`${base}/nodes/${d.id}`, { status }));
    if (r) {
      toast.success(`Node ${labelize(status).toLowerCase()}`);
      onChanged();
    }
  }

  const latest = d?.latestAssessment ?? null;

  return (
    <Drawer
      open={nodeId !== null}
      onClose={onClose}
      size="lg"
      title={d ? <span className="flex items-center gap-2"><span>{d.name}</span><Badge tone={CRITICALITY_TONE[d.criticality] ?? "neutral"} size="xs" dot>{labelize(d.criticality)}</Badge></span> : "Node"}
      description={d ? `Tier ${d.tier} · ${labelize(d.kind)} · ${d.country ?? "country unknown"}${d.city ? ` · ${d.city}` : ""}` : undefined}
    >
      {detail.error ? (
        <LoadError message={detail.error} onRetry={detail.reload} />
      ) : detail.loading && !d ? (
        <div className="space-y-3">
          <Skeleton height={80} />
          <Skeleton height={160} />
        </div>
      ) : !d ? null : (
        <div className="space-y-5">
          {action.refusal ? <RefusalNotice refusal={action.refusal} onDismiss={action.clear} /> : null}

          <section>
            <SectionHeading title="Risk verdict" hint="From the supplier risk engine's last run. Every flag carries the basis it was read from." />
            {latest ? (
              <div className="space-y-2">
                <div className="flex items-center gap-2">
                  <Badge tone={SUPPLIER_RISK_TONE[latest.level] ?? "neutral"} size="sm" dot>
                    {labelize(latest.level)}
                  </Badge>
                  <span className="text-meta tabular-nums text-content-muted">score {latest.score === null ? "n/a" : num(latest.score)} · {dateTime(latest.assessedAt)}</span>
                </div>
                <p className="text-2xs text-content-muted">{latest.basis}</p>
                {latest.flags.length === 0 ? (
                  <p className="text-meta text-content-muted">No flags.</p>
                ) : (
                  <ul className="space-y-1.5">
                    {latest.flags.map((f, i) => (
                      <li key={i} className="rounded-md border border-border p-2 text-meta">
                        <div className="flex items-center gap-2">
                          <Badge tone={f.severity === "critical" || f.severity === "high" ? "danger" : f.severity === "medium" ? "warning" : "neutral"} size="xs">
                            {f.severity}
                          </Badge>
                          <span className="font-medium">{labelize(f.code)}</span>
                        </div>
                        <div className="mt-1 text-content">{f.detail}</div>
                        <div className="text-2xs text-content-muted">Basis: {f.basis}</div>
                      </li>
                    ))}
                  </ul>
                )}
              </div>
            ) : (
              <p className="text-meta italic text-content-muted">Not assessed yet — run the supplier risk engine from the Supplier risk tab.</p>
            )}
          </section>

          <section>
            <SectionHeading
              title="Record"
              actions={
                editing ? (
                  <Button size="sm" variant="ghost" onClick={() => setEditing(false)}>
                    Cancel edit
                  </Button>
                ) : (
                  <Button size="sm" variant="secondary" onClick={startEditing}>
                    Edit node
                  </Button>
                )
              }
            />
            {editing ? (
              <form onSubmit={(e) => void saveEdit(e)} className="space-y-3 rounded-md border border-border p-3">
                <Field label="Name" required>
                  <Input value={edit.name} onChange={(e) => setEdit({ ...edit, name: e.target.value })} required maxLength={200} />
                </Field>
                <div className="grid grid-cols-2 gap-3">
                  <Field label="Kind">
                    <Select value={edit.kind} onChange={(e) => setEdit({ ...edit, kind: e.target.value })}>
                      {SUPPLY_NODE_KINDS.map((k) => (
                        <option key={k} value={k}>
                          {labelize(k)}
                        </option>
                      ))}
                    </Select>
                  </Field>
                  <Field label="Tier" hint="1 = contracted directly">
                    <Input type="number" min={1} max={6} value={edit.tier} onChange={(e) => setEdit({ ...edit, tier: e.target.value })} />
                  </Field>
                  <Field label="Country" hint="ISO alpha-2">
                    <Input value={edit.country} onChange={(e) => setEdit({ ...edit, country: e.target.value })} maxLength={3} placeholder="GB" />
                  </Field>
                  <Field label="City">
                    <Input value={edit.city} onChange={(e) => setEdit({ ...edit, city: e.target.value })} maxLength={120} />
                  </Field>
                  <Field label="Criticality" hint="feeds the risk engine">
                    <Select value={edit.criticality} onChange={(e) => setEdit({ ...edit, criticality: e.target.value })}>
                      {SUPPLY_CRITICALITIES.map((c) => (
                        <option key={c} value={c}>
                          {labelize(c)}
                        </option>
                      ))}
                    </Select>
                  </Field>
                  <Field label="Lead time (days)">
                    <Input type="number" min={0} value={edit.leadTimeDays} onChange={(e) => setEdit({ ...edit, leadTimeDays: e.target.value })} />
                  </Field>
                </div>
                <Field label="Vendor record">
                  <Select value={edit.vendorId} onChange={(e) => setEdit({ ...edit, vendorId: e.target.value })}>
                    {optionList(lookups.vendors, (v) => v.name).map((o) => (
                      <option key={o.value} value={o.value}>
                        {o.label}
                      </option>
                    ))}
                  </Select>
                </Field>
                <Field label="What they supply" hint="Comma-separated categories or trade codes">
                  <Input value={edit.categories} onChange={(e) => setEdit({ ...edit, categories: e.target.value })} />
                </Field>
                <Field label="Notes">
                  <Textarea rows={3} value={edit.notes} onChange={(e) => setEdit({ ...edit, notes: e.target.value })} />
                </Field>
                <ReasonList reasons={lookups.notes} />
                <div className="flex justify-end">
                  <Button type="submit" size="sm" loading={action.busy === "edit"}>
                    Save changes
                  </Button>
                </div>
              </form>
            ) : (
              <KeyValue
                items={[
                  { label: "Vendor", value: d.vendorId ?? <span className="italic text-content-subtle">not linked</span> },
                  { label: "Screened entity", value: d.entityId ?? <span className="italic text-content-subtle">not linked</span> },
                  { label: "Supplies", value: d.categories.length > 0 ? d.categories.join(", ") : EM_DASH },
                  { label: "Lead time", value: d.leadTimeDays === null ? EM_DASH : `${d.leadTimeDays} days` },
                  { label: "Status", value: labelize(d.status) },
                  { label: "Notes", value: d.notes ?? EM_DASH },
                ]}
              />
            )}
            <div className="mt-2 flex gap-2">
              {d.status !== "active" ? <Button size="sm" variant="secondary" onClick={() => void setStatus("active")}>Reactivate</Button> : null}
              {d.status === "active" ? <Button size="sm" variant="ghost" onClick={() => void setStatus("suspended")}>Suspend</Button> : null}
            </div>
          </section>

          <section>
            <SectionHeading title="Links" hint={`${d.upstream.length} upstream (who feeds this node) · ${d.downstream.length} downstream (who it feeds)`} />
            <LinkList title="Upstream" links={d.upstream} other={(l) => l.fromNodeId} nodeName={nodeName} onRemove={removeLink} busy={action.busy} />
            <LinkList title="Downstream" links={d.downstream} other={(l) => l.toNodeId} nodeName={nodeName} onRemove={removeLink} busy={action.busy} />
            <form onSubmit={(e) => void addLink(e)} className="mt-3 grid grid-cols-2 gap-2 rounded-md border border-border p-3">
              <Field label="Direction">
                <Select value={direction} onChange={(e) => setDirection(e.target.value as "downstream" | "upstream")}>
                  <option value="downstream">This node supplies…</option>
                  <option value="upstream">This node is supplied by…</option>
                </Select>
              </Field>
              <Field label="Other node">
                <Select value={linkTo} onChange={(e) => setLinkTo(e.target.value)}>
                  {optionList(nodes.filter((n) => n.id !== d.id), (n) => `T${n.tier} ${n.name}`).map((o) => (
                    <option key={o.value} value={o.value}>
                      {o.label}
                    </option>
                  ))}
                </Select>
              </Field>
              <Field label="Kind">
                <Select value={linkKind} onChange={(e) => setLinkKind(e.target.value)}>
                  {SUPPLY_LINK_KINDS.map((k) => (
                    <option key={k} value={k}>
                      {labelize(k)}
                    </option>
                  ))}
                </Select>
              </Field>
              <Field label="Category" hint="what flows along the edge">
                <Input value={linkCategory} onChange={(e) => setLinkCategory(e.target.value)} placeholder="steel" />
              </Field>
              <div className="col-span-2 flex items-center justify-between">
                <Checkbox label="Sole source — no alternative exists for this flow" checked={soleSource} onChange={(e) => setSoleSource(e.target.checked)} />
                <Button type="submit" size="sm" loading={action.busy === "link"} disabled={!linkTo}>
                  Add link
                </Button>
              </div>
            </form>
          </section>

          <section>
            <SectionHeading title="Long-lead items from this node" />
            {d.longLeadItems.length === 0 ? (
              <p className="text-meta italic text-content-muted">None.</p>
            ) : (
              <ul className="divide-y divide-border">
                {d.longLeadItems.map((i) => (
                  <li key={i.id} className="flex items-center justify-between gap-2 py-1.5 text-meta">
                    <span className="min-w-0 truncate">
                      <span className="font-mono">{i.reference}</span> {i.name}
                    </span>
                    <span className="flex shrink-0 items-center gap-2">
                      <Badge tone={LONG_LEAD_RISK_TONE[i.riskLevel] ?? "neutral"} size="xs" dot>
                        {labelize(i.riskLevel)}
                      </Badge>
                      <span className="text-2xs text-content-muted">{labelize(i.status)}</span>
                    </span>
                  </li>
                ))}
              </ul>
            )}
          </section>

          {d.assessments.length > 1 ? (
            <section>
              <SectionHeading title="Verdict history" hint="A snapshot is written only when the verdict moved." />
              <ul className="divide-y divide-border">
                {d.assessments.map((a) => (
                  <li key={a.id} className="flex items-center justify-between gap-2 py-1.5 text-meta">
                    <span>{dateTime(a.assessedAt)}</span>
                    <span className="flex items-center gap-2">
                      <Badge tone={SUPPLIER_RISK_TONE[a.level] ?? "neutral"} size="xs" dot>
                        {labelize(a.level)}
                      </Badge>
                      <span className="tabular-nums text-content-muted">{a.score === null ? "n/a" : num(a.score)}</span>
                    </span>
                  </li>
                ))}
              </ul>
            </section>
          ) : null}
          <ReasonList reasons={[]} />
        </div>
      )}
    </Drawer>
  );
}

function LinkList({ title, links, other, nodeName, onRemove, busy }: { title: string; links: NodeDetail["upstream"]; other: (l: NodeDetail["upstream"][number]) => string; nodeName: Map<string, string>; onRemove: (id: string) => void; busy: string | null }) {
  if (links.length === 0) return null;
  return (
    <div className="mb-2">
      <div className="text-2xs uppercase tracking-wide text-content-subtle">{title}</div>
      <ul className="divide-y divide-border">
        {links.map((l) => (
          <li key={l.id} className="flex items-center justify-between gap-2 py-1.5 text-meta">
            <span className="min-w-0 truncate">
              {nodeName.get(other(l)) ?? other(l)} <span className="text-content-muted">· {labelize(l.kind)}{l.category ? ` · ${l.category}` : ""}</span>
              {l.isSoleSource === 1 ? (
                <Badge tone="warning" size="xs" className="ml-2">
                  sole source
                </Badge>
              ) : null}
            </span>
            <Button size="xs" variant="ghost" loading={busy === `unlink:${l.id}`} onClick={() => onRemove(l.id)}>
              Remove
            </Button>
          </li>
        ))}
      </ul>
    </div>
  );
}
