/**
 * STATUTORY LIENS AND LIEN NOTICES (spec Vol II F #373–380).
 *
 * A lien is somebody down the chain claiming against the project, and the
 * only number that ever matters on the day is the DEADLINE: the date it must
 * be filed, enforced or released by. So the register leads with the deadline
 * and the countdown, sorts the exposure by currency rather than adding
 * currencies together, and never invents a statutory date the user did not
 * record — the deadline and its basis are typed by the person who read the
 * statute, and the platform holds them to it.
 */
import { useCallback, useEffect, useMemo, useState } from "react";
import { api } from "../../lib/api";
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
  Modal,
  Select,
  Spinner,
  Textarea,
} from "../../ui";
import { DataTable, type DataColumns } from "../../ui/data";
import { formatDate, humanize } from "../format";
import { fmtMoney, type ListResponse } from "./paymentsShared";

const LIEN_KINDS = [
  "preliminary_notice",
  "notice_of_intent",
  "lien_filed",
  "stop_notice",
  "bond_claim",
] as const;

export interface LienRow {
  id: string;
  reference: string;
  kind: string;
  status: string;
  claimantName: string;
  claimantVendorId: string | null;
  tier: number;
  amount: number;
  currency: string;
  jurisdiction: string | null;
  servedAt: string | null;
  filedAt: string | null;
  deadlineAt: string | null;
  deadlineBasis: string | null;
  releasedAt: string | null;
  bondReference: string | null;
  notes: string | null;
  daysToDeadline: number | null;
}

interface LienSummary {
  open: number;
  byCurrency: Array<{
    currency: string;
    count: number;
    amount: number;
    tier2Plus: number;
  }>;
  overdue: number;
  dueWithin14: number;
  next: Array<{
    id: string;
    reference: string;
    claimantName: string;
    deadlineAt: string | null;
    daysToDeadline: number;
  }>;
  total: number;
}

const OPEN_STATUSES = new Set(["noticed", "filed", "disputed"]);

function statusTone(status: string): "neutral" | "warning" | "danger" | "success" | "info" {
  switch (status) {
    case "released":
      return "success";
    case "bonded_off":
      return "info";
    case "disputed":
      return "warning";
    case "filed":
    case "noticed":
      return "danger";
    default:
      return "neutral";
  }
}

