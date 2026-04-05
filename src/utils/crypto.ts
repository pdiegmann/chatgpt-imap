import { createHash } from "crypto";
import type { EmailRef } from "../types/email.js";

export function encodeEmailRef(ref: EmailRef): string {
  const raw = `${ref.account_id}:${ref.folder}:${ref.uid_validity}:${ref.uid}`;
  return Buffer.from(raw).toString("base64url");
}

export function decodeEmailRef(encoded: string): EmailRef {
  let raw: string;
  try {
    raw = Buffer.from(encoded, "base64url").toString("utf-8");
  } catch {
    throw new Error(`Invalid email_ref: ${encoded}`);
  }
  const parts = raw.split(":");
  if (parts.length < 4) throw new Error(`Invalid email_ref format: ${encoded}`);
  const [account_id, ...rest] = parts;
  const uid = parseInt(rest[rest.length - 1], 10);
  const uid_validity = parseInt(rest[rest.length - 2], 10);
  const folder = rest.slice(0, rest.length - 2).join(":");
  if (isNaN(uid) || isNaN(uid_validity))
    throw new Error(`Invalid email_ref numeric fields: ${encoded}`);
  return { account_id, folder, uid_validity, uid };
}
