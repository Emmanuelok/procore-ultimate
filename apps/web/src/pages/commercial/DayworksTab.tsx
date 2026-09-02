/**
 * Dayworks tab (spec Vol II Domain B #150-161, #132).
 *
 * A daywork sheet is a two-party site record: the contractor records the
 * resources used, the administrator verifies them, and only a verified sheet
 * can be valued. Percentage additions come from the contract's daywork
 * schedule and are applied per resource class, which is why the sheet shows
 * net, addition and gross separately rather than one number.
 */
import { useCallback, useEffect, useState } from "react";
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
  Select,
  Spinner,
  Table,
  Td,
  Textarea,
  Th,
} from "../../ui";
import { formatDate, humanize } from "../format";
import {
  Drawer,
  dayworkStatusTone,
  money,
  padNo,
  parseNum,
  qty,
  todayIso,
  useCompanyUsers,
  type DayworkSheetRow,
  type ListResponse,
} from "./commercialShared";

const KINDS = ["labour", "material", "plant"] as const;

interface DayworkListResponse extends ListResponse<DayworkSheetRow> {
  byCurrency: Array<{ currency: string; verified: number; pending: number }>;
}

export default function DayworksTab({
  projectId,
  currency,
  onMutate,
}: {
  projectId: string;
  currency: string;
  onMutate: () => void;
}) {
  const [rows, setRows] = useState<DayworkSheetRow[] | null>(null);
  const [totals, setTotals] = useState<DayworkListResponse["byCurrency"]>([]);
  const [error, setError] = useState<string | null>(null);
  const [openId, setOpenId] = useState<string | null>(null);
  const [detail, setDetail] = useState<DayworkSheetRow | null>(null);
  const [creating, setCreating] = useState(false);
  const { nameOf } = useCompanyUsers();

  const load = useCallback(async () => {
    setError(null);
    try {
      const res = await api.get<DayworkListResponse>(
        `/api/v1/projects/${projectId}/daywork-sheets?pageSize=200`,
      );
      setRows(res?.items ?? []);
      setTotals(res?.byCurrency ?? []);
    } catch (err) {
      setRows([]);
      setError(err instanceof Error ? err.message : "Failed to load daywork sheets");
    }
  }, [projectId]);

  const loadDetail = useCallback(async (id: string) => {
    try {
      setDetail(await api.get<DayworkSheetRow>(`/api/v1/daywork-sheets/${id}`));
    } catch (err) {
      setError(err instanceof Error ? err.message : "Failed to load the sheet");
    }
  }, []);

  useEffect(() => {
    void load();
  }, [load]);

  useEffect(() => {
    if (openId) void loadDetail(openId);
    else setDetail(null);
  }, [openId, loadDetail]);

  async function refreshAll() {
    await load();
    if (openId) await loadDetail(openId);
    onMutate();
  }

  return (
    <div>
      <div className="mb-4 flex flex-wrap items-center justify-between gap-3">
        <div>
          <h2 className="text-sm font-semibold text-ink-900">Daywork sheets</h2>
          <p className="mt-0.5 text-xs text-ink-500">
            Verified sheets flow into an application as a typed daywork section.
          </p>
        </div>
        <Button size="sm" onClick={() => setCreating(true)}>
          New daywork sheet
        </Button>
      </div>

      <ErrorAlert message={error} />

      {totals.length > 0 ? (
        <div className="mb-4 flex flex-wrap gap-2">
          {totals.map((t) => (
            <Badge key={t.currency} tone="gray">
              {t.currency}: {money(t.verified, t.currency)} verified ·{" "}
              {money(t.pending, t.currency)} pending
            </Badge>
          ))}
        </div>
      ) : null}

      {rows === null ? (
        <Spinner />
      ) : rows.length === 0 ? (
        <EmptyState
          title="No daywork sheets"
          hint="Record the labour, plant and materials used on instructed work that cannot be valued at BQ rates."
        />
      ) : (
        <Table>
          <thead>
            <tr>
              <Th>No.</Th>
              <Th>Date</Th>
              <Th>Description</Th>
              <Th className="text-right">Net</Th>
              <Th className="text-right">Additions</Th>
              <Th className="text-right">Gross</Th>
              <Th>Verified by</Th>
              <Th>Status</Th>
            </tr>
          </thead>
          <tbody className="divide-y divide-ink-100">
            {rows.map((s) => (
              <tr
                key={s.id}
                className="cursor-pointer hover:bg-ink-50/60"
                onClick={() => setOpenId(s.id)}
              >
                <Td className="whitespace-nowrap font-mono text-xs font-medium">
                  {padNo("DW", s.number)}
                </Td>
                <Td className="whitespace-nowrap">{formatDate(s.workDate)}</Td>
                <Td className="max-w-md truncate">{s.description}</Td>
                <Td className="text-right tabular-nums">{money(s.netTotal, s.currency)}</Td>
                <Td className="text-right tabular-nums text-ink-500">
                  {money(s.additionTotal, s.currency)}
                </Td>
                <Td className="text-right font-medium tabular-nums">
                  {money(s.grossTotal, s.currency)}
                </Td>
                <Td className="whitespace-nowrap text-xs text-ink-500">
                  {s.verifiedBy ? nameOf(s.verifiedBy) : "—"}
                </Td>
                <Td>
                  <Badge tone={dayworkStatusTone(s.status)}>{humanize(s.status)}</Badge>
                </Td>
              </tr>
            ))}
          </tbody>
        </Table>
      )}

      <CreateSheetDrawer
        open={creating}
        projectId={projectId}
        currency={currency}
        onClose={() => setCreating(false)}
        onCreated={async (id) => {
          setCreating(false);
          await refreshAll();
          setOpenId(id);
        }}
      />

      <SheetDrawer
        sheet={detail}
        open={openId !== null}
        onClose={() => setOpenId(null)}
        onChanged={refreshAll}
        nameOf={nameOf}
      />
    </div>
  );
}