export default function LiensTab({ projectId }: { projectId: string }) {
  const base = `/api/v1/projects/${projectId}`;
  const [rows, setRows] = useState<LienRow[] | null>(null);
  const [summary, setSummary] = useState<LienSummary | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [creating, setCreating] = useState(false);

  const load = useCallback(async () => {
    setError(null);
    try {
      const [list, sum] = await Promise.all([
        api.get<ListResponse<LienRow>>(`${base}/liens?page=1&pageSize=200`),
        api.get<LienSummary>(`${base}/liens/summary`),
      ]);
      setRows(list.items);
      setSummary(sum);
    } catch (err) {
      setRows([]);
      setError(err instanceof Error ? err.message : "The lien register could not be loaded.");
    }
  }, [base]);

  useEffect(() => {
    void load();
  }, [load]);

  async function act(row: LienRow, action: string, body?: unknown) {
    setBusy(true);
    setError(null);
    try {
      await api.post(`${base}/liens/${row.id}/${action}`, body ?? {});
      await load();
    } catch (err) {
      setError(err instanceof Error ? err.message : `${row.reference} could not be ${action}d.`);
    } finally {
      setBusy(false);
    }
  }

  const columns = useMemo<DataColumns<LienRow>>(
    () => [
      {
        id: "reference",
        header: "Ref",
        accessor: "reference",
        type: "code",
        width: 110,
        mono: true,
        sticky: "start",
      },
      {
        id: "kind",
        header: "Kind",
        accessor: (r) => humanize(r.kind),
        type: "text",
        width: 160,
      },
      {
        id: "claimantName",
        header: "Claimant",
        accessor: "claimantName",
        type: "text",
        width: 220,
      },
      {
        id: "tier",
        header: "Tier",
        accessor: "tier",
        type: "number",
        width: 70,
        align: "right",
      },
      {
        id: "amount",
        header: "Amount",
        accessor: "amount",
        type: "custom",
        width: 140,
        align: "right",
        mono: true,
        cell: ({ row }) => <span>{fmtMoney(row.amount, row.currency)}</span>,
      },
      {
        id: "deadlineAt",
        header: "Statutory deadline",
        accessor: (r) => r.deadlineAt ?? "",
        type: "custom",
        width: 200,
        cell: ({ row }) =>
          row.deadlineAt ? (
            <span className="flex items-center gap-2">
              <span className="text-2xs">{formatDate(row.deadlineAt)}</span>
              {OPEN_STATUSES.has(row.status) && row.daysToDeadline !== null ? (
                <Badge
                  size="xs"
                  tone={
                    row.daysToDeadline < 0
                      ? "danger"
                      : row.daysToDeadline <= 14
                        ? "warning"
                        : "neutral"
                  }
                >
                  {row.daysToDeadline < 0 ? "OVERDUE" : `${row.daysToDeadline}d`}
                </Badge>
              ) : null}
            </span>
          ) : (
            <span
              className="text-2xs text-content-subtle"
              title="No statutory deadline was recorded on this lien."
            >
              not recorded
            </span>
          ),
      },
      {
        id: "status",
        header: "Status",
        accessor: "status",
        type: "custom",
        width: 130,
        cell: ({ row }) => (
          <Badge tone={statusTone(row.status)} dot size="xs">
            {humanize(row.status)}
          </Badge>
        ),
      },
      {
        id: "deadlineBasis",
        header: "Basis",
        accessor: (r) => r.deadlineBasis ?? "",
        type: "text",
        width: 280,
        truncate: false,
      },
    ],
    [],
  );

  return (
    <div className="space-y-4">
      <Alert tone="info" variant="subtle" size="sm" title="The deadline is recorded, not computed">
        Lien statutes vary by state and by tier, so this platform does not guess the date. Somebody
        reads the statute, records the deadline and its basis, and the hourly sweep breaches the
        obligation and raises a signal if it passes with no release or bond on file.
      </Alert>

      <ErrorAlert message={error} />

      {summary ? (
        <div className="grid gap-3 sm:grid-cols-3 lg:grid-cols-4">
          <Card>
            <CardBody className="px-4 py-3">
              <div className="text-xl font-bold tabular-nums">{summary.open}</div>
              <div className="text-label uppercase text-content-subtle">Open claims</div>
            </CardBody>
          </Card>
          <Card>
            <CardBody className="px-4 py-3">
              <div
                className={
                  "text-xl font-bold tabular-nums " + (summary.overdue > 0 ? "text-danger-fg" : "")
                }
              >
                {summary.overdue}
              </div>
              <div className="text-label uppercase text-content-subtle">Past their deadline</div>
            </CardBody>
          </Card>
          <Card>
            <CardBody className="px-4 py-3">
              <div
                className={
                  "text-xl font-bold tabular-nums " +
                  (summary.dueWithin14 > 0 ? "text-warning-fg" : "")
                }
              >
                {summary.dueWithin14}
              </div>
              <div className="text-label uppercase text-content-subtle">Due within 14 days</div>
            </CardBody>
          </Card>
          <Card>
            <CardBody className="px-4 py-3">
              <div className="text-label uppercase text-content-subtle">Open exposure</div>
              {summary.byCurrency.length === 0 ? (
                <div className="mt-1 text-meta text-content-subtle">—</div>
              ) : (
                <ul className="mt-1 space-y-0.5">
                  {summary.byCurrency.map((c) => (
                    <li key={c.currency} className="font-mono text-meta tabular-nums">
                      {fmtMoney(c.amount, c.currency)}{" "}
                      <span className="text-content-subtle">
                        ({c.count} claim{c.count === 1 ? "" : "s"}
                        {c.tier2Plus > 0 ? `, ${c.tier2Plus} below tier 1` : ""})
                      </span>
                    </li>
                  ))}
                </ul>
              )}
              <p className="mt-1 text-2xs text-content-subtle">
                Per currency. Two currencies are never added together.
              </p>
            </CardBody>
          </Card>
        </div>
      ) : null}

      <div className="flex justify-end">
        <Button size="sm" onClick={() => setCreating(true)}>
          Record a lien or notice
        </Button>
      </div>

      {rows === null ? (
        <Spinner label="Loading the lien register…" />
      ) : rows.length === 0 ? (
        <EmptyState
          title="No liens or notices on this project"
          hint="A preliminary notice, a stop notice or a bond claim from anyone in the supply chain belongs here the day it arrives."
          action={<Button onClick={() => setCreating(true)}>Record the first one</Button>}
        />
      ) : (
        <DataTable<LienRow>
          tableId="statutory-liens"
          data={rows}
          columns={columns}
          getRowId={(r) => r.id}
          height={460}
          stickyHeader
          gridLines
          savedViews={false}
          exportFileName={`liens-${projectId}`}
          rowTone={(r) =>
            OPEN_STATUSES.has(r.status) && r.daysToDeadline !== null && r.daysToDeadline < 0
              ? "danger"
              : undefined
          }
          rowActions={(row) => [
            {
              id: "file",
              label: "Record as filed",
              disabled: busy || row.status !== "noticed",
              onSelect: () => void act(row, "file"),
            },
            {
              id: "dispute",
              label: "Dispute…",
              disabled: busy || !["noticed", "filed"].includes(row.status),
              onSelect: () => {
                const reason = window.prompt(`On what grounds is ${row.reference} disputed?`);
                if (reason?.trim()) void act(row, "dispute", { reason: reason.trim() });
              },
            },
            {
              id: "bond-off",
              label: "Bond off…",
              disabled: busy || !OPEN_STATUSES.has(row.status),
              onSelect: () => {
                const ref = window.prompt(`Bond reference discharging ${row.reference}?`);
                if (ref?.trim()) void act(row, "bond-off", { bondReference: ref.trim() });
              },
            },
            {
              id: "release",
              label: "Record the release",
              disabled:
                busy || !["noticed", "filed", "disputed", "bonded_off"].includes(row.status),
              onSelect: () => void act(row, "release", {}),
            },
            {
              id: "expire",
              label: "Record as expired…",
              disabled: busy || !OPEN_STATUSES.has(row.status),
              onSelect: () => {
                const reason = window.prompt(`Why has ${row.reference} expired?`);
                if (reason?.trim()) void act(row, "expire", { reason: reason.trim() });
              },
            },
          ]}
          aria-label="Statutory liens"
        />
      )}

      <CreateLien
        open={creating}
        base={base}
        onClose={() => setCreating(false)}
        onCreated={() => {
          setCreating(false);
          void load();
        }}
      />
    </div>
  );
}

