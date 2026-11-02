import { createTool } from "@mastra/core/tools";
import { verifyEmail } from "@src/harness/contact-discovery";
import { z } from "zod";

export const verifyEmailTool = createTool({
  id: "verify-email",
  description:
    "Verify an email address before handing it to the user: syntax, disposable-domain, MX, and live SMTP mailbox checks. Returns a verdict with the stage that decided it. Use this on any email the platform inferred rather than observed verbatim.",
  inputSchema: z.object({
    email: z.string().email(),
  }),

  execute: async (inputData) => {
    const verdict = await verifyEmail(inputData.email, { timeoutMs: 15_000 });
    return {
      ok: true as const,
      email: inputData.email,
      stage: verdict.stage,
      valid: verdict.valid,
      reason: verdict.reason,
      catchAll: "catchAll" in verdict ? verdict.catchAll : false,
    };
  },
});
