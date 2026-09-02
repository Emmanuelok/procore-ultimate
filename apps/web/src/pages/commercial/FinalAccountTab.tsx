/**
 * Final account tab (spec Vol II Domain B #181-183, #187).
 *
 * Contract sum → omissions → remeasurement → agreed variations → provisional
 * sum expenditure → dayworks → fluctuations → claims → liquidated damages =
 * final contract sum, reconciled against Σ certificates to give the closing
 * balance (or the over-certification to recover).
 *
 * Every derived line names the record it came from. Anything unresolved is
 * listed as a GAP and deliberately left out of the total: a final account that
 * quietly includes disputed money is not a final account.
 */
import { useCallback, useEffect, useState } from "react";
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
  Select,
  Spinner,
  Table,
  Td,
  Textarea,
  Th,
} from "../../ui";
import { formatDateTime, humanize } from "../format";
import {
  Drawer,
  money,
  parseNum,
  useCompanyUsers,
  type FinalAccountRow,
  type ListResponse,
} from "./commercialShared";

const CATEGORY_LABELS: Record<string, string> = {
  contract_sum: "Contract sum",
  omission: "Less omissions",
  provisional_sum_omitted: "Less provisional sums omitted",
  remeasurement: "Remeasurement adjustment",
  variation: "Agreed variations",
  provisional_sum_expenditure: "Provisional sum / prime cost expenditure",
  daywork: "Dayworks",
  fluctuation: "Fluctuations",
  claim: "Claims and loss & expense",
  liquidated_damages: "Less liquidated damages",
  contra_charge: "Less contra charges",
  other: "Other adjustments",
};

const MANUAL_CATEGORIES = [
  "claim",
  "contra_charge",
  "omission",
  "other",
  "liquidated_damages",
] as const;

interface ContractOption {
  id: string;
  name: string;
  form: string;
  currency: string;
  contractSum: number | null;
}

