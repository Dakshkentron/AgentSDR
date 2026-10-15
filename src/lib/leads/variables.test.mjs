import { describe, expect, test } from "bun:test";
import { personProfile, personVariables } from "./variables.ts";
import { fillTemplate } from "../outreach/render.ts";

describe("canonical person variables", () => {
  test("flattens identity and raw JSON into one reusable campaign context", () => {
    const person = {
      email: "pat@example.com",
      linkedinUrl: "pat-lee",
      firstName: "Pat",
      lastName: "Lee",
      fullName: "Pat Lee",
      title: "VP Sales",
      raw: { employeeCount: 42 },
    };
    const variables = personVariables(person, { domain: "acme.com", name: "Acme", linkedinUrl: null, raw: {} });
    expect(variables).toEqual({
      firstName: "Pat",
      lastName: "Lee",
      fullName: "Pat Lee",
      name: "Pat Lee",
      title: "VP Sales",
      jobTitle: "VP Sales",
      company: "Acme",
      companyName: "Acme",
      companyDomain: "acme.com",
      employeeCount: "42",
      email: "pat@example.com",
      linkedinUrl: "pat-lee",
      linkedin: "pat-lee",
    });
    expect(fillTemplate("Hi {{FIRSTNAME}} at {{company}}", variables)).toBe("Hi Pat at Acme");
    expect(fillTemplate("Marker: {{ Canary Marker }} / {{favorite-color}}", {
      "Canary Marker": "raw-value",
      "favorite-color": "blue",
    })).toBe("Marker: raw-value / blue");
    expect(personProfile(person).name).toBe("Pat Lee");
  });

  test("typed values override raw aliases case-insensitively", () => {
    const variables = personVariables({
      email: "pat@example.com",
      linkedinUrl: null,
      firstName: "Current",
      lastName: null,
      fullName: null,
      title: null,
      raw: { FirstName: "Legacy", EMAIL: "old@example.com" },
    });
    expect(variables.firstName).toBe("Current");
    expect(variables.email).toBe("pat@example.com");
    expect(variables).not.toHaveProperty("FirstName");
    expect(variables).not.toHaveProperty("EMAIL");
  });
  test("a lead with only a full name still fills first and last name, in either spelling", () => {
    const variables = personVariables({ fullName: "Garvit Jain", raw: {} });
    expect(fillTemplate("Hi {{firstName}} {{lastName}}", variables)).toBe("Hi Garvit Jain");
    expect(fillTemplate("Thanks for connecting, {{first_name}}!", variables)).toBe("Thanks for connecting, Garvit!");
    expect(fillTemplate("Hi {{firstName}}", personVariables({ firstName: "Pat", fullName: "Patricia Lee", raw: {} }))).toBe("Hi Pat");
  });
});
