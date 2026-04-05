import type { ImapFlow } from "imapflow";
import { decodeEmailRef } from "../utils/crypto.js";
import { logger } from "../utils/logging.js";

export async function setFlags(
	client: ImapFlow,
	accountId: string,
	emailRefs: string[],
	seen: boolean,
): Promise<{
	updated: string[];
	failed: Array<{ email_ref: string; reason: string }>;
}> {
	const updated: string[] = [];
	const failed: Array<{ email_ref: string; reason: string }> = [];

	const byFolder = new Map<string, Array<{ ref: string; uid: number }>>();

	for (const ref of emailRefs) {
		try {
			const decoded = decodeEmailRef(ref);
			if (decoded.account_id !== accountId) {
				failed.push({ email_ref: ref, reason: "Account mismatch" });
				continue;
			}
			const existing = byFolder.get(decoded.folder) ?? [];
			existing.push({ ref, uid: decoded.uid });
			byFolder.set(decoded.folder, existing);
		} catch (e) {
			failed.push({
				email_ref: ref,
				reason: `Invalid email_ref: ${String(e)}`,
			});
		}
	}

	for (const [folder, items] of byFolder.entries()) {
		const lock = await client.getMailboxLock(folder);
		try {
			const uids = items.map((i) => i.uid);
			if (seen) {
				await client.messageFlagsAdd(uids, ["\\Seen"], { uid: true });
			} else {
				await client.messageFlagsRemove(uids, ["\\Seen"], { uid: true });
			}
			updated.push(...items.map((i) => i.ref));
		} catch (e) {
			logger.warn("Flag update failed", { folder, error: String(e) });
			failed.push(
				...items.map((i) => ({ email_ref: i.ref, reason: String(e) })),
			);
		} finally {
			lock.release();
		}
	}

	return { updated, failed };
}
