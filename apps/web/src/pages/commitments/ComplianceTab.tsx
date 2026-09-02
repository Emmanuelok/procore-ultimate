/**
 * THE COMPLIANCE REGISTER — every commitment on the project with its
 * insurance, bonding and lien-waiver position, worst first.
 *
 * This is the page that makes an expired certificate somebody's problem before
 * a payment run rather than after one. It is deliberately not a dashboard of
 * counts: each row carries the finding sentences the compliance engine wrote,
 * with the certificate's actual expiry date and how many days ago it lapsed.
 */
import { useState } from "react";
import {
  Alert,
  Badge,
  Button,
  Card,
  CardBody,
  EmptyState,
  ErrorAlert,
  Spinner,
} from "../../ui";
import {
  COMPLIANCE_LABEL,
  FindingList,
  complianceTone,
  money,
  titleCase,
  useResource,
  type Loadable,
} from "./shared";
import type { ComplianceEntry, ComplianceReport, ComplianceStatus } from "./types";

const ORDER: ComplianceStatus[] = ["blocked", "warning", "unknown", "compliant"];

/** What the daily sweep is about to notify on: cover running out inside the window. */
interface UpcomingExpiry {
  commitmentId: string;
  reference: string;
  vendorName: string | null;
  currency: string;
  unpaidBalance: number;
  subjectType: "certificate" | "bond";
  coverage: string;
  expiresOn: string;
  daysUntilExpiry: number;
  line: number | null;
  renewalRequest: string;
}

interface UpcomingReport {
  asOf: string;
  windowDays: number;
  items: UpcomingExpiry[];
  byLine: { within7: number; within14: number; within30: number };
  lastSweptAt: string | null;
  note: string | null;
}

/**
 * COVER ABOUT TO RUN OUT (#530-#532). A certificate that expires on the 14th
 * is a phone call on the 1st and a stopped payment on the 15th; the whole
 * value of this panel is that it appears BEFORE the answer becomes no. Each
 * row carries the renewal request the project can send the vendor verbatim.
 */
function UpcomingExpiries({
  projectId,
  onOpen,
}: {
  projectId: string;
  onOpen: (commitmentId: string) => void;
}) {
  const upcoming = useResource<UpcomingReport>(
    `/api/v1/projects/${projectId}/commitments/compliance/upcoming?days=30`,
  );
  const data = upcoming.data;
  if (upcoming.error) return <ErrorAlert message={upcoming.error} onRetry={upcoming.reload} />;
  if (!data) return null;
  if (data.items.length === 0) {
    return (
      <Card>
        <CardBody>
          <p className="text-meta text-content-muted">
            No insurance certificate or bond on a commitment with money still to pay expires within{" "}
            {data.windowDays} days.
          </p>
          <p className="mt-1 text-2xs text-content-subtle">
            {data.note ?? `Last swept ${data.lastSweptAt ?? "—"}.`}
          </p>
        </CardBody>
      </Card>
    );
  }
  return (
    <Card>
      <CardBody className="space-y-2">
        <div className="flex flex-wrap items-center gap-2">
          <span className="text-label uppercase text-content-subtle">
            Cover running out inside {data.windowDays} days
          </span>
          <Badge size="xs" tone={data.byLine.within7 > 0 ? "danger" : "neutral"}>
            {data.byLine.within7} within 7d
          </Badge>
          <Badge size="xs" tone={data.byLine.within14 > 0 ? "warning" : "neutral"}>
            {data.byLine.within14} within 14d
          </Badge>
          <Badge size="xs" tone="neutral">
            {data.byLine.within30} within 30d
          </Badge>
        </div>
        <p className="text-2xs text-content-subtle">
          {data.note ??
            `The daily sweep last ran at ${data.lastSweptAt}. It notifies the project team once per line crossed, not every morning.`}
        </p>
        <ul className="space-y-2">
          {data.items.map((it) => (
            <li
              key={`${it.subjectType}-${it.commitmentId}-${it.expiresOn}-${it.coverage}`}
              className="rounded-md border border-border p-2"
            >
              <div className="flex flex-wrap items-center gap-2">
                <Badge
                  size="xs"
                  tone={it.daysUntilExpiry <= 7 ? "danger" : it.daysUntilExpiry <= 14 ? "warning" : "neutral"}
                >
                  {it.daysUntilExpiry}d
                </Badge>
                <span className="font-mono text-2xs">{it.reference}</span>
                <span className="text-meta">
                  {it.vendorName ?? "vendor"} — {it.coverage} {it.subjectType} expires {it.expiresOn}
                </span>
                <span className="text-2xs text-content-subtle">
                  {money(it.unpaidBalance, it.currency)} still unpaid
                </span>
                <Button size="xs" variant="ghost" onClick={() => onOpen(it.commitmentId)}>
                  Open
                </Button>
              </div>
              <details className="mt-1">
                <summary className="cursor-pointer text-2xs text-accent-text">
                  Renewal request to send
                </summary>
                <p className="mt-1 whitespace-pre-wrap text-2xs text-content-muted">
                  {it.renewalRequest}
                </p>
              </details>
            </li>
          ))}
        </ul>
      </CardBody>
    </Card>
  );
}

