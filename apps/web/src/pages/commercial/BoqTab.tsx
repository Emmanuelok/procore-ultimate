/**
 * Bills of Quantities tab — BoQ register, hierarchical item editor with
 * rate build-ups (#145-149), taking-off dimension sheets with deductions
 * (#135-140), method-of-measurement compliance (#117-134) and CSV
 * import/export so the bill is machine-readable (#191).
 */
import { useCallback, useEffect, useMemo, useState, type FormEvent } from "react";
import { BOQ_ITEM_TYPES, BOQ_LEVELS, BOQ_METHODS } from "@constructos/shared";
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
  Textarea,
  Th,
} from "../../ui";
import { humanize } from "../format";
import {
  boqTone,
  Drawer,
  flattenBoqItems,
  itemTypeTone,
  methodLabel,
  money,
  parseNum,
  qty,
  round2,
  severityTone,
  type BoqDetail,
  type BoqRow,
  type FlatBoqItem,
  type MomReport,
  type TakeoffLine,
} from "./commercialShared";

const RATE_KINDS = ["labour", "material", "plant", "overhead", "profit"] as const;

interface BuildUpDraft {
  kind: string;
  description: string;
  qty: string;
  unit: string;
  rate: string;
}

const emptyBuildUpRow: BuildUpDraft = { kind: "labour", description: "", qty: "1", unit: "", rate: "" };

function buildUpTotal(rows: BuildUpDraft[]): number {
  return round2(
    rows.reduce((s, r) => {
      const q = Number(r.qty);
      const rate = Number(r.rate);
      return Number.isFinite(q) && Number.isFinite(rate) ? s + q * rate : s;
    }, 0),
  );
}

/* ----------------------------- Inline cell edit ---------------------------- */

function InlineNum({
  value,
  disabled,
  onCommit,
}: {
  value: number | null;
  disabled: boolean;
  onCommit: (next: number | null) => void;
}) {
  if (disabled) return <span className="tabular-nums">{value === null ? "—" : qty(value)}</span>;
  return (
    <input
      type="text"
      inputMode="decimal"
      defaultValue={value === null ? "" : String(value)}
      className="w-24 rounded border border-ink-200 px-2 py-1 text-right text-sm tabular-nums focus:border-brand-500 focus:outline-none"
      onBlur={(e) => {
        const parsed = parseNum(e.target.value);
        if (parsed === undefined) return; // not a number — ignore
        if (parsed === value) return;
        onCommit(parsed);
      }}
    />
  );
}

/* ------------------------------ Create BoQ modal --------------------------- */

function CreateBoqModal({
  projectId,
  open,
  onClose,
  onCreated,
}: {
  projectId: string;
  open: boolean;
  onClose: () => void;
  onCreated: (id: string) => void;
}) {
  const [name, setName] = useState("");
  const [method, setMethod] = useState<string>("nrm2");
  const [currency, setCurrency] = useState("USD");
  const [notes, setNotes] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  async function submit(e: FormEvent) {
    e.preventDefault();
    setError(null);
    setBusy(true);
    try {
      const payload: Record<string, unknown> = { name: name.trim(), method };
      if (currency.trim()) payload["currency"] = currency.trim().toUpperCase();
      if (notes.trim()) payload["notes"] = notes.trim();
      const created = await api.post<BoqRow>(`/api/v1/projects/${projectId}/boqs`, payload);
      setName("");
      setNotes("");
      onCreated(created?.id ?? "");
    } catch (err) {
      setError(err instanceof ApiClientError ? err.message : "Failed to create the BoQ.");
    } finally {
      setBusy(false);
    }
  }

  return (
    <Modal open={open} title="New Bill of Quantities" onClose={onClose}>
      <ErrorAlert message={error} />
      <form onSubmit={submit} className="space-y-4">
        <Field label="Name">
          <Input
            required
            value={name}
            onChange={(e) => setName(e.target.value)}
            placeholder="Main contract BQ"
          />
        </Field>
        <div className="grid grid-cols-2 gap-4">
          <Field label="Method of measurement">
            <Select value={method} onChange={(e) => setMethod(e.target.value)}>
              {BOQ_METHODS.map((m) => (
                <option key={m} value={m}>
                  {methodLabel(m)}
                </option>
              ))}
            </Select>
          </Field>
          <Field label="Currency" hint="ISO code, e.g. USD, GBP, AED">
            <Input
              required
              value={currency}
              onChange={(e) => setCurrency(e.target.value)}
              maxLength={8}
            />
          </Field>
        </div>
        <Field label="Notes">
          <Textarea value={notes} onChange={(e) => setNotes(e.target.value)} />
        </Field>
        <div className="flex justify-end gap-2">
          <Button variant="secondary" onClick={onClose}>
            Cancel
          </Button>
          <Button type="submit" disabled={busy || !name.trim()}>
            {busy ? "Creating…" : "Create BoQ"}
          </Button>
        </div>
      </form>
    </Modal>
  );
}

/* ------------------------------ Add item modal ----------------------------- */

