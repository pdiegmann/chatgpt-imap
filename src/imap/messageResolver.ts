import type { FetchMessageObject, ImapFlow, MessageStructureObject } from "imapflow";
import type { AddressObject, StructuredHeader } from "mailparser";
import type { HeaderValue } from "mailparser";
import { simpleParser } from "mailparser";
import type { EmailFull } from "../types/email.js";
import { encodeEmailRef } from "../utils/crypto.js";

function formatAddress(
	addr: { name?: string; address?: string } | null | undefined,
): string {
	if (!addr) return "";
	if (addr.name && addr.address && addr.name !== addr.address)
		return `"${addr.name}" <${addr.address}>`;
	return addr.address ?? addr.name ?? "";
}

function formatAddressList(
	list: Array<{ name?: string; address?: string }> | null | undefined,
): string[] {
	if (!list) return [];
	return list.map((a) => formatAddress(a)).filter(Boolean);
}

/**
 * Serialize a mailparser HeaderValue to a plain string.
 * Fixes the "[object Object]" bug for AddressObject and StructuredHeader values.
 */
function headerValueToString(value: HeaderValue): string {
	if (typeof value === "string") return value;
	if (value instanceof Date) return value.toISOString();
	if (Array.isArray(value)) {
		return value
			.map((v) => {
				if (typeof v === "string") return v;
				// StructuredHeader element
				const sv = v as StructuredHeader;
				if (typeof sv.value === "string") {
					const params = Object.entries(sv.params ?? {})
						.map(([k, p]) => `${k}=${p}`)
						.join("; ");
					return params ? `${sv.value}; ${params}` : sv.value;
				}
				return String(v);
			})
			.join(", ");
	}
	// AddressObject (From, To, Cc, Bcc, Reply-To headers)
	const ao = value as AddressObject;
	if (typeof ao.text === "string") return ao.text;
	// StructuredHeader (Content-Type, Content-Disposition, etc.)
	const sv = value as StructuredHeader;
	if (typeof sv.value === "string") {
		const params = Object.entries(sv.params ?? {})
			.map(([k, p]) => `${k}=${p}`)
			.join("; ");
		return params ? `${sv.value}; ${params}` : sv.value;
	}
	return String(value);
}

interface TextSection {
	sectionId: string;
	type: string;
	encoding: string | undefined;
	charset: string | undefined;
}

/**
 * Walk a BODYSTRUCTURE tree and collect text/plain and text/html sections
 * that are not flagged as attachments.
 */
function collectTextSections(
	structure: MessageStructureObject | undefined,
	depth = 0,
): TextSection[] {
	if (!structure || depth > 10) return [];
	const type = structure.type.toLowerCase();

	if (type.startsWith("multipart/")) {
		const results: TextSection[] = [];
		for (const child of structure.childNodes ?? []) {
			results.push(...collectTextSections(child, depth + 1));
		}
		return results;
	}

	if (type === "message/rfc822") {
		return collectTextSections(structure.childNodes?.[0], depth + 1);
	}

	if (
		(type === "text/plain" || type === "text/html") &&
		structure.disposition?.toLowerCase() !== "attachment"
	) {
		// Root simple messages have no part number set; IMAP section '1' is the implicit default.
		const sectionId = structure.part ?? "1";
		return [
			{
				sectionId,
				type,
				encoding: structure.encoding,
				charset: structure.parameters?.charset,
			},
		];
	}

	return [];
}

/**
 * Return true if the BODYSTRUCTURE tree contains at least one attachment node.
 */
function hasAttachmentNodes(
	structure: MessageStructureObject | undefined,
	depth = 0,
): boolean {
	if (!structure || depth > 10) return false;
	if (structure.disposition?.toLowerCase() === "attachment") return true;
	const type = structure.type.toLowerCase();
	if (type.startsWith("multipart/") || type === "message/rfc822") {
		return (structure.childNodes ?? []).some((c) =>
			hasAttachmentNodes(c, depth + 1),
		);
	}
	return false;
}

/**
 * Walk a BODYSTRUCTURE tree and collect metadata for attachment nodes.
 * This avoids downloading the actual attachment data.
 */
function collectAttachmentInfo(
	structure: MessageStructureObject | undefined,
	depth = 0,
): Array<{
	filename: string | null;
	content_type: string;
	size: number;
	content_id: string | null;
}> {
	if (!structure || depth > 10) return [];
	const type = structure.type.toLowerCase();

	if (type.startsWith("multipart/")) {
		const results: Array<{
			filename: string | null;
			content_type: string;
			size: number;
			content_id: string | null;
		}> = [];
		for (const child of structure.childNodes ?? []) {
			results.push(...collectAttachmentInfo(child, depth + 1));
		}
		return results;
	}

	if (type === "message/rfc822") {
		return collectAttachmentInfo(structure.childNodes?.[0], depth + 1);
	}

	if (structure.disposition?.toLowerCase() === "attachment") {
		const filename =
			structure.dispositionParameters?.filename ??
			structure.parameters?.name ??
			null;
		return [
			{
				filename,
				content_type: type || "application/octet-stream",
				size: structure.size ?? 0,
				content_id: structure.id ?? null,
			},
		];
	}

	return [];
}

