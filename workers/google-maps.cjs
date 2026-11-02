const net = require("node:net");
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

function parseArtifactsFromConsentPage(page) {
  return page.evaluate(() => {
    const anchors = [...document.querySelectorAll('a[href*="/maps/place/"]')];
    const phonePattern = /(\(?\+?62\)?[\d\s-]{7,}|\(0\d{2,3}\)\s?[\d\s-]{6,}|08\d{1,3}[\s-]\d{3,4}[\s-]\d{3,5})/;
    const seen = new Set();
    const artifacts = [];

    for (const anchor of anchors) {
      let card = anchor;
      let node = anchor.parentElement;

      while (node) {
        if (node.querySelectorAll('a[href*="/maps/place/"]').length > 1) break;
        card = node;
        node = node.parentElement;
      }

      const key = anchor.href;

      if (seen.has(key)) continue;
      seen.add(key);

      const text = card.innerText || "";
      const lines = text
        .split("\n")
        .map((l) => l.trim())
        .filter(Boolean);
      const ratingLine = lines.find((l) => /^\d[.,]\d$/.test(l));
      const reviewInline = ratingLine ? lines[lines.indexOf(ratingLine) + 1]?.match(/^(\d[\d.,]*)$/) : null;
      const metaLine = lines.find((l) => l.includes("·") && !/Closed|Opens|Open now|Closes|24 hours/i.test(l));
      const hoursLine = lines.find((l) => /Closed|Opens|Open now|Closes|24 hours/i.test(l));
      const phoneMatch = text.match(phonePattern);
      const websiteAnchor = card.querySelector('a[data-value="Website"], a[aria-label="Website"], a[aria-label="Website page"]');
      const rawWebsite = websiteAnchor instanceof HTMLAnchorElement ? websiteAnchor.href : null;
      const website = rawWebsite ? rawWebsite.split(/\s+/)[0] : null;
      const metaParts = metaLine
        ? metaLine
            .split("·")
            .map((p) => p.trim())
            .filter((p) => p.length > 0)
        : [];

      const metaSet = new Set(metaParts);
      artifacts.push({
        name:
          lines.find(
            (l) => l.length > 1 && !/^(Results|Share|Directions|Website|Order online|Save|Nearby|Sponsored)$/.test(l) && !/^\d\.\d$/.test(l) && !metaSet.has(l),
          ) ||
          anchor.getAttribute("aria-label") ||
          "",
        address: metaParts.length > 1 ? metaParts[metaParts.length - 1] : null,
        phone: phoneMatch ? phoneMatch[1].trim() : null,
        website: website,
        city: null,
        category: metaParts[0] ?? null,
        rating: ratingLine ? Number(ratingLine.replace(",", ".")) : null,
        reviewCount: reviewInline ? Number(reviewInline[1].replace(/[.,]/g, "")) : null,
        sourceUrl: anchor.href,
        hours: hoursLine ?? null,
      });
    }

    return artifacts;
  });
}

async function scrollToFeedEnd(page, maxScrolls) {
  await page.evaluate(async (limit) => {
    const feed = document.querySelector('div[role="feed"]');
    if (!feed) return;
    let scrolls = 0;
    let lastHeight = 0;

    while (scrolls < limit) {
      feed.scrollBy(0, 2000);
      await new Promise((r) => setTimeout(r, 800));

      if (feed.scrollHeight === lastHeight) break;

      lastHeight = feed.scrollHeight;
      scrolls += 1;
    }
  }, maxScrolls);
}

