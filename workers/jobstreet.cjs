const { chromium } = require("patchright");

const PROTOCOL_VERSION = 1;
const NAV_TIMEOUT_MS = 60000;
const RESULTS_WAIT_MS = 15000;
const HR_RE = /\b(hr|human resource|people|recruit|hrd|hris|payroll)\b/i;

function send(message) {
  process.stdout.write(JSON.stringify(message) + "\n");
}

function sendError(id, error, transient) {
  send({
    v: PROTOCOL_VERSION,
    id,
    ok: false,
    error: String(error && error.message ? error.message : error),
    transient: transient ?? false,
  });
}

function parseProxyUrl(raw) {
  if (!raw) return undefined;
  const parsed = new URL(raw);

  if (!parsed.username && !parsed.password) return { server: raw };

  return {
    server: `${parsed.protocol}//${parsed.hostname}:${parsed.port}`,
    username: decodeURIComponent(parsed.username),
    password: decodeURIComponent(parsed.password),
  };
}

function blockError(board, detail) {
  const error = new Error(`${board} blocked by bot detection: ${detail}`);
  error.transient = true;
  return error;
}

function looksBlocked(html) {
  return /just a moment|attention required|cf-browser-verification|cf-challenge|captcha|are you a robot|access denied|pardon our interruption/i.test(
    html.slice(0, 8000),
  );
}

function parseCountText(text) {
  const match = String(text || "").match(/[\d][\d.,\s]*/);
  if (!match) return null;
  const digits = match[0].replace(/[^\d]/g, "");
  return digits ? Number(digits) : null;
}

async function tryJobstreet(page, query, location) {
  const params = new URLSearchParams({ keywords: query });
  if (location) params.set("location", location);
  const url = `https://id.jobstreet.com/id/jobs?${params.toString()}`;

  const response = await page.goto(url, { waitUntil: "domcontentloaded", timeout: NAV_TIMEOUT_MS });
  if (response && response.status() >= 400) {
    throw blockError("jobstreet", `HTTP ${response.status()} on search page`);
  }

  await page.waitForTimeout(2500);

  const html = await page.content();
  if (looksBlocked(html)) {
    throw blockError("jobstreet", "challenge page detected");
  }

  try {
    await page.waitForSelector('[data-automation="jobTitle"], [data-automation="totalJobsCount"], article[data-automation="jobCard"]', {
      timeout: RESULTS_WAIT_MS,
    });
  } catch {
    throw blockError("jobstreet", `no results selector within ${RESULTS_WAIT_MS}ms`);
  }

  const data = await page.evaluate(() => {
    const textOf = (node) => (node ? node.innerText || node.textContent : "") || "";

    let totalResultCount = null;
    const countText = textOf(document.querySelector('[data-automation="totalJobsCount"]')).trim();
    if (countText) {
      const match = countText.match(/[\d][\d.,\s]*/);
      if (match) {
        const digits = match[0].replace(/[^\d]/g, "");
        if (digits) totalResultCount = Number(digits);
      }
    }

    const roles = [];
    const seen = new Set();
    const cards = [...document.querySelectorAll('article[data-automation="jobCard"], [data-automation="jobListing"] article, article')];

    for (const card of cards) {
      const titleNode = card.querySelector('[data-automation="jobTitle"]') || card.querySelector("h1 a, h2 a, h3 a, [data-automation='jobTitle'] a");

      if (!titleNode) continue;

      const title = textOf(titleNode).trim();
      if (!title || seen.has(title)) continue;
      seen.add(title);

      const company = textOf(card.querySelector('[data-automation="jobCompany"]')).trim() || null;
      const jobLocation = textOf(card.querySelector('[data-automation="jobLocation"]')).trim() || null;

      roles.push({ title, company, location: jobLocation });
    }

    return { totalResultCount, roles };
  });

  if (!data.roles.length) {
    throw blockError("jobstreet", "page loaded but no roles extracted");
  }

  return {
    board: "jobstreet",
    totalResultCount: data.totalResultCount ?? data.roles.length,
    roles: data.roles,
    url,
  };
}

