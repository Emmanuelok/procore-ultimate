/**
 * Panel — the card every command-centre block is built from.
 *
 * It owns the four states a panel can be in so no panel re-invents them:
 * loading (a skeleton, never a spinner), failed (the server's message plus a
 * retry), empty (a designed state that says WHY it is empty), and populated.
 */
import type { ReactNode } from "react";
import { Button, Card, CardBody, CardHeader, EmptyState, Skeleton } from "../../../ui";
import { IconRefresh, type IconComponent } from "../../../ui/icons";
import { cx } from "../../../ui/cx";
import { toneClass, type Tone } from "../../../ui/tokens";

export interface PanelProps {
  title: ReactNode;
  subtitle?: ReactNode;
  icon?: IconComponent;
  tone?: Tone;
  actions?: ReactNode;
  loading?: boolean;
  error?: string | null;
  onRetry?: () => void;
  /** True when the request succeeded but there is nothing to show. */
  isEmpty?: boolean;
  emptyTitle?: string;
  /** WHY it is empty. Always supply this — "No data" on its own is a shrug. */
  emptyHint?: ReactNode;
  emptyIcon?: IconComponent;
  emptyAction?: ReactNode;
  /** Custom loading body. Defaults to three skeleton lines. */
  skeleton?: ReactNode;
  footer?: ReactNode;
  className?: string;
  bodyClassName?: string;
  flush?: boolean;
  children?: ReactNode;
}

export default function Panel({
  title,
  subtitle,
  icon,
  tone = "neutral",
  actions,
  loading = false,
  error = null,
  onRetry,
  isEmpty = false,
  emptyTitle = "Nothing to show",
  emptyHint,
  emptyIcon,
  emptyAction,
  skeleton,
  footer,
  className,
  bodyClassName,
  flush = false,
  children,
}: PanelProps) {
  let body: ReactNode;
  if (loading) {
    body = skeleton ?? <DefaultSkeleton />;
  } else if (error) {
    body = (
      <div className={cx("rounded-md border p-3", toneClass("danger", "subtle"), toneClass("danger", "border"))}>
        <p className="text-meta font-medium">This panel could not be loaded.</p>
        <p className="mt-1 text-2xs leading-snug opacity-90">{error}</p>
        {onRetry ? (
          <Button
            size="xs"
            variant="secondary"
            leadingIcon={IconRefresh}
            className="mt-2"
            onClick={onRetry}
          >
            Try again
          </Button>
        ) : null}
      </div>
    );
  } else if (isEmpty) {
    body = (
      <EmptyState
        size="sm"
        icon={emptyIcon ?? icon}
        title={emptyTitle}
        hint={emptyHint}
        action={emptyAction}
      />
    );
  } else {
    body = children;
  }

  return (
    <Card className={cx("flex min-w-0 flex-col", className)}>
      <CardHeader title={title} subtitle={subtitle} icon={icon} tone={tone} actions={actions} />
      <CardBody className={cx("flex-1", flush && "p-0", bodyClassName)}>{body}</CardBody>
      {footer ? (
        <div className="border-t border-border-subtle px-card py-2.5 text-2xs text-content-subtle">
          {footer}
        </div>
      ) : null}
    </Card>
  );
}

function DefaultSkeleton() {
  return (
    <div className="space-y-2.5">
      <Skeleton height={12} width="62%" radius="sm" />
      <Skeleton height={12} width="88%" radius="sm" />
      <Skeleton height={12} width="45%" radius="sm" />
    </div>
  );
}

/** A row skeleton for list panels. */
export function RowSkeleton({ rows = 4 }: { rows?: number }) {
  return (
    <div className="space-y-3">
      {Array.from({ length: rows }).map((_, index) => (
        <div key={index} className="flex items-center gap-3">
          <Skeleton width={38} height={12} radius="sm" />
          <Skeleton height={12} className="flex-1" radius="sm" />
          <Skeleton width={56} height={12} radius="sm" />
        </div>
      ))}
    </div>
  );
}
