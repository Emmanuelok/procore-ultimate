/**
 * FilterBuilder — the composable "field + operator + value" query editor with
 * nested AND/OR groups. This is what turns a grid into a reporting tool: a
 * quantity surveyor can ask for "commitments where status is any of [approved,
 * executed] AND (variance > 25000 OR forecast date is before 30 Jun)".
 *
 * The value is a pure data structure (`DataFilterGroup`), so a page can put it
 * in a saved view, a URL, or an API query without any translation layer.
 */
import { useCallback, useMemo, useState } from "react";
import { cx } from "../cx";
import {
  IconClose,
  IconFilterAdjust,
  IconPlus,
  IconTrash,
} from "../icons";
import { Button, Input, Select } from "../primitives";
import { Popover } from "../overlays";
import { OptionCheckList } from "./internals";
import {
  appendFilterNode,
  createCondition,
  createFilterGroup,
  filterFieldMap,
  operatorSpec,
  operatorsFor,
  pruneFilter,
  removeFilterNode,
  updateFilterNode,
} from "./filters";
import type {
  DataFilterCondition,
  DataFilterField,
  DataFilterGroup,
  DataFilterNode,
  DataOption,
} from "./types";

export interface FilterBuilderProps {
  value: DataFilterGroup | null;
  fields: readonly DataFilterField[];
  onChange: (next: DataFilterGroup | null) => void;
  /** Optional facet options, keyed by field id, when a column has none. */
  optionsFor?: (fieldId: string) => readonly DataOption[];
  className?: string;
  /** Nesting cap. Two levels covers every real query; three is plenty. */
  maxDepth?: number;
}

export function FilterBuilder({
  value,
  fields,
  onChange,
  optionsFor,
  className,
  maxDepth = 3,
}: FilterBuilderProps) {
  const fieldMap = useMemo(() => filterFieldMap(fields), [fields]);
  const root = value ?? createFilterGroup("and");

  const update = useCallback(
    (next: DataFilterGroup) => {
      onChange(next.children.length === 0 ? null : next);
    },
    [onChange],
  );

  const addCondition = useCallback(
    (parentId: string) => {
      const first = fields[0];
      if (!first) return;
      update(appendFilterNode(root, parentId, createCondition(first.id, first.kind)));
    },
    [fields, root, update],
  );

  const addGroup = useCallback(
    (parentId: string) => {
      const first = fields[0];
      if (!first) return;
      const group = createFilterGroup("or", [createCondition(first.id, first.kind)]);
      update(appendFilterNode(root, parentId, group));
    },
    [fields, root, update],
  );

  if (fields.length === 0) {
    return (
      <p className={cx("px-3 py-6 text-center text-body text-content-subtle", className)}>
        No filterable columns.
      </p>
    );
  }

  return (
    <div className={cx("flex min-w-0 flex-col gap-2", className)}>
      <GroupEditor
        group={root}
        depth={0}
        maxDepth={maxDepth}
        fields={fields}
        fieldMap={fieldMap}
        optionsFor={optionsFor}
        onUpdate={update}
        root={root}
        onAddCondition={addCondition}
        onAddGroup={addGroup}
      />
    </div>
  );
}

/* ------------------------------------------------------------------------- */

interface GroupEditorProps {
  group: DataFilterGroup;
  root: DataFilterGroup;
  depth: number;
  maxDepth: number;
  fields: readonly DataFilterField[];
  fieldMap: ReadonlyMap<string, DataFilterField>;
  optionsFor?: (fieldId: string) => readonly DataOption[];
  onUpdate: (next: DataFilterGroup) => void;
  onAddCondition: (parentId: string) => void;
  onAddGroup: (parentId: string) => void;
}

