import { ImapFlow } from "imapflow";
import type { ConnectionConfig } from "../config/connectionStore.js";
import { logger } from "../utils/logging.js";

export async function createImapClient(
	config: ConnectionConfig,
): Promise<ImapFlow> {
	const client = new ImapFlow({
		host: config.imap_host,
		port: config.imap_port,
		secure: config.imap_tls,
		auth: {
			user: config.username,
			pass: config.password,
		},
		logger: false,
	});

	await client.connect();
	logger.debug("IMAP connected", {
		account_id: config.account_id,
		host: config.imap_host,
	});
	return client;
}

export async function withImapClient<T>(
	config: ConnectionConfig,
	fn: (client: ImapFlow) => Promise<T>,
): Promise<T> {
	const client = await createImapClient(config);
	try {
		return await fn(client);
	} finally {
		try {
			await client.logout();
		} catch {
			// ignore logout errors
		}
	}
}
