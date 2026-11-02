import type { AdapterContext, SinkAdapterDefinition, SinkLead, SinkResult } from "@src/adapters/types";
import { writeRunArtifact } from "@src/harness/artifacts";
import { serializeLeadsCsv } from "@src/plugins/builtin/csv/serialize";
import { definePlugin } from "@src/plugins/define";

export const CSV_SINK_TYPE = "sink:csv";

export const csvSinkAdapter: SinkAdapterDefinition = {
  kind: "sink",
  type: CSV_SINK_TYPE,
  label: "CSV export",
  credentials: {
    fields: [],
  },
  async write(leads: SinkLead[], ctx: AdapterContext): Promise<SinkResult> {
    const csv = serializeLeadsCsv(
      leads.map((lead) => ({
        ...lead,
      })),
    );
    if (ctx.runId) {
      await writeRunArtifact(ctx.runId, "leads.csv", csv);
    }

    return {
      written: leads.length,
      targetLocation: `runs/${ctx.runId}/leads.csv`,
      warnings: [],
    };
  },
};

export const csvPlugin = definePlugin({
  manifest: {
    name: "csv",
    description: "Writes qualified leads to a per-run CSV artifact on disk.",
    schemaVersion: 1,
  },
  definition: csvSinkAdapter,
  catalog: {
    type: CSV_SINK_TYPE,
    kind: "sink",
    label: "CSV export",
    credentialFields: [],
  },
});
