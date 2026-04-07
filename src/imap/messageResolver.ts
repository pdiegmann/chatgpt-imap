import type { FetchMessageObject, ImapFlow, MessageStructureObject } from "imapflow";
import type { AddressObject, Attachment, StructuredHeader } from "mailparser";
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
		const decoded = raw
			.toString("binary")
			.replace(/=\r?\n/g, "")
			.replace(/=([0-9A-Fa-f]{2})/g, (_, hex) =>
				String.fromCharCode(parseInt(hex, 16)),
			);
		bytes = Buffer.from(decoded, "binary");
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
		let uidValidity = 1;
		try {
			const status = await client.status(folder, { uidValidity: true });
			uidValidity = Number(status.uidValidity ?? 1);
		} catch {
			// use default
		}

		if (options.includeAttachments) {
			return await resolveWithFullSource(
				client,
				accountId,
				folder,
				uid,
				uidValidity,
				options,
			);
		}
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
 * Full-source path: download the complete RFC 2822 message and parse with simpleParser.
 * Used when includeAttachments is true.
 */
async function resolveWithFullSource(
	client: ImapFlow,
	accountId: string,
	folder: string,
	uid: number,
	uidValidity: number,
	options: {
		includeBodyText: boolean;
		includeBodyHtml: boolean;
		includeHeaders: boolean;
		maxBodyChars: number;
	},
): Promise<EmailFull | null> {
	for await (const msg of client.fetch(
		String(uid),
		{ uid: true, flags: true, envelope: true, source: true },
		{ uid: true },
	)) {
		const source = msg.source;
		if (!source) return null;

		const parsed = await simpleParser(source);
		const env = msg.envelope;

		const email_ref = encodeEmailRef({
			account_id: accountId,
			folder,
			uid_validity: uidValidity,
			uid,
		});

		const headers: Record<string, string> = {};
		if (options.includeHeaders && parsed.headers) {
			for (const [key, value] of parsed.headers.entries()) {
				headers[key] = headerValueToString(value);
			}
		}

		const attachments = (parsed.attachments ?? []).map((att: Attachment) => ({
			filename: att.filename ?? null,
			content_type: att.contentType ?? "application/octet-stream",
			size: att.size ?? 0,
			content_id: att.contentId ?? null,
		}));

		let body_text = options.includeBodyText ? (parsed.text ?? null) : null;
		if (body_text && body_text.length > options.maxBodyChars) {
			body_text = body_text.slice(0, options.maxBodyChars);
		}
		let body_html = options.includeBodyHtml ? parsed.html || null : null;
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
						: parsed.to.value,
				)
			: formatAddressList(env?.to);
		const ccList = parsed.cc
			? formatAddressList(
					Array.isArray(parsed.cc)
						? parsed.cc.flatMap((a: AddressObject) => a.value)
						: parsed.cc.value,
				)
			: formatAddressList(env?.cc);
		const bccList = parsed.bcc
			? formatAddressList(
					Array.isArray(parsed.bcc)
						? parsed.bcc.flatMap((a: AddressObject) => a.value)
						: parsed.bcc.value,
				)
			: formatAddressList(env?.bcc);

		return {
			email_ref,
			folder,
			uid,
			message_id: parsed.messageId ?? env?.messageId ?? null,
			date:
				parsed.date?.toISOString() ??
				env?.date?.toISOString() ??
				new Date().toISOString(),
			from: formatAddress(parsed.from?.value?.[0] ?? env?.from?.[0]),
			reply_to: replyToAddr,
			to: toList,
			cc: ccList,
			bcc: bccList,
			subject: parsed.subject ?? env?.subject ?? null,
			snippet: null,
			seen: msg.flags?.has("\\Seen") ?? false,
			has_attachments: attachments.length > 0,
			body_text,
			body_html,
			headers,
			flagged: msg.flags?.has("\\Flagged") ?? false,
			draft: msg.flags?.has("\\Draft") ?? false,
			answered: msg.flags?.has("\\Answered") ?? false,
			attachments,
		};
	}
	return null;
}

/**
 * Optimized path: fetch only headers and text body sections, skipping attachment data.
 * Used when includeAttachments is false to avoid downloading large attachments.
 *
 * Pass 1: fetch envelope + flags + bodyStructure + headers (no body bytes).
 * Pass 2: fetch only the text/html body-part sections identified in pass 1.
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
	}

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
		attachments: [],
	};
}