export default function FinalAccountTab({
  projectId,
  onMutate,
}: {
  projectId: string;
  onMutate: () => void;
}) {
  const [rows, setRows] = useState<FinalAccountRow[] | null>(null);
  const [contracts, setContracts] = useState<ContractOption[]>([]);
  const [openId, setOpenId] = useState<string | null>(null);
  const [detail, setDetail] = useState<FinalAccountRow | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [newContractId, setNewContractId] = useState("");
  const { nameOf } = useCompanyUsers();

  const load = useCallback(async () => {
    setError(null);
    try {
      const [accounts, contractList] = await Promise.all([
        api.get<ListResponse<FinalAccountRow>>(
          `/api/v1/projects/${projectId}/final-accounts?pageSize=50`,
        ),
        api.get<ListResponse<ContractOption>>(
          `/api/v1/projects/${projectId}/contracts?pageSize=100`,
        ),
      ]);
      setRows(accounts.items);
      setContracts(contractList.items);
    } catch (err) {
      setRows([]);
      setError(err instanceof Error ? err.message : "Failed to load final accounts");
    }
  }, [projectId]);

  const loadDetail = useCallback(async (id: string) => {
    try {
      setDetail(await api.get<FinalAccountRow>(`/api/v1/final-accounts/${id}`));
    } catch (err) {
      setError(err instanceof Error ? err.message : "Failed to load the account");
    }
  }, []);

  useEffect(() => {
    void load();
  }, [load]);

  useEffect(() => {
    if (openId) void loadDetail(openId);
    else setDetail(null);
  }, [openId, loadDetail]);

  async function act(fn: () => Promise<unknown>) {
    setError(null);
    setBusy(true);
    try {
      await fn();
      await load();
      if (openId) await loadDetail(openId);
      onMutate();
    } catch (err) {
      setError(err instanceof ApiClientError ? err.message : "The action failed");
    } finally {
      setBusy(false);
    }
  }

  const contractName = (id: string) => contracts.find((c) => c.id === id)?.name ?? id;

  return (
    <div>
      <div className="mb-4 flex flex-wrap items-end justify-between gap-3">
        <div>
          <h2 className="text-sm font-semibold text-ink-900">Final accounts</h2>
          <p className="mt-0.5 text-xs text-ink-500">
            One per contract; agreed only when both sides have signed, by two different people.
          </p>
        </div>
        <div className="flex items-end gap-2">
          <Field label="Contract" className="w-64">
            <Select value={newContractId} onChange={(e) => setNewContractId(e.target.value)}>
              <option value="">— choose a contract —</option>
              {contracts.map((c) => (
                <option key={c.id} value={c.id}>
                  {c.name}
                </option>
              ))}
            </Select>
          </Field>
          <Button
            size="sm"
            disabled={busy || !newContractId}
            onClick={() =>
              void act(async () => {
                const created = await api.post<{ id: string }>(
                  `/api/v1/projects/${projectId}/final-accounts`,
                  { contractId: newContractId },
                );
                setNewContractId("");
                setOpenId(created.id);
              })
            }
          >
            Open a final account
          </Button>
        </div>
      </div>

      <ErrorAlert message={error} />

      {rows === null ? (
        <Spinner />
      ) : rows.length === 0 ? (
        <EmptyState
          title="No final account yet"
          hint="Open one against a contract; the adjustment schedule is built from the records you already hold."
        />
      ) : (
        <Table>
          <thead>
            <tr>
              <Th>No.</Th>
              <Th>Contract</Th>
              <Th className="text-right">Contract sum</Th>
              <Th className="text-right">Final sum</Th>
              <Th className="text-right">Certified</Th>
              <Th className="text-right">Balance</Th>
              <Th>Gaps</Th>
              <Th>Status</Th>
            </tr>
          </thead>
          <tbody className="divide-y divide-ink-100">
            {rows.map((a) => (
              <tr
                key={a.id}
                className="cursor-pointer hover:bg-ink-50/60"
                onClick={() => setOpenId(a.id)}
              >
                <Td className="whitespace-nowrap font-mono text-xs font-medium">
                  FA-{String(a.number).padStart(3, "0")}
                </Td>
                <Td className="max-w-xs truncate">{contractName(a.contractId)}</Td>
                <Td className="text-right tabular-nums">{money(a.contractSum, a.currency)}</Td>
                <Td className="text-right font-medium tabular-nums">
                  {money(a.finalContractSum, a.currency)}
                </Td>
                <Td className="text-right tabular-nums">{money(a.certifiedToDate, a.currency)}</Td>
                <Td
                  className={
                    a.balanceDue < 0
                      ? "text-right font-medium tabular-nums text-red-600"
                      : "text-right font-medium tabular-nums text-emerald-700"
                  }
                >
                  {money(a.balanceDue, a.currency)}
                </Td>
                <Td>
                  {a.gaps.length > 0 ? (
                    <Badge tone="amber">{a.gaps.length}</Badge>
                  ) : (
                    <span className="text-xs text-ink-400">—</span>
                  )}
                </Td>
                <Td>
                  <Badge
                    tone={
                      a.status === "agreed"
                        ? "green"
                        : a.status === "issued"
                          ? "blue"
                          : a.status === "disputed"
                            ? "red"
                            : "gray"
                    }
                  >
                    {humanize(a.status)}
                  </Badge>
                </Td>
              </tr>
            ))}
          </tbody>
        </Table>
      )}

      <AccountDrawer
        account={detail}
        open={openId !== null}
        busy={busy}
        onClose={() => setOpenId(null)}
        onAct={act}
        nameOf={nameOf}
      />
    </div>
  );
}