async function tryGlints(page, query) {
  const url = `https://glints.com/id/explore?keywords=${encodeURIComponent(query)}`;

  const response = await page.goto(url, { waitUntil: "domcontentloaded", timeout: NAV_TIMEOUT_MS });
  if (response && response.status() >= 400) {
    throw blockError("glints", `HTTP ${response.status()} on search page`);
  }

  await page.waitForTimeout(2500);

  const data = await page.evaluate(() => {
    const script = document.querySelector("script#__NEXT_DATA__");

    if (!script) return { blocked: true };

    let parsed;
    try {
      parsed = JSON.parse(script.textContent);
    } catch {
      return { blocked: true };
    }

    const cache = parsed && parsed.props && parsed.props.apolloCache;
    const rootQuery = cache && cache.ROOT_QUERY;
    if (!rootQuery) return { blocked: true };

    const queryKey = Object.keys(rootQuery).find((key) => key.startsWith("searchJobsV3"));
    if (!queryKey) return { blocked: true };

    const entry = rootQuery[queryKey];
    const refs = (entry && entry.jobsInPage) || [];

    const jobs = [];
    for (const ref of refs) {
      const job = cache[ref && ref.__ref];
      if (!job) continue;

      const companyRef = job.company && cache[job.company.__ref];
      const locationRef = job.location && cache[job.location.__ref];

      jobs.push({
        title: (job.title || "").trim(),
        company: (companyRef && (companyRef.name || companyRef.brandName)) || null,
        location: (locationRef && (locationRef.formattedName || locationRef.name)) || job.city || null,
      });
    }

    return { blocked: false, jobs, hasMore: Boolean(entry && entry.hasMore) };
  });

  if (data.blocked) {
    throw blockError("glints", "no job search data in page payload");
  }

  const headerCount = await page.evaluate(() => {
    for (const heading of document.querySelectorAll("h1, h2")) {
      const match = (heading.innerText || "").match(/([\d][\d.,\s]*)\s*(?:lowongan|jobs?)/i);
      if (match) {
        const digits = match[1].replace(/[^\d]/g, "");
        if (digits) return Number(digits);
      }
    }
    return null;
  });

  const roles = data.jobs.filter((job) => job.title);

  if (!roles.length) {
    throw blockError("glints", "search data present but zero roles");
  }

  return {
    board: "glints",
    totalResultCount: headerCount ?? roles.length,
    roles,
    url,
  };
}

async function handleSearch(page, payload) {
  const { query, location = null } = payload || {};

  if (!query || !String(query).trim()) {
    const error = new Error("query is required");
    error.transient = false;
    throw error;
  }

  const warnings = [];
  let result;

  try {
    result = await tryJobstreet(page, String(query).trim(), location ? String(location).trim() : null);
  } catch (jobstreetError) {
    warnings.push(`jobstreet: ${jobstreetError.message}`);
    result = await tryGlints(page, String(query).trim());
  }

  return {
    board: result.board,
    totalResultCount: result.totalResultCount,
    firstPageRoles: result.roles.slice(0, 10),
    hrRelevantCount: result.roles.filter((role) => HR_RE.test(role.title)).length,
    sourceUrl: result.url,
    warnings,
    schemaVersion: 1,
  };
}

async function handleMessage(page, line) {
  let request;
  try {
    request = JSON.parse(line);
  } catch {
    sendError(-1, new Error("malformed NDJSON line"));
    return;
  }

  const { id, method, payload } = request;
  try {
    if (method === "ping") {
      send({ v: PROTOCOL_VERSION, id, ok: true, result: { pong: true } });
      return;
    }

    if (method === "search") {
      const result = await handleSearch(page, payload);
      send({ v: PROTOCOL_VERSION, id, ok: true, result });
      return;
    }

    sendError(id, new Error(`unknown method "${method}"`));
  } catch (error) {
    send({
      v: PROTOCOL_VERSION,
      id,
      ok: false,
      error: String(error && error.message ? error.message : error),
      transient: error ? (error.transient ?? /timeout|net::|ERR_|429|captcha|unusual traffic/i.test(String(error.message || error))) : false,
    });
  }
}

async function main() {
  const launchOptions = {
    headless: process.env.HEADLESS !== "false",
    proxy: parseProxyUrl(process.env.SCRAPE_PROXY_URL),
    locale: process.env.SCRAPE_LOCALE || "id-ID",
    timezoneId: process.env.SCRAPE_TIMEZONE || "Asia/Jakarta",
    args: ["--disable-blink-features=AutomationControlled", "--no-first-run", "--no-default-browser-check"],
  };

  const browser = await chromium.launch(launchOptions);
  const context = await browser.newContext({
    viewport: { width: 1440, height: 900 },
  });

  const page = await context.newPage();

  const shutdown = async () => {
    await browser.close().catch(() => {});
    process.exit(0);
  };

  process.on("SIGTERM", shutdown);
  process.on("SIGINT", shutdown);

  send({
    v: PROTOCOL_VERSION,
    id: "__ready__",
    ok: true,
    result: { ready: true, pid: process.pid },
  });

  let buffer = "";
  process.stdin.setEncoding("utf8");

  process.stdin.on("data", (chunk) => {
    buffer += chunk;
    let newlineIndex;
    while ((newlineIndex = buffer.indexOf("\n")) >= 0) {
      const line = buffer.slice(0, newlineIndex).trim();
      buffer = buffer.slice(newlineIndex + 1);

      if (!line) continue;

      handleMessage(page, line).catch((error) => {
        sendError(-1, error);
      });
    }
  });

  process.stdin.on("end", shutdown);
}

main().catch((error) => {
  process.stderr.write(
    JSON.stringify({
      level: "fatal",
      worker: "jobstreet",
      error: String(error && error.message ? error.message : error),
    }) + "\n",
  );
  sendError(-1, error);
  process.exit(1);
});
