/**
 * Metric catalogue — the code-resident registry (#821-828): what each metric
 * means, its unit, which direction is merit, and which platform records the
 * computation reads. A metric whose inputs are missing computes to a 422
 * with reasons, never to a fabricated number — the "needs" column tells the
 * reader up front what has to exist.
 */
import { Badge, Card, CardBody, Spinner, Table, Td, Th } from "../../ui";
import { DirectionBadge, LoadError } from "./benchmarksShared";
import type { MetricDef } from "./benchmarksShared";

export default function CatalogueTab({
  metrics,
  minSampleN,
  accessModel,
  error,
  onReload,
}: {
  metrics: MetricDef[] | null;
  minSampleN: number;
  accessModel: string | null;
  error: string | null;
  onReload: () => void;
}) {
  if (error && !metrics) return <LoadError message={error} onRetry={onReload} />;
  if (!metrics) return <Spinner label="Loading the metric registry…" />;

  return (
    <div className="space-y-4">
      {accessModel ? (
        <Card>
          <CardBody className="flex flex-wrap items-start justify-between gap-3">
            <div className="max-w-3xl">
              <h3 className="text-xs font-semibold uppercase tracking-wide text-ink-500">
                Access model
              </h3>
              <p className="mt-1 text-sm text-ink-700">{accessModel}</p>
            </div>
            <Badge tone="blue">Suppression below n = {minSampleN}</Badge>
          </CardBody>
        </Card>
      ) : null}

      <Table>
        <thead>
          <tr>
            <Th>Metric</Th>
            <Th>Unit</Th>
            <Th>Direction of merit</Th>
            <Th className="min-w-64">What it measures</Th>
            <Th className="min-w-64">What it needs</Th>
          </tr>
        </thead>
        <tbody className="divide-y divide-ink-100">
          {metrics.map((m) => (
            <tr key={m.key} className="align-top">
              <Td>
                <div className="font-medium text-ink-900">{m.name}</div>
                <div className="mt-0.5 font-mono text-[11px] text-ink-400">{m.key}</div>
              </Td>
              <Td className="whitespace-nowrap text-ink-600">{m.unit}</Td>
              <Td>
                <DirectionBadge higherIsBetter={m.higherIsBetter} />
              </Td>
              <Td className="text-xs leading-5 text-ink-600">{m.description}</Td>
              <Td className="text-xs leading-5 text-ink-600">{m.inputs}</Td>
            </tr>
          ))}
        </tbody>
      </Table>
    </div>
  );
}
