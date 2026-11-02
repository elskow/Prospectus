const { chromium } = require("patchright");

const PROTOCOL_VERSION = 1;

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

function textOf(node) {
  return (node ? node.innerText || node.textContent : "") || "";
}

function extractCompaniesFromSearch(page) {
  return page.evaluate(() => {
    const seen = new Set();
    const artifacts = [];

    const entities = [
      ...document.querySelectorAll(
        "div.entity-result, div.reusable-search__result-container, .app-entity-typeahead__result, li.reusable-search__result-container",
      ),
    ];

    for (const entity of entities) {
      const nameNode =
        entity.querySelector(".entity-result__title-text a span[aria-hidden='true']") ||
        entity.querySelector(".entity-result__title-text a") ||
        entity.querySelector("a[href*='/company/'] span") ||
        entity.querySelector("a[href*='/school/'] span");

      const linkNode = entity.querySelector("a[href*='/company/'], a[href*='/school/']");

      if (!nameNode || !linkNode) continue;

      const name = (nameNode.innerText || nameNode.textContent || "").trim();
      if (!name || seen.has(name)) continue;
      seen.add(name);

      const subtitle = textOf(entity.querySelector(".entity-result__primary-subtitle")).trim();
      const metadata = textOf(entity.querySelector(".entity-result__secondary-subtitle")).trim();

      const city = metadata ? metadata.split(",")[0].trim() : subtitle ? subtitle.split("·")[0].trim() : null;
      const category = subtitle ? subtitle.split("·")[0].trim() : null;

      artifacts.push({
        name,
        website: null,
        city: city || null,
        category: category || null,
        sourceUrl: linkNode.href.split("?")[0],
        contacts: [],
      });
    }

    return artifacts;
  });
}

function extractPeopleFromSearch(page) {
  return page.evaluate(() => {
    const seen = new Set();
    const contacts = [];

    const entities = [...document.querySelectorAll("div.entity-result, li.reusable-search__result-container")];

    for (const entity of entities) {
      const link = entity.querySelector("a[href*='/in/']");

      if (!link) continue;

      const nameNode =
        entity.querySelector(".entity-result__title-text a span[aria-hidden='true']") ||
        entity.querySelector(".entity-result__title-text a") ||
        entity.querySelector("a[href*='/in/'] span");

      const name = (nameNode ? nameNode.innerText || nameNode.textContent : "").trim();
      const href = link.href.split("?")[0];

      if (!name || seen.has(href)) continue;
      seen.add(href);

      const title = textOf(entity.querySelector(".entity-result__primary-subtitle")).trim() || null;
      const city = textOf(entity.querySelector(".entity-result__secondary-subtitle")).trim() || null;

      contacts.push({
        name,
        title,
        city,
        linkedinUrl: href,
        isDecisionMaker: null,
      });
    }

    return contacts;
  });
}

async function isSignedIn(page) {
  await page.goto("https://www.linkedin.com/", { waitUntil: "domcontentloaded", timeout: 45000 }).catch(() => {});
  const url = page.url();
  return !/login|signin|authwall/.test(url);
}

const DECISION_MAKER_RE = /\b(owner|founder|ceo|director|manager|co-?founder|pemilik|direktur|komisaris)\b/i;

function extractPeopleFromCompanyPeopleTab(page) {
  return page.evaluate(() => {
    const seen = new Set();
    const people = [];

    const links = [...document.querySelectorAll("a[href*='/in/']")];

    for (const link of links) {
      const href = link.href.split("?")[0];
      if (!href || seen.has(href)) continue;

      let container = link.closest("li") || link.closest("div[data-view-name]") || link.parentElement;
      for (let depth = 0; depth < 3 && container && !container.querySelector("span, p"); depth += 1) {
        container = container.parentElement;
      }
      if (!container) continue;

      const nameNode = link.querySelector("span[aria-hidden='true']") || link;
      const name = (nameNode.innerText || nameNode.textContent || "").split("\n")[0].trim();
      if (!name || name.length < 2) continue;
      seen.add(href);

      const titleNode = container.querySelector(".entity-result__primary-subtitle, .t-14.t-black.t-normal, p");
      const title = titleNode ? (titleNode.innerText || titleNode.textContent || "").split("\n")[0].trim() : "";

      people.push({
        name,
        title: title || null,
        city: null,
        linkedinUrl: href,
        isDecisionMaker: title ? DECISION_MAKER_RE.test(title) : null,
      });
    }

    return people;
  });
}

