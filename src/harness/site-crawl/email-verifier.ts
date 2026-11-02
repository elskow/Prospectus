import { promises as dns } from "node:dns";
import net from "node:net";

export type EmailVerdict =
  | { stage: "syntax" | "disposable" | "mx"; valid: false; reason: string }
  | { stage: "smtp"; valid: boolean; reason: string; catchAll: boolean }
  | { stage: "mx"; valid: true; reason: "mx-records-found" };

const DISPOSABLE_DOMAINS = new Set([
  "mailinator.com",
  "tempmail",
  "10minutemail",
  "guerrillamail",
  "yopmail",
  "throwawaymail",
  "sharklasers",
  "getnada",
  "trashmail",
]);

export async function verifyEmail(email: string, opts?: { smtp?: boolean; timeoutMs?: number }): Promise<EmailVerdict> {
  const trimmed = email.trim().toLowerCase();
  if (!/^[^\s@]+@[^\s@]+\.[^\s@]{2,}$/.test(trimmed)) {
    return { stage: "syntax", valid: false, reason: "invalid syntax" };
  }
  const domain = trimmed.split("@")[1] ?? "";
  if (DISPOSABLE_DOMAINS.has(domain) || [...DISPOSABLE_DOMAINS].some((d) => domain.includes(d))) {
    return { stage: "disposable", valid: false, reason: "disposable domain" };
  }

  let mx: { exchange: string; priority: number }[];
  try {
    mx = await dns.resolveMx(domain);
  } catch {
    return { stage: "mx", valid: false, reason: "no mx records" };
  }
  if (mx.length === 0) {
    return { stage: "mx", valid: false, reason: "no mx records" };
  }
  if (opts?.smtp === false) {
    return { stage: "mx", valid: true, reason: "mx-records-found" };
  }

  mx.sort((a, b) => a.priority - b.priority);
  const bestMx = mx[0];
  if (!bestMx) {
    return { stage: "mx", valid: true, reason: "mx-records-found" };
  }
  const smtpResult = await smtpProbe(trimmed, bestMx.exchange, opts?.timeoutMs ?? 15_000);
  return smtpResult;
}

function smtpProbe(email: string, mxHost: string, timeoutMs: number): Promise<EmailVerdict> {
  const { promise, resolve } = Promise.withResolvers<EmailVerdict>();
  const socket = net.createConnection({ host: mxHost, port: 25 });
  let buffer = "";
  let stage: "greet" | "helo" | "mail" | "rcpt" | "catchall" = "greet";
  let catchAll = false;
  const domain = email.split("@")[1];

  const finish = (verdict: EmailVerdict): void => {
    clearTimeout(timer);
    socket.removeAllListeners();
    socket.destroy();
    resolve(verdict);
  };

  const timer = setTimeout(() => finish({ stage: "smtp", valid: false, reason: "smtp_unreachable", catchAll: false }), timeoutMs);

  const send = (cmd: string): void => {
    socket.write(`${cmd}\r\n`);
  };

  const next = (reply: string): void => {
    const code = Number.parseInt(reply.slice(0, 3), 10);
    if (Number.isNaN(code) || reply[3] === "-") {
      return;
    }
    switch (stage) {
      case "greet":
        if (code !== 220) {
          return finish({ stage: "smtp", valid: false, reason: `greeting ${code}`, catchAll: false });
        }
        stage = "helo";
        send("EHLO prospectus.local");
        break;
      case "helo":
        if (code >= 500) {
          return finish({ stage: "smtp", valid: false, reason: `ehlo rejected ${code}`, catchAll: false });
        }
        stage = "mail";
        send("MAIL FROM:<verify@prospectus.local>");
        break;
      case "mail":
        if (code !== 250) {
          return finish({ stage: "smtp", valid: false, reason: `mail-from rejected ${code}`, catchAll: false });
        }
        stage = "rcpt";
        send(`RCPT TO:<${email}>`);
        break;
      case "rcpt":
        if (code === 250 || code === 251) {
          return finish({ stage: "smtp", valid: true, reason: "accepted", catchAll: false });
        }
        if (code === 450 || code === 451 || code === 452) {
          return finish({ stage: "smtp", valid: false, reason: "greylisted", catchAll: false });
        }
        stage = "catchall";
        send(`RCPT TO:<${Math.random().toString(36).slice(2, 10)}@${domain}>`);
        break;
      case "catchall":
        catchAll = code === 250 || code === 251;
        finish({
          stage: "smtp",
          valid: false,
          reason: catchAll ? "catch-all-domain" : code >= 500 ? `mailbox rejected-${code}` : `rejected-${code}`,
          catchAll,
        });
    }
  };

  socket.on("data", (chunk) => {
    buffer += chunk.toString("utf8");
    const lines = buffer.split(/\r?\n/);
    buffer = lines.pop() ?? "";
    for (const line of lines) {
      if (line.trim().length >= 3) {
        {
        }
        next(line);
        return;
      }
    }
  });
  socket.on("error", () => finish({ stage: "smtp", valid: false, reason: "smtp_unreachable", catchAll: false }));

  return promise;
}
