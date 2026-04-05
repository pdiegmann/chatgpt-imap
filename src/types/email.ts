export interface EmailRef {
	account_id: string;
	folder: string;
	uid_validity: number;
	uid: number;
}

export interface AttachmentInfo {
	filename: string | null;
	content_type: string;
	size: number;
	content_id: string | null;
}

export interface EmailSummary {
	email_ref: string;
	folder: string;
	uid: number;
	message_id: string | null;
	date: string;
	from: string;
	to: string[];
	cc: string[];
	subject: string | null;
	snippet: string | null;
	seen: boolean;
	has_attachments: boolean | null;
}

export interface EmailFull extends EmailSummary {
	reply_to: string | null;
	bcc: string[];
	body_text: string | null;
	body_html: string | null;
	headers: Record<string, string>;
	flagged: boolean;
	draft: boolean;
	answered: boolean;
	attachments: AttachmentInfo[];
}
