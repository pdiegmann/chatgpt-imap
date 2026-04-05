import { z } from "zod";

export const GetEmailInputSchema = z
  .object({
    email_ref: z.string(),
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
  })
  .strict();

export const GetEmailOutputSchema = z
  .object({
    email_ref: z.string(),
    folder: z.string(),
    uid: z.number().int(),
    message_id: z.union([z.string(), z.null()]),
    date: z.string(),
    from: z.string(),
    reply_to: z.union([z.string(), z.null()]).optional(),
    to: z.array(z.string()),
    cc: z.array(z.string()),
    bcc: z.array(z.string()),
    subject: z.union([z.string(), z.null()]),
    body_text: z.union([z.string(), z.null()]).optional(),
    body_html: z.union([z.string(), z.null()]).optional(),
    headers: z.record(z.string(), z.string()).optional(),
    seen: z.boolean(),
    flagged: z.boolean(),
    draft: z.boolean(),
    answered: z.boolean(),
    attachments: z
      .array(
        z
          .object({
            filename: z.union([z.string(), z.null()]),
            content_type: z.string(),
            size: z.number().int(),
            content_id: z.union([z.string(), z.null()]),
          })
          .strict()
      )
      .optional(),
  })
  .strict();

export type GetEmailInput = z.infer<typeof GetEmailInputSchema>;
export type GetEmailOutput = z.infer<typeof GetEmailOutputSchema>;
