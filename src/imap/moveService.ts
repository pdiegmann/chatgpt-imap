import type { ImapFlow } from "imapflow";
import { decodeEmailRef } from "../utils/crypto.js";
import { logger } from "../utils/logging.js";

export async function moveEmails(
	client: ImapFlow,
	accountId: string,
	emailRefs: string[],
	destinationPath: string,
	createIfMissing: boolean,
): Promise<{
	moved: string[];
	destination_resolved: string;
	failed: Array<{ email_ref: string; reason: string }>;
}> {
	const moved: string[] = [];
	const failed: Array<{ email_ref: string; reason: string }> = [];

	if (createIfMissing) {
		try {
			await client.mailboxCreate(destinationPath);
		} catch {
			// may already exist
		}
	}

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
			await client.messageMove(
				items.map((i) => i.uid),
				destinationPath,
				{ uid: true },
			);
			moved.push(...items.map((i) => i.ref));
		} catch (e) {
			logger.warn("Move failed", {
				folder,
				destination: destinationPath,
				error: String(e),
			});
			failed.push(
				...items.map((i) => ({ email_ref: i.ref, reason: String(e) })),
			);
		} finally {
			lock.release();
		}
	}

	return { moved, destination_resolved: destinationPath, failed };
}
