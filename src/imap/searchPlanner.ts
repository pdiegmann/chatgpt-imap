import type { ImapFlow, FetchMessageObject } from "imapflow";
import type { SearchQuery } from "../types/query.js";
import type { EmailSummary } from "../types/email.js";
import type { FolderInfo } from "../types/folder.js";
import { compileQuery } from "./queryCompiler.js";
import { encodeEmailRef } from "../utils/crypto.js";
import { logger } from "../utils/logging.js";

function formatAddress(
  addr: { name?: string; address?: string } | null | undefined
): string {
  if (!addr) return "";
  if (addr.name && addr.address && addr.name !== addr.address)
    return `"${addr.name}" <${addr.address}>`;
  return addr.address ?? addr.name ?? "";
}

function formatAddressList(
  list: Array<{ name?: string; address?: string }> | null | undefined
): string[] {
  if (!list) return [];
  return list.map(formatAddress).filter(Boolean);
}

export async function executeSearch(
  client: ImapFlow,
  accountId: string,
  searchQuery: SearchQuery,
  folders: FolderInfo[]
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
      ...folders.filter((f) => f.can_select).map((f) => f.path)
    );
  }

  const { imapSearch } = compileQuery(searchQuery.query);
  const limit = searchQuery.limit ?? 25;
  const offset = searchQuery.offset ?? 0;
  const allResults: EmailSummary[] = [];

  for (const folderPath of targetFolders) {
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

        const searchResult = await client.search(imapSearch, { uid: true });
        if (!searchResult || !searchResult.length) continue;
        const uids = searchResult;

        // Search results are in ascending order; reverse for newest-first
        const sortedUids = [...uids].reverse();

        for await (const msg of client.fetch(
          sortedUids as number[],
          {
            uid: true,
            flags: true,
            envelope: true,
            bodyStructure: true,
          },
          { uid: true }
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
                    n.disposition === "attachment"
                )
              : null;

          allResults.push({
            email_ref,
            folder: folderPath,
            uid,
            message_id: env?.messageId ?? null,
            date:
              env?.date?.toISOString() ?? new Date().toISOString(),
            from: formatAddress(env?.from?.[0]),
            to: formatAddressList(env?.to),
            cc: formatAddressList(env?.cc),
            subject: env?.subject ?? null,
            snippet: null,
            seen,
            has_attachments: hasAttachments,
          });
        }
      } finally {
        lock.release();
      }
    } catch (e) {
      logger.warn("Search failed for folder", {
        folder: folderPath,
        error: String(e),
      });
      warnings.push(
        `Search failed for folder "${folderPath}": ${String(e)}`
      );
    }
  }

  const total = allResults.length;
  const paginated = allResults.slice(offset, offset + limit);
  return { results: paginated, total_estimate: total, search_warnings: warnings };
}