export default function ComplianceTab({
  projectId,
  report,
  onOpen,
}: {
  projectId: string;
  report: Loadable<ComplianceReport>;
  onOpen: (commitmentId: string) => void;
}) {
  const [only, setOnly] = useState<ComplianceStatus | "all">("all");

  if (report.loading && !report.data) {
    return (
      <div className="py-12">
        <Spinner label="Reading the certificate and bond register…" />
      </div>
    );
  }
  if (report.error) return <ErrorAlert message={report.error} onRetry={report.reload} />;
  const data = report.data;
  if (!data) return null;

  if (data.entries.length === 0) {
    return (
      <EmptyState
        title="No live commitments to assess"
        hint="The compliance sweep covers every commitment on the project that is not void. There are none."
      />
    );
  }

  const entries =
    only === "all" ? data.entries : data.entries.filter((e) => e.compliance.status === only);

  return (
    <div className="space-y-4">
      <UpcomingExpiries projectId={projectId} onOpen={onOpen} />

      <Card>
        <CardBody className="space-y-3">
          <div className="flex flex-wrap items-center gap-2">
            <span className="text-label uppercase text-content-subtle">
              Assessed {data.asOf}
            </span>
            <Button
              size="xs"
              variant={only === "all" ? "secondary" : "ghost"}
              onClick={() => setOnly("all")}
            >
              All {data.summary.total}
            </Button>
            {ORDER.map((status) => (
              <Button
                key={status}
                size="xs"
                variant={only === status ? "secondary" : "ghost"}
                onClick={() => setOnly(status)}
              >
                {COMPLIANCE_LABEL[status]} {countOf(data, status)}
              </Button>
            ))}
          </div>
          <p className="text-2xs text-content-muted">
            {data.summary.paymentBlocked} commitment
            {data.summary.paymentBlocked === 1 ? "" : "s"} cannot have a payment issued against
            {data.summary.paymentBlocked === 1 ? " it" : " them"} right now. The certificate and
            bond records are read live from the insurance module — this register never holds its own
            copy of a certificate, so it cannot disagree with the insurance dashboard about one.
          </p>
          {data.notes.map((note) => (
            <Alert key={note} tone="info" size="sm">
              {note}
            </Alert>
          ))}
        </CardBody>
      </Card>

      {entries.length === 0 ? (
        <EmptyState
          title={`No commitment is ${COMPLIANCE_LABEL[only as ComplianceStatus].toLowerCase()}`}
          hint="Pick another bucket above."
        />
      ) : (
        <div className="space-y-3">
          {entries.map((entry) => (
            <EntryCard key={entry.commitmentId} entry={entry} onOpen={onOpen} />
          ))}
        </div>
      )}
    </div>
  );
}

function countOf(report: ComplianceReport, status: ComplianceStatus): number {
  switch (status) {
    case "blocked":
      return report.summary.blocked;
    case "warning":
      return report.summary.warning;
    case "unknown":
      return report.summary.unknown;
    default:
      return report.summary.compliant;
  }
}

function EntryCard({
  entry,
  onOpen,
}: {
  entry: ComplianceEntry;
  onOpen: (commitmentId: string) => void;
}) {
  const c = entry.compliance;
  return (
    <Card>
      <CardBody className="space-y-2">
        <div className="flex flex-wrap items-start justify-between gap-2">
          <div className="min-w-0">
            <div className="flex flex-wrap items-center gap-2">
              <span className="font-mono text-sm font-semibold">{entry.reference}</span>
              <span className="truncate text-sm">{entry.title}</span>
              <Badge tone={complianceTone(c.status)} dot size="xs">
                {COMPLIANCE_LABEL[c.status]}
              </Badge>
              <Badge tone="neutral" size="xs" variant="outline">
                strictness {c.strictness}
              </Badge>
            </div>
            <p className="mt-0.5 text-2xs text-content-subtle">
              {entry.vendorName ?? "no vendor bound"} · {titleCase(entry.kind)} ·{" "}
              {titleCase(entry.status)} ·{" "}
              {money(entry.revisedCommitmentSum, entry.currency)}
            </p>
          </div>
          <Button size="xs" variant="secondary" onClick={() => onOpen(entry.commitmentId)}>
            Open commitment
          </Button>
        </div>

        {c.note ? <p className="text-meta text-content-muted">{c.note}</p> : null}
        <FindingList findings={c.blocking} heading="Blocking — payment refused" />
        <FindingList findings={c.warnings} heading="Warnings — payment permitted, exposure recorded" />
        {c.findings.length === 0 ? (
          <p className="text-2xs text-content-subtle">
            {c.requirementsKnown
              ? `Every recorded requirement is satisfied. ${c.evidence.certificatesConsidered} certificate(s) and ${c.evidence.bondsConsidered} bond(s) were consulted.`
              : "No insurance or bond requirement is recorded on this commitment, so nothing was tested."}
          </p>
        ) : null}
      </CardBody>
    </Card>
  );
}
