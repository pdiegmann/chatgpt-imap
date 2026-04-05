import { z } from "zod";

export const ConnectionConfigSchema = z.object({
	account_id: z.string().min(1),
	display_name: z.string().optional(),
	imap_host: z.string().min(1),
	imap_port: z.number().int().min(1).max(65535),
	imap_tls: z.boolean().default(true),
	username: z.string().min(1),
	password: z.string().min(1),
	smtp_host: z.string().optional(),
	smtp_port: z.number().int().min(1).max(65535).optional(),
	smtp_tls: z.boolean().optional(),
	special_folder_overrides: z
		.object({
			inbox: z.string().optional(),
			archive: z.string().optional(),
			drafts: z.string().optional(),
			sent: z.string().optional(),
			trash: z.string().optional(),
			junk: z.string().optional(),
		})
		.optional(),
});

export type ConnectionConfig = z.infer<typeof ConnectionConfigSchema>;

const store = new Map<string, ConnectionConfig>();

export function registerConnection(config: ConnectionConfig): void {
	const validated = ConnectionConfigSchema.parse(config);
	store.set(validated.account_id, validated);
}

export function getConnection(account_id: string): ConnectionConfig {
	const conn = store.get(account_id);
	if (!conn)
		throw new Error(`No connection registered for account_id: ${account_id}`);
	return conn;
}

export function loadFromEnv(): void {
	const account_id = process.env.IMAP_ACCOUNT_ID ?? "default";
	const imap_host = process.env.IMAP_HOST;
	const imap_port = process.env.IMAP_PORT
		? parseInt(process.env.IMAP_PORT, 10)
		: undefined;
	const imap_tls = process.env.IMAP_TLS !== "false";
	const username = process.env.IMAP_USERNAME;
	const password = process.env.IMAP_PASSWORD;

	if (!imap_host || !username || !password || !imap_port) {
		return;
	}

	registerConnection({
		account_id,
		imap_host,
		imap_port,
		imap_tls,
		username,
		password,
		smtp_host: process.env.SMTP_HOST,
		smtp_port: process.env.SMTP_PORT
			? parseInt(process.env.SMTP_PORT, 10)
			: undefined,
		smtp_tls: process.env.SMTP_TLS !== "false",
	});
}