async function handleDiscoverCompanyPeople(page, payload) {
  const { companyUrl, maxResults = 8 } = payload;
  const warnings = [];

  const signedIn = await isSignedIn(page);
  if (!signedIn) {
    const error = new Error("linkedin session invalid or expired: set a valid li_at session cookie in credentials");
    error.transient = false;
    throw error;
  }

  const slugMatch = /linkedin\.com\/company\/([^/?#]+)/.exec(companyUrl);
  if (!slugMatch) {
    const error = new Error(`not a linkedin company url: ${companyUrl}`);
    error.transient = false;
    throw error;
  }

  const peopleUrl = `https://www.linkedin.com/company/${slugMatch[1]}/people/`;
  await page.goto(peopleUrl, { waitUntil: "domcontentloaded", timeout: 60000 }).catch(() => {});
  await page.waitForTimeout(2500);

  const afterLoginGate = page.url();
  if (/login|signin|authwall/.test(afterLoginGate)) {
    const error = new Error(`people tab redirected to login gate: ${afterLoginGate}`);
    error.transient = true;
    throw error;
  }

  let people = await extractPeopleFromCompanyPeopleTab(page);
  warnings.push(`people tab found ${people.length} people for ${slugMatch[1]}`);

  if (people.length === 0) {
    await page.waitForTimeout(3500);
    people = await extractPeopleFromCompanyPeopleTab(page);
    warnings.push(`retry after settle found ${people.length} people`);
  }

  const seen = new Set();
  const merged = [];
  for (const person of people) {
    if (seen.has(person.linkedinUrl)) continue;
    seen.add(person.linkedinUrl);
    merged.push(person);
  }

  merged.sort((a, b) => Number(b.isDecisionMaker ?? false) - Number(a.isDecisionMaker ?? false));

  return {
    companyName: slugMatch[1],
    city: null,
    people: merged.slice(0, maxResults),
    sourceUrl: peopleUrl,
    warnings,
    schemaVersion: 1,
  };
}

async function handleDiscoverPeople(page, payload) {
  const { companyName, city, maxResults = 5 } = payload;
  const warnings = [];

  const signedIn = await isSignedIn(page);

  if (!signedIn) {
    const error = new Error("linkedin session invalid or expired: set a valid li_at session cookie in credentials");
    error.transient = false;
    throw error;
  }

  const base = city ? `${companyName} ${city}` : companyName;
  let peopleUrl = `https://www.linkedin.com/search/results/people/?keywords=${encodeURIComponent(base + " founder OR owner OR CEO OR direktur OR pemilik")}`;
  const extract = async (keywords) => {
    peopleUrl = `https://www.linkedin.com/search/results/people/?keywords=${encodeURIComponent(keywords)}`;
    await page.goto(peopleUrl, { waitUntil: "domcontentloaded", timeout: 60000 });
    await page.waitForTimeout(2500);
    return (await extractPeopleFromSearch(page)).map((person) => ({
      ...person,
      isDecisionMaker: person.title ? DECISION_MAKER_RE.test(person.title) : false,
    }));
  };

  let people = await extract(`${base} founder OR owner OR CEO OR direktur OR pemilik`);
  warnings.push(`decision-maker search found ${people.length} people for "${base}"`);

  if (people.length === 0) {
    people = await extract(base);
    warnings.push(`fallback general search found ${people.length} people for "${base}"`);
  }

  const seen = new Set();
  const merged = [];
  for (const person of people) {
    if (seen.has(person.linkedinUrl)) continue;
    seen.add(person.linkedinUrl);
    merged.push(person);
  }

  merged.sort((a, b) => Number(b.isDecisionMaker ?? false) - Number(a.isDecisionMaker ?? false));

  const selected = merged.slice(0, maxResults);

  return {
    companyName,
    city: city || null,
    people: selected,
    sourceUrl: peopleUrl,
    warnings,
    schemaVersion: 1,
  };
}

async function handleCrawl(page, payload) {
  const { query, maxResults = 20 } = payload;
  const warnings = [];

  const signedIn = await isSignedIn(page);

  if (!signedIn) {
    const error = new Error("linkedin session invalid or expired: set a valid li_at session cookie in credentials (Settings → LinkedIn)");
    error.transient = false;
    throw error;
  }

  for (const url of [
    `https://www.linkedin.com/search/results/companies/?keywords=${encodeURIComponent(query)}`,
    `https://www.linkedin.com/search/results/people/?keywords=${encodeURIComponent(query + " founder OR owner OR CEO")}`,
  ]) {
    const reachable = await page.request
      .get(url, { maxRedirects: 0 })
      .then((res) => res.status() < 300)
      .catch(() => false);
    if (!reachable) {
      const error = new Error("linkedin session invalid or expired: set a valid li_at session cookie in credentials (Settings → LinkedIn)");
      error.transient = false;
      throw error;
    }
  }

  const artifacts = [];

  const companyUrl = `https://www.linkedin.com/search/results/companies/?keywords=${encodeURIComponent(query)}`;
  await page.goto(companyUrl, { waitUntil: "domcontentloaded", timeout: 60000 });
  await page.waitForTimeout(2500);

  const companies = await extractCompaniesFromSearch(page);
  artifacts.push(...companies.slice(0, maxResults));

  const peopleUrl = `https://www.linkedin.com/search/results/people/?keywords=${encodeURIComponent(query)}%20founder%20OR%20owner%20OR%20CEO`;
  await page.goto(peopleUrl, { waitUntil: "domcontentloaded", timeout: 60000 });
  await page.waitForTimeout(2500);

  const people = await extractPeopleFromSearch(page);

  const decisionMarker = /at\s|\s@/;
  const isUnambiguous = (person, company) => {
    if (!person.title || !company.name) return false;
    if (!decisionMarker.test(person.title)) return false;
    const titleParts = person.title.split(/\s+at\s+|\s+@\s+/).map((p) => p.toLowerCase());
    const companyName = company.name.toLowerCase();
    return titleParts.length > 1 && titleParts[1] === companyName;
  };

  for (const person of people.slice(0, maxResults)) {
    const company = artifacts.find((a) => isUnambiguous(person, a));

    if (company) {
      company.contacts = company.contacts || [];
      company.contacts.push(person);
    } else {
      const companyHint =
        person.title && decisionMarker.test(person.title)
          ? person.title
              .split(/\s+at\s+|\s+@\s+/)
              .slice(1)
              .join(" at ")
              .trim() || null
          : null;

      if (companyHint) {
        artifacts.push({
          kind: "person",
          name: person.name,
          title: person.title,
          website: null,
          city: person.city,
          category: null,
          sourceUrl: person.linkedinUrl,
          companyHint,
          contacts: [person],
        });
      }
    }
  }

  warnings.push(`found ${companies.length} companies, ${people.length} people for "${query}"`);

  return {
    query,
    artifacts,
    sourceUrl: companyUrl,
    warnings,
    schemaVersion: 1,
  };
}

async function main() {
  const launchOptions = {
    headless: process.env.HEADLESS !== "false",
    proxy: parseProxyUrl(process.env.SCRAPE_PROXY_URL),
    locale: process.env.SCRAPE_LOCALE || "en-US",
    timezoneId: process.env.SCRAPE_TIMEZONE || "Asia/Jakarta",
    args: ["--disable-blink-features=AutomationControlled", "--no-first-run", "--no-default-browser-check"],
  };

  const browser = await chromium.launch(launchOptions);
  const context = await browser.newContext({
    viewport: { width: 1440, height: 900 },
  });

  if (process.env.LINKEDIN_LI_AT) {
    await context.addCookies([
      {
        name: "li_at",
        value: process.env.LINKEDIN_LI_AT,
        domain: ".linkedin.com",
        path: "/",
        httpOnly: true,
        secure: true,
        sameSite: "Lax",
      },
    ]);
  }

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

    if (method === "discover-company-people") {
      const result = await handleDiscoverCompanyPeople(page, payload);
      send({ v: PROTOCOL_VERSION, id, ok: true, result });
      return;
    }

    if (method === "crawl") {
      const result = await handleCrawl(page, payload);
      send({ v: PROTOCOL_VERSION, id, ok: true, result });
      return;
    }

    if (method === "discover-people") {
      const result = await handleDiscoverPeople(page, payload);
      send({ v: PROTOCOL_VERSION, id, ok: true, result });
      return;
    }

    sendError(id, new Error(`unknown method "${method}"`));
  } catch (error) {
    const message = String(error && error.message ? error.message : error);
    const isTransient = /timeout|net::|ERR_|429|captcha|unusual traffic/i.test(message);
    send({
      v: PROTOCOL_VERSION,
      id,
      ok: false,
      error: message,
      transient: isTransient,
    });
  }
}

main().catch((error) => {
  sendError(-1, error);
  process.exit(1);
});