function CreateSheetDrawer({
  open,
  projectId,
  currency,
  onClose,
  onCreated,
}: {
  open: boolean;
  projectId: string;
  currency: string;
  onClose: () => void;
  onCreated: (id: string) => void;
}) {
  const [workDate, setWorkDate] = useState(todayIso());
  const [description, setDescription] = useState("");
  const [location, setLocation] = useState("");
  const [instructionRef, setInstructionRef] = useState("");
  const [additions, setAdditions] = useState({ labour: "80", material: "15", plant: "10" });
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  async function submit() {
    setError(null);
    setBusy(true);
    try {
      const percentAdditions: Record<string, number> = {};
      for (const k of KINDS) {
        const n = parseNum(additions[k]);
        if (n != null) percentAdditions[k] = n;
      }
      const created = await api.post<{ id: string }>(
        `/api/v1/projects/${projectId}/daywork-sheets`,
        {
          workDate,
          description,
          location: location || null,
          instructionRef: instructionRef || null,
          percentAdditions,
          currency,
        },
      );
      onCreated(created.id);
    } catch (err) {
      setError(err instanceof ApiClientError ? err.message : "Failed to create the sheet");
    } finally {
      setBusy(false);
    }
  }

  return (
    <Drawer open={open} title="New daywork sheet" onClose={onClose}>
      <ErrorAlert message={error} />
      <div className="space-y-3">
        <Field label="Date of work">
          <Input type="date" value={workDate} onChange={(e) => setWorkDate(e.target.value)} />
        </Field>
        <Field label="Description of the work">
          <Textarea
            rows={3}
            value={description}
            onChange={(e) => setDescription(e.target.value)}
            placeholder="Breaking out an unrecorded obstruction beneath the pile cap"
          />
        </Field>
        <Field label="Location">
          <Input value={location} onChange={(e) => setLocation(e.target.value)} />
        </Field>
        <Field label="Instruction reference">
          <Input
            value={instructionRef}
            onChange={(e) => setInstructionRef(e.target.value)}
            placeholder="AI-014"
          />
        </Field>
        <div>
          <div className="mb-1 text-xs font-medium uppercase tracking-wide text-ink-400">
            Percentage additions from the daywork schedule
          </div>
          <div className="grid grid-cols-3 gap-2">
            {KINDS.map((k) => (
              <Field key={k} label={humanize(k)}>
                <Input
                  value={additions[k]}
                  onChange={(e) => setAdditions((a) => ({ ...a, [k]: e.target.value }))}
                  inputMode="decimal"
                />
              </Field>
            ))}
          </div>
        </div>
      </div>
      <div className="mt-5 flex justify-end gap-2">
        <Button variant="secondary" onClick={onClose}>
          Cancel
        </Button>
        <Button disabled={busy || description.trim().length === 0} onClick={() => void submit()}>
          {busy ? "Creating…" : "Create sheet"}
        </Button>
      </div>
    </Drawer>
  );
}

