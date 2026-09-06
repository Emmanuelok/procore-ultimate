/**
 * Lender exposure across the portfolio — company level (spec Vol II Domain O
 * #739-742).
 *
 * A treasury team does not think one project at a time: it thinks in
 * facilities, lenders and closing dates across everything the company is
 * financing. This is that view.
 *
 * Two honesty rules are load-bearing here:
 *  - Money is bucketed by currency and NEVER summed across them. There is no
 *    exchange rate on this platform, so a single "total committed" across a
 *    USD loan and a EUR grant would be a fabricated number.
 *  - The API returns only projects the caller holds finance access on. When
 *    that scoping is in force the page says so, so an empty table is never
 *    mistaken for "the company has no debt".
 */
import { useEffect, useState } from "react";
import { Link } from "react-router-dom";
import { api, ApiClientError } from "../../lib/api";
import {
  Badge,
  Card,
  CardBody,
  EmptyState,
  ErrorAlert,
  PageHeader,
  Spinner,
  Table,
  Td,
  Th,
} from "../../ui";
import { humanize } from "../format";
import { fmtMoney } from "./financeShared";

interface PortfolioFacility {
  id: string;
  projectId: string;
  projectName: string | null;
  name: string;
  lender: string | null;
  instrument: string;
  currency: string;
  committedAmount: number;
  disbursed: number;
  pipeline: number;
  daysToClosing: number | null;
}

interface CurrencyBucket {
  currency: string;
  amount: number;
  recordCount: number;
}

interface PortfolioResponse {
  facilities: PortfolioFacility[];
  committedByCurrency: CurrencyBucket[];
  disbursedByCurrency: CurrencyBucket[];
  scoped?: boolean;
  reason?: string;
}

function ClosingBadge({ days }: { days: number | null }) {
  if (days === null) return <span className="text-xs text-ink-400">no closing date</span>;
  if (days < 0)
    return <Badge tone="red">closed {Math.abs(days)}d ago</Badge>;
  if (days <= 90) return <Badge tone="amber">{days}d to closing</Badge>;
  return <Badge tone="gray">{days}d to closing</Badge>;
}

export default function FinancePortfolioPage() {
  const [data, setData] = useState<PortfolioResponse | null>(null);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    let cancelled = false;
    api
      .get<PortfolioResponse>("/api/v1/finance/portfolio")
      .then((d) => {
        if (!cancelled) setData(d);
      })
      .catch((err: unknown) => {
        if (cancelled) return;
        setError(
          err instanceof ApiClientError ? err.message : "Could not load the finance portfolio",
        );
        setData({ facilities: [], committedByCurrency: [], disbursedByCurrency: [] });
      });
    return () => {
      cancelled = true;
    };
  }, []);

  if (data === null) {
    return (
      <div>
        <PageHeader
          title="Finance portfolio"
          subtitle="Lender facilities, drawn and undrawn, across every project you can see"
        />
        <ErrorAlert message={error} />
        <Spinner label="Loading facilities…" />
      </div>
    );
  }

  const disbursedIn = (currency: string) =>
    data.disbursedByCurrency.find((b) => b.currency === currency)?.amount ?? 0;

  return (
    <div>
      <PageHeader
        title="Finance portfolio"
        subtitle="Lender facilities, drawn and undrawn, across every project you can see"
      />
      <ErrorAlert message={error} />

      {data.scoped ? (
        <p className="mb-3 rounded-md bg-ink-50 px-3 py-2 text-xs text-ink-600">
          Scoped to the projects you hold finance access on. Facilities on other projects are not
          counted here.
        </p>
      ) : null}

      {data.committedByCurrency.length > 0 ? (
        <Card className="mb-4">
          <CardBody className="py-3">
            <div className="mb-2 text-xs font-semibold uppercase tracking-wide text-ink-400">
              Committed and drawn, per currency
            </div>
            <div className="flex flex-wrap gap-x-8 gap-y-3">
              {data.committedByCurrency.map((b) => {
                const drawn = disbursedIn(b.currency);
                const pct = b.amount > 0 ? Math.round((drawn / b.amount) * 100) : null;
                return (
                  <div key={b.currency}>
                    <div className="text-xs text-ink-400">
                      {b.currency} · {b.recordCount} facilit
                      {b.recordCount === 1 ? "y" : "ies"}
                    </div>
                    <div className="text-lg font-semibold tabular-nums text-ink-900">
                      {fmtMoney(b.amount, b.currency)}
                    </div>
                    <div className="text-xs text-ink-500">
                      {fmtMoney(drawn, b.currency)} drawn
                      {pct === null ? "" : ` · ${pct}%`}
                    </div>
                  </div>
                );
              })}
            </div>
            <p className="mt-2 text-xs text-ink-400">
              Currencies are reported separately. There is no exchange rate on this platform, so a
              single cross-currency total would be a number nobody could stand behind.
            </p>
          </CardBody>
        </Card>
      ) : null}

      {data.facilities.length === 0 ? (
        <EmptyState
          title="No facilities to show"
          description={
            data.reason ??
            "No funding facility has been recorded on the projects you can see. Facilities are created on a project's Finance workspace."
          }
        />
      ) : (
        <Card>
          <CardBody className="p-0">
            <Table>
              <thead>
                <tr>
                  <Th>Project</Th>
                  <Th>Facility</Th>
                  <Th>Lender</Th>
                  <Th>Instrument</Th>
                  <Th className="text-right">Committed</Th>
                  <Th className="text-right">Disbursed</Th>
                  <Th className="text-right">Pipeline</Th>
                  <Th className="text-right">Undrawn</Th>
                  <Th>Availability</Th>
                </tr>
              </thead>
              <tbody className="divide-y divide-ink-100">
                {data.facilities.map((f) => (
                  <tr key={f.id} className="hover:bg-ink-50/60">
                    <Td className="max-w-[180px]">
                      <Link
                        className="line-clamp-1 text-brand-700 hover:underline"
                        to={`/projects/${f.projectId}/finance`}
                      >
                        {f.projectName ?? f.projectId}
                      </Link>
                    </Td>
                    <Td className="max-w-[200px]">
                      <span className="line-clamp-1 font-medium text-ink-900">{f.name}</span>
                    </Td>
                    <Td className="text-xs text-ink-600">{f.lender ?? "—"}</Td>
                    <Td>
                      <Badge tone="gray">{humanize(f.instrument)}</Badge>
                    </Td>
                    <Td className="text-right tabular-nums">
                      {fmtMoney(f.committedAmount, f.currency)}
                    </Td>
                    <Td className="text-right tabular-nums">{fmtMoney(f.disbursed, f.currency)}</Td>
                    <Td className="text-right tabular-nums text-ink-500">
                      {fmtMoney(f.pipeline, f.currency)}
                    </Td>
                    <Td className="text-right tabular-nums">
                      {fmtMoney(f.committedAmount - f.disbursed - f.pipeline, f.currency)}
                    </Td>
                    <Td>
                      <ClosingBadge days={f.daysToClosing} />
                    </Td>
                  </tr>
                ))}
              </tbody>
            </Table>
          </CardBody>
        </Card>
      )}
    </div>
  );
}
