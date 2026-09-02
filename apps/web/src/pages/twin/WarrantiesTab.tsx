/**
 * Warranties tab — cover, expiry and claims (spec Domain L #642-645).
 *
 * Expiry is not a page that has to be opened: the scheduler raises an
 * obligation per active warranty and notifies the asset owner at 90, 30 and 7
 * days. This tab shows what that produced, and lets an operator run the sweep
 * on demand.
 */
import { useCallback, useEffect, useState } from "react";
import { toast } from "sonner";
import { api, ApiClientError } from "../../lib/api";
import {
  Badge,
  Button,
  Card,
  CardBody,
  EmptyState,
  ErrorAlert,
  Select,
  Spinner,
  Stat,
  Table,
  Td,
  Th,
} from "../../ui";
import { formatDate, humanize } from "../format";
import type { ListResponse, Warranty, WarrantyClaim } from "./twinShared";

const CLAIM_NEXT: Record<string, string[]> = {
  lodged: ["acknowledged", "rejected"],
  acknowledged: ["in_repair", "closed", "rejected"],
  in_repair: ["closed", "rejected"],
  closed: [],
  rejected: ["lodged"],
};

export default function WarrantiesTab({
  projectId,
  onChanged,
}: {
  projectId: string;
  onChanged: () => void;
}) {
  const [expiring, setExpiring] = useState<{ items: Warranty[]; total: number; expired: number } | null>(
    null,
  );
  const [claims, setClaims] = useState<WarrantyClaim[] | null>(null);
  const [summary, setSummary] = useState<{
    byStatus: Record<string, number>;
    expiringWithin90Days: number;
    openClaims: number;
  } | null>(null);
  const [days, setDays] = useState("90");
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  const load = useCallback(async () => {
    setError(null);
    try {
      const [exp, claimList, sum] = await Promise.all([
        api.get<{ items: Warranty[]; total: number; expired: number }>(
          `/api/v1/projects/${projectId}/warranties/expiring?days=${days}`,
        ),
        api.get<ListResponse<WarrantyClaim>>(
          `/api/v1/projects/${projectId}/warranty-claims?pageSize=100`,
        ),
        api.get<{
          byStatus: Record<string, number>;
          expiringWithin90Days: number;
          openClaims: number;
        }>(`/api/v1/projects/${projectId}/warranties/summary`),
      ]);
      setExpiring(exp);
      setClaims(claimList.items);
      setSummary(sum);
    } catch (err) {
      setError(err instanceof Error ? err.message : "Failed to load warranties");
    }
  }, [projectId, days]);

  useEffect(() => {
    void load();
  }, [load]);

  async function runSweep() {
    setBusy(true);
    try {
      const res = await api.post<{ obligationsCreated: number; notified: number; expired: number }>(
        `/api/v1/projects/${projectId}/warranties/sweep`,
      );
      toast.success(
        `${res.obligationsCreated} obligation(s) raised, ${res.notified} notice(s) sent, ${res.expired} marked expired.`,
      );
      await load();
      onChanged();
    } catch (err) {
      toast.error(
        err instanceof ApiClientError ? err.message : "The sweep needs twin admin on this project.",
      );
    } finally {
      setBusy(false);
    }
  }

  async function advanceClaim(claim: WarrantyClaim, status: string) {
    setBusy(true);
    try {
      await api.patch(`/api/v1/warranty-claims/${claim.id}`, { status });
      toast.success(`Claim ${humanize(status).toLowerCase()}.`);
      await load();
      onChanged();
    } catch (err) {
      toast.error(err instanceof ApiClientError ? err.message : "The transition was refused.");
    } finally {
      setBusy(false);
    }
  }

  return (
    <div>
      <div className="mb-4 grid grid-cols-2 gap-4 md:grid-cols-4">
        <Card>
          <CardBody>
            <Stat
              label="Active"
              value={summary ? (summary.byStatus["active"] ?? 0) : "—"}
              hint="warranties in force"
            />
          </CardBody>
        </Card>
        <Card>
          <CardBody>
            <Stat
              label="Expiring in 90 days"
              value={summary ? summary.expiringWithin90Days : "—"}
              tone={(summary?.expiringWithin90Days ?? 0) > 0 ? "warning" : "neutral"}
            />
          </CardBody>
        </Card>
        <Card>
          <CardBody>
            <Stat
              label="Expired"
              value={summary ? (summary.byStatus["expired"] ?? 0) : "—"}
              tone={(summary?.byStatus["expired"] ?? 0) > 0 ? "danger" : "neutral"}
            />
          </CardBody>
        </Card>
        <Card>
          <CardBody>
            <Stat label="Open claims" value={summary ? summary.openClaims : "—"} />
          </CardBody>
        </Card>
      </div>

      <div className="mb-3 flex flex-wrap items-center justify-between gap-2">
        <div className="flex items-center gap-2">
          <span className="text-xs text-ink-500">Horizon</span>
          <Select value={days} onChange={(e) => setDays(e.target.value)} className="max-w-[140px]">
            <option value="30">30 days</option>
            <option value="90">90 days</option>
            <option value="180">180 days</option>
            <option value="365">1 year</option>
          </Select>
        </div>
        <Button variant="secondary" disabled={busy} onClick={() => void runSweep()}>
          Run expiry sweep
        </Button>
      </div>

      <ErrorAlert message={error} />

      {expiring === null ? (
        <Spinner label="Loading warranties…" />
      ) : expiring.items.length === 0 ? (
        <EmptyState
          title="Nothing expiring in this horizon"
          hint="Warranties are recorded on the asset; the sweep raises an obligation per warranty so the deadline belongs to the platform, not to a page."
        />
      ) : (
        <Table>
          <thead>
            <tr>
              <Th>Asset</Th>
              <Th>Provider</Th>
              <Th>From</Th>
              <Th>To</Th>
              <Th className="text-right">Days left</Th>
              <Th>Status</Th>
              <Th>Obligation</Th>
            </tr>
          </thead>
          <tbody className="divide-y divide-ink-100">
            {expiring.items.map((w) => (
              <tr key={w.id}>
                <Td>
                  <span className="font-mono text-xs">{w.tagCode}</span>{" "}
                  <span className="text-ink-700">{w.assetName}</span>
                </Td>
                <Td>{w.provider}</Td>
                <Td>{formatDate(w.startDate)}</Td>
                <Td>{formatDate(w.endDate)}</Td>
                <Td
                  className={`text-right tabular-nums ${
                    (w.daysRemaining ?? 0) < 0 ? "text-red-600" : ""
                  }`}
                >
                  {w.daysRemaining}
                </Td>
                <Td>
                  <Badge
                    size="sm"
                    tone={
                      w.status === "expired" ? "danger" : w.status === "claimed" ? "warning" : "success"
                    }
                  >
                    {w.status ?? "active"}
                  </Badge>
                </Td>
                <Td className="text-xs text-ink-500">
                  {w.obligationId ? "raised" : "not yet raised"}
                  {w.notifiedDays !== null && w.notifiedDays !== undefined ? (
                    <span className="block text-[11px] text-ink-400">
                      notified at {w.notifiedDays}d
                    </span>
                  ) : null}
                </Td>
              </tr>
            ))}
          </tbody>
        </Table>
      )}

      <Card className="mt-6">
        <CardBody>
          <h3 className="mb-2 text-sm font-semibold text-ink-900">Warranty claims</h3>
          {claims === null ? (
            <Spinner label="Loading claims…" />
          ) : claims.length === 0 ? (
            <p className="text-xs text-ink-500">
              No claims lodged. Lodge one from the asset drawer when something under warranty fails.
            </p>
          ) : (
            <Table>
              <thead>
                <tr>
                  <Th className="w-14">#</Th>
                  <Th>Claim</Th>
                  <Th>Asset</Th>
                  <Th>Provider</Th>
                  <Th>Lodged</Th>
                  <Th>Status</Th>
                  <Th className="text-right">Actions</Th>
                </tr>
              </thead>
              <tbody className="divide-y divide-ink-100">
                {claims.map((c) => (
                  <tr key={c.id}>
                    <Td className="tabular-nums">{c.number}</Td>
                    <Td>
                      <span className="font-medium text-ink-900">{c.title}</span>
                      {c.resolution ? (
                        <div className="text-[11px] text-ink-400">{c.resolution}</div>
                      ) : null}
                    </Td>
                    <Td>
                      <span className="font-mono text-xs">{c.tagCode}</span> {c.assetName}
                    </Td>
                    <Td>{c.provider}</Td>
                    <Td>{formatDate(c.lodgedAt)}</Td>
                    <Td>
                      <Badge
                        size="sm"
                        tone={
                          c.status === "closed"
                            ? "success"
                            : c.status === "rejected"
                              ? "danger"
                              : "warning"
                        }
                      >
                        {humanize(c.status)}
                      </Badge>
                    </Td>
                    <Td className="text-right">
                      <div className="flex justify-end gap-1">
                        {(CLAIM_NEXT[c.status] ?? []).map((next) => (
                          <Button
                            key={next}
                            size="sm"
                            variant="ghost"
                            disabled={busy}
                            onClick={() => void advanceClaim(c, next)}
                          >
                            {humanize(next)}
                          </Button>
                        ))}
                      </div>
                    </Td>
                  </tr>
                ))}
              </tbody>
            </Table>
          )}
        </CardBody>
      </Card>
    </div>
  );
}
