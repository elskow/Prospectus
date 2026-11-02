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

async function handleCrawl(page, payload) {
  const { query, maxResults = 20 } = payload;
  const warnings = [];

  const searchUrl = `https://x.com/search?q=${encodeURIComponent(query)}&f=live`;
  await page.goto(searchUrl, { waitUntil: "domcontentloaded", timeout: 60000 });
  await page.waitForTimeout(3500);

  const authWall = await page.evaluate(() => {
    const body = document.body ? document.body.innerText : "";
    return /sign in|log in|join x/i.test(body.slice(0, 2000)) && !document.querySelector("article[data-testid='tweet']");
  });

  if (authWall) {
    const error = new Error("x requires sign-in: set valid auth_token + ct0 session cookies in credentials");
    error.transient = false;
    throw error;
  }

  const artifacts = await page.evaluate((maxResults) => {
    const seen = new Set();
    const results = [];

    const tweets = [...document.querySelectorAll("article[data-testid='tweet']")];

    for (const tweet of tweets) {
      const userLink = tweet.querySelector("a[href^='/'][href*='/status/'] > span, a[data-testid='User-Name']");
      const handleLink = tweet.querySelector("a[href^='/'][role='link']");

      if (!handleLink) continue;

      const displayNameNode = tweet.querySelector("a[data-testid='User-Name'] span");
      const handle = (handleLink.getAttribute("href") || "").split("/")[1];

      if (!handle || seen.has(handle)) continue;
      seen.add(handle);

      const bio =
        tweet.querySelector("div[data-testid='tweetText']") && tweet.querySelector("div[data-testid='tweetText']").innerText
          ? tweet.querySelector("div[data-testid='tweetText']").innerText.trim()
          : null;

      const name = displayNameNode ? displayNameNode.innerText.trim() : `@${handle}`;

      const isBusiness = /shop|store|official|company|studio|co\.|cafe|roastery|supplier|jasa|toko/i.test(name + " " + (bio || ""));

      results.push({
        name,
        website: null,
        city: null,
        category: isBusiness ? "x-business" : null,
        sourceUrl: `https://x.com/${handle}`,
        socialHandle: `@${handle}`,
        contacts: [],
      });

      if (results.length >= maxResults) break;
    }

    return results;
  }, maxResults);

  warnings.push(`found ${artifacts.length} x accounts for "${query}"`);

  return {
    query,
    artifacts,
    sourceUrl: searchUrl,
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

  if (process.env.X_AUTH_TOKEN && process.env.X_CT0) {
    await context.addCookies([
      {
        name: "auth_token",
        value: process.env.X_AUTH_TOKEN,
        domain: ".x.com",
        path: "/",
        httpOnly: true,
        secure: true,
        sameSite: "None",
      },
      {
        name: "ct0",
        value: process.env.X_CT0,
        domain: ".x.com",
        path: "/",
        httpOnly: false,
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

    if (method === "crawl") {
      const result = await handleCrawl(page, payload);
      send({ v: PROTOCOL_VERSION, id, ok: true, result });
      return;
    }

    sendError(id, new Error(`unknown method "${method}"`));
  } catch (error) {
    const message = String(error && error.message ? error.message : error);
    const isTransient = /timeout|net::|ERR_|429|rate limit/i.test(message);
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
