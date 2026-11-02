const PROTOCOL_VERSION = 1;

function send(obj) {
  process.stdout.write(`${JSON.stringify(obj)}\n`);
}

function sendError(id, error) {
  const message = String(error && error.message ? error.message : error);
  send({
    v: PROTOCOL_VERSION,
    id,
    ok: false,
    error: message,
    transient: /timeout|net::|ERR_|429|rate limit/i.test(message),
  });
}

const WA_RE = /(?:\+62|62|0)\s?8\d{1,3}[\s.-]?\d{3,4}[\s.-]?\d{3,5}/g;
const EMAIL_RE = /[a-z0-9._%+-]+@[a-z0-9.-]+\.[a-z]{2,}/gi;

async function searchHandles(query, maxResults) {
  const res = await fetch("https://lite.duckduckgo.com/lite/", {
    method: "POST",
    headers: { "content-type": "application/x-www-form-urlencoded", "user-agent": "Mozilla/5.0" },
    body: `q=${encodeURIComponent(`"${query}" site:instagram.com`)}`,
  });
  if (!res.ok) throw new Error(`ddg lite ${res.status}`);
  const html = await res.text();
  const handles = [];
  for (const m of html.matchAll(/href="([^"]+)"/g)) {
    const match = m[1].match(/instagram\.com\/([A-Za-z0-9._]+)\/?$/);
    if (match && !/^(p|reel|explore|tv|stories|accounts)$/.test(match[1])) handles.push(match[1]);
    if (handles.length >= maxResults) break;
  }
  return [...new Set(handles)];
}

async function handleCrawl(browser, payload) {
  const { query, maxResults = 5 } = payload;
  const warnings = [];
  const artifacts = [];

  const handles = await searchHandles(query, maxResults);
  if (handles.length === 0) {
    warnings.push(`no instagram profiles found for "${query}"`);
    return { query, artifacts, warnings, schemaVersion: 1 };
  }

  for (const handle of handles) {
    try {
      let profile = null;
      for (let attempt = 0; attempt < 3; attempt += 1) {
        const context = await browser.newContext({
          userAgent: "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/126.0.0.0 Safari/537.36",
          locale: process.env.SCRAPE_LOCALE || "id-ID",
        });
        const profilePage = await context.newPage();
        try {
          await profilePage.goto(`https://www.instagram.com/${handle}/`, { waitUntil: "domcontentloaded", timeout: 45000 });
          await profilePage.waitForTimeout(3000 + attempt * 2500);
          profile = await profilePage.evaluate(() => {
            const text = (document.body.innerText || "").slice(0, 2500);
            const headerLink = [...document.querySelectorAll("header a[href^='http'], main a[href^='http']")]
              .map((a) => a.getAttribute("href"))
              .find((h) => h && !h.includes("instagram.com") && !h.includes("threads."));
            const headline = text.split("\n").slice(0, 14).join(" | ");
            return { text: headline, external: headerLink };
          });
          const walled =
            /Login ke Instagram|Log into Instagram|Masuk.*Daftar/.test(profile.text.split(" | ").slice(0, 2).join(" ")) &&
            !/pengikut|followers/i.test(profile.text);
          if (!walled) break;
        } finally {
          await context.close().catch(() => {});
        }
      }

      if (!profile || !/pengikut|followers|@[A-Za-z0-9._]/.test(profile.text)) {
        warnings.push(`instagram profile "${handle}" login-walled`);
        continue;
      }

      const bio = profile.text;
      const phones = [...new Set(bio.match(WA_RE) ?? [])];
      const emails = [...new Set((bio.match(EMAIL_RE) ?? []).map((e) => e.toLowerCase()))];
      const followerMatch = bio.match(/([\d,.]+\s?[KMBjtr]?)\s*(?:followers|pengikut)/i) ?? bio.match(/([\d.,]+)\s*(rb|jt|[KMBjtr])\b/i);
      const segments = bio.split(" | ");
      const lower = segments.map((s) => s.trim().toLowerCase());
      const first = lower.indexOf(handle.toLowerCase());
      const second = lower.indexOf(handle.toLowerCase(), first + 1);
      const anchor = second >= 0 ? second : first;
      const name =
        anchor >= 0 && segments[anchor - 1] && !/pengikut|followers|diikuti|following|masuk|daftar|log in/i.test(segments[anchor - 1])
          ? segments[anchor - 1].trim()
          : handle;
      const bioText = anchor >= 0 ? segments.slice(anchor + 1).join(" · ") : segments.join(" · ");

      artifacts.push({
        name,
        website: profile.external ?? null,
        city: null,
        category: followerMatch ? `instagram · ${followerMatch[1]} followers` : "instagram",
        phone: phones[0] ?? null,
        snippet: bioText || profile.text,
        contacts:
          emails.length > 0 || phones.length > 0
            ? [
                {
                  name: null,
                  title: "instagram bio",
                  email: emails[0] ?? null,
                  phone: phones[0] ?? null,
                  linkedinUrl: null,
                  isDecisionMaker: null,
                },
              ]
            : null,
        sourceUrl: `https://www.instagram.com/${handle}/`,
        title: name,
      });
    } catch (error) {
      warnings.push(`instagram profile "${handle}" failed: ${String(error && error.message ? error.message : error)}`);
    }
  }

  return { query, artifacts, warnings, schemaVersion: 1 };
}

async function main() {
  const { chromium } = require("patchright");
  const browser = await chromium.launch({ headless: true });
  const context = await browser.newContext({
    userAgent: "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/126.0.0.0 Safari/537.36",
    locale: process.env.SCRAPE_LOCALE || "id-ID",
  });
  await context.close();

  send({ v: PROTOCOL_VERSION, id: "__ready__", ok: true });

  let buffer = "";
  process.stdin.setEncoding("utf8");
  process.stdin.on("data", (chunk) => {
    buffer += chunk;
    let newlineIndex;
    while ((newlineIndex = buffer.indexOf("\n")) >= 0) {
      const line = buffer.slice(0, newlineIndex).trim();
      buffer = buffer.slice(newlineIndex + 1);
      if (!line) continue;

      let request;
      try {
        request = JSON.parse(line);
      } catch {
        continue;
      }

      const { id, method, payload } = request;

      (async () => {
        try {
          if (method === "ping") {
            send({ v: PROTOCOL_VERSION, id, ok: true, result: { pong: true } });
            return;
          }

          if (method === "crawl") {
            const result = await handleCrawl(browser, payload);
            send({ v: PROTOCOL_VERSION, id, ok: true, result });
            return;
          }

          sendError(id, new Error(`unknown method "${method}"`));
        } catch (error) {
          sendError(id, error);
        }
      })();
    }
  });

  process.stdin.on("end", async () => {
    await browser.close().catch(() => {});
    process.exit(0);
  });
}

main().catch((error) => {
  sendError(-1, error);
  process.exit(1);
});
