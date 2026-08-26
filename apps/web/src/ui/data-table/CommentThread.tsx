/**
 * CommentThread — the discussion attached to a record.
 *
 * Handles the things that actually matter on a construction record: who said
 * it, when, whether it is an internal note or visible to the client, mentions
 * rendered as chips, attachments, replies, and resolution.
 *
 * Body text is treated as plain text. Mentions are written either as
 * `@[Jane Cole](user_12)` or as a bare `@Jane Cole` matching a known mention;
 * URLs are linkified. Nothing else is interpreted, so a pasted contract clause
 * cannot inject markup.
 */
import {
  Fragment,
  useCallback,
  useMemo,
  useRef,
  useState,
  type KeyboardEvent as ReactKeyboardEvent,
  type ReactNode,
} from "react";
import { cx } from "../cx";
import {
  IconCheck,
  IconCheckCircle,
  IconComment,
  IconLock,
  IconMore,
  IconSend,
} from "../icons";
import { Avatar, Badge, Button, EmptyState, Textarea } from "../primitives";
import { DropdownMenu, MenuItem } from "../overlays";
import { AttachmentGrid, type FileItem } from "./FileList";
import { formatDateTimeCell, formatRelativeTime, toDate } from "./format";

export interface CommentAuthor {
  id?: string;
  name: string;
  avatarUrl?: string | null;
  role?: string;
}

export interface CommentMention {
  id: string;
  label: string;
}

export interface CommentReaction {
  emoji: string;
  count: number;
  reacted?: boolean;
}

export interface CommentItem {
  id: string;
  author: CommentAuthor;
  /** Plain text (mentions + URLs are rendered) or a ready-made node. */
  body: string | ReactNode;
  createdAt?: string | number | Date | null;
  editedAt?: string | number | Date | null;
  mentions?: readonly CommentMention[];
  attachments?: readonly FileItem[];
  reactions?: readonly CommentReaction[];
  replies?: readonly CommentItem[];
  /** Not visible outside the delivery team. */
  internal?: boolean;
  pinned?: boolean;
  resolved?: boolean;
  /** Extra entries in the "…" menu. */
  actions?: ReactNode;
  canEdit?: boolean;
  canDelete?: boolean;
}

export interface CommentThreadProps {
  comments: readonly CommentItem[];
  currentUser?: CommentAuthor;

  /** Omit to render read-only. `parentId` is set when replying. */
  onSubmit?: (body: string, parentId?: string) => void | Promise<void>;
  onEdit?: (comment: CommentItem, body: string) => void | Promise<void>;
  onDelete?: (comment: CommentItem) => void;
  onResolve?: (comment: CommentItem, resolved: boolean) => void;
  onReact?: (comment: CommentItem, emoji: string) => void;

  /** People that can be @-mentioned; used to render bare `@Name` as chips. */
  mentionable?: readonly CommentMention[];
  placeholder?: string;
  /** Collapse replies beyond this count behind a "Show N more". Default 3. */
  collapseRepliesAfter?: number;
  /** Newest first. Default false (chronological, like a conversation). */
  descending?: boolean;
  emptyText?: ReactNode;
  className?: string;
  "aria-label"?: string;
  busy?: boolean;
}

/* ========================================================================== */

