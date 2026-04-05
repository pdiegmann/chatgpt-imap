import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";
import { getConnection } from "../config/connectionStore.js";
import { withImapClient } from "../imap/client.js";
import { discoverFolders, resolveSpecialFolder } from "../imap/folderDiscovery.js";
import { executeSearch } from "../imap/searchPlanner.js";
import { resolveMessage } from "../imap/messageResolver.js";
import { setFlags } from "../imap/flagService.js";
import { moveEmails } from "../imap/moveService.js";
import { createDraft } from "../imap/draftService.js";
import { decodeEmailRef } from "../utils/crypto.js";
import { makeError } from "../schemas/common.js";
import { logger } from "../utils/logging.js";
import type { SearchQuery } from "../types/query.js";

const ACCOUNT_ID = process.env.IMAP_ACCOUNT_ID ?? "default";

function toToolResult(data: unknown): {
  content: Array<{ type: "text"; text: string }>;
} {
  return { content: [{ type: "text", text: JSON.stringify(data, null, 2) }] };
}

export function registerTools(server: McpServer): void {
  // list_folders
  server.tool(
    "list_folders",
    "Lists all mailbox folders and detects special folders (inbox, archive, drafts, sent, trash, junk). Does not modify any state.",
    {
      include_stats: z
        .boolean()
        .default(false)
        .describe(
          "Include message_count and unseen_count per folder"
        ),
      include_unselectable: z
        .boolean()
        .default(false)
        .describe("Include container folders that cannot be selected"),
    },
    async (input) => {
      try {
        const config = getConnection(ACCOUNT_ID);
        const folders = await withImapClient(config, (client) =>
          discoverFolders(
            client,
            input.include_stats,
            input.include_unselectable
          )
        );
        return toToolResult({ folders });
      } catch (e) {
        logger.error("list_folders failed", { error: String(e) });
        return toToolResult(makeError("INTERNAL_ERROR", String(e)));
      }
    }
  );

  // search_emails
  server.tool(
    "search_emails",
    "Searches emails using a structured query DSL. Supports AND/OR logic, field filters (from, to, subject, body, date), and folder scoping. Does NOT modify any state or mark emails as read.",
    {
      folders: z
        .array(z.string())
        .optional()
        .describe("Explicit folder paths to search in"),
      special_folders: z
        .array(
          z.enum(["inbox", "archive", "drafts", "sent", "trash", "junk"])
        )
        .optional()
        .describe("Special folder types to search in"),
      query: z
        .object({
          type: z.enum(["condition", "group"]),
          operator: z.string(),
          field: z.string().optional(),
          value: z
            .union([z.string(), z.array(z.string())])
            .optional(),
          children: z.array(z.unknown()).optional(),
        })
        .describe("Query DSL node (condition or group with AND/OR)"),
      limit: z.number().int().min(1).max(200).default(25),
      offset: z.number().int().min(0).default(0),
      sort: z
        .object({
          field: z.enum(["date"]),
          direction: z.enum(["asc", "desc"]),
        })
        .default({ field: "date", direction: "desc" }),
      return_body_snippet: z.boolean().default(true),
    },
    async (input) => {
      try {
        const config = getConnection(ACCOUNT_ID);
        const result = await withImapClient(config, async (client) => {
          const folders = await discoverFolders(client, false, false);
          return executeSearch(
            client,
            ACCOUNT_ID,
            input as unknown as SearchQuery,
            folders
          );
        });
        return toToolResult(result);
      } catch (e) {
        logger.error("search_emails failed", { error: String(e) });
        return toToolResult(makeError("INTERNAL_ERROR", String(e)));
      }
    }
  );

  // get_email
  server.tool(
    "get_email",
    "Retrieves a single email by its email_ref. Does NOT implicitly mark the email as read or modify any state.",
    {
      email_ref: z
        .string()
        .describe("Stable email reference returned by search_emails"),
      include_body_text: z.boolean().default(true),
      include_body_html: z.boolean().default(false),
      include_headers: z.boolean().default(true),
      include_attachments: z.boolean().default(true),
      max_body_chars: z
        .number()
        .int()
        .min(100)
        .max(200000)
        .default(40000),
    },
    async (input) => {
      try {
        const decoded = decodeEmailRef(input.email_ref);
        if (decoded.account_id !== ACCOUNT_ID) {
          return toToolResult(
            makeError(
              "EMAIL_NOT_FOUND",
              "email_ref belongs to a different account"
            )
          );
        }
        const config = getConnection(ACCOUNT_ID);
        const email = await withImapClient(config, (client) =>
          resolveMessage(client, ACCOUNT_ID, decoded.folder, decoded.uid, {
            includeBodyText: input.include_body_text,
            includeBodyHtml: input.include_body_html,
            includeHeaders: input.include_headers,
            includeAttachments: input.include_attachments,
            maxBodyChars: input.max_body_chars,
          })
        );
        if (!email) {
          return toToolResult(
            makeError(
              "EMAIL_NOT_FOUND",
              `Email not found: ${input.email_ref}`
            )
          );
        }
        return toToolResult(email);
      } catch (e) {
        logger.error("get_email failed", { error: String(e) });
        return toToolResult(makeError("INTERNAL_ERROR", String(e)));
      }
    }
  );

  // set_email_flags
  server.tool(
    "set_email_flags",
    "Explicitly sets the seen/unseen flag on one or more emails. Use seen=true to mark as read, seen=false to mark as unread. Only works with explicit email_refs.",
    {
      email_refs: z
        .array(z.string())
        .min(1)
        .max(500)
        .describe("List of email_refs to update"),
      seen: z
        .boolean()
        .describe("true = mark as read, false = mark as unread"),
    },
    async (input) => {
      try {
        const config = getConnection(ACCOUNT_ID);
        const result = await withImapClient(config, (client) =>
          setFlags(client, ACCOUNT_ID, input.email_refs, input.seen)
        );
        return toToolResult({ ...result, requested_seen: input.seen });
      } catch (e) {
        logger.error("set_email_flags failed", { error: String(e) });
        return toToolResult(makeError("FLAG_UPDATE_FAILED", String(e)));
      }
    }
  );

  // move_emails
  server.tool(
    "move_emails",
    "Moves emails to a destination folder or special folder. For archive, only acts when the archive folder is unambiguously resolved. Requires explicit email_refs.",
    {
      email_refs: z
        .array(z.string())
        .min(1)
        .max(500)
        .describe("List of email_refs to move"),
      destination_folder: z
        .string()
        .optional()
        .describe("Explicit destination folder path"),
      destination_special_use: z
        .enum(["archive", "drafts", "sent", "trash", "junk", "inbox"])
        .optional()
        .describe("Destination by special use type"),
      create_if_missing: z
        .boolean()
        .default(false)
        .describe("Create destination folder if it does not exist"),
    },
    async (input) => {
      try {
        if (
          !input.destination_folder &&
          !input.destination_special_use
        ) {
          return toToolResult(
            makeError(
              "AMBIGUOUS_TARGET",
              "Either destination_folder or destination_special_use must be provided"
            )
          );
        }
        const config = getConnection(ACCOUNT_ID);
        const result = await withImapClient(config, async (client) => {
          let destPath = input.destination_folder;

          if (!destPath && input.destination_special_use) {
            const folders = await discoverFolders(client, false, false);
            const resolved = resolveSpecialFolder(
              folders,
              input.destination_special_use
            );
            if (!resolved) {
              return {
                moved: [],
                destination_resolved: "",
                failed: input.email_refs.map((ref) => ({
                  email_ref: ref,
                  reason: `Special folder "${input.destination_special_use}" could not be resolved`,
                })),
              };
            }
            destPath = resolved.path;
          }

          return moveEmails(
            client,
            ACCOUNT_ID,
            input.email_refs,
            destPath!,
            input.create_if_missing
          );
        });
        return toToolResult(result);
      } catch (e) {
        logger.error("move_emails failed", { error: String(e) });
        return toToolResult(makeError("MOVE_FAILED", String(e)));
      }
    }
  );

  // create_draft
  server.tool(
    "create_draft",
    "Creates a new draft or a reply draft. Does NOT send any email. For reply drafts, automatically sets To, Subject, In-Reply-To, and References from the original message.",
    {
      draft_type: z.enum(["new", "reply"]).default("new"),
      reply_to_email_ref: z
        .string()
        .optional()
        .describe("Required when draft_type is 'reply'"),
      to: z.array(z.string()).optional(),
      cc: z.array(z.string()).optional(),
      bcc: z.array(z.string()).optional(),
      subject: z.string().optional(),
      body_text: z.string().describe("Plain text body (required)"),
      body_html: z.string().optional(),
      quote_original: z.boolean().default(true),
      save_to_special_use: z.enum(["drafts"]).default("drafts"),
    },
    async (input) => {
      try {
        if (
          input.draft_type === "new" &&
          (!input.to?.length || !input.subject)
        ) {
          return toToolResult(
            makeError(
              "INVALID_QUERY",
              "For new drafts, 'to' and 'subject' are required"
            )
          );
        }
        if (
          input.draft_type === "reply" &&
          !input.reply_to_email_ref
        ) {
          return toToolResult(
            makeError(
              "INVALID_QUERY",
              "For reply drafts, 'reply_to_email_ref' is required"
            )
          );
        }

        const config = getConnection(ACCOUNT_ID);
        const result = await withImapClient(config, async (client) => {
          const folders = await discoverFolders(client, false, false);
          const draftsFolder = resolveSpecialFolder(folders, "drafts");
          if (!draftsFolder) {
            throw new Error("Drafts folder not found");
          }
          return createDraft(client, ACCOUNT_ID, draftsFolder.path, {
            draft_type: input.draft_type,
            reply_to_email_ref: input.reply_to_email_ref,
            to: input.to,
            cc: input.cc,
            bcc: input.bcc,
            subject: input.subject,
            body_text: input.body_text,
            body_html: input.body_html,
            quote_original: input.quote_original,
            save_to_special_use: input.save_to_special_use,
          });
        });
        return toToolResult(result);
      } catch (e) {
        logger.error("create_draft failed", { error: String(e) });
        return toToolResult(
          makeError("DRAFT_CREATE_FAILED", String(e))
        );
      }
    }
  );
}
