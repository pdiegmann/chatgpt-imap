import { ImapFlow } from "imapflow";
import type { ConnectionConfig } from "../config/connectionStore.js";
import { logger } from "../utils/logging.js";

// How long to wait for the TCP connection + server greeting to succeed
const IMAP_CONNECTION_TIMEOUT_MS = 15_000;
// How long an idle socket may remain silent before being torn down
const IMAP_SOCKET_TIMEOUT_MS = 30_000;
// Default wall-clock budget for a complete tool operation (connect → work → logout)
const DEFAULT_OP_TIMEOUT_MS = 60_000;

function parseEnvInt(name: string, fallback: number): number {
	const raw = process.env[name];
	if (!raw) return fallback;
	const n = parseInt(raw, 10);
	return Number.isFinite(n) && n > 0 ? n : fallback;
}

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
		connectionTimeout: IMAP_CONNECTION_TIMEOUT_MS,
		socketTimeout: IMAP_SOCKET_TIMEOUT_MS,
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
	const opTimeoutMs = parseEnvInt("IMAP_OP_TIMEOUT_MS", DEFAULT_OP_TIMEOUT_MS);
	const client = await createImapClient(config);

	let timeoutHandle: ReturnType<typeof setTimeout> | undefined;
	const timeoutPromise = new Promise<never>((_, reject) => {
		timeoutHandle = setTimeout(
			() =>
				reject(
					new Error(`IMAP operation timed out after ${opTimeoutMs}ms`),
				),
			opTimeoutMs,
		);
	});

	try {
		return await Promise.race([fn(client), timeoutPromise]);
	} finally {
		clearTimeout(timeoutHandle);
		try {
			await client.logout();
		} catch {
			// ignore logout errors
		}
	}
}
