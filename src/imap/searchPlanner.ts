import type { ImapFlow } from "imapflow";
import type { EmailSummary } from "../types/email.js";
import type { FolderInfo } from "../types/folder.js";
import type { SearchQuery } from "../types/query.js";
import { encodeEmailRef } from "../utils/crypto.js";
import { logger } from "../utils/logging.js";
import { compileQuery } from "./queryCompiler.js";

/** Maximum raw bytes fetched from the start of a message to build a snippet. */
const SNIPPET_SOURCE_BYTES = 4000;

function formatAddress(
  addr: { name?: string; address?: string } | null | undefined,
): string {
  if (!addr) return "";
  if (addr.name && addr.address && addr.name !== addr.address)
    return `"${addr.name}" <${addr.address}>`;
  return addr.address ?? addr.name ?? "";
}

function formatAddressList(
  list: Array<{ name?: string; address?: string }> | null | undefined,
): string[] {
  if (!list) return [];
  return list.map(formatAddress).filter(Boolean);
}

/**
 * Extracts a plain-text snippet from a raw RFC 2822 message buffer.
 *
 * Finds the blank-line separator between headers and body, then returns
 * the first `maxLen` characters of the decoded body (best-effort:
 * quoted-printable soft-line breaks are resolved, obvious base64 blocks
 * are skipped).
 */
function extractSnippet(source: Buffer, maxLen = 200): string | null {
  const raw = source.toString(
    "utf8",
    0,
    Math.min(source.length, SNIPPET_SOURCE_BYTES),
  );

  // Locate blank line separating headers from body
  const match = raw.match(/\r?\n\r?\n([\s\S]*)/);
  if (!match) return null;

  let body = match[1];

  // Skip blocks that look like base64-encoded content (long runs of base64 chars)
  if (/^[A-Za-z0-9+/\r\n]{40,}={0,2}\s*$/.test(body.trim())) {
    return null;
  }

  // Decode quoted-printable soft line breaks and encoded chars
  body = body
    .replace(/=\r?\n/g, "")
    .replace(/=[0-9A-Fa-f]{2}/g, (m) => {
      try {
        return String.fromCharCode(parseInt(m.slice(1), 16));
      } catch {
        return "";
      }
    });

  // Strip MIME boundary markers and sub-part Content-* header lines
  body = body
    .replace(/^--[^\r\n]*[\r\n]*/gm, "")
    .replace(/^Content-[^\r\n]+[\r\n]*/gim, "");

  // Normalize whitespace
  body = body.replace(/\s+/g, " ").trim();

  return body.length > 0 ? body.slice(0, maxLen) : null;
}

export async function executeSearch(
  client: ImapFlow,
  accountId: string,
  searchQuery: SearchQuery,
  folders: FolderInfo[],
): Promise<{
  results: EmailSummary[];
  total_estimate: number;
  search_warnings: string[];
}> {
  const warnings: string[] = [];
  const targetFolders: string[] = [];

  if (searchQuery.folders?.length) {
    targetFolders.push(...searchQuery.folders);
  } else if (searchQuery.special_folders?.length) {
    for (const use of searchQuery.special_folders) {
      const f = folders.find((fl) => fl.special_use === use && fl.can_select);
      if (f) targetFolders.push(f.path);
      else warnings.push(`Special folder "${use}" not found`);
    }
  } else {
    targetFolders.push(
      ...folders.filter((f) => f.can_select).map((f) => f.path),
    );
  }

  const { imapSearch, isMatchAll } = compileQuery(
    searchQuery.query ?? { type: "group", operator: "AND", children: [] },
  );
  const limit = searchQuery.limit ?? 25;
  const offset = searchQuery.offset ?? 0;
  const sortDirection = searchQuery.sort?.direction ?? "desc";
  const returnSnippet = searchQuery.return_body_snippet ?? false;
  // Total results needed to satisfy the requested page
  const needed = offset + limit;

  if (isMatchAll) {
    warnings.push(
      "No query conditions provided – returning most recent messages. " +
        "Specify folders to narrow the scope.",
    );
  }

  const allResults: EmailSummary[] = [];

  for (const folderPath of targetFolders) {
    // Stop scanning more folders once we have enough results
    if (allResults.length >= needed) break;

    try {
      const lock = await client.getMailboxLock(folderPath);
      try {
        // Fetch uidValidity once before iterating messages
        let uidValidity = 1;
        try {
          const status = await client.status(folderPath, { uidValidity: true });
          uidValidity = Number(status.uidValidity ?? 1);
        } catch {
          // use default
        }

        // imapflow's search() returns false when no messages match (not an empty array)
        const searchResult = await client.search(imapSearch, { uid: true });
        // biome-ignore lint/complexity/useOptionalChain: searchResult can be "false" which would not have "uid" property, but if it's an array it should be treated as such
        if (!searchResult || !searchResult.length) continue;

        // UIDs come back in ascending order; apply the requested sort direction.
        const sortedUids =
          sortDirection === "asc"
            ? [...searchResult]
            : [...searchResult].reverse();

        // For match-all queries, cap per-folder fetches to avoid downloading
        // the entire mailbox when the caller only needs a few results.
        const remaining = needed - allResults.length;
        const uidsToFetch = isMatchAll
          ? sortedUids.slice(0, remaining)
          : sortedUids;

        for await (const msg of client.fetch(
          uidsToFetch as number[],
          {
            uid: true,
            flags: true,
            envelope: true,
            bodyStructure: true,
            ...(returnSnippet
              ? { source: { start: 0, maxLength: SNIPPET_SOURCE_BYTES } }
              : {}),
          },
          { uid: true },
        )) {
          const env = msg.envelope;
          const uid = msg.uid;

          const email_ref = encodeEmailRef({
            account_id: accountId,
            folder: folderPath,
            uid_validity: uidValidity,
            uid,
          });
          const seen = msg.flags?.has("\\Seen") ?? false;
          const hasAttachments =
            msg.bodyStructure?.childNodes != null
              ? msg.bodyStructure.childNodes.some(
                  (n: { disposition?: string }) =>
                    n.disposition === "attachment",
                )
              : null;

          const snippet =
            returnSnippet && msg.source
              ? extractSnippet(msg.source as Buffer)
              : null;

          allResults.push({
            email_ref,
            folder: folderPath,
            uid,
            message_id: env?.messageId ?? null,
            date: env?.date?.toISOString() ?? new Date().toISOString(),
            from: formatAddress(env?.from?.[0]),
            to: formatAddressList(env?.to),
            cc: formatAddressList(env?.cc),
            subject: env?.subject ?? null,
            snippet,
            seen,
            has_attachments: hasAttachments,
          });

          // Stop fetching from this folder once we have enough for the page
          if (allResults.length >= needed) break;
        }
      } finally {
        lock.release();
      }
    } catch (e) {
      logger.warn("Search failed for folder", {
        folder: folderPath,
        error: String(e),
      });
      warnings.push(`Search failed for folder "${folderPath}": ${String(e)}`);
    }
  }

  const total = allResults.length;
  const paginated = allResults.slice(offset, offset + limit);
  return {
    results: paginated,
    total_estimate: total,
    search_warnings: warnings,
  };
}