function AddItemModal({
  boq,
  open,
  onClose,
  onCreated,
}: {
  boq: BoqDetail;
  open: boolean;
  onClose: () => void;
  onCreated: () => void;
}) {
  const [level, setLevel] = useState<string>("item");
  const [parentId, setParentId] = useState("");
  const [itemType, setItemType] = useState<string>("measured");
  const [code, setCode] = useState("");
  const [description, setDescription] = useState("");
  const [unit, setUnit] = useState("");
  const [quantity, setQuantity] = useState("");
  const [rate, setRate] = useState("");
  const [withBuildUp, setWithBuildUp] = useState(false);
  const [buildUp, setBuildUp] = useState<BuildUpDraft[]>([{ ...emptyBuildUpRow }]);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const parents = useMemo(
    () =>
      boq.items.filter((i) =>
        level === "section" ? i.level === "bill" : i.level === "bill" || i.level === "section",
      ),
    [boq.items, level],
  );
  const computedRate = buildUpTotal(buildUp);
  const isLeaf = level === "item";

  function setRow(idx: number, patch: Partial<BuildUpDraft>) {
    setBuildUp((rows) => rows.map((r, i) => (i === idx ? { ...r, ...patch } : r)));
  }

  async function submit(e: FormEvent) {
    e.preventDefault();
    setError(null);
    if (level !== "bill" && !parentId) {
      setError(`A ${level} needs a parent ${level === "section" ? "bill" : "section or bill"}.`);
      return;
    }
    setBusy(true);
    try {
      const payload: Record<string, unknown> = {
        level,
        code: code.trim(),
        description: description.trim(),
      };
      if (level !== "bill" && parentId) payload["parentId"] = parentId;
      if (isLeaf) {
        payload["itemType"] = itemType;
        if (unit.trim()) payload["unit"] = unit.trim();
        const q = parseNum(quantity);
        if (q !== undefined && q !== null) payload["quantity"] = q;
        if (withBuildUp) {
          const rows = buildUp
            .filter((r) => r.description.trim())
            .map((r) => ({
              kind: r.kind,
              description: r.description.trim(),
              qty: Number(r.qty) || 0,
              unit: r.unit.trim() || null,
              rate: Number(r.rate) || 0,
            }));
          if (rows.length === 0) {
            setError("Add at least one build-up component, or turn the build-up off.");
            setBusy(false);
            return;
          }
          payload["rateBuildUp"] = rows;
        } else {
          const r = parseNum(rate);
          if (r !== undefined && r !== null) payload["rate"] = r;
        }
      }
      await api.post(`/api/v1/boqs/${boq.id}/items`, payload);
      setCode("");
      setDescription("");
      setUnit("");
      setQuantity("");
      setRate("");
      setBuildUp([{ ...emptyBuildUpRow }]);
      onCreated();
    } catch (err) {
      setError(err instanceof ApiClientError ? err.message : "Failed to add the item.");
    } finally {
      setBusy(false);
    }
  }

  return (
    <Modal open={open} title="Add BQ item" onClose={onClose} wide>
      <ErrorAlert message={error} />
      <form onSubmit={submit} className="space-y-4">
        <div className="grid grid-cols-2 gap-4 sm:grid-cols-3">
          <Field label="Level">
            <Select value={level} onChange={(e) => setLevel(e.target.value)}>
              {BOQ_LEVELS.map((l) => (
                <option key={l} value={l}>
                  {humanize(l)}
                </option>
              ))}
            </Select>
          </Field>
          <Field label="Parent" hint={level === "bill" ? "Bills sit at the root" : undefined}>
            <Select
              value={parentId}
              onChange={(e) => setParentId(e.target.value)}
              disabled={level === "bill"}
            >
              <option value="">— select —</option>
              {parents.map((p) => (
                <option key={p.id} value={p.id}>
                  {`${" ".repeat(p.depth * 3)}${p.code} · ${p.description.slice(0, 60)}`}
                </option>
              ))}
            </Select>
          </Field>
          {isLeaf ? (
            <Field label="Item type">
              <Select value={itemType} onChange={(e) => setItemType(e.target.value)}>
                {BOQ_ITEM_TYPES.map((t) => (
                  <option key={t} value={t}>
                    {humanize(t)}
                  </option>
                ))}
              </Select>
            </Field>
          ) : null}
        </div>
        <div className="grid grid-cols-3 gap-4">
          <Field label="Code">
            <Input required value={code} onChange={(e) => setCode(e.target.value)} placeholder="D20.2" />
          </Field>
          <div className="col-span-2">
            <Field label="Description">
              <Input
                required
                value={description}
                onChange={(e) => setDescription(e.target.value)}
                placeholder="Excavating basements; maximum depth ≤ 2m"
              />
            </Field>
          </div>
        </div>
        {isLeaf ? (
          <>
            <div className="grid grid-cols-3 gap-4">
              <Field label="Unit">
                <Input value={unit} onChange={(e) => setUnit(e.target.value)} placeholder="m³" />
              </Field>
              <Field label="Quantity">
                <Input
                  inputMode="decimal"
                  value={quantity}
                  onChange={(e) => setQuantity(e.target.value)}
                />
              </Field>
              <Field
                label="Rate"
                hint={withBuildUp ? "Σ of the build-up components" : undefined}
              >
                <Input
                  inputMode="decimal"
                  value={withBuildUp ? String(computedRate) : rate}
                  onChange={(e) => setRate(e.target.value)}
                  disabled={withBuildUp}
                />
              </Field>
            </div>
            <div className="rounded-md border border-ink-100 p-3">
              <label className="flex items-center gap-2 text-sm text-ink-700">
                <input
                  type="checkbox"
                  checked={withBuildUp}
                  onChange={(e) => setWithBuildUp(e.target.checked)}
                />
                Rate build-up sheet (labour / material / plant / overhead / profit)
              </label>
              {withBuildUp ? (
                <div className="mt-3 space-y-2">
                  {buildUp.map((row, idx) => (
                    <div key={idx} className="flex flex-wrap items-center gap-2">
                      <Select
                        className="w-28"
                        value={row.kind}
                        onChange={(e) => setRow(idx, { kind: e.target.value })}
                      >
                        {RATE_KINDS.map((k) => (
                          <option key={k} value={k}>
                            {humanize(k)}
                          </option>
                        ))}
                      </Select>
                      <Input
                        className="min-w-40 flex-1"
                        placeholder="Component description"
                        value={row.description}
                        onChange={(e) => setRow(idx, { description: e.target.value })}
                      />
                      <Input
                        className="w-20 text-right"
                        inputMode="decimal"
                        placeholder="Qty"
                        value={row.qty}
                        onChange={(e) => setRow(idx, { qty: e.target.value })}
                      />
                      <Input
                        className="w-16"
                        placeholder="Unit"
                        value={row.unit}
                        onChange={(e) => setRow(idx, { unit: e.target.value })}
                      />
                      <Input
                        className="w-24 text-right"
                        inputMode="decimal"
                        placeholder="Rate"
                        value={row.rate}
                        onChange={(e) => setRow(idx, { rate: e.target.value })}
                      />
                      <span className="w-24 text-right text-sm tabular-nums text-ink-600">
                        {money(
                          round2((Number(row.qty) || 0) * (Number(row.rate) || 0)),
                          boq.currency,
                        )}
                      </span>
                      <Button
                        variant="ghost"
                        size="sm"
                        onClick={() => setBuildUp((rows) => rows.filter((_, i) => i !== idx))}
                        disabled={buildUp.length === 1}
                      >
                        ✕
                      </Button>
                    </div>
                  ))}
                  <div className="flex items-center justify-between pt-1">
                    <Button
                      variant="secondary"
                      size="sm"
                      onClick={() => setBuildUp((rows) => [...rows, { ...emptyBuildUpRow }])}
                    >
                      Add component
                    </Button>
                    <span className="text-sm font-medium text-ink-800 tabular-nums">
                      Built-up rate: {money(computedRate, boq.currency)}
                    </span>
                  </div>
                </div>
              ) : null}
            </div>
          </>
        ) : null}
        <div className="flex justify-end gap-2">
          <Button variant="secondary" onClick={onClose}>
            Cancel
          </Button>
          <Button type="submit" disabled={busy}>
            {busy ? "Adding…" : "Add item"}
          </Button>
        </div>
      </form>
    </Modal>
  );
}

