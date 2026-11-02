import type { AdapterContext, SinkAdapterDefinition, SinkLead, SinkResult } from "@src/adapters/types";
import { z } from "zod";

export const SHEETS_SINK_TYPE = "sink:google-sheets";

const TOKEN_URL = "https://oauth2.googleapis.com/token";
const SHEETS_BASE = "https://sheets.googleapis.com/v4";
const DRIVE_BASE = "https://www.googleapis.com/drive/v3";

export interface SheetsCredentials {
  clientId: string;
  clientSecret: string;
  refreshToken: string;
  spreadsheetId?: string;
  sheetName?: string;
}

const HEADERS_ROW = [
  "Company",
  "City",
  "Website",
  "Contact",
  "Title",
  "Email",
  "Email Verification",
  "Phone",
  "WhatsApp",
  "Decision Maker",
  "Source URL",
  "Discovered At",
];

function csvCell(value: string): string {
  if (/[",\n]/.test(value)) return `"${value.replace(/"/g, '""')}"`;

  return value;
}

function leadRow(lead: SinkLead): string[] {
  return [
    lead.companyName,
    lead.city ?? "",
    lead.website ?? "",
    lead.contactName ?? "",
    lead.contactTitle ?? "",
    lead.contactEmail ?? "",
    lead.emailVerification ?? "",
    lead.contactPhone ?? "",
    lead.contactWhatsapp ?? "",
    lead.isDecisionMaker === null ? "" : lead.isDecisionMaker ? "yes" : "no",
    lead.sourceUrl ?? "",
    lead.discoveredAt ?? "",
  ];
}

export async function getAccessToken(credentials: SheetsCredentials): Promise<string> {
  const res = await fetch(TOKEN_URL, {
    method: "POST",
    headers: { "content-type": "application/x-www-form-urlencoded" },
    body: new URLSearchParams({
      client_id: credentials.clientId,
      client_secret: credentials.clientSecret,
      refresh_token: credentials.refreshToken,
      grant_type: "refresh_token",
    }),
  });

  if (!res.ok) {
    const body = await res.text();

    throw new Error(`google token refresh failed: HTTP ${res.status} ${body.slice(0, 200)}`);
  }

  const json = (await res.json()) as { access_token?: string };

  if (!json.access_token) throw new Error("google token refresh returned no access_token");

  return json.access_token;
}

export async function findOrCreateSpreadsheet(token: string, credentials: SheetsCredentials, title: string): Promise<string> {
  if (credentials.spreadsheetId) return credentials.spreadsheetId;

  const query = encodeURIComponent(`name = '${title.replace(/'/g, "\\'")}' and mimeType = 'application/vnd.google-apps.spreadsheet' and trashed = false`);

  const search = await fetch(`${DRIVE_BASE}/files?q=${query}&fields=files(id,name)&pageSize=1`, {
    headers: { authorization: `Bearer ${token}` },
  });

  if (search.ok) {
    const found = (await search.json()) as { files?: { id: string }[] };
    const firstFile = found.files?.[0];
    if (firstFile) return firstFile.id;
  }

  const created = await fetch(`${SHEETS_BASE}/v4/spreadsheets`, {
    method: "POST",
    headers: { authorization: `Bearer ${token}`, "content-type": "application/json" },
    body: JSON.stringify({ properties: { title } }),
  });

  if (!created.ok) {
    const body = await created.text();

    throw new Error(`spreadsheet create failed: HTTP ${created.status} ${body.slice(0, 200)}`);
  }

  const json = (await created.json()) as { spreadsheetId: string };
  return json.spreadsheetId;
}

export async function appendRows(token: string, spreadsheetId: string, leads: SinkLead[], sheetName?: string): Promise<number> {
  const values = leads.map(leadRow);
  const prefix = sheetName ? `'${sheetName.replace(/'/g, "''")}'!` : "";

  const headerRes = await fetch(`${SHEETS_BASE}/v4/spreadsheets/${spreadsheetId}/values/${encodeURIComponent(`${prefix}A1:M1`)}?majorDimension=ROWS`, {
    headers: { authorization: `Bearer ${token}` },
  });
  const existing = headerRes.ok ? z.object({ values: z.array(z.array(z.string())).optional() }).parse(await headerRes.json()).values : undefined;
  const needHeader = headerRes.ok && (!existing || existing.length === 0);

  const appendRes = await fetch(
    `${SHEETS_BASE}/v4/spreadsheets/${spreadsheetId}/values/${encodeURIComponent(`${prefix}A1:M1`)}:append?valueInputOption=USER_ENTERED&insertDataOption=INSERT_ROWS`,
    {
      method: "POST",
      headers: { authorization: `Bearer ${token}`, "content-type": "application/json" },
      body: JSON.stringify({ values: needHeader ? [HEADERS_ROW, ...values] : values }),
    },
  );

  if (!appendRes.ok) {
    const body = await appendRes.text();

    throw new Error(`sheets append failed: HTTP ${appendRes.status} ${body.slice(0, 200)}`);
  }

  return values.length;
}

export const googleSheetsSinkAdapter: SinkAdapterDefinition = {
  kind: "sink",
  type: SHEETS_SINK_TYPE,
  label: "Google Sheets export",
  credentials: {
    fields: [],
  },
  async write(leads: SinkLead[], ctx: AdapterContext): Promise<SinkResult> {
    const credentials = ctx.credentials as unknown as SheetsCredentials;
    if (!credentials.clientId || !credentials.clientSecret || !credentials.refreshToken) {
      throw new Error("google sheets sink requires clientId, clientSecret and refreshToken credentials");
    }

    const token = await getAccessToken(credentials);
    const spreadsheetId = await findOrCreateSpreadsheet(token, credentials, "Prospectus Leads");
    const written = await appendRows(token, spreadsheetId, leads, credentials.sheetName);

    return {
      written,
      targetLocation: credentials.sheetName ? `sheets:${spreadsheetId}/${credentials.sheetName}` : `sheets:${spreadsheetId}`,
      warnings: [],
    };
  },
};

export { csvCell };