/**
 * Decode a raw IMAP body-part buffer (base64 or quoted-printable) to a UTF-8 string.
 */
function decodeBodyPart(
	raw: Buffer,
	encoding: string | undefined,
	charset: string | undefined,
): string {
	const enc = (encoding ?? "").toLowerCase().replace(/\s/g, "");
	let bytes: Buffer;

	if (enc === "base64") {
		bytes = Buffer.from(
			raw.toString("ascii").replace(/[\r\n]/g, ""),
			"base64",
		);
	} else if (enc === "quoted-printable") {
		// Decode QP to bytes directly for consistency with the base64 path
		const str = raw.toString("ascii");
		const buf = new Uint8Array(str.length);
		let out = 0;
		for (let i = 0; i < str.length; ) {
			if (str[i] === "=" && i + 1 < str.length) {
				const next = str[i + 1];
				if (next === "\r" || next === "\n") {
					// soft line break
					i += next === "\r" && str[i + 2] === "\n" ? 3 : 2;
				} else if (i + 2 < str.length && /[0-9A-Fa-f]{2}/.test(str.slice(i + 1, i + 3))) {
					buf[out++] = parseInt(str.slice(i + 1, i + 3), 16);
					i += 3;
				} else {
					buf[out++] = str.charCodeAt(i++);
				}
			} else {
				buf[out++] = str.charCodeAt(i++);
			}
		}
		bytes = Buffer.from(buf.subarray(0, out));
	} else {
		bytes = raw;
	}

	const cs = (charset ?? "utf-8").toLowerCase().trim();
	try {
		return new TextDecoder(cs).decode(bytes);
	} catch {
		return bytes.toString("utf-8");
	}
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
	},
): Promise<EmailFull | null> {
	const lock = await client.getMailboxLock(folder);
	try {
		// Use the uidValidity from the selected mailbox (populated by getMailboxLock/SELECT)
		// instead of issuing a redundant STATUS command on the already-selected mailbox,
		// which RFC 3501 discourages and which can hang on some servers.
		const uidValidity = Number(
			(client.mailbox ? client.mailbox.uidValidity : undefined) ?? 1,
		);

		// Always use the optimized body-parts path which fetches only the text
		// sections identified via BODYSTRUCTURE, avoiding the expensive download
		// of the full RFC 2822 source (which includes all attachment data and
		// can easily exceed operation timeouts for large messages).
		return await resolveWithBodyParts(
			client,
			accountId,
			folder,
			uid,
			uidValidity,
			options,
		);
	} finally {
		lock.release();
	}
}

/**
 * Fetch email content using targeted body-part requests, skipping attachment data.
 *
 * Pass 1: fetch envelope + flags + bodyStructure + headers (no body bytes).
 * Pass 2: fetch only the text/html body-part sections identified in pass 1.
 *
 * Attachment metadata (filename, type, size) is extracted from BODYSTRUCTURE
 * without downloading the actual attachment data.
 */
