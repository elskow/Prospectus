import { websiteCrawlPlugin } from "@src/plugins/builtin/website-crawl";
import { csvPlugin } from "@src/plugins/builtin/csv";
import { googleMapsPlugin } from "@src/plugins/builtin/google-maps";
import { googleSheetsPlugin } from "@src/plugins/builtin/google-sheets";
import { jobBoardsPlugin } from "@src/plugins/builtin/job-boards";
import { instagramPlugin } from "@src/plugins/builtin/instagram";
import { linkedinPlugin } from "@src/plugins/builtin/linkedin";
import { newsPlugin } from "@src/plugins/builtin/news";
import { threadsPlugin } from "@src/plugins/builtin/threads";
import { websearchPlugin } from "@src/plugins/builtin/websearch";
import { xPlugin } from "@src/plugins/builtin/x";
import type { AdapterPlugin } from "@src/plugins/define";

export function builtinPlugins(): AdapterPlugin[] {
  return [
    googleMapsPlugin,
    instagramPlugin,
    linkedinPlugin,
    xPlugin,
    threadsPlugin,
    jobBoardsPlugin,
    newsPlugin,
    websearchPlugin,
    websiteCrawlPlugin,
    googleSheetsPlugin,
    csvPlugin,
  ];
}
