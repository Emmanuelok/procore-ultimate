/**
 * Upload hygiene and e-mail-to-folder ingestion (spec Vol I #293, #300) — pure.
 *
 *  · `classifyUpload` is the MIME allowlist every document upload route runs
 *    BEFORE bytes are stored. It is deliberately a list of what construction
 *    document control actually receives, not a blacklist of what it fears.
 *  · `parseFolderAlias` reads the addressing convention for e-mail capture:
 *    `<anything>+<folderId>@<domain>` files the message into that folder.
 *  · `buildEml` renders the received message as an RFC-822-ish text so the
 *    bytes that arrived are kept beside the attachments they carried.
 */

export interface UploadClassification {
  ok: boolean;
  /** the content type to store (a sniffed/normalised value when the client sent octet-stream) */
  contentType: string;
  reason?: string;
}

const ALLOWED_TYPES = new Set([
  "application/pdf",
  "image/png",
  "image/jpeg",
  "image/gif",
  "image/webp",
  "image/tiff",
  "image/heic",
  "image/heif",
  "image/svg+xml",
  "image/bmp",
  "text/plain",
  "text/csv",
  "text/markdown",
  "text/html",
  "application/json",
  "application/xml",
  "text/xml",
  "application/zip",
  "application/x-zip-compressed",
  "application/msword",
  "application/vnd.openxmlformats-officedocument.wordprocessingml.document",
  "application/vnd.ms-excel",
  "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet",
  "application/vnd.ms-powerpoint",
  "application/vnd.openxmlformats-officedocument.presentationml.presentation",
  "application/vnd.oasis.opendocument.text",
  "application/vnd.oasis.opendocument.spreadsheet",
  "application/rtf",
  "message/rfc822",
  "application/vnd.ms-outlook",
  "application/acad",
  "application/x-acad",
  "application/x-autocad",
  "image/vnd.dwg",
  "image/x-dwg",
  "application/dxf",
  "image/vnd.dxf",
  "application/x-step",
  "model/ifc",
  "application/x-ifc",
  "video/mp4",
  "video/quicktime",
  "audio/mpeg",
]);

/** Extensions that arrive as application/octet-stream from most browsers. */
const EXT_TYPES: Record<string, string> = {
  pdf: "application/pdf",
  dwg: "image/vnd.dwg",
  dxf: "image/vnd.dxf",
  ifc: "model/ifc",
  rvt: "application/octet-stream",
  nwd: "application/octet-stream",
  nwc: "application/octet-stream",
  skp: "application/octet-stream",
  xer: "application/octet-stream",
  mpp: "application/octet-stream",
  eml: "message/rfc822",
  msg: "application/vnd.ms-outlook",
  csv: "text/csv",
  txt: "text/plain",
  md: "text/markdown",
  zip: "application/zip",
  docx: "application/vnd.openxmlformats-officedocument.wordprocessingml.document",
  xlsx: "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet",
  pptx: "application/vnd.openxmlformats-officedocument.presentationml.presentation",
  doc: "application/msword",
  xls: "application/vnd.ms-excel",
  ppt: "application/vnd.ms-powerpoint",
  png: "image/png",
  jpg: "image/jpeg",
  jpeg: "image/jpeg",
  heic: "image/heic",
  tif: "image/tiff",
  tiff: "image/tiff",
  mp4: "video/mp4",
  mov: "video/quicktime",
};

const BLOCKED_EXT = new Set([
  "exe", "dll", "bat", "cmd", "com", "msi", "scr", "ps1", "sh", "js", "jar", "vbs", "apk", "app",
]);

export function fileExtension(filename: string): string {
  const m = /\.([A-Za-z0-9]{1,8})$/.exec(filename.trim());
  return m ? m[1]!.toLowerCase() : "";
}

/** Decide whether an upload is accepted and what content type to record. */
export function classifyUpload(contentType: string | undefined, filename: string): UploadClassification {
  const ext = fileExtension(filename);
  if (BLOCKED_EXT.has(ext)) {
    return { ok: false, contentType: contentType ?? "", reason: `Files of type .${ext} are not accepted` };
  }
  const declared = (contentType ?? "").split(";")[0]!.trim().toLowerCase();
  if (declared && declared !== "application/octet-stream" && ALLOWED_TYPES.has(declared)) {
    return { ok: true, contentType: declared };
  }
  const byExt = EXT_TYPES[ext];
  if (byExt) return { ok: true, contentType: byExt };
  if (declared === "" || declared === "application/octet-stream") {
    return {
      ok: false,
      contentType: declared || "application/octet-stream",
      reason: `Cannot determine a supported document type for "${filename}"`,
    };
  }
  return { ok: false, contentType: declared, reason: `Content type ${declared} is not accepted` };
}

/** Only PDFs are accepted by the drawing-set and spec-book pipelines. */
export function classifyPdfUpload(contentType: string | undefined, filename: string): UploadClassification {
  const c = classifyUpload(contentType, filename);
  if (!c.ok) return c;
  if (c.contentType !== "application/pdf") {
    return { ok: false, contentType: c.contentType, reason: "Expected a PDF" };
  }
  return c;
}

/** Strip path separators and control characters from a client-supplied name. */
export function safeFilename(name: string | undefined, fallback = "untitled"): string {
  const base = (name ?? "").split(/[\\/]/).pop() ?? "";
  // eslint-disable-next-line no-control-regex
  const cleaned = base.replace(/[\x00-\x1f\x7f]/g, "").trim();
  return cleaned.length > 0 ? cleaned.slice(0, 300) : fallback;
}

export interface FolderAlias {
  /** the local part before the "+", e.g. the project alias */
  alias: string | null;
  folderId: string | null;
}

/** "docs+fld_abc123@constructos.example" → { alias: "docs", folderId: "fld_abc123" } */
export function parseFolderAlias(to: string | undefined): FolderAlias {
  if (!to) return { alias: null, folderId: null };
  // take the first address, tolerate "Name <addr>"
  const first = to.split(",")[0] ?? "";
  const angled = /<([^>]+)>/.exec(first);
  const addr = (angled ? angled[1]! : first).trim();
  const local = addr.split("@")[0] ?? "";
  const plus = local.indexOf("+");
  if (plus === -1) return { alias: local || null, folderId: null };
  const alias = local.slice(0, plus) || null;
  const folderId = local.slice(plus + 1).trim() || null;
  return { alias, folderId };
}

export interface EmlInput {
  messageId?: string | null;
  from?: string | null;
  to?: string | null;
  subject?: string | null;
  receivedAt?: string | null;
  text?: string | null;
  attachments: Array<{ filename: string; contentType: string; sizeBytes: number }>;
}

/** Render a received message as a plain-text .eml (headers + body + manifest). */
export function buildEml(input: EmlInput): string {
  const lines = [
    `Message-ID: ${input.messageId ?? "(none)"}`,
    `From: ${input.from ?? "(unknown)"}`,
    `To: ${input.to ?? "(unknown)"}`,
    `Subject: ${input.subject ?? "(no subject)"}`,
    `Date: ${input.receivedAt ?? new Date().toISOString()}`,
    `X-ConstructOS-Attachments: ${input.attachments.length}`,
    "",
    input.text ?? "",
    "",
    "--- attachments ---",
    ...input.attachments.map((a) => `${a.filename}\t${a.contentType}\t${a.sizeBytes} bytes`),
    "",
  ];
  return lines.join("\r\n");
}
