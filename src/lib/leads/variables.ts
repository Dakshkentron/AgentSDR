export type PersonVariableSource = {
  email: string | null;
  linkedinUrl: string | null;
  firstName?: string | null;
  lastName?: string | null;
  fullName?: string | null;
  title?: string | null;
  raw: Record<string, unknown> | null;
};

export type CompanyVariableSource = {
  domain: string;
  name: string | null;
  linkedinUrl: string | null;
  raw: Record<string, unknown> | null;
};

function stringify(value: unknown): string | null {
  if (value === null || value === undefined) return null;
  if (typeof value === "string") return value;
  if (typeof value === "number" || typeof value === "boolean") return String(value);
  return JSON.stringify(value);
}

/** Flatten the canonical person into the exact token bag used by templates. */
export function personVariables(person: PersonVariableSource, company?: CompanyVariableSource | null): Record<string, string> {
  const variables: Record<string, string> = {};
  const keysByLowerCase = new Map<string, string>();
  const set = (key: string, value: string, overwrite = true) => {
    const normalized = key.toLowerCase();
    const previous = keysByLowerCase.get(normalized);
    if (previous && !overwrite) return;
    if (previous && previous !== key) delete variables[previous];
    variables[key] = value;
    keysByLowerCase.set(normalized, key);
  };
  for (const [key, value] of Object.entries(person.raw ?? {})) {
    const rendered = stringify(value);
    if (rendered !== null) set(key, rendered);
  }
  for (const [key, value] of Object.entries(company?.raw ?? {})) {
    const rendered = stringify(value);
    if (rendered !== null) set(key, rendered, false);
  }
  // Leads from a LinkedIn search or a sheet often carry only a full name;
  // without this {{firstName}} would render empty ("Hi ,").
  const [derivedFirst, ...derivedRest] = (person.fullName ?? "").trim().split(/\s+/).filter(Boolean);
  const typed = {
    firstName: person.firstName || derivedFirst,
    lastName: person.lastName || (person.firstName ? null : derivedRest.join(" ")),
    fullName: person.fullName,
    name: person.fullName,
    title: person.title,
    jobTitle: person.title,
    company: company?.name,
    companyName: company?.name,
    companyDomain: company?.domain,
    companyLinkedinUrl: company?.linkedinUrl,
  };
  for (const [key, value] of Object.entries(typed)) {
    if (value) set(key, value);
  }
  if (person.email) set("email", person.email);
  if (person.linkedinUrl) {
    set("linkedinUrl", person.linkedinUrl);
    set("linkedin", person.linkedinUrl);
  }
  return variables;
}

/** Case-insensitive lookup while preserving original JSON keys for the UI. */
export function variableValue(variables: Record<string, string>, key: string): string | null {
  const wanted = key.toLowerCase();
  const match = Object.entries(variables).find(([candidate]) => candidate.toLowerCase() === wanted);
  return match?.[1] ?? null;
}

export function personProfile(person: PersonVariableSource, company?: CompanyVariableSource | null) {
  const variables = personVariables(person, company);
  return {
    email: person.email,
    linkedinUrl: person.linkedinUrl ?? "",
    name: person.fullName ?? variableValue(variables, "name") ?? variableValue(variables, "fullName"),
    firstName: person.firstName ?? variableValue(variables, "firstName"),
    lastName: person.lastName ?? variableValue(variables, "lastName"),
    headline: person.title ?? variableValue(variables, "headline") ?? variableValue(variables, "title") ?? variableValue(variables, "jobTitle"),
    company: variableValue(variables, "company") ?? variableValue(variables, "companyName"),
    location: variableValue(variables, "location"),
    profilePictureUrl: variableValue(variables, "profilePictureUrl"),
    variables,
  };
}
