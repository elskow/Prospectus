const { chromium } = require("patchright");

const PROTOCOL_VERSION = 1;

function send(payload) {
  process.stdout.write(JSON.stringify(payload) + "\n");
}

function fail(id, error, transient) {
  send({
    v: PROTOCOL_VERSION,
    id,
    ok: false,
    error,
    transient: transient === true,
  });
}

async function capture(request) {
  const { startUrl, cookieChecks, timeoutMs } = request;
  const deadline = Date.now() + (typeof timeoutMs === "number" ? timeoutMs : 300_000);

  const browser = await chromium.launch({
    headless: false,
    args: ["--disable-blink-features=AutomationControlled", "--no-first-run", "--no-default-browser-check"],
  });
  const context = await browser.newContext({
    viewport: { width: 1280, height: 860 },
  });
  const page = await context.newPage();

  const shutdown = async () => {
    await browser.close().catch(() => {});
  };
  process.on("SIGTERM", shutdown);
  process.on("SIGINT", shutdown);

  try {
    try {
      await page.goto(startUrl, {
        waitUntil: "domcontentloaded",
        timeout: 60_000,
      });
    } catch {
      await page.goto(new URL("/", startUrl).href, {
        waitUntil: "domcontentloaded",
        timeout: 60_000,
      });
    }

    while (Date.now() < deadline) {
      await page.waitForTimeout(2_000);
      const cookies = await context.cookies();
      const matched = {};
      let allFound = true;

      for (const check of cookieChecks) {
        const cookie = cookies.find((c) => c.name === check.name && (!check.domain || c.domain.includes(check.domain)));
        if (cookie) {
          matched[check.field] = cookie.value;
        } else {
          allFound = false;
        }
      }

      if (allFound) {
        await shutdown();
        return matched;
      }
    }

    throw new Error("capture-timeout");
  } finally {
    await shutdown();
  }
}

async function main() {
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

    while ((newlineIndex = buffer.indexOf("\n")) !== -1) {
      const line = buffer.slice(0, newlineIndex);
      buffer = buffer.slice(newlineIndex + 1);
      if (!line.trim()) continue;

      let request;
      try {
        request = JSON.parse(line);
      } catch {
        fail("parse", "malformed request line");
        continue;
      }

      if (request.method === "capture") {
        capture(request.payload ?? {})
          .then((result) => send({ v: PROTOCOL_VERSION, id: request.id, ok: true, result }))
          .catch((error) => fail(request.id, error.message ?? String(error), error.message === "capture-timeout"));
      } else {
        fail(request.id, `unknown method "${request.method}"`);
      }
    }
  });

  process.stdin.on("end", () => process.exit(0));
}

main();