async function resolveWithBodyParts(
	client: ImapFlow,
	accountId: string,
	folder: string,
	uid: number,
	uidValidity: number,
	options: {
		includeBodyText: boolean;
		includeBodyHtml: boolean;
		includeHeaders: boolean;
		includeAttachments: boolean;
		maxBodyChars: number;
	},
): Promise<EmailFull | null> {
	// Pass 1: structure + headers (tiny; no attachment bytes downloaded)
	let structMsg: FetchMessageObject | null = null;

	for await (const msg of client.fetch(
		String(uid),
		{ uid: true, flags: true, envelope: true, bodyStructure: true, headers: true },
		{ uid: true },
	)) {
		structMsg = msg;
		break;
	}

	if (!structMsg) return null;

	const env = structMsg.envelope;
	const seen = structMsg.flags?.has("\\Seen") ?? false;
	const flagged = structMsg.flags?.has("\\Flagged") ?? false;
	const draft = structMsg.flags?.has("\\Draft") ?? false;
	const answered = structMsg.flags?.has("\\Answered") ?? false;
	const has_attachments = hasAttachmentNodes(structMsg.bodyStructure);

	const email_ref = encodeEmailRef({
		account_id: accountId,
		folder,
		uid_validity: uidValidity,
		uid: structMsg.uid,
	});

	// Determine which text sections to fetch
	const allTextSections = collectTextSections(structMsg.bodyStructure);
	const wantedSections = allTextSections.filter(
		(s) =>
			(options.includeBodyText && s.type === "text/plain") ||
			(options.includeBodyHtml && s.type === "text/html"),
	);

	// Pass 2: fetch only the needed text body sections (skips attachment data)
	let bodyParts = new Map<string, Buffer>();
	if (wantedSections.length > 0) {
		for await (const msg of client.fetch(
			String(uid),
			{ bodyParts: wantedSections.map((s) => s.sectionId) },
			{ uid: true },
		)) {
			bodyParts = (msg.bodyParts as Map<string, Buffer>) ?? new Map();
			break;
		}
	}

	// Parse headers from the raw header buffer fetched in pass 1
	let parsedFrom = formatAddress(env?.from?.[0]);
	let parsedReplyTo: string | null = null;
	let parsedTo = formatAddressList(env?.to);
	let parsedCc = formatAddressList(env?.cc);
	let parsedBcc = formatAddressList(env?.bcc);
	let parsedSubject: string | null = env?.subject ?? null;
	let parsedDate: string =
		env?.date?.toISOString() ?? new Date().toISOString();
	let parsedMessageId: string | null = env?.messageId ?? null;
	const headers: Record<string, string> = {};

	if (structMsg.headers) {
		// Parse only the header section (tiny, fast) using simpleParser
		const minimalMsg = Buffer.concat([
			structMsg.headers,
			Buffer.from("\r\n"),
		]);
		const ph = await simpleParser(minimalMsg);

		if (options.includeHeaders && ph.headers) {
			for (const [key, value] of ph.headers.entries()) {
				headers[key] = headerValueToString(value);
			}
		}

		parsedFrom = formatAddress(ph.from?.value?.[0] ?? env?.from?.[0]);
		parsedReplyTo = ph.replyTo
			? formatAddress(ph.replyTo.value?.[0])
			: null;
		parsedTo = ph.to
			? formatAddressList(
					Array.isArray(ph.to)
						? ph.to.flatMap((a: AddressObject) => a.value)
						: ph.to.value,
				)
			: formatAddressList(env?.to);
		parsedCc = ph.cc
			? formatAddressList(
					Array.isArray(ph.cc)
						? ph.cc.flatMap((a: AddressObject) => a.value)
						: ph.cc.value,
				)
			: formatAddressList(env?.cc);
		parsedBcc = ph.bcc
			? formatAddressList(
					Array.isArray(ph.bcc)
						? ph.bcc.flatMap((a: AddressObject) => a.value)
						: ph.bcc.value,
				)
			: formatAddressList(env?.bcc);
		parsedSubject = ph.subject ?? env?.subject ?? null;
		parsedDate =
			ph.date?.toISOString() ??
			env?.date?.toISOString() ??
			new Date().toISOString();
		parsedMessageId = ph.messageId ?? env?.messageId ?? null;
	}

	// Decode text body sections
	let body_text: string | null = null;
	let body_html: string | null = null;

	for (const section of wantedSections) {
		const raw = bodyParts.get(section.sectionId);
		if (!raw) continue;
		const decoded = decodeBodyPart(raw, section.encoding, section.charset);

		if (section.type === "text/plain" && options.includeBodyText && !body_text) {
			body_text =
				decoded.length > options.maxBodyChars
					? decoded.slice(0, options.maxBodyChars)
					: decoded;
		} else if (
			section.type === "text/html" &&
			options.includeBodyHtml &&
			!body_html
		) {
			body_html =
				decoded.length > options.maxBodyChars
					? decoded.slice(0, options.maxBodyChars)
					: decoded;
		}

		// Stop decoding once both requested text types have been found
		if (
			(!options.includeBodyText || body_text !== null) &&
			(!options.includeBodyHtml || body_html !== null)
		) {
			break;
		}
	}

	// Extract attachment metadata from BODYSTRUCTURE (no download needed)
	const attachments = options.includeAttachments
		? collectAttachmentInfo(structMsg.bodyStructure)
		: [];

	return {
		email_ref,
		folder,
		uid: structMsg.uid,
		message_id: parsedMessageId,
		date: parsedDate,
		from: parsedFrom,
		reply_to: parsedReplyTo,
		to: parsedTo,
		cc: parsedCc,
		bcc: parsedBcc,
		subject: parsedSubject,
		snippet: null,
		seen,
		has_attachments,
		body_text,
		body_html,
		headers,
		flagged,
		draft,
		answered,
		attachments,
	};
}
