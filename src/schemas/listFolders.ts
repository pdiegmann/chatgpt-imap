import { z } from "zod";

export const ListFoldersInputSchema = z
	.object({
		include_stats: z.boolean().default(false),
		include_unselectable: z.boolean().default(false),
	})
	.strict();

export const FolderItemSchema = z
	.object({
		path: z.string(),
		display_name: z.string(),
		delimiter: z.union([z.string(), z.null()]),
		attributes: z.array(z.string()),
		special_use: z.union([
			z.enum(["inbox", "archive", "drafts", "sent", "trash", "junk"]),
			z.null(),
		]),
		can_select: z.boolean(),
		can_append: z.boolean(),
		message_count: z.union([z.number().int(), z.null()]),
		unseen_count: z.union([z.number().int(), z.null()]),
	})
	.strict();

export const ListFoldersOutputSchema = z
	.object({
		folders: z.array(FolderItemSchema),
	})
	.strict();

export type ListFoldersInput = z.infer<typeof ListFoldersInputSchema>;
export type ListFoldersOutput = z.infer<typeof ListFoldersOutputSchema>;
