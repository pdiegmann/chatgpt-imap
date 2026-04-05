import type { SearchObject } from "imapflow";
import type { ConditionNode, GroupNode, QueryNode } from "../types/query.js";

export interface CompiledQuery {
	imapSearch: SearchObject;
}

function conditionToImap(node: ConditionNode): SearchObject {
	const { field, operator, value } = node;

	if (typeof value === "string") {
		switch (field) {
			case "from":
				return { from: value };
			case "to":
				return { to: value };
			case "cc":
				return { cc: value };
			case "bcc":
				return { bcc: value };
			case "subject":
				return { subject: value };
			case "body":
				return { body: value };
			case "text_any":
				return { text: value };
			case "date": {
				const date = new Date(value);
				if (operator === "before") return { before: date };
				if (operator === "after") return { since: date };
				if (operator === "on") return { on: date };
				return {};
			}
			default:
				return {};
		}
	} else if (
		Array.isArray(value) &&
		value.length === 2 &&
		operator === "between"
	) {
		const [start, end] = value;
		// IMAP implicitly ANDs multiple keys in the same SearchObject
		return { since: new Date(start), before: new Date(end) };
	}

	return {};
}

function mergeSearchObjects(objects: SearchObject[]): SearchObject {
	const result: SearchObject = {};
	for (const obj of objects) {
		Object.assign(result, obj);
	}
	return result;
}

function groupToImap(node: GroupNode): SearchObject {
	const parts = node.children.map(nodeToImap);
	if (parts.length === 0) return {};
	if (parts.length === 1) return parts[0];

	if (node.operator === "AND") {
		// Multiple conditions in the same SearchObject are implicitly ANDed
		return mergeSearchObjects(parts);
	} else {
		// Use imapflow's or array
		return { or: parts };
	}
}

export function nodeToImap(node: QueryNode): SearchObject {
	if (node.type === "condition") return conditionToImap(node);
	return groupToImap(node as GroupNode);
}

export function compileQuery(node: QueryNode): CompiledQuery {
	return { imapSearch: nodeToImap(node) };
}
