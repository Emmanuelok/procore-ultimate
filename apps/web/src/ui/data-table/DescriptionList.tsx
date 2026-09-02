/**
 * DescriptionList — the label/value grid every detail page needs.
 *
 * Two layouts: `stacked` (label above value, the default, best in narrow
 * inspector panels) and `inline` (label in a fixed-width gutter, best for long
 * scannable records). Values can be copied with one click, which matters when
 * the value is a contract number someone has to paste into an email.
 */
import { useCallback, useState, type ReactNode } from "react";
import { cx } from "../cx";
import { IconCheck, IconCopy } from "../icons";
import { type IconLike } from "../primitives";
import { tone as toneStyles, type Tone } from "../tokens";
import { renderIconLike } from "./internals";
import { EMPTY_VALUE } from "./format";

export interface DescriptionItem {
  id?: string;
  label: ReactNode;
  value: ReactNode;
  /** Supporting note under the value. */
  hint?: ReactNode;
  icon?: IconLike;
  tone?: Tone;
  /** Copy affordance. Provide the raw text to copy. */
  copyValue?: string;
  /** Column span inside the grid. */
  span?: 1 | 2 | 3 | 4 | "full";
  /** Right-aligned controls (edit pencil, external link). */
  actions?: ReactNode;
  /** Skip rendering entirely — handy for conditional fields. */
  hidden?: boolean;
}

export interface DescriptionListProps {
  items: readonly DescriptionItem[];
  /** Grid columns at the widest breakpoint. Default 2. */
  columns?: 1 | 2 | 3 | 4;
  layout?: "stacked" | "inline";
  /** Gutter width for `inline`, in rem. Default 10. */
  labelWidth?: number;
  /** Hairline between rows. */
  dividers?: boolean;
  size?: "sm" | "md";
  className?: string;
  "aria-label"?: string;
}

const COLUMN_CLASS: Record<1 | 2 | 3 | 4, string> = {
  1: "grid-cols-1",
  2: "grid-cols-1 sm:grid-cols-2",
  3: "grid-cols-1 sm:grid-cols-2 lg:grid-cols-3",
  4: "grid-cols-1 sm:grid-cols-2 lg:grid-cols-4",
};

const SPAN_CLASS: Record<string, string> = {
  "1": "",
  "2": "sm:col-span-2",
  "3": "sm:col-span-2 lg:col-span-3",
  "4": "sm:col-span-2 lg:col-span-4",
  full: "col-span-full",
};

export function DescriptionList({
  items,
  columns = 2,
  layout = "stacked",
  labelWidth = 10,
  dividers = false,
  size = "md",
  className,
  "aria-label": ariaLabel,
}: DescriptionListProps) {
  const visible = items.filter((item) => !item.hidden);

  return (
    <dl
      aria-label={ariaLabel}
      className={cx(
        "grid gap-x-6",
        COLUMN_CLASS[columns],
        dividers ? "gap-y-0" : size === "sm" ? "gap-y-2.5" : "gap-y-stack",
        className,
      )}
    >
      {visible.map((item, index) => (
        <DescriptionRow
          key={item.id ?? index}
          item={item}
          layout={layout}
          labelWidth={labelWidth}
          dividers={dividers}
          size={size}
        />
      ))}
    </dl>
  );
}

function DescriptionRow({
  item,
  layout,
  labelWidth,
  dividers,
  size,
}: {
  item: DescriptionItem;
  layout: "stacked" | "inline";
  labelWidth: number;
  dividers: boolean;
  size: "sm" | "md";
}) {
  const styles = item.tone ? toneStyles[item.tone] : null;
  const blank = item.value === null || item.value === undefined || item.value === "";

  const label = (
    <dt
      className={cx(
        "flex min-w-0 shrink-0 items-center gap-1.5 text-label uppercase text-content-subtle",
        layout === "inline" && "pt-px",
      )}
      style={layout === "inline" ? { width: `${labelWidth}rem` } : undefined}
    >
      {renderIconLike(item.icon, 12, "shrink-0")}
      <span className="truncate">{item.label}</span>
    </dt>
  );

  const value = (
    <dd
      className={cx(
        "group/value flex min-w-0 flex-1 items-start gap-1.5",
        size === "sm" ? "text-meta" : "text-body",
        blank ? "text-content-disabled" : styles?.text ?? "text-content",
      )}
    >
      <span className="min-w-0 flex-1 break-words">{blank ? EMPTY_VALUE : item.value}</span>
      {item.copyValue ? <CopyButton value={item.copyValue} /> : null}
      {item.actions ? <span className="shrink-0">{item.actions}</span> : null}
    </dd>
  );

  return (
    <div
      className={cx(
        "min-w-0",
        SPAN_CLASS[String(item.span ?? 1)],
        layout === "inline" ? "flex items-start gap-3" : "flex flex-col gap-0.5",
        dividers && "border-b border-border-subtle py-2 last:border-b-0",
      )}
    >
      {label}
      <div className={cx("min-w-0", layout === "inline" ? "flex-1" : undefined)}>
        {value}
        {item.hint ? (
          <p className="mt-0.5 text-meta text-content-subtle">{item.hint}</p>
        ) : null}
      </div>
    </div>
  );
}

function CopyButton({ value }: { value: string }) {
  const [copied, setCopied] = useState(false);

  const copy = useCallback(async () => {
    try {
      await navigator.clipboard.writeText(value);
      setCopied(true);
      window.setTimeout(() => setCopied(false), 1400);
    } catch {
      /* clipboard blocked — nothing useful to do */
    }
  }, [value]);

  return (
    <button
      type="button"
      onClick={copy}
      aria-label={copied ? "Copied" : `Copy ${value}`}
      className={cx(
        "grid size-5 shrink-0 place-items-center rounded-xs text-content-subtle",
        "opacity-0 transition-opacity duration-fast hover:bg-surface-active hover:text-content",
        "group-hover/value:opacity-100 focus-visible:opacity-100",
        copied && "opacity-100 text-success-fg",
      )}
    >
      {copied ? <IconCheck size={12} strokeWidth={2.5} /> : <IconCopy size={12} />}
    </button>
  );
}
