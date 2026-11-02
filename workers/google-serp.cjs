const { chromium } = require("patchright");

const PROTOCOL_VERSION = 1;

function send(message) {
  process.stdout.write(JSON.stringify(message) + "\n");
}

function sendError(id, error) {
  send({
    v: PROTOCOL_VERSION,
    id,
    ok: false,
    error: String(error && error.message ? error.message : error),
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

function extractResults() {
  const seen = new Set();
  const results = [];
  const anchors = [...document.querySelectorAll("a[href]")];
  for (const anchor of anchors) {
    const href = anchor.href;
    if (!/^https?:\/\//.test(href)) continue;
    if (href.includes("google.") || href.includes("gstatic.") || href.includes("googleusercontent.")) continue;
    if (href.startsWith("https://www.google.com/search?")) continue;
    if (seen.has(href)) continue;
    const container = anchor.closest("div[data-hveid], div.g, div[data-sokoban-container], h3")?.parentElement ?? anchor;
    const titleEl = anchor.querySelector("h3") ?? (anchor.querySelector("h3") ? null : document.querySelector(`a[href="${CSS.escape(href)}"] h3`));
    const title = (titleEl?.textContent ?? anchor.textContent ?? "").trim();
    if (!title || title.length < 2) continue;
    const snippet = container.innerText
      ? container.innerText
          .split("\n")
          .map((l) => l.trim())
          .filter(Boolean)
          .slice(1, 4)
          .join(" ")
          .slice(0, 300)
      : "";
    seen.add(href);
    results.push({ title, url: href, snippet: snippet || null });
    if (results.length >= 15) break;
  }
  return results;
}

async function handleSearch(page, payload) {
  const query = String(payload?.query ?? "").trim();
  if (!query) throw new Error("query is required");
  const limit = Math.min(Number(payload?.limit) || 10, 20);
  const url = `https://www.google.com/search?q=${encodeURIComponent(query)}&num=${Math.max(limit, 10)}&hl=id&gl=id&pws=0`;

  await page.goto(url, { waitUntil: "domcontentloaded", timeout: 45_000 });
  if (page.url().includes("/sorry/") || (await page.title()).match(/unusual traffic|are you a robot/i)) {
    throw new Error("google captcha wall (sorry page)");
  }

  const results = await page.evaluate(extractResults);

  if (results.length === 0) {
    await page.waitForTimeout(2_500);
    return { results: await page.evaluate(extractResults), warnings: ["late-render retry"] };
  }
  return { results: results.slice(0, limit), warnings: [] };
}

async function main() {
  const launchOptions = {
    headless: process.env.HEADLESS !== "false",
    proxy: parseProxyUrl(process.env.SERP_PROXY_URL),
    locale: process.env.SCRAPE_LOCALE || "id-ID",
    timezoneId: process.env.SCRAPE_TIMEZONE || "Asia/Jakarta",
    args: ["--disable-blink-features=AutomationControlled", "--no-first-run", "--no-default-browser-check"],
  };

  const browser = await chromium.launch(launchOptions);
  const context = await browser.newContext({
    viewport: { width: 1440, height: 900 },
    userAgent: "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/126.0.0.0 Safari/537.36",
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
    const message = String(error && error.message ? error.message : error);
    const isTransient = /timeout|net::|ERR_|429|captcha|unusual traffic/i.test(message);
    send({ v: PROTOCOL_VERSION, id, ok: false, error: message, transient: isTransient });
  }
}

main().catch((error) => {
  sendError(-1, error);
  process.exit(1);
});