export function CommentThread({
  comments,
  currentUser,
  onSubmit,
  onEdit,
  onDelete,
  onResolve,
  onReact,
  mentionable,
  placeholder = "Write a comment…  ⌘↵ to send",
  collapseRepliesAfter = 3,
  descending = false,
  emptyText = "No comments yet",
  className,
  "aria-label": ariaLabel = "Comments",
  busy = false,
}: CommentThreadProps) {
  const [replyTo, setReplyTo] = useState<string | null>(null);
  const [editing, setEditing] = useState<string | null>(null);

  const ordered = useMemo(() => {
    const list = [...comments];
    list.sort((a, b) => {
      const timeA = toDate(a.createdAt)?.getTime() ?? 0;
      const timeB = toDate(b.createdAt)?.getTime() ?? 0;
      return descending ? timeB - timeA : timeA - timeB;
    });
    return list;
  }, [comments, descending]);

  return (
    <section aria-label={ariaLabel} className={cx("flex min-w-0 flex-col gap-4", className)}>
      {ordered.length === 0 ? (
        <EmptyState size="sm" bordered={false} icon={IconComment} title={emptyText} />
      ) : (
        <ol className="flex flex-col gap-4">
          {ordered.map((comment) => (
            <li key={comment.id} className="min-w-0">
              <Comment
                comment={comment}
                mentionable={mentionable}
                onReply={onSubmit ? () => setReplyTo(comment.id) : undefined}
                onEdit={onEdit ? () => setEditing(comment.id) : undefined}
                onDelete={onDelete}
                onResolve={onResolve}
                onReact={onReact}
                editing={editing === comment.id}
                onEditSubmit={async (body) => {
                  await onEdit?.(comment, body);
                  setEditing(null);
                }}
                onEditCancel={() => setEditing(null)}
              />

              {comment.replies && comment.replies.length > 0 ? (
                <Replies
                  replies={comment.replies}
                  mentionable={mentionable}
                  collapseAfter={collapseRepliesAfter}
                  onDelete={onDelete}
                  onReact={onReact}
                />
              ) : null}

              {onSubmit && replyTo === comment.id ? (
                <div className="ml-9 mt-2">
                  <Composer
                    author={currentUser}
                    placeholder="Reply…"
                    autoFocus
                    busy={busy}
                    onCancel={() => setReplyTo(null)}
                    onSubmit={async (body) => {
                      await onSubmit(body, comment.id);
                      setReplyTo(null);
                    }}
                  />
                </div>
              ) : null}
            </li>
          ))}
        </ol>
      )}

      {onSubmit ? (
        <Composer
          author={currentUser}
          placeholder={placeholder}
          busy={busy}
          onSubmit={(body) => onSubmit(body)}
        />
      ) : null}
    </section>
  );
}

/* ------------------------------------------------------------------------- */

function Replies({
  replies,
  mentionable,
  collapseAfter,
  onDelete,
  onReact,
}: {
  replies: readonly CommentItem[];
  mentionable: readonly CommentMention[] | undefined;
  collapseAfter: number;
  onDelete?: (comment: CommentItem) => void;
  onReact?: (comment: CommentItem, emoji: string) => void;
}) {
  const [expanded, setExpanded] = useState(false);
  const hidden = Math.max(0, replies.length - collapseAfter);
  const shown = expanded || hidden === 0 ? replies : replies.slice(replies.length - collapseAfter);

  return (
    <div className="relative ml-4 mt-3 flex flex-col gap-3 border-l border-border pl-5">
      {hidden > 0 && !expanded ? (
        <button
          type="button"
          onClick={() => setExpanded(true)}
          className="self-start rounded-sm text-meta text-accent-text underline-offset-2 hover:underline"
        >
          Show {hidden} earlier {hidden === 1 ? "reply" : "replies"}
        </button>
      ) : null}
      {shown.map((reply) => (
        <Comment
          key={reply.id}
          comment={reply}
          mentionable={mentionable}
          compact
          onDelete={onDelete}
          onReact={onReact}
        />
      ))}
    </div>
  );
}

/* ------------------------------------------------------------------------- */

