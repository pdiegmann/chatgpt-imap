export type QueryField =
	| "from"
	| "to"
	| "cc"
	| "bcc"
	| "subject"
	| "body"
	| "text_any"
	| "date";
export type TextOperator = "contains" | "equals" | "starts_with" | "ends_with";
export type DateOperator = "before" | "after" | "on" | "between";
export type QueryOperator = TextOperator | DateOperator;

export interface ConditionNode {
	type: "condition";
	field: QueryField;
	operator: QueryOperator;
	value: string | [string, string];
}

export interface GroupNode {
	type: "group";
	operator: "AND" | "OR";
	children: QueryNode[];
}

export type QueryNode = ConditionNode | GroupNode;

export interface SearchQuery {
	query: QueryNode;
	folders?: string[];
	special_folders?: Array<
		"inbox" | "archive" | "drafts" | "sent" | "trash" | "junk"
	>;
	limit?: number;
	offset?: number;
	sort?: { field: "date"; direction: "asc" | "desc" };
	return_body_snippet?: boolean;
}