function CreateLien({
  open,
  base,
  onClose,
  onCreated,
}: {
  open: boolean;
  base: string;
  onClose: () => void;
  onCreated: () => void;
}) {
  const [kind, setKind] = useState<string>("preliminary_notice");
  const [claimantName, setClaimantName] = useState("");
  const [tier, setTier] = useState("2");
  const [amount, setAmount] = useState("");
  const [currency, setCurrency] = useState("USD");
  const [jurisdiction, setJurisdiction] = useState("");
  const [deadlineAt, setDeadlineAt] = useState("");
  const [deadlineBasis, setDeadlineBasis] = useState("");
  const [notes, setNotes] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const valid = claimantName.trim().length > 0 && Number.isFinite(Number(amount));

  async function submit() {
    setBusy(true);
    setError(null);
    try {
      await api.post(`${base}/liens`, {
        kind,
        claimantName: claimantName.trim(),
        tier: Number(tier) || 1,
        amount: Number(amount) || 0,
        currency: currency.trim().toUpperCase() || "USD",
        ...(jurisdiction.trim() ? { jurisdiction: jurisdiction.trim() } : {}),
        ...(deadlineAt ? { deadlineAt } : {}),
        ...(deadlineBasis.trim() ? { deadlineBasis: deadlineBasis.trim() } : {}),
        ...(notes.trim() ? { notes: notes.trim() } : {}),
      });
      setClaimantName("");
      setAmount("");
      setDeadlineAt("");
      setDeadlineBasis("");
      setNotes("");
      onCreated();
    } catch (err) {
      setError(err instanceof Error ? err.message : "The lien could not be recorded.");
    } finally {
      setBusy(false);
    }
  }

  return (
    <Modal
      open={open}
      onClose={onClose}
      title="Record a lien or lien notice"
      size="lg"
      footer={
        <div className="flex justify-end gap-2">
          <Button variant="ghost" onClick={onClose}>
            Cancel
          </Button>
          <Button disabled={!valid || busy} onClick={() => void submit()}>
            {busy ? "Recording…" : "Record it"}
          </Button>
        </div>
      }
    >
      <div className="space-y-3">
        <ErrorAlert message={error} />
        <div className="grid gap-3 sm:grid-cols-2">
          <Field label="Kind" required>
            <Select value={kind} onChange={(e) => setKind(e.target.value)}>
              {LIEN_KINDS.map((k) => (
                <option key={k} value={k}>
                  {humanize(k)}
                </option>
              ))}
            </Select>
          </Field>
          <Field label="Tier" hint="1 = our direct subcontractor; 2+ = further down the chain.">
            <Input value={tier} inputMode="numeric" onChange={(e) => setTier(e.target.value)} />
          </Field>
        </div>
        <Field label="Claimant" required>
          <Input value={claimantName} onChange={(e) => setClaimantName(e.target.value)} />
        </Field>
        <div className="grid gap-3 sm:grid-cols-3">
          <Field label="Amount" required>
            <Input value={amount} inputMode="decimal" onChange={(e) => setAmount(e.target.value)} />
          </Field>
          <Field label="Currency">
            <Input value={currency} maxLength={3} onChange={(e) => setCurrency(e.target.value)} />
          </Field>
          <Field label="Jurisdiction">
            <Input value={jurisdiction} onChange={(e) => setJurisdiction(e.target.value)} />
          </Field>
        </div>
        <div className="grid gap-3 sm:grid-cols-2">
          <Field
            label="Statutory deadline"
            hint="The date it must be filed, enforced or released by."
          >
            <Input type="date" value={deadlineAt} onChange={(e) => setDeadlineAt(e.target.value)} />
          </Field>
          <Field label="Basis for that date" hint="Which section of which statute produced it.">
            <Input
              value={deadlineBasis}
              placeholder="90 days from last furnishing (Civil Code 8414)"
              onChange={(e) => setDeadlineBasis(e.target.value)}
            />
          </Field>
        </div>
        <Field label="Notes">
          <Textarea rows={3} value={notes} onChange={(e) => setNotes(e.target.value)} />
        </Field>
      </div>
    </Modal>
  );
}
