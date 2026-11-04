import { createError, defineEventHandler, getRouterParam } from "h3";
import { asc, eq } from "drizzle-orm";
import { requireUser } from "@server/utils/auth";
import { db } from "@src/db";
import { companies, contacts } from "@src/db/schema";

export default defineEventHandler(async (event) => {
  await requireUser(event);
  const id = getRouterParam(event, "id");
  if (!id) throw createError({ statusCode: 400, statusMessage: "missing company id" });

  const [company] = await db.select().from(companies).where(eq(companies.id, id));
  if (!company) throw createError({ statusCode: 404, statusMessage: "company not found" });

  const contactRows = await db.select().from(contacts).where(eq(contacts.companyId, id)).orderBy(asc(contacts.createdAt));

  const provenance = company.fieldProvenance ?? {};
  const provenanceSummary = Object.entries(provenance).map(([field, value]) => {
    let stage: string | null = null;
    if (value && typeof value === "object" && "stage" in value) {
      const raw = value.stage;
      if (typeof raw === "string") stage = raw;
      else if (raw !== null && raw !== undefined) stage = String(raw);
    }
    return { field, stage };
  });

  return {
    company: {
      id: company.id,
      name: company.name,
      legalEntity: company.legalEntity,
      website: company.website,
      linkedinUrl: company.linkedinUrl,
      emailDomain: company.emailDomain,
      address: company.address,
      city: company.city,
      province: company.province,
      country: company.country,
      phone: company.phone,
      industry: company.industryCategory,
      productsServices: company.productsServices,
      rating: company.rating,
      reviewCount: company.reviewCount,
      branchesCount: company.branchesCount,
      digitalPresence: company.digitalPresence,
      emailHuntAttempts: company.emailHuntAttempts,
      status: company.status,
      hasEmail: company.hasEmail,
      validationNotes: company.validationNotes,
      createdAt: company.createdAt.toISOString(),
      updatedAt: company.updatedAt.toISOString(),
    },
    contacts: contactRows.map((c) => ({
      id: c.id,
      name: c.name,
      title: c.title,
      email: c.email,
      emailType: c.emailType,
      emailVerification: c.emailVerification,
      phone: c.phone,
      phoneNormalized: c.phoneNormalized,
      whatsapp: c.whatsapp,
      waLikely: c.waLikely,
      linkedinUrl: c.linkedinUrl,
      isDecisionMaker: c.isDecisionMaker,
      createdAt: c.createdAt.toISOString(),
    })),
    provenanceSummary,
  };
});
