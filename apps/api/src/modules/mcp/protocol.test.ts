import { describe, expect, it } from "vitest";
import {
  errorForStatus,
  parseCall,
  rpcError,
  rpcResult,
  RPC_ERRORS,
  splitBatch,
} from "./protocol.js";

/**
 * JSON-RPC envelope rules. These are the rules real clients depend on and the
 * ones a hand-rolled server usually gets wrong, so each is asserted rather than
 * assumed — particularly the notification rule, where answering at all is the
 * bug.
 */

describe("parseCall", () => {
  it("accepts a well-formed request", () => {
    const out = parseCall({ jsonrpc: "2.0", id: 1, method: "tools/list", params: { a: 1 } });
    expect(out.ok).toBe(true);
    if (out.ok) {
      expect(out.call).toEqual({
        id: 1,
        notification: false,
        method: "tools/list",
        params: { a: 1 },
      });
    }
  });

  it("treats an absent id as a NOTIFICATION", () => {
    const out = parseCall({ jsonrpc: "2.0", method: "notifications/initialized" });
    expect(out.ok).toBe(true);
    if (out.ok) expect(out.call.notification).toBe(true);
  });

  it("treats an explicit null id as a request, not a notification", () => {
    const out = parseCall({ jsonrpc: "2.0", id: null, method: "ping" });
    expect(out.ok).toBe(true);
    if (out.ok) {
      expect(out.call.notification).toBe(false);
      expect(out.call.id).toBeNull();
    }
  });

  it("defaults params to an empty object", () => {
    const out = parseCall({ jsonrpc: "2.0", id: "a", method: "ping" });
    if (out.ok) expect(out.call.params).toEqual({});
  });

  it("refuses a wrong or missing version", () => {
    expect(parseCall({ jsonrpc: "1.0", id: 1, method: "ping" })).toMatchObject({
      ok: false,
      error: { code: RPC_ERRORS.invalidRequest },
    });
    expect(parseCall({ id: 1, method: "ping" })).toMatchObject({ ok: false });
  });

  it("refuses a non-object envelope, a missing method and positional params", () => {
    expect(parseCall("hello")).toMatchObject({ ok: false, error: { code: RPC_ERRORS.invalidRequest } });
    expect(parseCall([1, 2])).toMatchObject({ ok: false });
    expect(parseCall({ jsonrpc: "2.0", id: 1 })).toMatchObject({ ok: false });
    expect(parseCall({ jsonrpc: "2.0", id: 1, method: "" })).toMatchObject({ ok: false });
    expect(parseCall({ jsonrpc: "2.0", id: 1, method: "ping", params: [1, 2] })).toMatchObject({
      ok: false,
      error: { code: RPC_ERRORS.invalidParams },
    });
  });

  it("refuses an id that is neither string, number nor null", () => {
    expect(parseCall({ jsonrpc: "2.0", id: { a: 1 }, method: "ping" })).toMatchObject({
      ok: false,
    });
  });

  it("echoes the id on an error where it could be recovered", () => {
    const out = parseCall({ jsonrpc: "1.0", id: 7, method: "ping" });
    expect(out.ok).toBe(false);
    if (!out.ok) expect(out.id).toBe(7);
  });
});

describe("response builders", () => {
  it("never puts result and error on the same response", () => {
    const ok = rpcResult(1, { a: 1 });
    expect(ok).toEqual({ jsonrpc: "2.0", id: 1, result: { a: 1 } });
    expect(ok).not.toHaveProperty("error");
    const bad = rpcError(1, -32601, "nope");
    expect(bad).toEqual({ jsonrpc: "2.0", id: 1, error: { code: -32601, message: "nope" } });
    expect(bad).not.toHaveProperty("result");
  });

  it("omits data when there is none, and carries it when there is", () => {
    expect(rpcError(1, -1, "m").error).toEqual({ code: -1, message: "m" });
    expect(rpcError(1, -1, "m", { x: 1 }).error).toEqual({ code: -1, message: "m", data: { x: 1 } });
  });
});

describe("splitBatch", () => {
  it("wraps a single call and flags a batch", () => {
    expect(splitBatch({ jsonrpc: "2.0" })).toEqual({
      batch: false,
      calls: [{ jsonrpc: "2.0" }],
    });
    const batch = splitBatch([{ a: 1 }, { b: 2 }]);
    expect(batch.batch).toBe(true);
    expect(batch.calls).toHaveLength(2);
  });

  it("reports an empty array as an empty batch, which the caller must refuse", () => {
    expect(splitBatch([])).toEqual({ batch: true, calls: [] });
  });
});

describe("errorForStatus", () => {
  it("keeps a refusal a refusal", () => {
    expect(errorForStatus(401)).toBe(RPC_ERRORS.forbidden);
    expect(errorForStatus(403)).toBe(RPC_ERRORS.forbidden);
  });

  it("maps validation, absence and everything else distinctly", () => {
    expect(errorForStatus(400)).toBe(RPC_ERRORS.invalidParams);
    expect(errorForStatus(422)).toBe(RPC_ERRORS.invalidParams);
    expect(errorForStatus(404)).toBe(RPC_ERRORS.unavailable);
    expect(errorForStatus(500)).toBe(RPC_ERRORS.internal);
    expect(errorForStatus(409)).toBe(RPC_ERRORS.internal);
  });
});
