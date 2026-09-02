import { describe, expect, it } from "vitest";
import {
  buildEml,
  classifyPdfUpload,
  classifyUpload,
  fileExtension,
  parseFolderAlias,
  safeFilename,
} from "./inbound.js";

describe("upload MIME allowlist (#293, §6.5)", () => {
  it("accepts a declared allowed type", () => {
    expect(classifyUpload("application/pdf", "spec.pdf")).toEqual({ ok: true, contentType: "application/pdf" });
    expect(classifyUpload("image/jpeg; charset=binary", "site.JPG").contentType).toBe("image/jpeg");
  });

  it("recovers the type from the extension when the browser sends octet-stream", () => {
    expect(classifyUpload("application/octet-stream", "model.ifc")).toMatchObject({ ok: true, contentType: "model/ifc" });
    expect(classifyUpload(undefined, "plan.dwg")).toMatchObject({ ok: true, contentType: "image/vnd.dwg" });
  });

  it("refuses executables regardless of the declared type", () => {
    const r = classifyUpload("application/pdf", "invoice.pdf.exe");
    expect(r.ok).toBe(false);
    expect(r.reason).toMatch(/\.exe/);
    expect(classifyUpload("text/plain", "run.sh").ok).toBe(false);
  });

  it("refuses an unknown declared type and an undeterminable octet-stream", () => {
    expect(classifyUpload("application/x-msdownload", "thing.bin").ok).toBe(false);
    const r = classifyUpload("application/octet-stream", "mystery.qqq");
    expect(r.ok).toBe(false);
    expect(r.reason).toMatch(/Cannot determine/);
  });

  it("only lets PDFs into the drawing and spec pipelines", () => {
    expect(classifyPdfUpload("application/pdf", "set.pdf").ok).toBe(true);
    expect(classifyPdfUpload("application/octet-stream", "set.pdf").ok).toBe(true);
    const r = classifyPdfUpload("image/png", "set.png");
    expect(r.ok).toBe(false);
    expect(r.reason).toBe("Expected a PDF");
  });

  it("sanitises filenames", () => {
    expect(fileExtension("a.b.PDF")).toBe("pdf");
    expect(safeFilename("../../etc/passwd")).toBe("passwd");
    expect(safeFilename("C:\\Users\\x\\rep\u0000ort.docx")).toBe("report.docx");
    expect(safeFilename("   ", "fallback.bin")).toBe("fallback.bin");
    expect(safeFilename(undefined)).toBe("untitled");
  });
});

describe("e-mail-to-folder addressing (#300)", () => {
  it("parses the +folderId convention, tolerating display names and lists", () => {
    expect(parseFolderAlias("docs+fld_abc@constructos.example")).toEqual({ alias: "docs", folderId: "fld_abc" });
    expect(parseFolderAlias("Project Docs <docs+fld_abc@x.io>, other@x.io")).toEqual({ alias: "docs", folderId: "fld_abc" });
    expect(parseFolderAlias("docs@x.io")).toEqual({ alias: "docs", folderId: null });
    expect(parseFolderAlias(undefined)).toEqual({ alias: null, folderId: null });
  });

  it("renders the received message with a manifest of its attachments", () => {
    const eml = buildEml({
      messageId: "<m1@x>",
      from: "a@x.io",
      to: "docs+fld_1@y.io",
      subject: "RE: Pour 3",
      receivedAt: "2026-09-01T10:00:00.000Z",
      text: "Attached.",
      attachments: [{ filename: "pour3.pdf", contentType: "application/pdf", sizeBytes: 1234 }],
    });
    expect(eml).toContain("Message-ID: <m1@x>");
    expect(eml).toContain("Subject: RE: Pour 3");
    expect(eml).toContain("X-ConstructOS-Attachments: 1");
    expect(eml).toContain("pour3.pdf\tapplication/pdf\t1234 bytes");
  });
});