function Comment({
  comment,
  mentionable,
  compact = false,
  onReply,
  onEdit,
  onDelete,
  onResolve,
  onReact,
  editing = false,
  onEditSubmit,
  onEditCancel,
}: {
  comment: CommentItem;
  mentionable: readonly CommentMention[] | undefined;
  compact?: boolean;
  onReply?: () => void;
  onEdit?: () => void;
  onDelete?: (comment: CommentItem) => void;
  onResolve?: (comment: CommentItem, resolved: boolean) => void;
  onReact?: (comment: CommentItem, emoji: string) => void;
  editing?: boolean;
  onEditSubmit?: (body: string) => void | Promise<void>;
  onEditCancel?: () => void;
}) {
  const hasMenu = Boolean(
    comment.actions ||
      (onEdit && comment.canEdit !== false) ||
      (onDelete && comment.canDelete !== false) ||
      onResolve,
  );

  return (
    <article
      className={cx(
        "group/comment flex min-w-0 gap-2.5",
        comment.resolved && "opacity-70",
      )}
    >
      <Avatar
        name={comment.author.name}
        src={comment.author.avatarUrl ?? null}
        size={compact ? "xs" : "sm"}
        className="mt-0.5 shrink-0"
      />

      <div className="min-w-0 flex-1">
        <div className="flex min-w-0 flex-wrap items-baseline gap-x-2 gap-y-0.5">
          <span className="text-body font-semibold text-content">{comment.author.name}</span>
          {comment.author.role ? (
            <span className="text-meta text-content-subtle">{comment.author.role}</span>
          ) : null}
          {comment.internal ? (
            <Badge tone="warning" size="xs" icon={IconLock}>
              Internal
            </Badge>
          ) : null}
          {comment.pinned ? (
            <Badge tone="accent" size="xs">
              Pinned
            </Badge>
          ) : null}
          {comment.resolved ? (
            <Badge tone="success" size="xs" icon={IconCheckCircle}>
              Resolved
            </Badge>
          ) : null}
          {comment.createdAt ? (
            <time
              dateTime={toDate(comment.createdAt)?.toISOString()}
              title={formatDateTimeCell(comment.createdAt)}
              className="text-meta tabular-nums text-content-subtle"
            >
              {formatRelativeTime(comment.createdAt)}
            </time>
          ) : null}
          {comment.editedAt ? (
            <span className="text-meta text-content-disabled" title={formatDateTimeCell(comment.editedAt)}>
              (edited)
            </span>
          ) : null}

          <span className="flex-1" />

          {hasMenu ? (
            <span className="opacity-0 transition-opacity duration-fast group-hover/comment:opacity-100 focus-within:opacity-100">
              <DropdownMenu
                placement="bottom-end"
                aria-label="Comment actions"
                trigger={
                  <button
                    type="button"
                    aria-label="Comment actions"
                    className="grid size-6 place-items-center rounded-sm text-content-subtle hover:bg-surface-active hover:text-content"
                  >
                    <IconMore size={14} />
                  </button>
                }
              >
                {onResolve ? (
                  <MenuItem
                    icon={IconCheck}
                    onSelect={() => onResolve(comment, !comment.resolved)}
                  >
                    {comment.resolved ? "Reopen" : "Mark resolved"}
                  </MenuItem>
                ) : null}
                {onEdit && comment.canEdit !== false ? (
                  <MenuItem onSelect={onEdit}>Edit</MenuItem>
                ) : null}
                {onDelete && comment.canDelete !== false ? (
                  <MenuItem destructive onSelect={() => onDelete(comment)}>
                    Delete
                  </MenuItem>
                ) : null}
                {comment.actions}
              </DropdownMenu>
            </span>
          ) : null}
        </div>

        {editing && onEditSubmit ? (
          <div className="mt-1.5">
            <Composer
              initialValue={typeof comment.body === "string" ? comment.body : ""}
              placeholder="Edit comment…"
              submitLabel="Save"
              autoFocus
              onCancel={onEditCancel}
              onSubmit={onEditSubmit}
            />
          </div>
        ) : (
          <div className="mt-0.5 whitespace-pre-wrap break-words text-body text-content">
            {typeof comment.body === "string"
              ? renderCommentBody(comment.body, comment.mentions ?? mentionable)
              : comment.body}
          </div>
        )}

        {comment.attachments && comment.attachments.length > 0 ? (
          <div className="mt-2">
            <AttachmentGrid files={comment.attachments} tileSize={104} captions={false} />
          </div>
        ) : null}

        {(comment.reactions && comment.reactions.length > 0) || onReply ? (
          <div className="mt-1.5 flex flex-wrap items-center gap-1.5">
            {comment.reactions?.map((reaction) => (
              <button
                key={reaction.emoji}
                type="button"
                onClick={() => onReact?.(comment, reaction.emoji)}
                disabled={!onReact}
                className={cx(
                  "inline-flex h-6 items-center gap-1 rounded-full border px-2 text-meta tabular-nums",
                  "transition-colors duration-fast",
                  reaction.reacted
                    ? "border-accent-border bg-accent-subtle text-accent-subtle-fg"
                    : "border-border bg-surface-sunken text-content-muted hover:border-border-strong",
                  !onReact && "cursor-default",
                )}
              >
                <span aria-hidden="true">{reaction.emoji}</span>
                {reaction.count}
              </button>
            ))}
            {onReply ? (
              <button
                type="button"
                onClick={onReply}
                className="rounded-sm px-1 text-meta text-content-subtle underline-offset-2 hover:text-accent-text hover:underline"
              >
                Reply
              </button>
            ) : null}
          </div>
        ) : null}
      </div>
    </article>
  );
}

/* ------------------------------------------------------------------------- */
/* Composer                                                                    */
/* ------------------------------------------------------------------------- */

