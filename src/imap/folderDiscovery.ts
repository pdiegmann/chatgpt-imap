import type { ImapFlow, ListTreeResponse } from "imapflow";
import { detectSpecialUse } from "../config/specialFolders.js";
import type { FolderInfo, SpecialUse } from "../types/folder.js";
import { logger } from "../utils/logging.js";

export async function discoverFolders(
	client: ImapFlow,
	includeStats: boolean,
	includeUnselectable: boolean,
): Promise<FolderInfo[]> {
	const tree = await client.listTree();
	const folders: FolderInfo[] = [];

	async function processFolder(folder: ListTreeResponse): Promise<void> {
		const attributes = Array.from(folder.flags ?? []);
		const canSelect = !attributes.includes("\\Noselect") && !folder.disabled;
		const canAppend = canSelect;

		if (!includeUnselectable && !canSelect) {
			for (const sub of folder.folders ?? []) {
				await processFolder(sub);
			}
			return;
		}

		const special_use: SpecialUse = detectSpecialUse(
			folder.path ?? "",
			attributes,
		);
		let message_count: number | null = null;
		let unseen_count: number | null = null;

		if (includeStats && canSelect && folder.path) {
			try {
				const status = await client.status(folder.path, {
					messages: true,
					unseen: true,
				});
				message_count = status.messages ?? null;
				unseen_count = status.unseen ?? null;
			} catch (e) {
				logger.warn("Failed to get folder stats", {
					folder: folder.path,
					error: String(e),
				});
			}
		}

		const display_name =
			folder.name ??
			(folder.path ?? "").split(folder.delimiter ?? "/").pop() ??
			folder.path ??
			"";

		folders.push({
			path: folder.path ?? "",
			display_name,
			delimiter: folder.delimiter ?? null,
			attributes,
			special_use,
			can_select: canSelect,
			can_append: canAppend,
			message_count,
			unseen_count,
		});

		for (const sub of folder.folders ?? []) {
			await processFolder(sub);
		}
	}

	for (const folder of tree.folders ?? []) {
		await processFolder(folder);
	}

	return folders;
}

export function resolveSpecialFolder(
	folders: FolderInfo[],
	use: SpecialUse,
): FolderInfo | null {
	if (!use) return null;
	return folders.find((f) => f.special_use === use && f.can_select) ?? null;
}
