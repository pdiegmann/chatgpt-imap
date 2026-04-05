import { z } from "zod";

export const CreateDraftInputSchema = z
  .object({
    draft_type: z.enum(["new", "reply"]).default("new"),
    reply_to_email_ref: z.string().optional(),
    to: z.array(z.string()).optional(),
    cc: z.array(z.string()).optional(),
    bcc: z.array(z.string()).optional(),
    subject: z.string().optional(),
    body_text: z.string(),
    body_html: z.string().optional(),
    quote_original: z.boolean().default(true),
    save_to_special_use: z.enum(["drafts"]).default("drafts"),
  })
  .strict();

export const CreateDraftOutputSchema = z
  .object({
    draft_email_ref: z.string(),
    folder: z.string(),
    message_id: z.union([z.string(), z.null()]),
    subject: z.union([z.string(), z.null()]),
    to: z.array(z.string()),
    cc: z.array(z.string()),
    bcc: z.array(z.string()),
    reply_to_email_ref: z.union([z.string(), z.null()]),
  })
  .strict();

export type CreateDraftInput = z.infer<typeof CreateDraftInputSchema>;
export type CreateDraftOutput = z.infer<typeof CreateDraftOutputSchema>;
