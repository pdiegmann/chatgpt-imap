export type SpecialUse =
	| "inbox"
	| "archive"
	| "drafts"
	| "sent"
	| "trash"
	| "junk"
	| null;

export interface FolderInfo {
	path: string;
	display_name: string;
	delimiter: string | null;
	attributes: string[];
	special_use: SpecialUse;
	can_select: boolean;
	can_append: boolean;
	message_count: number | null;
	unseen_count: number | null;
}
