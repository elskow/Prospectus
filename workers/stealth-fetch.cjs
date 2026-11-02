const { chromium } = require("patchright");

const request = JSON.parse(process.argv[2] ?? "{}");
const url = request.url;
const timeoutMs = typeof request.timeoutMs === "number" ? request.timeoutMs : 25_000;

function emit(payload) {
  process.stdout.write(JSON.stringify(payload) + "\n");
}

async function main() {
  if (!url || !/^https?:\/\//.test(url)) {
    emit({ ok: false, error: "invalid url" });
    return;
  }

  const browser = await chromium.launch({
    headless: process.env.STEALTH_HEADLESS !== "false",
    args: ["--disable-blink-features=AutomationControlled", "--no-first-run", "--no-default-browser-check"],
  });

  const shutdown = async (code) => {
    await browser.close().catch(() => {});
    process.exit(code);
  };
  process.on("SIGTERM", () => shutdown(0));
  process.on("SIGINT", () => shutdown(0));

  try {
    const context = await browser.newContext({
      viewport: { width: 1440, height: 900 },
      locale: process.env.SCRAPE_LOCALE || "id-ID",
      timezoneId: process.env.SCRAPE_TIMEZONE || "Asia/Jakarta",
      userAgent: "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/156.0.0.0 Safari/537.36",
    });
    const page = await context.newPage();
    const res = await page.goto(url, { waitUntil: "domcontentloaded", timeout: timeoutMs });
    await page.waitForLoadState("networkidle", { timeout: 5_000 }).catch(() => {});
    const html = await page.content();
    await context.close().catch(() => {});
    emit({ ok: true, status: res ? res.status() : 0, html });
    await shutdown(0);
  } catch (error) {
    emit({ ok: false, error: String(error && error.message ? error.message : error) });
    await shutdown(1);
  }
}

main();
