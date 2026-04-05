import { z } from "zod";

export const ErrorCodeEnum = z.enum([
  "AUTH_FAILED",
  "CONNECTION_FAILED",
  "FOLDER_NOT_FOUND",
  "SPECIAL_FOLDER_NOT_RESOLVED",
  "EMAIL_NOT_FOUND",
  "INVALID_QUERY",
  "UNSUPPORTED_QUERY_PART",
  "AMBIGUOUS_TARGET",
  "MOVE_FAILED",
  "FLAG_UPDATE_FAILED",
  "DRAFT_CREATE_FAILED",
  "RATE_LIMITED",
  "INTERNAL_ERROR",
]);

export const ErrorSchema = z.object({
  error: z.object({
    code: ErrorCodeEnum,
    message: z.string(),
    details: z.union([z.record(z.string(), z.unknown()), z.null()]).optional(),
  }),
});

export type AppError = z.infer<typeof ErrorSchema>;

export function makeError(
  code: z.infer<typeof ErrorCodeEnum>,
  message: string,
  details?: Record<string, unknown>
): AppError {
  return { error: { code, message, details: details ?? null } };
}
