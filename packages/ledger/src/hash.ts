import { createHash } from "node:crypto";
import { canonicalize } from "./canonical.js";

export function sha256Hex(data: string | Uint8Array): string {
  return createHash("sha256").update(data).digest("hex");
}

/** Hash any JSON-serializable payload deterministically. */
export function hashPayload(payload: unknown): string {
  return sha256Hex(canonicalize(payload));
}