function AccountDrawer({
  account,
  open,
  busy,
  onClose,
  onAct,
  nameOf,
}: {
  account: FinalAccountRow | null;
  open: boolean;
  busy: boolean;
  onClose: () => void;
  onAct: (fn: () => Promise<unknown>) => Promise<void>;
  nameOf: (id: string | null | undefined) => string;
}) {
  const [category, setCategory] = useState<string>("claim");
  const [description, setDescription] = useState("");
  const [amount, setAmount] = useState("");
  const [note, setNote] = useState("");

  if (!account) {
    return (
      <Drawer open={open} title="Final account" onClose={onClose} wide>
        <Spinner />
      </Drawer>
    );
  }

  const draft = account.status === "draft";
  const issued = account.status === "issued";
  const grouped = new Map<string, typeof account.lines>();
  for (const line of account.lines ?? []) {
    const list = grouped.get(line.category) ?? [];
    list.push(line);
    grouped.set(line.category, list);
  }

  return (
    <Drawer
      open={open}
      title={`Final account FA-${String(account.number).padStart(3, "0")}`}
      onClose={onClose}
      wide
    >
      <div className="mb-4 flex flex-wrap items-center gap-2">
        <Badge tone={account.status === "agreed" ? "green" : issued ? "blue" : "gray"}>
          {humanize(account.status)}
        </Badge>
        <Badge tone="gray">{account.currency}</Badge>
        {account.computedAt ? (
          <span className="text-xs text-ink-400">
            Computed {formatDateTime(account.computedAt)}
          </span>
        ) : (
          <span className="text-xs text-amber-700">Not yet computed</span>
        )}
      </div>

      <Card className="mb-4">
        <CardBody className="py-3">
          <div className="grid grid-cols-2 gap-3 text-center sm:grid-cols-4">
            <div>
              <div className="text-xs uppercase tracking-wide text-ink-400">Contract sum</div>
              <div className="text-lg font-semibold tabular-nums">
                {money(account.contractSum, account.currency)}
              </div>
            </div>
            <div>
              <div className="text-xs uppercase tracking-wide text-ink-400">Final sum</div>
              <div className="text-lg font-semibold tabular-nums text-brand-700">
                {money(account.finalContractSum, account.currency)}
              </div>
            </div>
            <div>
              <div className="text-xs uppercase tracking-wide text-ink-400">Certified</div>
              <div className="text-lg font-semibold tabular-nums">
                {money(account.certifiedToDate, account.currency)}
              </div>
            </div>
            <div>
              <div className="text-xs uppercase tracking-wide text-ink-400">
                {account.balanceDue < 0 ? "Over-certified" : "Balance due"}
              </div>
              <div
                className={`text-lg font-semibold tabular-nums ${
                  account.balanceDue < 0 ? "text-red-600" : "text-emerald-700"
                }`}
              >
                {money(Math.abs(account.balanceDue), account.currency)}
              </div>
            </div>
          </div>
        </CardBody>
      </Card>

      {account.gaps.length > 0 ? (
        <Alert tone="warning" className="mb-4" title="Left out of the account">
          <ul className="mt-1 space-y-0.5 text-xs">
            {account.gaps.map((g) => (
              <li key={g}>• {g}</li>
            ))}
          </ul>
        </Alert>
      ) : null}

      <Table>
        <thead>
          <tr>
            <Th>Adjustment</Th>
            <Th>Source</Th>
            <Th className="text-right">Amount</Th>
          </tr>
        </thead>
        <tbody className="divide-y divide-ink-100">
          <tr className="bg-ink-50 font-medium">
            <Td>Contract sum</Td>
            <Td className="text-xs text-ink-400">Contract</Td>
            <Td className="text-right tabular-nums">
              {money(account.contractSum, account.currency)}
            </Td>
          </tr>
          {[...grouped.entries()].map(([cat, lines]) => (
            <>
              <tr key={cat} className="bg-ink-50/60">
                <Td colSpan={2} className="text-xs font-semibold uppercase tracking-wide text-ink-500">
                  {CATEGORY_LABELS[cat] ?? humanize(cat)}
                </Td>
                <Td className="text-right font-medium tabular-nums">
                  {money(
                    (lines ?? []).reduce((s, l) => s + l.amount, 0),
                    account.currency,
                  )}
                </Td>
              </tr>
              {(lines ?? []).map((l) => (
                <tr key={l.id}>
                  <Td className="pl-6 text-sm">
                    {l.description}
                    {l.manual ? (
                      <Badge tone="violet" className="ml-2">
                        Manual
                      </Badge>
                    ) : null}
                    {l.note ? (
                      <span className="block text-xs text-ink-400">{l.note}</span>
                    ) : null}
                  </Td>
                  <Td className="text-xs text-ink-400">
                    {l.sourceType ? humanize(l.sourceType) : "—"}
                  </Td>
                  <Td className="text-right tabular-nums">{money(l.amount, account.currency)}</Td>
                </tr>
              ))}
            </>
          ))}
          <tr className="border-t-2 border-ink-300 font-semibold">
            <Td>Final contract sum</Td>
            <Td />
            <Td className="text-right tabular-nums">
              {money(account.finalContractSum, account.currency)}
            </Td>
          </tr>
        </tbody>
      </Table>

      {draft ? (
        <div className="mt-4 rounded-md bg-ink-50 p-3">
          <div className="mb-2 text-xs font-semibold uppercase tracking-wide text-ink-500">
            Add a negotiated line
          </div>
          <div className="grid grid-cols-2 gap-2 sm:grid-cols-4">
            <Field label="Category">
              <Select value={category} onChange={(e) => setCategory(e.target.value)}>
                {MANUAL_CATEGORIES.map((c) => (
                  <option key={c} value={c}>
                    {CATEGORY_LABELS[c] ?? humanize(c)}
                  </option>
                ))}
              </Select>
            </Field>
            <Field label="Description" className="sm:col-span-2">
              <Input value={description} onChange={(e) => setDescription(e.target.value)} />
            </Field>
            <Field label="Amount (sign it)">
              <Input value={amount} inputMode="decimal" onChange={(e) => setAmount(e.target.value)} />
            </Field>
          </div>
          <Field label="Note" className="mt-2">
            <Textarea rows={2} value={note} onChange={(e) => setNote(e.target.value)} />
          </Field>
          <div className="mt-2 flex justify-end">
            <Button
              size="sm"
              disabled={busy || !description.trim() || parseNum(amount) == null}
              onClick={() =>
                void onAct(async () => {
                  await api.post(`/api/v1/final-accounts/${account.id}/lines`, {
                    category,
                    description,
                    amount: parseNum(amount),
                    note: note || null,
                  });
                  setDescription("");
                  setAmount("");
                  setNote("");
                })
              }
            >
              Add line
            </Button>
          </div>
        </div>
      ) : null}

      <div className="mt-5 flex flex-wrap items-center justify-end gap-2">
        {draft ? (
          <>
            <Button
              variant="secondary"
              disabled={busy}
              onClick={() =>
                void onAct(() => api.post(`/api/v1/final-accounts/${account.id}/compute`, {}))
              }
            >
              Recompute from records
            </Button>
            <Button
              disabled={busy || !account.computedAt}
              onClick={() =>
                void onAct(() => api.post(`/api/v1/final-accounts/${account.id}/issue`, {}))
              }
            >
              Issue
            </Button>
          </>
        ) : null}
        {issued ? (
          <>
            <span className="mr-auto text-xs text-ink-500">
              Contractor: {account.contractorSignedBy ? nameOf(account.contractorSignedBy) : "—"} ·
              Employer: {account.employerSignedBy ? nameOf(account.employerSignedBy) : "—"}
            </span>
            <Button
              variant="secondary"
              disabled={busy || Boolean(account.contractorSignedBy)}
              onClick={() =>
                void onAct(() =>
                  api.post(`/api/v1/final-accounts/${account.id}/sign`, { side: "contractor" }),
                )
              }
            >
              Sign as contractor
            </Button>
            <Button
              disabled={busy || Boolean(account.employerSignedBy)}
              onClick={() =>
                void onAct(() =>
                  api.post(`/api/v1/final-accounts/${account.id}/sign`, { side: "employer" }),
                )
              }
            >
              Sign as employer
            </Button>
          </>
        ) : null}
      </div>
      {issued ? (
        <p className="mt-2 text-right text-xs text-ink-400">
          Both signatures are needed, and the same person cannot sign for both sides.
        </p>
      ) : null}
    </Drawer>
  );
}