function Composer({
  author,
  placeholder,
  initialValue = "",
  submitLabel = "Comment",
  autoFocus = false,
  busy = false,
  onSubmit,
  onCancel,
}: {
  author?: CommentAuthor;
  placeholder?: string;
  initialValue?: string;
  submitLabel?: string;
  autoFocus?: boolean;
  busy?: boolean;
  onSubmit: (body: string) => void | Promise<void>;
  onCancel?: () => void;
}) {
  const [value, setValue] = useState(initialValue);
  const [sending, setSending] = useState(false);
  const textareaRef = useRef<HTMLTextAreaElement | null>(null);

  const send = useCallback(async () => {
    const body = value.trim();
    if (!body || sending) return;
    setSending(true);
    try {
      await onSubmit(body);
      setValue("");
    } finally {
      setSending(false);
    }
  }, [value, sending, onSubmit]);

  const onKeyDown = (event: ReactKeyboardEvent<HTMLTextAreaElement>) => {
    if ((event.metaKey || event.ctrlKey) && event.key === "Enter") {
      event.preventDefault();
      void send();
    }
    if (event.key === "Escape" && onCancel) {
      event.preventDefault();
      onCancel();
    }
  };

  return (
    <div className="flex min-w-0 gap-2.5">
      {author ? (
        <Avatar name={author.name} src={author.avatarUrl ?? null} size="sm" className="mt-0.5 shrink-0" />
      ) : null}
      <div className="min-w-0 flex-1">
        <Textarea
          ref={textareaRef}
          autoFocus={autoFocus}
          autoResize
          minRows={2}
          maxRows={10}
          value={value}
          placeholder={placeholder}
          aria-label={placeholder}
          onChange={(event) => setValue(event.target.value)}
          onKeyDown={onKeyDown}
        />
        <div className="mt-1.5 flex items-center justify-end gap-1.5">
          {onCancel ? (
            <Button variant="ghost" size="sm" onClick={onCancel} disabled={sending}>
              Cancel
            </Button>
          ) : null}
          <Button
            size="sm"
            leadingIcon={IconSend}
            loading={sending || busy}
            disabled={!value.trim()}
            onClick={() => void send()}
          >
            {submitLabel}
          </Button>
        </div>
      </div>
    </div>
  );
}

/* ------------------------------------------------------------------------- */
/* Body rendering                                                              */
/* ------------------------------------------------------------------------- */

const EXPLICIT_MENTION = /@\[([^\]]+)\]\(([^)]+)\)/g;
const URL_PATTERN = /\bhttps?:\/\/[^\s<>"')]+/g;

/**
 * Render a plain-text comment body: `@[Label](id)` and bare `@Label` (when the
 * label is a known mention) become chips, URLs become links, everything else is
 * escaped by React as text.
 */
export function renderCommentBody(
  text: string,
  mentions: readonly CommentMention[] | undefined,
): ReactNode {
  const chunks: ReactNode[] = [];
  let cursor = 0;
  let key = 0;

  const pushText = (value: string) => {
    if (!value) return;
    // Linkify inside the plain segments.
    let last = 0;
    for (const match of value.matchAll(URL_PATTERN)) {
      const index = match.index ?? 0;
      if (index > last) chunks.push(<Fragment key={key++}>{value.slice(last, index)}</Fragment>);
      const href = match[0];
      chunks.push(
        <a
          key={key++}
          href={href}
          target="_blank"
          rel="noreferrer noopener"
          className="text-accent-text underline-offset-2 hover:underline"
        >
          {href}
        </a>,
      );
      last = index + href.length;
    }
    if (last < value.length) chunks.push(<Fragment key={key++}>{value.slice(last)}</Fragment>);
  };

  const pushMention = (label: string) => {
    chunks.push(
      <span
        key={key++}
        className="rounded-xs bg-accent-subtle px-1 py-px font-medium text-accent-subtle-fg"
      >
        @{label}
      </span>,
    );
  };

  // Pass 1: explicit @[Label](id).
  for (const match of text.matchAll(EXPLICIT_MENTION)) {
    const index = match.index ?? 0;
    pushBareSegment(text.slice(cursor, index));
    pushMention(match[1] ?? "");
    cursor = index + match[0].length;
  }
  pushBareSegment(text.slice(cursor));

  return chunks;

  // Pass 2 (within each plain segment): bare @Label for known mentions.
  function pushBareSegment(segment: string) {
    if (!segment) return;
    if (!mentions || mentions.length === 0) {
      pushText(segment);
      return;
    }
    const labels = [...mentions]
      .map((mention) => mention.label)
      .filter(Boolean)
      .sort((a, b) => b.length - a.length);

    let rest = segment;
    outer: while (rest.length > 0) {
      const at = rest.indexOf("@");
      if (at < 0) break;
      const after = rest.slice(at + 1);
      for (const label of labels) {
        if (after.toLowerCase().startsWith(label.toLowerCase())) {
          pushText(rest.slice(0, at));
          pushMention(label);
          rest = after.slice(label.length);
          continue outer;
        }
      }
      pushText(rest.slice(0, at + 1));
      rest = after;
    }
    pushText(rest);
  }
}
