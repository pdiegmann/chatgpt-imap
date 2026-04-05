import type { ImapFlow } from "imapflow";
import { encodeEmailRef, decodeEmailRef } from "../utils/crypto.js";
import { ensureReSubject, buildQuoteText } from "../utils/mime.js";
import { resolveMessage } from "./messageResolver.js";
import nodemailer from "nodemailer";

interface DraftOptions {
  draft_type: "new" | "reply";
  reply_to_email_ref?: string;
  to?: string[];
  cc?: string[];
  bcc?: string[];
  subject?: string;
  body_text: string;
  body_html?: string;
  quote_original?: boolean;
  save_to_special_use?: string;
}

export async function createDraft(
  client: ImapFlow,
  accountId: string,
  draftsFolder: string,
  options: DraftOptions
): Promise<{
  draft_email_ref: string;
  folder: string;
  message_id: string | null;
  subject: string | null;
  to: string[];
  cc: string[];
  bcc: string[];
  reply_to_email_ref: string | null;
}> {
  let to = options.to ?? [];
  let subject: string | null = options.subject ?? null;
  let inReplyTo: string | null = null;
  let references: string | null = null;
  let bodyText = options.body_text;
  const cc = options.cc ?? [];
  const bcc = options.bcc ?? [];

  if (options.draft_type === "reply" && options.reply_to_email_ref) {
    const refDecoded = decodeEmailRef(options.reply_to_email_ref);
    const original = await resolveMessage(
      client,
      accountId,
      refDecoded.folder,
      refDecoded.uid,
      {
        includeBodyText: true,
        includeBodyHtml: false,
        includeHeaders: true,
        includeAttachments: false,
        maxBodyChars: 10000,
      }
    );

    if (original) {
      if (!to.length) {
        const replyTarget = original.reply_to ?? original.from;
        if (replyTarget) to = [replyTarget];
      }
      subject = subject ?? ensureReSubject(original.subject);
      inReplyTo = original.message_id;
      const origRefs = original.headers?.["references"];
      references = origRefs
        ? `${origRefs} ${original.message_id ?? ""}`.trim()
        : original.message_id;

      if (options.quote_original !== false && original.body_text) {
        bodyText += buildQuoteText(
          original.body_text,
          original.from,
          original.date
        );
      }
    }
  }

  const messageId = `<${Date.now()}.${Math.random().toString(36).slice(2)}@chatgpt-imap>`;

  const mailOptions: nodemailer.SendMailOptions = {
    from: accountId,
    to: to.join(", ") || undefined,
    cc: cc.join(", ") || undefined,
    bcc: bcc.join(", ") || undefined,
    subject: subject ?? undefined,
    text: bodyText,
    html: options.body_html,
    messageId,
    inReplyTo: inReplyTo ?? undefined,
    references: references ?? undefined,
    headers: {
      "X-Mailer": "chatgpt-imap-mcp",
    },
  };

  const transport = nodemailer.createTransport({
    streamTransport: true,
    newline: "unix",
  });
  const info = await transport.sendMail(mailOptions);
  const rawMessage: Buffer = await new Promise((resolve, reject) => {
    const chunks: Buffer[] = [];
    (info.message as NodeJS.ReadableStream).on("data", (chunk: Buffer) =>
      chunks.push(chunk)
    );
    (info.message as NodeJS.ReadableStream).on("end", () =>
      resolve(Buffer.concat(chunks))
    );
    (info.message as NodeJS.ReadableStream).on("error", reject);
  });

  // Append to drafts folder
  const appendResult = await client.append(
    draftsFolder,
    rawMessage,
    ["\\Draft", "\\Seen"]
  );

  let uid = 0;
  let uidValidity = 1;
  try {
    if (appendResult && appendResult.uid) uid = appendResult.uid;
    const status = await client.status(draftsFolder, { uidValidity: true });
    uidValidity = Number(status.uidValidity ?? 1);
  } catch {
    // use defaults
  }

  const draft_email_ref = encodeEmailRef({
    account_id: accountId,
    folder: draftsFolder,
    uid_validity: uidValidity,
    uid,
  });

  return {
    draft_email_ref,
    folder: draftsFolder,
    message_id: messageId,
    subject,
    to,
    cc,
    bcc,
    reply_to_email_ref: options.reply_to_email_ref ?? null,
  };
}
