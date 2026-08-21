/**
 * Certificates tab — interim payment certificates with the certificate-vs-
 * application variance statement (#179-180).
 */
import { useCallback, useEffect, useMemo, useState } from "react";
import { api } from "../../lib/api";
import { Badge, EmptyState, ErrorAlert, Spinner, Table, Td, Th } from "../../ui";
import { formatDate, formatDateTime, humanize } from "../format";
import {
  certTone,
  money,
  padNo,
  useCompanyUsers,
  type BoqRow,
  type CertificateRow,
  type ListResponse,
  type ValuationRow,
} from "./commercialShared";

export default function CertificatesTab({
  projectId,
  boqs,
}: {
  projectId: string;
  boqs: BoqRow[] | null;
}) {
  const [rows, setRows] = useState<CertificateRow[] | null>(null);
  const [valuations, setValuations] = useState<ValuationRow[]>([]);
  const [error, setError] = useState<string | null>(null);
  const { nameOf } = useCompanyUsers();

  const load = useCallback(async () => {
    setError(null);
    try {
      const [certs, vals] = await Promise.all([
        api.get<ListResponse<CertificateRow>>(
          `/api/v1/projects/${projectId}/certificates?pageSize=100`,
        ),
        api.get<ListResponse<ValuationRow>>(
          `/api/v1/projects/${projectId}/valuations?pageSize=100`,
        ),
      ]);
      setRows(certs?.items ?? []);
      setValuations(vals?.items ?? []);
    } catch (err) {
      setRows([]);
      setError(err instanceof Error ? err.message : "Failed to load certificates");
    }
  }, [projectId]);

  useEffect(() => {
    void load();
  }, [load]);

  const valById = useMemo(() => new Map(valuations.map((v) => [v.id, v])), [valuations]);
  const currencyFor = useCallback(
    (c: CertificateRow) => {
      const val = valById.get(c.valuationId);
      return boqs?.find((b) => b.id === val?.boqId)?.currency ?? "USD";
    },
    [valById, boqs],
  );

  return (
    <div>
      <h2 className="mb-4 text-sm font-semibold text-ink-900">Payment certificates</h2>
      <ErrorAlert message={error} />
      {rows === null ? (
        <Spinner />
      ) : rows.length === 0 ? (
        <EmptyState
          title="No certificates yet"
          hint="Certificates are issued from submitted valuations on the Valuations tab."
        />
      ) : (
        <Table>
          <thead>
            <tr>
              <Th>No.</Th>
              <Th>Valuation</Th>
              <Th className="text-right">Certified work</Th>
              <Th className="text-right">Materials</Th>
              <Th className="text-right">Net certified</Th>
              <Th className="text-right">Variance</Th>
              <Th>Due date</Th>
              <Th>Issued</Th>
              <Th>Status</Th>
            </tr>
          </thead>
          <tbody className="divide-y divide-ink-100">
            {rows.map((c) => {
              const currency = currencyFor(c);
              const val = valById.get(c.valuationId);
              const variance = c.varianceFromApplication;
              return (
                <tr key={c.id} className="hover:bg-ink-50/60">
                  <Td className="whitespace-nowrap font-mono text-xs font-medium">
                    {padNo("PC", c.number)}
                  </Td>
                  <Td className="whitespace-nowrap font-mono text-xs">
                    {val ? padNo("VAL", val.number) : "—"}
                  </Td>
                  <Td className="text-right tabular-nums">{money(c.certifiedWorkDone, currency)}</Td>
                  <Td className="text-right tabular-nums">{money(c.certifiedMaterials, currency)}</Td>
                  <Td className="text-right font-medium tabular-nums">
                    {money(c.netCertified, currency)}
                  </Td>
                  <Td
                    className={
                      variance === 0
                        ? "text-right tabular-nums text-ink-400"
                        : variance > 0
                          ? "text-right font-medium tabular-nums text-emerald-600"
                          : "text-right font-medium tabular-nums text-red-600"
                    }
                  >
                    {variance === 0 ? "—" : `${variance > 0 ? "+" : ""}${money(variance, currency)}`}
                    {c.varianceReason ? (
                      <span className="ml-1 cursor-help text-ink-400" title={c.varianceReason}>
                        ⓘ
                      </span>
                    ) : null}
                  </Td>
                  <Td className="whitespace-nowrap">{formatDate(c.dueDate)}</Td>
                  <Td className="whitespace-nowrap text-xs text-ink-500">
                    {nameOf(c.issuedBy)}
                    <span className="block">{formatDateTime(c.issuedAt)}</span>
                  </Td>
                  <Td>
                    <Badge tone={certTone(c.status)}>{humanize(c.status)}</Badge>
                  </Td>
                </tr>
              );
            })}
          </tbody>
        </Table>
      )}
    </div>
  );
}
