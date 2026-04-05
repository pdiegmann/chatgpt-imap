import type { ImapFlow } from "imapflow";
import type { EmailFull } from "../types/email.js";
import type { Attachment, AddressObject, EmailAddress } from "mailparser";
import { encodeEmailRef } from "../utils/crypto.js";
import { simpleParser } from "mailparser";

function formatAddress(
  addr: { name?: string; address?: string } | null | undefined
): string {
  if (!addr) return "";
  if (addr.name && addr.address && addr.name !== addr.address)
    return `"${addr.name}" <${addr.address}>`;
  return addr.address ?? addr.name ?? "";
}

function formatAddressList(
  list: Array<{ name?: string; address?: string }> | null | undefined
): string[] {
  if (!list) return [];
  return list.map((a) => formatAddress(a)).filter(Boolean);
}

export async function resolveMessage(
  client: ImapFlow,
  accountId: string,
  folder: string,
  uid: number,
  options: {
    includeBodyText: boolean;
    includeBodyHtml: boolean;
    includeHeaders: boolean;
    includeAttachments: boolean;
    maxBodyChars: number;
  }
): Promise<EmailFull | null> {
  const lock = await client.getMailboxLock(folder);
  try {
    let uidValidity = 1;
    try {
      const status = await client.status(folder, { uidValidity: true });
      uidValidity = Number(status.uidValidity ?? 1);
    } catch {
      // use default
    }

    const messages: EmailFull[] = [];

    for await (const msg of client.fetch(
      String(uid),
      {
        uid: true,
        flags: true,
        envelope: true,
        source: true,
      },
      { uid: true }
    )) {
      const source = msg.source;
      if (!source) continue;

      const parsed = await simpleParser(source);
      const env = msg.envelope;

      const email_ref = encodeEmailRef({
        account_id: accountId,
        folder,
        uid_validity: uidValidity,
        uid,
      });
      const seen = msg.flags?.has("\\Seen") ?? false;
      const flagged = msg.flags?.has("\\Flagged") ?? false;
      const draft = msg.flags?.has("\\Draft") ?? false;
      const answered = msg.flags?.has("\\Answered") ?? false;

      const headers: Record<string, string> = {};
      if (options.includeHeaders && parsed.headers) {
        for (const [key, value] of parsed.headers.entries()) {
          headers[key] = Array.isArray(value)
            ? value.join(", ")
            : String(value);
        }
      }

      const attachments = options.includeAttachments
        ? (parsed.attachments ?? []).map((att: Attachment) => ({
            filename: att.filename ?? null,
            content_type: att.contentType ?? "application/octet-stream",
            size: att.size ?? 0,
            content_id: att.contentId ?? null,
          }))
        : [];

      let body_text = options.includeBodyText ? (parsed.text ?? null) : null;
      if (body_text && body_text.length > options.maxBodyChars) {
        body_text = body_text.slice(0, options.maxBodyChars);
      }
      let body_html = options.includeBodyHtml ? (parsed.html || null) : null;
      if (body_html && body_html.length > options.maxBodyChars) {
        body_html = body_html.slice(0, options.maxBodyChars);
      }

      const replyToAddr = parsed.replyTo
        ? formatAddress(parsed.replyTo.value?.[0])
        : null;

      const toList = parsed.to
        ? formatAddressList(
            Array.isArray(parsed.to)
              ? parsed.to.flatMap((a: AddressObject) => a.value)
              : parsed.to.value
          )
        : formatAddressList(env?.to);

      const ccList = parsed.cc
        ? formatAddressList(
            Array.isArray(parsed.cc)
              ? parsed.cc.flatMap((a: AddressObject) => a.value)
              : parsed.cc.value
          )
        : formatAddressList(env?.cc);

      const bccList = parsed.bcc
        ? formatAddressList(
            Array.isArray(parsed.bcc)
              ? parsed.bcc.flatMap((a: AddressObject) => a.value)
              : parsed.bcc.value
          )
        : formatAddressList(env?.bcc);

      messages.push({
        email_ref,
        folder,
        uid,
        message_id: parsed.messageId ?? env?.messageId ?? null,
        date:
          parsed.date?.toISOString() ??
          env?.date?.toISOString() ??
          new Date().toISOString(),
        from: formatAddress(
          parsed.from?.value?.[0] ?? env?.from?.[0]
        ),
        reply_to: replyToAddr,
        to: toList,
        cc: ccList,
        bcc: bccList,
        subject: parsed.subject ?? env?.subject ?? null,
        snippet: null,
        seen,
        has_attachments: attachments.length > 0 ? true : null,
        body_text,
        body_html,
        headers,
        flagged,
        draft,
        answered,
        attachments,
      });
    }

    return messages[0] ?? null;
  } finally {
    lock.release();
  }
}
