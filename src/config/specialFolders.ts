import type { SpecialUse } from "../types/folder.js";

export const SPECIAL_USE_ATTRIBUTES: Record<string, SpecialUse> = {
	"\\All": "archive",
	"\\Archive": "archive",
	"\\Drafts": "drafts",
	"\\Sent": "sent",
	"\\Trash": "trash",
	"\\Junk": "junk",
	"\\Spam": "junk",
	"\\Inbox": "inbox",
	"\\Flagged": null,
};

const HEURISTIC_PATTERNS: Array<{ pattern: RegExp; use: SpecialUse }> = [
	{ pattern: /^inbox$/i, use: "inbox" },
	{ pattern: /^(archive|archiv|all\s*mail)$/i, use: "archive" },
	{ pattern: /^(draft|drafts|entw[üu]rfe?)$/i, use: "drafts" },
	{
		pattern: /^(sent|sent\s*items?|gesendet|sent\s*messages?)$/i,
		use: "sent",
	},
	{ pattern: /^(trash|deleted|gel[öo]scht|bin)$/i, use: "trash" },
	{ pattern: /^(junk|spam)$/i, use: "junk" },
];

export function detectSpecialUseFromAttributes(
	attributes: string[],
): SpecialUse {
	for (const attr of attributes) {
		const use = SPECIAL_USE_ATTRIBUTES[attr];
		if (use !== undefined) return use;
	}
	return null;
}

export function detectSpecialUseHeuristic(folderName: string): SpecialUse {
	const name = folderName.split(/[/.]/).pop() ?? folderName;
	for (const { pattern, use } of HEURISTIC_PATTERNS) {
		if (pattern.test(name)) return use;
	}
	return null;
}

export function detectSpecialUse(
	folderName: string,
	attributes: string[],
): SpecialUse {
	const fromAttr = detectSpecialUseFromAttributes(attributes);
	if (fromAttr !== null) return fromAttr;
	return detectSpecialUseHeuristic(folderName);
}
