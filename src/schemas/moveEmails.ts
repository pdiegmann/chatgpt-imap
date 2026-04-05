import { z } from "zod";

export const MoveEmailsInputSchema = z
	.object({
		email_refs: z.array(z.string()).min(1).max(500),
		destination_folder: z.string().optional(),
		destination_special_use: z
			.enum(["archive", "drafts", "sent", "trash", "junk", "inbox"])
			.optional(),
		create_if_missing: z.boolean().default(false),
	})
	.strict()
	.refine(
		(data) =>
			data.destination_folder !== undefined ||
			data.destination_special_use !== undefined,
		{
			message:
				"Either destination_folder or destination_special_use must be provided",
		},
	);

export const MoveEmailsOutputSchema = z
	.object({
		moved: z.array(z.string()),
		destination_resolved: z.string(),
		failed: z
			.array(
				z
					.object({
						email_ref: z.string(),
						reason: z.string(),
					})
					.strict(),
			)
			.optional(),
	})
	.strict();

export type MoveEmailsInput = z.infer<typeof MoveEmailsInputSchema>;
export type MoveEmailsOutput = z.infer<typeof MoveEmailsOutputSchema>;
