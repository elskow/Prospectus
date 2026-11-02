import type { ProspectusConfig } from "./src/adapters/registry";

export const prospectusConfig: ProspectusConfig = {
  adapters: [
    { type: "source:google-maps", enabled: true },
    { type: "source:linkedin", enabled: true },
    { type: "source:x", enabled: true },
    { type: "source:threads", enabled: true },
    { type: "source:job-boards", enabled: true },
    { type: "source:websearch", enabled: true },
    { type: "source:website-crawl", enabled: true },
    { type: "sink:google-sheets", enabled: true },
    { type: "sink:csv", enabled: true },
  ],
};
