import { z } from "zod";

export const SetEmailFlagsInputSchema = z
  .object({
    email_refs: z.array(z.string()).min(1).max(500),
    seen: z.boolean(),
  })
  .strict();

export const SetEmailFlagsOutputSchema = z
  .object({
    updated: z.array(z.string()),
    requested_seen: z.boolean(),
    failed: z
      .array(
        z
          .object({
            email_ref: z.string(),
            reason: z.string(),
          })
          .strict()
      )
      .optional(),
  })
  .strict();

export type SetEmailFlagsInput = z.infer<typeof SetEmailFlagsInputSchema>;
export type SetEmailFlagsOutput = z.infer<typeof SetEmailFlagsOutputSchema>;
