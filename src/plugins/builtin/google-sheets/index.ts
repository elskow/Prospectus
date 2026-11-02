import { definePlugin } from "@src/plugins/define";
import { googleSheetsSinkAdapter, SHEETS_SINK_TYPE } from "@src/plugins/builtin/google-sheets/api";

export const googleSheetsPlugin = definePlugin({
  manifest: {
    name: "google-sheets",
    description: "Syncs qualified leads into a Google Sheets spreadsheet via per-user OAuth refresh tokens.",
    schemaVersion: 1,
  },
  definition: googleSheetsSinkAdapter,
  catalog: {
    type: SHEETS_SINK_TYPE,
    kind: "sink",
    label: "Google Sheets export",
    credentialFields: [
      { name: "clientId", label: "Google OAuth client ID", secret: false, required: true },
      { name: "clientSecret", label: "Google OAuth client secret", secret: true, required: true },
      { name: "refreshToken", label: "Google OAuth refresh token", secret: true, required: true },
      { name: "spreadsheetId", label: "Existing spreadsheet ID (optional)", secret: false, required: false },
    ],
  },
});
