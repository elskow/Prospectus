import type { Processor, ProcessOutputStepArgs, ProcessorMessageResult } from "@mastra/core/processors";
import type { MastraDBMessage } from "@mastra/core/agent";
import type { ExtractionResult } from "@src/harness/schemas";

function normalized(value: string): string {
  return value.toLowerCase().replace(/[\s\-().+]/g, "");
}

function textOf(message: MastraDBMessage): string {
  let out = "";
  for (const part of message.content.parts) {
    if (part.type === "text" && "text" in part) out += part.text;
  }
  return out;
}

function stepText(args: ProcessOutputStepArgs): string {
  if (args.text) return args.text;
  const last = args.messages.at(-1);
  return last ? textOf(last) : "";
}

function latestUserText(args: ProcessOutputStepArgs): string {
  for (let i = args.messages.length - 1; i >= 0; i -= 1) {
    const message = args.messages[i];
    if (!message || message.role !== "user") continue;
    const text = textOf(message);
    if (text) return text;
  }
  return "";
}

function parseJson<T>(text: string): T | null {
  const start = text.indexOf("{");
  const end = text.lastIndexOf("}");
  if (start === -1 || end <= start) return null;
  try {
    return JSON.parse(text.slice(start, end + 1)) as T;
  } catch {
    return null;
  }
}

export class ExtractionVerifier implements Processor<"extraction-verifier"> {
  readonly id = "extraction-verifier" as const;

  processOutputStep(args: ProcessOutputStepArgs): ProcessorMessageResult {
    const source = normalized(latestUserText(args));
    const parsed = parseJson<ExtractionResult>(stepText(args));
    if (!parsed?.candidates?.length || !source) return args.messageList;

    const violations: string[] = [];
    for (const candidate of parsed.candidates) {
      const label = candidate.name || "(unnamed candidate)";
      if (!candidate.name?.trim()) violations.push(`${label}: missing company name`);
      if (candidate.phone && !source.includes(normalized(candidate.phone))) {
        violations.push(`${label}: phone ${candidate.phone} not found in source`);
      }
      for (const contact of candidate.contacts ?? []) {
        if (contact.email && !source.includes(normalized(contact.email))) {
          violations.push(`${label}: email ${contact.email} not found in source`);
        }
        if (contact.phone && !source.includes(normalized(contact.phone))) {
          violations.push(`${label}: contact phone ${contact.phone} not found in source`);
        }
        if (contact.linkedinUrl && !source.includes(normalized(contact.linkedinUrl))) {
          violations.push(`${label}: linkedin ${contact.linkedinUrl} not found in source`);
        }
      }
    }

    if (violations.length > 0 && args.retryCount < 3) {
      args.abort(
        `Extraction violations: ${violations.slice(0, 8).join("; ")}. ` +
          "Only output phone numbers, emails, and LinkedIn URLs that appear verbatim in the source text. Use null when absent.",
        { retry: true, metadata: { violations } },
      );
    }
    return args.messageList;
  }
}