function GroupEditor({
  group,
  root,
  depth,
  maxDepth,
  fields,
  fieldMap,
  optionsFor,
  onUpdate,
  onAddCondition,
  onAddGroup,
}: GroupEditorProps) {
  const setConjunction = (conjunction: "and" | "or") => {
    onUpdate(
      updateFilterNode(root, group.id, (node) =>
        node.kind === "group" ? { ...node, conjunction } : node,
      ),
    );
  };

  return (
    <div
      className={cx(
        "min-w-0",
        depth > 0 &&
          "rounded-md border border-border-subtle bg-surface-sunken/60 p-2 shadow-e0",
      )}
    >
      <ul className="flex min-w-0 flex-col gap-1.5">
        {group.children.map((child, index) => (
          <li key={child.id} className="flex min-w-0 items-start gap-2">
            <div className="flex h-control-sm w-16 shrink-0 items-center">
              {index === 0 ? (
                <span className="text-label uppercase text-content-subtle">Where</span>
              ) : index === 1 ? (
                <Select
                  size="xs"
                  aria-label="Combine with"
                  value={group.conjunction}
                  onChange={(event) => setConjunction(event.target.value as "and" | "or")}
                  className="w-full"
                >
                  <option value="and">and</option>
                  <option value="or">or</option>
                </Select>
              ) : (
                <span className="pl-1 text-body text-content-muted">{group.conjunction}</span>
              )}
            </div>

            <div className="min-w-0 flex-1">
              {child.kind === "group" ? (
                <GroupEditor
                  group={child}
                  root={root}
                  depth={depth + 1}
                  maxDepth={maxDepth}
                  fields={fields}
                  fieldMap={fieldMap}
                  optionsFor={optionsFor}
                  onUpdate={onUpdate}
                  onAddCondition={onAddCondition}
                  onAddGroup={onAddGroup}
                />
              ) : (
                <ConditionEditor
                  condition={child}
                  root={root}
                  fields={fields}
                  fieldMap={fieldMap}
                  optionsFor={optionsFor}
                  onUpdate={onUpdate}
                />
              )}
            </div>

            <Button
              variant="ghost"
              size="xs"
              iconOnly
              leadingIcon={child.kind === "group" ? IconTrash : IconClose}
              aria-label={child.kind === "group" ? "Remove group" : "Remove condition"}
              className="mt-0.5 shrink-0 text-content-subtle hover:text-danger-fg"
              onClick={() => onUpdate(removeFilterNode(root, child.id))}
            />
          </li>
        ))}
      </ul>

      <div className="mt-2 flex items-center gap-1 pl-16">
        <Button
          variant="ghost"
          size="xs"
          leadingIcon={IconPlus}
          onClick={() => onAddCondition(group.id)}
        >
          Condition
        </Button>
        {depth + 1 < maxDepth ? (
          <Button
            variant="ghost"
            size="xs"
            leadingIcon={IconFilterAdjust}
            onClick={() => onAddGroup(group.id)}
          >
            Group
          </Button>
        ) : null}
      </div>
    </div>
  );
}

/* ------------------------------------------------------------------------- */

interface ConditionEditorProps {
  condition: DataFilterCondition;
  root: DataFilterGroup;
  fields: readonly DataFilterField[];
  fieldMap: ReadonlyMap<string, DataFilterField>;
  optionsFor?: (fieldId: string) => readonly DataOption[];
  onUpdate: (next: DataFilterGroup) => void;
}

function ConditionEditor({
  condition,
  root,
  fields,
  fieldMap,
  optionsFor,
  onUpdate,
}: ConditionEditorProps) {
  const field = fieldMap.get(condition.field) ?? fields[0];
  const kind = field?.kind ?? "text";
  const operators = operatorsFor(kind);
  const spec = operatorSpec(kind, condition.operator);

  const patch = (next: Partial<DataFilterCondition>) => {
    onUpdate(
      updateFilterNode(root, condition.id, (node) =>
        node.kind === "condition" ? { ...node, ...next } : node,
      ),
    );
  };

  const onFieldChange = (fieldId: string) => {
    const nextField = fieldMap.get(fieldId);
    const nextKind = nextField?.kind ?? "text";
    const nextOperator = operatorsFor(nextKind)[0]?.value ?? "contains";
    patch({
      field: fieldId,
      operator: nextOperator,
      value: nextKind === "enum" ? [] : "",
      value2: undefined,
    });
  };

  const inputType = kind === "date" ? "date" : kind === "number" ? "number" : "text";

  return (
    <div className="flex min-w-0 flex-wrap items-center gap-1.5">
      <Select
        size="xs"
        aria-label="Field"
        value={condition.field}
        onChange={(event) => onFieldChange(event.target.value)}
        className="w-40 min-w-0"
      >
        {fields.map((entry) => (
          <option key={entry.id} value={entry.id}>
            {entry.label}
          </option>
        ))}
      </Select>

      <Select
        size="xs"
        aria-label="Operator"
        value={condition.operator}
        onChange={(event) =>
          patch({ operator: event.target.value as DataFilterCondition["operator"] })
        }
        className="w-36 min-w-0"
      >
        {operators.map((entry) => (
          <option key={entry.value} value={entry.value}>
            {entry.label}
          </option>
        ))}
      </Select>

      {spec.arity === 0 ? null : spec.multi ? (
        <EnumConditionValue
          condition={condition}
          field={field}
          optionsFor={optionsFor}
          onChange={(next) => patch({ value: next })}
        />
      ) : (
        <>
          <Input
            size="xs"
            type={inputType}
            aria-label="Value"
            placeholder="Value"
            value={typeof condition.value === "string" ? condition.value : ""}
            onChange={(event) => patch({ value: event.target.value })}
            className="w-36 min-w-0"
          />
          {spec.arity === 2 ? (
            <>
              <span className="text-meta text-content-subtle">and</span>
              <Input
                size="xs"
                type={inputType}
                aria-label="Second value"
                placeholder="Value"
                value={typeof condition.value2 === "string" ? condition.value2 : ""}
                onChange={(event) => patch({ value2: event.target.value })}
                className="w-36 min-w-0"
              />
            </>
          ) : null}
        </>
      )}
    </div>
  );
}

