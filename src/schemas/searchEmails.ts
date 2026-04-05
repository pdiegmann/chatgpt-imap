import { z } from "zod";

type ConditionNode = {
	type: "condition";
	field:
		| "from"
		| "to"
		| "cc"
		| "bcc"
		| "subject"
		| "body"
		| "text_any"
		| "date";
	operator:
		| "contains"
		| "equals"
		| "starts_with"
		| "ends_with"
		| "before"
		| "after"
		| "on"
		| "between";
	value: string | [string, string];
};

type GroupNode = {
	type: "group";
	operator: "AND" | "OR";
	children: QueryNode[];
};

type QueryNode = GroupNode | ConditionNode;

const ConditionNodeSchema: z.ZodType<ConditionNode> = z
	.object({
		type: z.literal("condition"),
		field: z.enum([
			"from",
			"to",
			"cc",
			"bcc",
			"subject",
			"body",
			"text_any",
			"date",
		]),
		operator: z.enum([
			"contains",
			"equals",
			"starts_with",
			"ends_with",
			"before",
			"after",
			"on",
			"between",
		]),
		value: z.union([z.string(), z.tuple([z.string(), z.string()])]),
	})
	.strict();

const GroupNodeSchema: z.ZodType<GroupNode> = z.lazy(() =>
	z
		.object({
			type: z.literal("group"),
			operator: z.enum(["AND", "OR"]),
			children: z.array(QueryNodeSchema).min(1),
		})
		.strict(),
);

const QueryNodeSchema: z.ZodType<QueryNode> = z.union([
	GroupNodeSchema,
	ConditionNodeSchema,
]);

export const SearchEmailsInputSchema = z
	.object({
		folders: z.array(z.string()).optional(),
		special_folders: z
			.array(z.enum(["inbox", "archive", "drafts", "sent", "trash", "junk"]))
			.optional(),
		query: QueryNodeSchema,
		limit: z.number().int().min(1).max(200).default(25),
		offset: z.number().int().min(0).default(0),
		sort: z
			.object({
				field: z.enum(["date"]),
				direction: z.enum(["asc", "desc"]),
			})
			.default({ field: "date", direction: "desc" }),
		return_body_snippet: z.boolean().default(true),
	})
	.strict();

export const EmailSummarySchema = z
	.object({
		email_ref: z.string(),
		folder: z.string(),
		uid: z.number().int(),
		message_id: z.union([z.string(), z.null()]),
		date: z.string(),
		from: z.string(),
		to: z.array(z.string()),
		cc: z.array(z.string()),
		subject: z.union([z.string(), z.null()]),
		snippet: z.union([z.string(), z.null()]),
		seen: z.boolean(),
		has_attachments: z.union([z.boolean(), z.null()]),
	})
	.strict();

export const SearchEmailsOutputSchema = z
	.object({
		results: z.array(EmailSummarySchema),
		total_estimate: z.number().int(),
		search_warnings: z.array(z.string()).optional(),
	})
	.strict();

export type SearchEmailsInput = z.infer<typeof SearchEmailsInputSchema>;
export type SearchEmailsOutput = z.infer<typeof SearchEmailsOutputSchema>;