/* -------------------------------- Item drawer ------------------------------ */

function ItemDrawer({
  boq,
  item,
  onClose,
  onChanged,
}: {
  boq: BoqDetail;
  item: FlatBoqItem;
  onClose: () => void;
  onChanged: () => void;
}) {
  const [lines, setLines] = useState<TakeoffLine[] | null>(null);
  const [linesTotal, setLinesTotal] = useState(0);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  const [desc, setDesc] = useState("");
  const [timesing, setTimesing] = useState("1");
  const [length, setLength] = useState("");
  const [width, setWidth] = useState("");
  const [depth, setDepth] = useState("");
  const [manualQty, setManualQty] = useState("");

  const editable = boq.status !== "agreed";

  const loadLines = useCallback(async () => {
    try {
      const res = await api.get<{ items: TakeoffLine[]; total: number }>(
        `/api/v1/boq-items/${item.id}/takeoff`,
      );
      setLines(res?.items ?? []);
      setLinesTotal(res?.total ?? 0);
    } catch (err) {
      setLines([]);
      setError(err instanceof Error ? err.message : "Failed to load taking-off lines");
    }
  }, [item.id]);

  useEffect(() => {
    void loadLines();
  }, [loadLines]);

  const manual = parseNum(manualQty);
  const dims = [length, width, depth]
    .map((d) => parseNum(d))
    .filter((d): d is number => typeof d === "number");
  const tParsed = parseNum(timesing);
  const t = tParsed === null ? 1 : tParsed; // blank timesing defaults to 1
  const preview =
    typeof manual === "number"
      ? manual
      : dims.length > 0 && typeof t === "number"
        ? Math.round(t * dims.reduce((p, d) => p * d, 1) * 1000) / 1000
        : null;

  async function addLine(e: FormEvent) {
    e.preventDefault();
    setError(null);
    setBusy(true);
    try {
      const payload: Record<string, unknown> = { description: desc.trim() };
      if (typeof t === "number" && t > 0) payload["timesing"] = t;
      if (typeof manual === "number") {
        payload["quantity"] = manual;
      } else {
        const l = parseNum(length);
        const w = parseNum(width);
        const d = parseNum(depth);
        if (typeof l === "number") payload["length"] = l;
        if (typeof w === "number") payload["width"] = w;
        if (typeof d === "number") payload["depth"] = d;
      }
      await api.post(`/api/v1/boq-items/${item.id}/takeoff`, payload);
      setDesc("");
      setLength("");
      setWidth("");
      setDepth("");
      setManualQty("");
      setTimesing("1");
      await loadLines();
    } catch (err) {
      setError(err instanceof ApiClientError ? err.message : "Failed to add the dimension line.");
    } finally {
      setBusy(false);
    }
  }

  async function deleteLine(lineId: string) {
    setError(null);
    try {
      await api.del(`/api/v1/takeoff-lines/${lineId}`);
      await loadLines();
    } catch (err) {
      setError(err instanceof ApiClientError ? err.message : "Failed to delete the line.");
    }
  }

  async function applyTakeoff() {
    setError(null);
    setBusy(true);
    try {
      await api.post(`/api/v1/boq-items/${item.id}/takeoff/apply`);
      onChanged();
    } catch (err) {
      setError(err instanceof ApiClientError ? err.message : "Failed to apply the take-off.");
    } finally {
      setBusy(false);
    }
  }

  async function deleteItem() {
    setError(null);
    setBusy(true);
    try {
      await api.del(`/api/v1/boq-items/${item.id}`);
      onClose();
      onChanged();
    } catch (err) {
      setError(err instanceof ApiClientError ? err.message : "Failed to delete the item.");
      setBusy(false);
    }
  }

  return (
    <Drawer open title={`${item.code} — BQ item`} onClose={onClose} wide>
      <ErrorAlert message={error} />
      <p className="mb-3 text-sm text-ink-700">{item.description}</p>
      <div className="mb-4 grid grid-cols-4 gap-3 text-sm">
        <div>
          <div className="text-xs uppercase tracking-wide text-ink-400">Unit</div>
          <div className="text-ink-800">{item.unit ?? "—"}</div>
        </div>
        <div>
          <div className="text-xs uppercase tracking-wide text-ink-400">Quantity</div>
          <div className="tabular-nums text-ink-800">{qty(item.quantity)}</div>
        </div>
        <div>
          <div className="text-xs uppercase tracking-wide text-ink-400">Rate</div>
          <div className="tabular-nums text-ink-800">{money(item.rate, boq.currency)}</div>
        </div>
        <div>
          <div className="text-xs uppercase tracking-wide text-ink-400">Amount</div>
          <div className="tabular-nums font-medium text-ink-900">
            {money(item.amount, boq.currency)}
          </div>
        </div>
      </div>
      {item.itemType !== "measured" ? (
        <div className="mb-4">
          <Badge tone={itemTypeTone(item.itemType)}>{humanize(item.itemType)}</Badge>
        </div>
      ) : null}

      {item.rateBuildUp && item.rateBuildUp.length > 0 ? (
        <div className="mb-5">
          <h3 className="mb-2 text-sm font-semibold text-ink-900">Rate build-up</h3>
          <div className="overflow-x-auto rounded-md ring-1 ring-ink-100">
            <table className="min-w-full divide-y divide-ink-100 text-sm">
              <thead>
                <tr>
                  <Th>Kind</Th>
                  <Th>Description</Th>
                  <Th className="text-right">Qty</Th>
                  <Th className="text-right">Rate</Th>
                  <Th className="text-right">Amount</Th>
                </tr>
              </thead>
              <tbody className="divide-y divide-ink-100">
                {item.rateBuildUp.map((c, i) => (
                  <tr key={i}>
                    <Td>{humanize(c.kind)}</Td>
                    <Td>{c.description}</Td>
                    <Td className="text-right tabular-nums">{qty(c.qty)}</Td>
                    <Td className="text-right tabular-nums">{money(c.rate, boq.currency)}</Td>
                    <Td className="text-right tabular-nums">
                      {money(c.amount ?? round2(c.qty * c.rate), boq.currency)}
                    </Td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        </div>
      ) : null}

      <div className="mb-2 flex items-center justify-between">
        <h3 className="text-sm font-semibold text-ink-900">Taking-off (dimension sheet)</h3>
        {lines !== null ? (
          <span className="text-xs text-ink-400">
            Σ lines: <span className="tabular-nums">{qty(linesTotal)}</span>
          </span>
        ) : null}
      </div>
      {lines === null ? (
        <Spinner />
      ) : lines.length === 0 ? (
        <p className="mb-3 text-sm text-ink-400">
          No dimension lines yet — every quantity should trace to a measured source.
        </p>
      ) : (
        <div className="mb-3 overflow-x-auto rounded-md ring-1 ring-ink-100">
          <table className="min-w-full divide-y divide-ink-100 text-sm">
            <thead>
              <tr>
                <Th>Description</Th>
                <Th className="text-right">×</Th>
                <Th className="text-right">L</Th>
                <Th className="text-right">W</Th>
                <Th className="text-right">D</Th>
                <Th className="text-right">Qty</Th>
                <Th />
              </tr>
            </thead>
            <tbody className="divide-y divide-ink-100">
              {lines.map((l) => (
                <tr key={l.id}>
                  <Td>
                    {l.description}
                    {l.isManual ? (
                      <span className="ml-1.5 text-xs text-amber-600">(manual)</span>
                    ) : null}
                  </Td>
                  <Td className="text-right tabular-nums">{qty(l.timesing)}</Td>
                  <Td className="text-right tabular-nums">{l.length !== null ? qty(l.length) : "—"}</Td>
                  <Td className="text-right tabular-nums">{l.width !== null ? qty(l.width) : "—"}</Td>
                  <Td className="text-right tabular-nums">{l.depth !== null ? qty(l.depth) : "—"}</Td>
                  <Td className="text-right font-medium tabular-nums">{qty(l.quantity)}</Td>
                  <Td className="text-right">
                    {editable ? (
                      <button
                        type="button"
                        className="text-xs text-red-600 hover:underline"
                        onClick={() => void deleteLine(l.id)}
                      >
                        Delete
                      </button>
                    ) : null}
                  </Td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}

      {editable ? (
        <form onSubmit={addLine} className="mb-4 space-y-2 rounded-md border border-ink-100 p-3">
          <Input
            required
            placeholder="Dimension description (e.g. Basement, grid 1–4)"
            value={desc}
            onChange={(e) => setDesc(e.target.value)}
          />
          <div className="flex flex-wrap items-center gap-2">
            <Input
              className="w-16 text-right"
              inputMode="decimal"
              title="Timesing"
              placeholder="×"
              value={timesing}
              onChange={(e) => setTimesing(e.target.value)}
            />
            <Input
              className="w-20 text-right"
              inputMode="decimal"
              placeholder="Length"
              value={length}
              onChange={(e) => setLength(e.target.value)}
            />
            <Input
              className="w-20 text-right"
              inputMode="decimal"
              placeholder="Width"
              value={width}
              onChange={(e) => setWidth(e.target.value)}
            />
            <Input
              className="w-20 text-right"
              inputMode="decimal"
              placeholder="Depth"
              value={depth}
              onChange={(e) => setDepth(e.target.value)}
            />
            <span className="text-xs text-ink-400">or</span>
            <Input
              className="w-24 text-right"
              inputMode="decimal"
              placeholder="Manual qty"
              value={manualQty}
              onChange={(e) => setManualQty(e.target.value)}
            />
            <span className="ml-auto text-sm text-ink-600">
              Line qty:{" "}
              <span className="font-medium tabular-nums">
                {preview !== null ? qty(preview) : "—"}
              </span>
            </span>
            <Button type="submit" size="sm" disabled={busy || !desc.trim() || preview === null}>
              Add line
            </Button>
          </div>
        </form>
      ) : null}

      <div className="flex items-center justify-between">
        {editable ? (
          <Button
            variant="secondary"
            disabled={busy || !lines || lines.length === 0}
            onClick={() => void applyTakeoff()}
          >
            Apply {lines?.length ?? 0} line{(lines?.length ?? 0) === 1 ? "" : "s"} → item quantity
          </Button>
        ) : (
          <span className="text-xs text-ink-400">Agreed BoQ — measurement is locked.</span>
        )}
        {boq.status === "draft" ? (
          <Button variant="danger" size="sm" disabled={busy} onClick={() => void deleteItem()}>
            Delete item
          </Button>
        ) : null}
      </div>
    </Drawer>
  );
}

/* ---------------------------------- BoQ tab -------------------------------- */

export default function BoqTab({
  projectId,
  boqs,
  onMutate,
}: {
  projectId: string;
  boqs: BoqRow[] | null;
  onMutate: () => void;
}) {
  const [selectedId, setSelectedId] = useState<string | null>(null);
  const [detail, setDetail] = useState<BoqDetail | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [createOpen, setCreateOpen] = useState(false);
  const [addOpen, setAddOpen] = useState(false);
  const [drawerItemId, setDrawerItemId] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  const loadDetail = useCallback(async (id: string) => {
    setError(null);
    try {
      const raw = await api.get<Omit<BoqDetail, "items"> & { items?: unknown }>(
        `/api/v1/boqs/${id}`,
      );
      setDetail({ ...raw, items: flattenBoqItems(raw?.items) });
    } catch (err) {
      setDetail(null);
      setError(err instanceof Error ? err.message : "Failed to load the BoQ");
    }
  }, []);

  useEffect(() => {
    if (selectedId) void loadDetail(selectedId);
    else setDetail(null);
  }, [selectedId, loadDetail]);

  const refresh = useCallback(() => {
    if (selectedId) void loadDetail(selectedId);
    onMutate();
  }, [selectedId, loadDetail, onMutate]);

  async function patchItem(itemId: string, patch: Record<string, unknown>) {
    setError(null);
    try {
      await api.patch(`/api/v1/boq-items/${itemId}`, patch);
      refresh();
    } catch (err) {
      setError(err instanceof ApiClientError ? err.message : "Failed to save the item.");
    }
  }

  async function setStatus(next: string) {
    if (!detail) return;
    setError(null);
    setBusy(true);
    try {
      await api.patch(`/api/v1/boqs/${detail.id}`, { status: next });
      refresh();
    } catch (err) {
      setError(err instanceof ApiClientError ? err.message : "Failed to update the status.");
    } finally {
      setBusy(false);
    }
  }

  /* ------------------------------ list view ------------------------------ */

  if (!selectedId) {
    return (
      <div>
        <div className="mb-4 flex items-center justify-between">
          <h2 className="text-sm font-semibold text-ink-900">Bills of Quantities</h2>
          <Button onClick={() => setCreateOpen(true)}>New BoQ</Button>
        </div>
        <ErrorAlert message={error} />
        {boqs === null ? (
          <Spinner />
        ) : boqs.length === 0 ? (
          <EmptyState
            title="No Bills of Quantities yet"
            hint="The BQ is the contract's commercial spine — create one to start measuring."
            action={<Button onClick={() => setCreateOpen(true)}>Create the first BoQ</Button>}
          />
        ) : (
          <Table>
            <thead>
              <tr>
                <Th>Name</Th>
                <Th>Method</Th>
                <Th>Status</Th>
                <Th className="text-right">Items</Th>
                <Th className="text-right">Total</Th>
              </tr>
            </thead>
            <tbody className="divide-y divide-ink-100">
              {boqs.map((b) => (
                <tr
                  key={b.id}
                  className="cursor-pointer hover:bg-ink-50/60"
                  onClick={() => setSelectedId(b.id)}
                >
                  <Td>
                    <span className="font-medium text-brand-700">{b.name}</span>
                    <span className="ml-2 text-xs text-ink-400">v{b.version}</span>
                  </Td>
                  <Td>
                    <Badge tone="blue">{methodLabel(b.method)}</Badge>
                  </Td>
                  <Td>
                    <Badge tone={boqTone(b.status)}>{humanize(b.status)}</Badge>
                  </Td>
                  <Td className="text-right tabular-nums">{b.itemCount ?? 0}</Td>
                  <Td className="text-right font-medium tabular-nums">
                    {money(b.totalAmount ?? 0, b.currency)}
                  </Td>
                </tr>
              ))}
            </tbody>
          </Table>
        )}
        <CreateBoqModal
          projectId={projectId}
          open={createOpen}
          onClose={() => setCreateOpen(false)}
          onCreated={(id) => {
            setCreateOpen(false);
            onMutate();
            if (id) setSelectedId(id);
          }}
        />
      </div>
    );
  }

  /* ----------------------------- editor view ----------------------------- */

  const editable = detail !== null && detail.status !== "agreed";
  const drawerItem = detail?.items.find((i) => i.id === drawerItemId) ?? null;

  return (
    <div>
      <div className="mb-4 flex flex-wrap items-center justify-between gap-3">
        <div className="flex items-center gap-3">
          <Button variant="ghost" size="sm" onClick={() => setSelectedId(null)}>
            ← All bills
          </Button>
          {detail ? (
            <>
              <h2 className="text-sm font-semibold text-ink-900">{detail.name}</h2>
              <Badge tone="blue">{methodLabel(detail.method)}</Badge>
              <Badge tone={boqTone(detail.status)}>{humanize(detail.status)}</Badge>
            </>
          ) : null}
        </div>
        {detail ? (
          <div className="flex items-center gap-2">
            <span className="mr-2 text-sm text-ink-600">
              Total:{" "}
              <span className="font-semibold tabular-nums text-ink-900">
                {money(detail.totalAmount ?? 0, detail.currency)}
              </span>
            </span>
            {editable ? (
              <Button variant="secondary" size="sm" onClick={() => setAddOpen(true)}>
                Add item
              </Button>
            ) : null}
            {detail.status === "draft" ? (
              <Button size="sm" disabled={busy} onClick={() => void setStatus("issued")}>
                Issue
              </Button>
            ) : null}
            {detail.status === "issued" ? (
              <Button size="sm" disabled={busy} onClick={() => void setStatus("agreed")}>
                Mark agreed
              </Button>
            ) : null}
          </div>
        ) : null}
      </div>

      <ErrorAlert message={error} />

      {detail !== null ? (
        <BillToolsPanel
          boq={detail}
          editable={editable}
          onImported={refresh}
          onError={setError}
        />
      ) : null}

      {detail === null ? (
        <Spinner />
      ) : detail.items.length === 0 ? (
        <EmptyState
          title="Empty bill"
          hint="Add a bill, then sections, then measured items."
          action={
            editable ? <Button onClick={() => setAddOpen(true)}>Add the first item</Button> : undefined
          }
        />
      ) : (
        <Table>
          <thead>
            <tr>
              <Th>Code</Th>
              <Th>Description</Th>
              <Th>Unit</Th>
              <Th className="text-right">Qty</Th>
              <Th className="text-right">Rate</Th>
              <Th className="text-right">Amount</Th>
              <Th />
            </tr>
          </thead>
          <tbody className="divide-y divide-ink-100">
            {detail.items.map((it) => {
              const leaf = it.level === "item";
              return (
                <tr key={it.id} className={leaf ? "hover:bg-ink-50/60" : "bg-ink-50/40"}>
                  <Td className="whitespace-nowrap font-mono text-xs">{it.code}</Td>
                  <Td>
                    <span style={{ paddingLeft: `${it.depth * 1.25}rem` }}>
                      <span className={leaf ? "" : "font-semibold text-ink-900"}>
                        {it.description}
                      </span>
                      {leaf && it.itemType !== "measured" ? (
                        <span className="ml-2 align-middle">
                          <Badge tone={itemTypeTone(it.itemType)}>{humanize(it.itemType)}</Badge>
                        </span>
                      ) : null}
                    </span>
                  </Td>
                  <Td>{leaf ? (it.unit ?? "—") : ""}</Td>
                  <Td className="text-right tabular-nums">
                    {leaf ? (
                      <InlineNum
                        key={`${it.id}-q-${it.quantity ?? "n"}`}
                        value={it.quantity}
                        disabled={!editable}
                        onCommit={(v) => void patchItem(it.id, { quantity: v })}
                      />
                    ) : (
                      ""
                    )}
                  </Td>
                  <Td className="text-right tabular-nums">
                    {leaf ? (
                      <InlineNum
                        key={`${it.id}-r-${it.rate ?? "n"}`}
                        value={it.rate}
                        disabled={!editable || (it.rateBuildUp?.length ?? 0) > 0}
                        onCommit={(v) => void patchItem(it.id, { rate: v })}
                      />
                    ) : (
                      ""
                    )}
                  </Td>
                  <Td className="text-right font-medium tabular-nums">
                    {leaf ? money(it.amount, detail.currency) : ""}
                  </Td>
                  <Td className="text-right">
                    {leaf ? (
                      <button
                        type="button"
                        className="text-xs font-medium text-brand-700 hover:underline"
                        onClick={() => setDrawerItemId(it.id)}
                      >
                        Open
                      </button>
                    ) : null}
                  </Td>
                </tr>
              );
            })}
          </tbody>
        </Table>
      )}

      {detail ? (
        <AddItemModal
          boq={detail}
          open={addOpen}
          onClose={() => setAddOpen(false)}
          onCreated={() => {
            setAddOpen(false);
            refresh();
          }}
        />
      ) : null}
      {detail && drawerItem ? (
        <ItemDrawer
          boq={detail}
          item={drawerItem}
          onClose={() => setDrawerItemId(null)}
          onChanged={refresh}
        />
      ) : null}
    </div>
  );
}


/* -------------------- Measurement check + CSV interchange ------------------ */

/**
 * Two things a bill needs that a grid cannot show: whether it actually
 * complies with the measurement standard it claims, and a way in and out as
 * CSV so an estimating package or an ERP can exchange it.
 */
function BillToolsPanel({
  boq,
  editable,
  onImported,
  onError,
}: {
  boq: BoqDetail;
  editable: boolean;
  onImported: () => void;
  onError: (message: string | null) => void;
}) {
  const [report, setReport] = useState<MomReport | null>(null);
  const [open, setOpen] = useState(false);
  const [checking, setChecking] = useState(false);
  const [importOpen, setImportOpen] = useState(false);
  const [csv, setCsv] = useState("");
  const [replace, setReplace] = useState(false);
  const [importing, setImporting] = useState(false);
  const [importResult, setImportResult] = useState<{
    imported: number;
    rejected: number;
    errors: string[];
  } | null>(null);

  const check = useCallback(async () => {
    setChecking(true);
    onError(null);
    try {
      setReport(await api.get<MomReport>(`/api/v1/boqs/${boq.id}/measurement-check`));
      setOpen(true);
    } catch (err) {
      onError(err instanceof Error ? err.message : "Failed to run the measurement check");
    } finally {
      setChecking(false);
    }
  }, [boq.id, onError]);

  async function exportCsv() {
    onError(null);
    try {
      const text = await api.get<string>(`/api/v1/boqs/${boq.id}/export?format=csv`);
      const blob = new Blob([typeof text === "string" ? text : JSON.stringify(text)], {
        type: "text/csv;charset=utf-8",
      });
      const url = URL.createObjectURL(blob);
      const a = document.createElement("a");
      a.href = url;
      a.download = `${boq.name.replace(/[^\w.-]+/g, "_")}.csv`;
      a.click();
      URL.revokeObjectURL(url);
    } catch (err) {
      onError(err instanceof Error ? err.message : "Failed to export the bill");
    }
  }

  const score = report?.complianceScore;

  return (
    <div className="mb-4 flex flex-wrap items-center gap-2 rounded-md bg-ink-50 px-3 py-2">
      <span className="text-xs font-semibold uppercase tracking-wide text-ink-500">
        {methodLabel(boq.method)} compliance
      </span>
      {report ? (
        <>
          <Badge tone={report.counts.error > 0 ? "red" : report.counts.warning > 0 ? "amber" : "green"}>
            {report.counts.error} error{report.counts.error === 1 ? "" : "s"} ·{" "}
            {report.counts.warning} warning{report.counts.warning === 1 ? "" : "s"}
          </Badge>
          {score != null ? <Badge tone="gray">{score}/100</Badge> : null}
          <button
            type="button"
            className="text-xs font-medium text-brand-700 hover:text-brand-900"
            onClick={() => setOpen(true)}
          >
            View findings
          </button>
        </>
      ) : (
        <span className="text-xs text-ink-400">Not checked yet</span>
      )}
      <div className="ml-auto flex items-center gap-2">
        <Button variant="secondary" size="sm" disabled={checking} onClick={() => void check()}>
          {checking ? "Checking…" : "Run measurement check"}
        </Button>
        <Button variant="secondary" size="sm" onClick={() => void exportCsv()}>
          Export CSV
        </Button>
        {editable && boq.status === "draft" ? (
          <Button variant="secondary" size="sm" onClick={() => setImportOpen(true)}>
            Import CSV
          </Button>
        ) : null}
      </div>

      <Drawer
        open={open && report !== null}
        title={`Measurement check — ${report?.standardName ?? ""}`}
        onClose={() => setOpen(false)}
        wide
      >
        {report ? (
          <>
            <p className="mb-3 text-sm text-ink-600">
              {report.itemsChecked} measured item{report.itemsChecked === 1 ? "" : "s"} checked.
              {report.notes.length > 0 ? ` ${report.notes.join(" ")}` : ""}
            </p>
            {report.findings.length === 0 ? (
              <EmptyState
                title="No findings"
                hint="The bill matches every rule this engine can check from the record itself."
              />
            ) : (
              <Table>
                <thead>
                  <tr>
                    <Th>Severity</Th>
                    <Th>Item</Th>
                    <Th>Finding</Th>
                    <Th>Rule</Th>
                  </tr>
                </thead>
                <tbody className="divide-y divide-ink-100">
                  {report.findings.map((f, i) => (
                    <tr key={`${f.ruleId}-${f.itemId ?? i}`}>
                      <Td>
                        <Badge tone={severityTone(f.severity)}>{humanize(f.severity)}</Badge>
                      </Td>
                      <Td className="whitespace-nowrap font-mono text-xs">{f.code ?? "—"}</Td>
                      <Td className="text-sm">{f.message}</Td>
                      <Td className="text-xs text-ink-400">
                        {f.ruleId}
                        <span className="block">{f.reference}</span>
                      </Td>
                    </tr>
                  ))}
                </tbody>
              </Table>
            )}
          </>
        ) : null}
      </Drawer>

      <Modal open={importOpen} title="Import bill items from CSV" onClose={() => setImportOpen(false)}>
        <p className="mb-3 text-sm text-ink-600">
          The file needs at least <code>code</code> and <code>description</code> columns; unit,
          quantity, rate, level and itemType are used when present. Bills and sections are created
          from the depth of the code (5, 5.2, 5.2.1) when the level is not stated.
        </p>
        <Field label="CSV">
          <Textarea
            rows={8}
            value={csv}
            onChange={(e) => setCsv(e.target.value)}
            placeholder="code,description,unit,quantity,rate&#10;5,Substructure,,,&#10;5.1,Excavation,m3,120,32"
          />
        </Field>
        <label className="mt-2 flex items-center gap-2 text-sm text-ink-600">
          <input type="checkbox" checked={replace} onChange={(e) => setReplace(e.target.checked)} />
          Replace the existing items instead of appending
        </label>
        {importResult ? (
          <div className="mt-3 rounded-md bg-emerald-50 p-2 text-xs text-emerald-900 ring-1 ring-emerald-100">
            Imported {importResult.imported} row{importResult.imported === 1 ? "" : "s"}
            {importResult.rejected > 0 ? `, rejected ${importResult.rejected}` : ""}.
            {importResult.errors.length > 0 ? (
              <ul className="mt-1 space-y-0.5">
                {importResult.errors.slice(0, 5).map((e) => (
                  <li key={e}>• {e}</li>
                ))}
              </ul>
            ) : null}
          </div>
        ) : null}
        <div className="mt-4 flex justify-end gap-2">
          <Button variant="secondary" onClick={() => setImportOpen(false)}>
            Close
          </Button>
          <Button
            disabled={importing || csv.trim().length === 0}
            onClick={() => {
              setImporting(true);
              onError(null);
              api
                .post<{ imported: number; rejected: number; errors: string[] }>(
                  `/api/v1/boqs/${boq.id}/import`,
                  { content: csv, replace },
                )
                .then((res) => {
                  setImportResult(res);
                  setCsv("");
                  onImported();
                })
                .catch((err: unknown) =>
                  onError(err instanceof ApiClientError ? err.message : "Import failed"),
                )
                .finally(() => setImporting(false));
            }}
          >
            {importing ? "Importing…" : "Import"}
          </Button>
        </div>
      </Modal>
    </div>
  );
}
