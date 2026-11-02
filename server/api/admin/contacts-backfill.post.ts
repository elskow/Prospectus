import { defineEventHandler, createError } from "h3";
import { eq } from "drizzle-orm";
import { requireUser } from "@server/utils/auth";
import { db } from "@src/db";
import { companies, contacts } from "@src/db/schema";
import { verifyEmail, isRoleEmail } from "@src/harness/contact-discovery";
import { domainHasMailInfrastructure, whatsappReachable } from "@src/harness/osint-contacts";

export default defineEventHandler(async (event) => {
  await requireUser(event);

  const rows = await db
    .select({
      id: contacts.id,
      email: contacts.email,
      emailType: contacts.emailType,
      phone: contacts.phone,
      whatsapp: contacts.whatsapp,
      website: companies.website,
    })
    .from(contacts)
    .innerJoin(companies, eq(contacts.companyId, companies.id))
    .limit(500);

  let verified = 0;
  let invalidated = 0;
  let waConfirmed = 0;
  let typed = 0;

  for (const row of rows) {
    if (row.email && (row.emailType === null || row.emailType === "role")) {
      const mailLive = row.website ? await domainHasMailInfrastructure(row.website).catch(() => false) : false;
      if (!mailLive) {
        await db.update(contacts).set({ emailType: "role", updatedAt: new Date() }).where(eq(contacts.id, row.id));
        typed += 1;
      } else if (!isRoleEmail(row.email)) {
        const verdict = await verifyEmail(row.email, { timeoutMs: 8000 }).catch(() => null);
        if (verdict?.stage === "smtp" && verdict.valid) {
          await db.update(contacts).set({ emailType: "personal", updatedAt: new Date() }).where(eq(contacts.id, row.id));
          verified += 1;
        } else if (verdict?.stage === "smtp" && !verdict.valid && verdict.reason !== "smtp_unreachable") {
          await db.update(contacts).set({ email: null, emailType: null, updatedAt: new Date() }).where(eq(contacts.id, row.id));
          invalidated += 1;
        }
      }
    }

    if (row.phone && !row.whatsapp) {
      const reachable = await whatsappReachable(row.phone).catch(() => false);
      if (reachable) {
        await db
          .update(contacts)
          .set({ whatsapp: row.phone.replace(/[^0-9+]/g, "").replace(/^0/, "+62"), updatedAt: new Date() })
          .where(eq(contacts.id, row.id));
        waConfirmed += 1;
      }
    }
  }

  return { checked: rows.length, verified, invalidated, waConfirmed, typed };
});
