import { customAlphabet } from "nanoid";

/** URL-safe, lowercase-alphanumeric ids; 21 chars ≈ 121 bits of entropy. */
const alphabet = "0123456789abcdefghijklmnopqrstuvwxyz";
const nano = customAlphabet(alphabet, 21);

export function newId(prefix?: string): string {
  return prefix ? `${prefix}_${nano()}` : nano();
}
