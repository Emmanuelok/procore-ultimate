/**
 * Recent activity — the last things to move on this project.
 *
 * ---------------------------------------------------------------------------
 * WHAT THIS IS, AND WHAT IT IS NOT
 *
 * It is the most recently UPDATED records across the registers this page has
 * already loaded: RFIs, submittals, punch, commitments and owner applications.
 * No extra request is made for it and nothing is invented — every entry is a
 * row with a real `updatedAt` and a link to the record.
 *
 * It is NOT the audit trail. The hash-chained ledger that records who changed
 * what, and when, lives under Assurance, and the footer says so rather than
 * letting this panel be mistaken for it.
 */
import { Link } from "react-router-dom";
import { ActivityBadge, ActivityFeed, type TimelineItem } from "../../../ui";
import {
  IconActivity,
  IconCommitment,
  IconInvoice,
  IconPunch,
  IconRfi,
  IconSubmittal,
} from "../../../ui/icons";
import type { Tone } from "../../../ui/tokens";
import { money, titleCase, type Loadable, type Paginated } from "../../../layouts/project/lib";
import Panel, { RowSkeleton } from "./Panel";
import type {
  CommitmentList,
  InvoiceRow,
  PunchRow,
  RfiRow,
  SubmittalRow,
} from "./types";

const SHOWN = 10;

export interface ActivityPanelProps {
  rfis: Loadable<Paginated<RfiRow>>;
  submittals: Loadable<Paginated<SubmittalRow>>;
  punch: Loadable<Paginated<PunchRow>>;
  commitments: Loadable<CommitmentList>;
  invoices: Loadable<Paginated<InvoiceRow>>;
  className?: string;
}

function statusTone(status: string): Tone {
  if (/reject|void|terminat|late/.test(status)) return "danger";
  if (/pending|review|hold|revise|submitted/.test(status)) return "warning";
  if (/approv|closed|paid|complete|answered|executed/.test(status)) return "success";
  return "neutral";
}

export default function ActivityPanel({
  rfis,
  submittals,
  punch,
  commitments,
  invoices,
  className,
}: ActivityPanelProps) {
  const items: TimelineItem[] = [];

  for (const row of rfis.data?.items ?? []) {
    items.push({
      id: `rfi-${row.id}`,
      icon: IconRfi,
      tone: statusTone(row.status),
      timestamp: row.updatedAt,
      badge: <ActivityBadge action={titleCase(row.status)} tone={statusTone(row.status)} />,
      title: (
        <Link to={`rfis/${row.id}`} className="hover:underline underline-offset-2">
          RFI-{String(row.number).padStart(3, "0")} · {row.subject}
        </Link>
      ),
    });
  }

  for (const row of submittals.data?.items ?? []) {
    items.push({
      id: `sub-${row.id}`,
      icon: IconSubmittal,
      tone: statusTone(row.status),
      timestamp: row.updatedAt,
      badge: <ActivityBadge action={titleCase(row.status)} tone={statusTone(row.status)} />,
      title: (
        <Link to={`submittals/${row.id}`} className="hover:underline underline-offset-2">
          SUB-{String(row.number).padStart(3, "0")} · {row.title}
        </Link>
      ),
    });
  }

  for (const row of punch.data?.items ?? []) {
    items.push({
      id: `punch-${row.id}`,
      icon: IconPunch,
      tone: statusTone(row.status),
      timestamp: row.updatedAt,
      badge: <ActivityBadge action={titleCase(row.status)} tone={statusTone(row.status)} />,
      title: (
        <Link to="punch" className="hover:underline underline-offset-2">
          PL-{String(row.number).padStart(3, "0")} · {row.title}
        </Link>
      ),
    });
  }

  for (const row of commitments.data?.items ?? []) {
    items.push({
      id: `commitment-${row.id}`,
      icon: IconCommitment,
      tone: statusTone(row.status),
      timestamp: row.updatedAt,
      badge: <ActivityBadge action={titleCase(row.status)} tone={statusTone(row.status)} />,
      description: `${row.vendorName ?? "No vendor recorded"} · ${money(row.revisedCommitmentSum, row.currency)}`,
      title: (
        <Link to="commitments" className="hover:underline underline-offset-2">
          {row.reference} · {row.title}
        </Link>
      ),
    });
  }

  for (const row of invoices.data?.items ?? []) {
    items.push({
      id: `invoice-${row.id}`,
      icon: IconInvoice,
      tone: statusTone(row.status),
      timestamp: row.updatedAt,
      badge: <ActivityBadge action={titleCase(row.status)} tone={statusTone(row.status)} />,
      description: `${money(row.currentPaymentDue, row.currency)} due this application`,
      title: (
        <Link to="invoicing" className="hover:underline underline-offset-2">
          {row.reference}
          {row.title ? ` · ${row.title}` : ""}
        </Link>
      ),
    });
  }

  const ordered = items
    .filter((item) => Boolean(item.timestamp))
    .sort((a, b) => String(b.timestamp).localeCompare(String(a.timestamp)))
    .slice(0, SHOWN);

  const loading =
    rfis.loading && submittals.loading && punch.loading && commitments.loading && invoices.loading;

  const missing = [
    rfis.error ? "RFIs" : null,
    submittals.error ? "submittals" : null,
    punch.error ? "punch" : null,
    commitments.error ? "commitments" : null,
    invoices.error ? "owner applications" : null,
  ].filter((label): label is string => label !== null);

  return (
    <Panel
      className={className}
      title="Recent activity"
      subtitle="Most recently updated records across this project"
      icon={IconActivity}
      loading={loading}
      isEmpty={ordered.length === 0}
      emptyTitle="Nothing has moved yet"
      emptyHint="No record in the RFI, submittal, punch, commitment or owner-application registers has been updated. Activity appears here as soon as work starts."
      skeleton={<RowSkeleton rows={5} />}
      footer={
        <>
          Built from the registers already loaded on this page — RFIs, submittals, punch,
          commitments and owner applications. It is not the audit trail: the hash-chained ledger of
          every change lives under{" "}
          <Link to="assurance" className="text-accent-text underline underline-offset-2">
            Assurance
          </Link>
          .
          {missing.length > 0 ? ` This feed EXCLUDES ${missing.join(", ")} — those registers could not be read.` : ""}
        </>
      }
    >
      <ActivityFeed items={ordered} groupByDay timeFormat="relative" aria-label="Recent activity" />
    </Panel>
  );
}
