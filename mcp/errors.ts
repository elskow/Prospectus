export class ToolError extends Error {
  constructor(
    readonly code: string,
    message: string,
  ) {
    super(message);
    this.name = "ToolError";
  }
}

export function noUser(): ToolError {
  return new ToolError("NO_USER", "no Prospectus user found; set PROSPECTUS_MCP_USER_EMAIL");
}

export function campaignNotFound(): ToolError {
  return new ToolError("CAMPAIGN_NOT_FOUND", "campaign not found for the configured Prospectus user");
}

export function invalidArguments(message: string): ToolError {
  return new ToolError("INVALID_ARGUMENTS", message);
}

export function capReached(message: string): ToolError {
  return new ToolError("CAP_REACHED", message);
}

export function noActiveRun(message: string): ToolError {
  return new ToolError("NO_ACTIVE_RUN", message);
}
