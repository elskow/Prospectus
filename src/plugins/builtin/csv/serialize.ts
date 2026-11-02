export const CSV_HEADERS = [
  "company",
  "city",
  "website",
  "what_they_sell",
  "contact_name",
  "contact_title",
  "email",
  "email_verification",
  "phone",
  "whatsapp",
  "is_decision_maker",
  "source_url",
  "discovered_at",
];

interface CsvLeadRow {
  companyName: string;
  city: string | null;
  website: string | null;
  contactName: string | null;
  contactTitle: string | null;
  contactEmail: string | null;
  emailVerification: string | null;
  contactPhone: string | null;
  contactWhatsapp: string | null;
  isDecisionMaker: boolean | null;
  sourceUrl: string | null;
  discoveredAt: string | null;
}

export function csvEscape(value: string): string {
  if (/[",\n]/.test(value)) return `"${value.replace(/"/g, '""')}"`;

  return value;
}

export function serializeLeadsCsv(leads: CsvLeadRow[]): string {
  const lines = [CSV_HEADERS.join(",")];
  for (const lead of leads) {
    lines.push(
      [
        lead.companyName,
        lead.city ?? "",
        lead.website ?? "",
        lead.contactName ?? "",
        lead.contactTitle ?? "",
        lead.contactEmail ?? "",
        lead.emailVerification ?? "",
        lead.contactPhone ?? "",
        lead.contactWhatsapp ?? "",
        lead.isDecisionMaker === null ? "" : lead.isDecisionMaker ? "yes" : "no",
        lead.sourceUrl ?? "",
        lead.discoveredAt ?? "",
      ]
        .map(csvEscape)
        .join(","),
    );
  }

  return lines.join("\n");
}