function EnumConditionValue({
  condition,
  field,
  optionsFor,
  onChange,
}: {
  condition: DataFilterCondition;
  field: DataFilterField | undefined;
  optionsFor?: (fieldId: string) => readonly DataOption[];
  onChange: (next: string[]) => void;
}) {
  const [open, setOpen] = useState(false);
  const selected = Array.isArray(condition.value) ? (condition.value as string[]) : [];
  const options = useMemo<readonly DataOption[]>(() => {
    if (field?.options?.length) return field.options;
    if (optionsFor && field) return optionsFor(field.id);
    return [];
  }, [field, optionsFor, open]); // eslint-disable-line react-hooks/exhaustive-deps

  const label =
    selected.length === 0
      ? "Select…"
      : selected.length === 1
        ? (options.find((option) => option.value === selected[0])?.text ?? selected[0] ?? "")
        : `${selected.length} selected`;

  return (
    <Popover
      open={open}
      onOpenChange={setOpen}
      placement="bottom-start"
      padded={false}
      role="listbox"
      aria-label="Filter values"
      trigger={
        <Button variant="outline" size="xs" className="w-40 min-w-0 justify-between font-normal">
          <span className="truncate">{label}</span>
        </Button>
      }
    >
      <OptionCheckList
        options={options}
        selected={selected}
        onToggle={(optionValue, next) => {
          onChange(
            next
              ? [...selected, optionValue]
              : selected.filter((entry) => entry !== optionValue),
          );
        }}
        onClear={() => onChange([])}
      />
    </Popover>
  );
}

/* ------------------------------------------------------------------------- */

/** Convenience wrapper: the toolbar's "Filter" popover, already wired. */
export function FilterBuilderPopover({
  value,
  fields,
  onChange,
  optionsFor,
  open,
  onOpenChange,
  trigger,
}: FilterBuilderProps & {
  open?: boolean;
  onOpenChange?: (open: boolean) => void;
  trigger: React.ReactElement;
}) {
  const fieldMap = useMemo(() => filterFieldMap(fields), [fields]);
  const count = value ? countLeaves(value) : 0;

  return (
    <Popover
      open={open}
      onOpenChange={onOpenChange}
      trigger={trigger}
      placement="bottom-start"
      width={640}
      padded={false}
      title="Advanced filter"
      aria-label="Advanced filter"
    >
      <div className="max-h-[60vh] overflow-y-auto p-3">
        <FilterBuilder
          value={value}
          fields={fields}
          onChange={onChange}
          optionsFor={optionsFor}
        />
      </div>
      <div className="flex items-center justify-between gap-2 border-t border-border px-3 py-2">
        <span className="text-meta text-content-subtle">
          {count === 0 ? "No conditions" : `${count} condition${count === 1 ? "" : "s"}`}
        </span>
        <div className="flex items-center gap-1.5">
          <Button
            variant="ghost"
            size="sm"
            onClick={() => onChange(null)}
            disabled={count === 0}
          >
            Clear
          </Button>
          <Button
            variant="secondary"
            size="sm"
            onClick={() => {
              onChange(pruneFilter(value, fieldMap));
              onOpenChange?.(false);
            }}
          >
            Done
          </Button>
        </div>
      </div>
    </Popover>
  );
}

function countLeaves(node: DataFilterNode): number {
  if (node.kind === "condition") return 1;
  return node.children.reduce((total, child) => total + countLeaves(child), 0);
}