function SheetDrawer({
  sheet,
  open,
  onClose,
  onChanged,
  nameOf,
}: {
  sheet: DayworkSheetRow | null;
  open: boolean;
  onClose: () => void;
  onChanged: () => Promise<void>;
  nameOf: (id: string | null | undefined) => string;
}) {
  const [kind, setKind] = useState<string>("labour");
  const [description, setDescription] = useState("");
  const [unit, setUnit] = useState("hr");
  const [quantity, setQuantity] = useState("");
  const [rate, setRate] = useState("");
  const [reason, setReason] = useState("");
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  if (!sheet) {
    return (
      <Drawer open={open} title="Daywork sheet" onClose={onClose} wide>
        <Spinner />
      </Drawer>
    );
  }

  const editable = sheet.status === "draft";

  async function act(fn: () => Promise<unknown>) {
    setError(null);
    setBusy(true);
    try {
      await fn();
      await onChanged();
    } catch (err) {
      setError(err instanceof ApiClientError ? err.message : "The action failed");
    } finally {
      setBusy(false);
    }
  }

  return (
    <Drawer open={open} title={`${padNo("DW", sheet.number)} · ${sheet.description}`} onClose={onClose} wide>
      <ErrorAlert message={error} />

      <div className="mb-4 flex flex-wrap items-center gap-2">
        <Badge tone={dayworkStatusTone(sheet.status)}>{humanize(sheet.status)}</Badge>
        <Badge tone="gray">{formatDate(sheet.workDate)}</Badge>
        {sheet.location ? <Badge tone="gray">{sheet.location}</Badge> : null}
        {sheet.verifiedBy ? (
          <Badge tone="green">Verified by {nameOf(sheet.verifiedBy)}</Badge>
        ) : null}
      </div>

      {sheet.rejectionReason ? (
        <div className="mb-4 rounded-md bg-red-50 p-3 text-sm text-red-800 ring-1 ring-red-100">
          Rejected: {sheet.rejectionReason}
        </div>
      ) : null}

      <Card className="mb-4">
        <CardBody className="py-3">
          <div className="grid grid-cols-3 gap-3 text-center">
            <div>
              <div className="text-xs uppercase tracking-wide text-ink-400">Net</div>
              <div className="text-lg font-semibold tabular-nums">
                {money(sheet.netTotal, sheet.currency)}
              </div>
            </div>
            <div>
              <div className="text-xs uppercase tracking-wide text-ink-400">Additions</div>
              <div className="text-lg font-semibold tabular-nums text-ink-600">
                {money(sheet.additionTotal, sheet.currency)}
              </div>
            </div>
            <div>
              <div className="text-xs uppercase tracking-wide text-ink-400">Gross</div>
              <div className="text-lg font-semibold tabular-nums text-brand-700">
                {money(sheet.grossTotal, sheet.currency)}
              </div>
            </div>
          </div>
          <div className="mt-2 text-center text-xs text-ink-400">
            Additions:{" "}
            {KINDS.map((k) => `${humanize(k)} ${sheet.percentAdditions[k] ?? 0}%`).join(" · ")}
          </div>
        </CardBody>
      </Card>

      <Table>
        <thead>
          <tr>
            <Th>Class</Th>
            <Th>Description</Th>
            <Th className="text-right">Qty</Th>
            <Th className="text-right">Rate</Th>
            <Th className="text-right">Amount</Th>
            <Th className="text-right">+%</Th>
            <Th className="text-right">With addition</Th>
            {editable ? <Th /> : null}
          </tr>
        </thead>
        <tbody className="divide-y divide-ink-100">
          {(sheet.items ?? []).map((i) => (
            <tr key={i.id}>
              <Td>
                <Badge tone="gray">{humanize(i.kind)}</Badge>
              </Td>
              <Td>{i.description}</Td>
              <Td className="text-right tabular-nums">
                {qty(i.qty)} {i.unit ?? ""}
              </Td>
              <Td className="text-right tabular-nums">{money(i.rate, sheet.currency)}</Td>
              <Td className="text-right tabular-nums">{money(i.amount, sheet.currency)}</Td>
              <Td className="text-right tabular-nums text-ink-500">{i.percentAddition}%</Td>
              <Td className="text-right font-medium tabular-nums">
                {money(i.amountWithAddition, sheet.currency)}
              </Td>
              {editable ? (
                <Td className="text-right">
                  <button
                    type="button"
                    className="text-xs font-medium text-red-600 hover:text-red-800"
                    disabled={busy}
                    onClick={() => void act(() => api.del(`/api/v1/daywork-items/${i.id}`))}
                  >
                    Remove
                  </button>
                </Td>
              ) : null}
            </tr>
          ))}
          {(sheet.items ?? []).length === 0 ? (
            <tr>
              <Td colSpan={editable ? 8 : 7} className="text-center text-sm text-ink-400">
                No resource lines yet.
              </Td>
            </tr>
          ) : null}
        </tbody>
      </Table>

      {editable ? (
        <div className="mt-4 rounded-md bg-ink-50 p-3">
          <div className="mb-2 text-xs font-semibold uppercase tracking-wide text-ink-500">
            Add a resource line
          </div>
          <div className="grid grid-cols-2 gap-2 sm:grid-cols-5">
            <Field label="Class">
              <Select value={kind} onChange={(e) => setKind(e.target.value)}>
                {KINDS.map((k) => (
                  <option key={k} value={k}>
                    {humanize(k)}
                  </option>
                ))}
              </Select>
            </Field>
            <Field label="Description" className="sm:col-span-2">
              <Input value={description} onChange={(e) => setDescription(e.target.value)} />
            </Field>
            <Field label="Unit">
              <Input value={unit} onChange={(e) => setUnit(e.target.value)} />
            </Field>
            <Field label="Quantity">
              <Input
                value={quantity}
                inputMode="decimal"
                onChange={(e) => setQuantity(e.target.value)}
              />
            </Field>
            <Field label="Rate">
              <Input value={rate} inputMode="decimal" onChange={(e) => setRate(e.target.value)} />
            </Field>
          </div>
          <div className="mt-2 flex justify-end">
            <Button
              size="sm"
              disabled={busy || !description.trim() || !parseNum(quantity) || parseNum(rate) == null}
              onClick={() =>
                void act(async () => {
                  await api.post(`/api/v1/daywork-sheets/${sheet.id}/items`, {
                    kind,
                    description,
                    unit: unit || null,
                    qty: parseNum(quantity),
                    rate: parseNum(rate),
                  });
                  setDescription("");
                  setQuantity("");
                  setRate("");
                })
              }
            >
              Add line
            </Button>
          </div>
        </div>
      ) : null}

      <div className="mt-5 flex flex-wrap justify-end gap-2">
        {sheet.status === "draft" ? (
          <Button
            disabled={busy || (sheet.items ?? []).length === 0}
            onClick={() => void act(() => api.post(`/api/v1/daywork-sheets/${sheet.id}/submit`, {}))}
          >
            Submit for verification
          </Button>
        ) : null}
        {sheet.status === "submitted" ? (
          <>
            <Input
              className="w-64"
              placeholder="Reason (required to reject)"
              value={reason}
              onChange={(e) => setReason(e.target.value)}
            />
            <Button
              variant="danger"
              disabled={busy || reason.trim().length < 3}
              onClick={() =>
                void act(() =>
                  api.post(`/api/v1/daywork-sheets/${sheet.id}/reject`, { reason }),
                )
              }
            >
              Reject
            </Button>
            <Button
              disabled={busy}
              onClick={() => void act(() => api.post(`/api/v1/daywork-sheets/${sheet.id}/verify`, {}))}
            >
              Verify
            </Button>
          </>
        ) : null}
      </div>
      {sheet.status === "submitted" ? (
        <p className="mt-2 text-right text-xs text-ink-400">
          Verification must be done by someone other than the person who recorded or submitted the
          sheet.
        </p>
      ) : null}
    </Drawer>
  );
}