async function handleCrawl(page, payload) {
  const { query, maxResults, maxScrolls, viewport } = payload;
  const viewportPart =
    viewport && Number.isFinite(viewport.lat) && Number.isFinite(viewport.lng) ? `/@${viewport.lat},${viewport.lng},${viewport.zoom || 14}z` : "";
  const url = `https://www.google.com/maps/search/${encodeURIComponent(query)}${viewportPart}?hl=en`;
  await page.goto(url, { waitUntil: "domcontentloaded", timeout: 45000 });
  await page.waitForTimeout(2500);

  const consentButton = await page.$('button:has-text("Accept all"), button[aria-label*="Accept"]');
  if (consentButton) {
    await consentButton.click();
    await page.waitForTimeout(2000);
  }

  await page.waitForURL(/\/maps\/place\//, { timeout: 8000 }).catch(() => {});

  if (page.url().includes("/maps/place/")) {
    const detail = await page.evaluate(() => {
      const body = document.body.innerText || "";
      const chip = body.match(/(\d)[.,](\d)\s*\((\d[\d.,]*)\)/);
      const name = body.match(/\n([^\n]{2,80})\n\d[.,]\d\s*\(/)?.[1] ?? null;
      const websiteAnchor = document.querySelector(
        'a[data-item-id="authority"], a[data-value="Website"], a[aria-label="Website"], a[aria-label="Website page"]',
      );
      const address = document.querySelector('button[data-item-id="address"]')?.textContent ?? null;
      return {
        name: name?.trim() ?? null,
        rating: chip ? Number(`${chip[1]}.${chip[2]}`) : null,
        reviewCount: chip ? Number(chip[3].replace(/[.,]/g, "")) : null,
        website: websiteAnchor instanceof HTMLAnchorElement ? websiteAnchor.href : null,
        address: address ? address.trim() : null,
      };
    });
    const artifacts = detail.name
      ? [
          {
            name: detail.name,
            rating: detail.rating,
            reviewCount: detail.reviewCount,
            website: detail.website && !/google\./.test(detail.website) ? detail.website : null,
            address: detail.address,
            sourceUrl: page.url(),
          },
        ]
      : [];
    return { query, artifacts, sourceUrl: url, warnings: artifacts.length === 0 ? ["place page rendered without extractable data"] : [] };
  }

  await page.waitForSelector('a[href*="/maps/place/"]', { timeout: 20000 });
  await scrollToFeedEnd(page, Math.min(maxScrolls || 15, Math.ceil((maxResults || 40) / 8)));

  const artifacts = await parseArtifactsFromConsentPage(page);
  return {
    query,
    artifacts: artifacts.slice(0, maxResults || 40),
    sourceUrl: url,
    warnings: [],
  };
}

async function handleResolveWebsite(page, payload) {
  const { placeUrl } = payload;
  await page.goto(placeUrl, { waitUntil: "domcontentloaded", timeout: 45000 });
  await page.waitForTimeout(2000);

  const consentButton = await page.$('button:has-text("Accept all"), button[aria-label*="Accept"]');
  if (consentButton) {
    await consentButton.click();
    await page.waitForTimeout(2000);
  }

  return page.evaluate(() => {
    const websiteAnchor = document.querySelector('a[data-item-id="authority"], a[data-value="Website"], a[aria-label="Website"], a[aria-label="Website page"]');

    const externalLinks =
      websiteAnchor instanceof HTMLAnchorElement
        ? [websiteAnchor.href]
        : [...document.querySelectorAll('a[href^="http"]')].map((a) => a.href).filter((href) => !/google\.|gstatic\.|googleapis\./.test(href));
    const addressText = document.querySelector('button[data-item-id="address"]')?.textContent ?? null;
    const bodyText = document.body.innerText || "";
    const ratingMatch = bodyText.match(/(\d)[.,](\d)\s*\((\d[\d.,]*)\)/);
    const reviewMatch = bodyText.match(/\((\d[\d.,]*)\)\s*(?:ulasan|reviews?)|ulasan\s*(\d[\d.,]*)|reviews?\s*(\d[\d.,]*)/i);

    return {
      website: externalLinks[0]?.split(/\s+/)[0] ?? null,
      address: addressText ? addressText.trim() : null,
      rating: ratingMatch ? Number(`${ratingMatch[1]}.${ratingMatch[2]}`) : null,
      reviewCount: (() => {
        const raw = ratingMatch?.[3] ?? reviewMatch?.[1] ?? reviewMatch?.[2] ?? reviewMatch?.[3];
        if (!raw) return null;
        const digits = raw.replace(/[.,]/g, "");
        const n = Number(digits);
        return Number.isFinite(n) ? n : null;
      })(),
    };
  });
}

async function main() {
  const sessions = new Map();

  async function createSession(proxyUrl) {
    const launchOptions = {
      headless: process.env.HEADLESS !== "false",
      proxy: parseProxyUrl(proxyUrl),
      locale: process.env.SCRAPE_LOCALE || "en-US",
      timezoneId: process.env.SCRAPE_TIMEZONE || "Asia/Jakarta",
      args: ["--disable-blink-features=AutomationControlled", "--no-first-run", "--no-default-browser-check"],
    };

    const browser = await chromium.launch(launchOptions);
    const context = await browser.newContext({
      viewport: { width: 1440, height: 900 },
      userAgent: "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/126.0.0.0 Safari/537.36",
    });
    if (process.env.SCRAPE_BLOCK_ASSETS !== "false") {
      await context.route("**/*", (route) => {
        const type = route.request().resourceType();
        if (type === "image" || type === "media" || type === "font" || type === "stylesheet") {
          return route.abort();
        }
        return route.continue();
      });
    }
    const page = await context.newPage();
    return { browser, page, queue: Promise.resolve(), lastUsed: Date.now(), busy: 0 };
  }

  const pendingSessions = new Map();

  async function getSession(proxyUrl) {
    const key = proxyUrl || "";
    if (!sessions.has(key)) {
      if (!pendingSessions.has(key)) {
        pendingSessions.set(
          key,
          createSession(key)
            .then((session) => {
              sessions.set(key, session);
              pendingSessions.delete(key);
              return session;
            })
            .catch((error) => {
              pendingSessions.delete(key);
              throw error;
            }),
        );
      }
      await pendingSessions.get(key);
    }
    return { key, session: sessions.get(key) };
  }

  async function dispatch(proxyUrl, line, emit) {
    const { session } = await getSession(proxyUrl);
    session.busy += 1;
    session.queue = session.queue.then(() => handleMessage(session.page, line, emit)).catch(() => {});
    try {
      await session.queue;
    } finally {
      session.busy = Math.max(0, session.busy - 1);
      session.lastUsed = Date.now();
    }
  }

  const idleMs = Number(process.env.MAPS_DAEMON_IDLE_MS || 10 * 60_000);
  const idleTimer = setInterval(() => {
    for (const [key, session] of sessions) {
      if (session.busy > 0 || Date.now() - session.lastUsed < idleMs) continue;
      sessions.delete(key);
      void session.browser.close().catch(() => {});
    }
  }, 60_000);
  idleTimer.unref?.();

  const shutdown = async () => {
    for (const session of sessions.values()) {
      await session.browser.close().catch(() => {});
    }
    process.exit(0);
  };

  process.on("SIGTERM", shutdown);
  process.on("SIGINT", shutdown);

  const daemonPort = Number(process.env.MAPS_DAEMON_PORT || 0);

  if (daemonPort > 0) {
    const server = net.createServer((socket) => {
      socket.setEncoding("utf8");
      let pending = "";
      socket.on("data", (chunk) => {
        pending += chunk;
        let index;
        while ((index = pending.indexOf("\n")) >= 0) {
          const line = pending.slice(0, index).trim();
          pending = pending.slice(index + 1);
          if (!line) continue;
          const emit = (message) => {
            if (!socket.destroyed) socket.write(JSON.stringify(message) + "\n");
          };
          let proxyUrl = process.env.SCRAPE_PROXY_URL || "";
          try {
            const parsed = JSON.parse(line);
            if (parsed && parsed.payload && typeof parsed.payload.proxyUrl === "string") proxyUrl = parsed.payload.proxyUrl;
          } catch {}
          dispatch(proxyUrl, line, emit).catch((error) => {
            emit({ v: PROTOCOL_VERSION, id: -1, ok: false, error: String(error && error.message ? error.message : error), transient: false });
          });
        }
      });
    });

    await new Promise((resolve, reject) => {
      server.once("error", reject);
      server.listen(daemonPort, "127.0.0.1", resolve);
    });

    send({
      v: PROTOCOL_VERSION,
      id: "__ready__",
      ok: true,
      result: { ready: true, pid: process.pid, daemon: `127.0.0.1:${daemonPort}` },
    });
    return;
  }

  await getSession(process.env.SCRAPE_PROXY_URL || "");

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
      dispatch(process.env.SCRAPE_PROXY_URL || "", line, send).catch((error) => {
        sendError(-1, error);
      });
    }
  });

  process.stdin.on("end", shutdown);
}

async function handleMessage(page, line, emit) {
  let request;
  try {
    request = JSON.parse(line);
  } catch {
    emit({ v: PROTOCOL_VERSION, id: -1, ok: false, error: "malformed NDJSON line", transient: false });
    return;
  }

  const { id, method, payload } = request;
  try {
    if (method === "ping") {
      emit({ v: PROTOCOL_VERSION, id, ok: true, result: { pong: true } });
      return;
    }

    if (method === "crawl") {
      const result = await handleCrawl(page, payload);
      emit({ v: PROTOCOL_VERSION, id, ok: true, result });
      return;
    }

    if (method === "resolve-website") {
      const result = await handleResolveWebsite(page, payload);
      emit({ v: PROTOCOL_VERSION, id, ok: true, result });
      return;
    }

    emit({ v: PROTOCOL_VERSION, id, ok: false, error: `unknown method "${method}"`, transient: false });
  } catch (error) {
    const message = String(error && error.message ? error.message : error);
    const isTransient = /timeout|net::|ERR_|429|captcha|unusual traffic/i.test(message);
    emit({
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
