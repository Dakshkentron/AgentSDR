import { publicAppUrl } from "@/lib/http/publicAppUrl";
import { buildUnsubscribeToken } from "./unsubscribeToken";
import { currentOrganizationId } from "@/lib/tenancy/scope";

/**
 * The email rendering pipeline, shared by the scheduler (real sends) and the
 * sequence preview. Kept in one module deliberately: a preview that renders
 * through a second copy of this logic would drift from what actually gets
 * mailed, which defeats the point of previewing.
 *
 * Order matters — renderEmail() below is the canonical sequence.
 */

/**
 * Resolves spin-text syntax {A|B|C} by picking one option at random, so
 * sends to different leads aren't byte-for-byte identical (spam-filter/
 * "confuse who's actually reading" evasion, per explicit user request).
 * Runs BEFORE fillTemplate's merge-field substitution — spin-text applies
 * only to the author's own template text, never to lead data that gets
 * substituted in later (a company name containing a literal "{" or "|"
 * must not be treated as spin-text).
 */
export function resolveSpinText(template: string): string {
  return template.replace(/\{([^{}]+)\}/g, (match, inner: string) => {
    if (!inner.includes("|")) return match; // not spin-text — leave "{...}" as-is (e.g. accidental brace)
    const options = inner.split("|").map((o) => o.trim());
    return options[Math.floor(Math.random() * options.length)];
  });
}

export function fillTemplate(
  template: string,
  variables: Record<string, string>,
): string {
  const lookup = new Map(Object.entries(variables).map(([k, v]) => [k.toLowerCase(), v]));
  return resolveSpinText(template).replace(
    /\{\{\s*([^{}\r\n]+?)\s*\}\}/g,
    (match, rawKey: string) => {
      const key = rawKey.trim();
      if (key.toLowerCase() === "signature") return match;
      // {{first_name}} as people often write it finds {{firstName}}.
      return lookup.get(key.toLowerCase()) ?? lookup.get(key.toLowerCase().replace(/_/g, "")) ?? "";
    },
  );
}

/** Appended to every outreach send — compliance requirement AgentSDR-app never actually had either (see audit notes). */
/**
 * Appended to every outreach send. Required in practice, not optional polish:
 * CAN-SPAM and its equivalents require a working opt-out in commercial email,
 * and both Gmail and Outlook weight one-click unsubscribe when scoring spam,
 * so removing it costs deliverability as well as compliance.
 */
export function appendUnsubscribeFooter(body: string, leadEmail: string): string {
  return `${body}\n\n---\nDon't want to hear from us again? Unsubscribe: ${unsubscribeUrl(leadEmail)}`;
}

/** Human-facing opt-out page — what the footer link points at. */
export function unsubscribeUrl(leadEmail: string): string {
  const baseUrl = publicAppUrl() ?? "";
  return `${baseUrl}/unsubscribe?token=${buildUnsubscribeToken(leadEmail, currentOrganizationId())}`;
}

/**
 * The POST-capable endpoint for the List-Unsubscribe header. RFC 8058 requires
 * one-click to POST, and the /unsubscribe page only serves GET — pointing the
 * header there would make Gmail's native button fail.
 */
export function unsubscribePostUrl(leadEmail: string): string {
  const baseUrl = publicAppUrl() ?? "";
  return `${baseUrl}/api/outreach/unsubscribe?token=${buildUnsubscribeToken(leadEmail, currentOrganizationId())}`;
}

/**
 * Substitutes the sending mailbox's signature into the body.
 *
 * The placeholder is %signature% rather than a {{...}} token on purpose:
 * fillTemplate runs first and its catch-all {{key}} regex would match a
 * {{SIGNATURE}} token, find no matching custom field, and silently replace
 * it with "". %...% cannot collide with merge fields.
 *
 * Matched case-insensitively, and tolerant of surrounding spaces (%signature%,
 * %Signature%, % signature %). All occurrences are replaced, so a body that
 * repeats it in a PS still renders. Falls back to appending when the body has
 * no placeholder, preserving the previous behavior.
 *
 * {{SIGNATURE}} stays supported for bodies written before the switch, but is
 * only reachable for leads with no custom fields — see above.
 */
// Built fresh per call: a /g regex carries lastIndex between .test() calls,
// so a shared instance would match only every other send.
const signaturePlaceholder = () => /%\s*signature\s*%/gi;

export function applySignature(body: string, signatureHtml: string | null): string {
  const hasPlaceholder = signaturePlaceholder().test(body) || body.includes("{{SIGNATURE}}");

  // No signature configured: strip the placeholder rather than mailing it out
  // literally, otherwise the lead sees "%signature%" at the foot of the email.
  if (!signatureHtml) {
    return hasPlaceholder
      ? body.replace(signaturePlaceholder(), "").replaceAll("{{SIGNATURE}}", "").trimEnd()
      : body;
  }

  if (hasPlaceholder) {
    return body.replace(signaturePlaceholder(), signatureHtml).replaceAll("{{SIGNATURE}}", signatureHtml);
  }
  return `${body}\n\n${signatureHtml}`;
}



/** Escapes text before it is placed into HTML, so lead data can't inject markup. */
function escapeHtml(text: string): string {
  return text
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;");
}

// Trailing punctuation is excluded from the match so "see https://x.com." does
// not swallow the sentence's full stop into the href. URLs and bare emails are
// matched in ONE pass — running two passes would wrap an email that sits inside
// a URL twice, producing nested anchors.
const LINK_PATTERN =
  /(https?:\/\/[^\s<>"']+[^\s<>"'.,;:!?)\]])|(\b[A-Za-z0-9._%+-]+@[A-Za-z0-9.-]+\.[A-Za-z]{2,}\b)/g;

/**
 * Converts a plain-text body into HTML: escapes it, turns URLs and email
 * addresses into real anchors, and preserves line breaks.
 *
 * This exists because Gmail sends were passing the plain-text body straight
 * through as the HTML part (`html ?? text` in gmail.ts), so newlines collapsed
 * and every URL — the unsubscribe link included — arrived as unclickable text.
 */
export function toHtmlBody(text: string): string {
  const linked = escapeHtml(text).replace(LINK_PATTERN, (match, url: string | undefined) =>
    url ? `<a href="${url}">${url}</a>` : `<a href="mailto:${match}">${match}</a>`,
  );
  return linked.replace(/\r?\n/g, "<br />\n");
}

export type RenderableLead = {
  email: string;
  variables: Record<string, string>;
};

/**
 * The full pipeline exactly as a real send performs it: spin-text and merge
 * fields first, then the signature, then the unsubscribe footer. The scheduler
 * calls the same steps in the same order (see sendOne in scheduler.ts).
 */
export function renderEmail(
  step: { subject: string; body: string },
  lead: RenderableLead,
  signatureHtml: string | null,
  opts: { includeUnsubscribeFooter?: boolean } = {},
): { subject: string; body: string; html: string } {
  const subject = fillTemplate(step.subject, lead.variables);
  const withSignature = applySignature(fillTemplate(step.body, lead.variables), signatureHtml);
  if (opts.includeUnsubscribeFooter === false) {
    return { subject, body: withSignature, html: toHtmlBody(withSignature) };
  }

  // The footer is appended AFTER the body is converted to HTML, so the link can
  // read "Unsubscribe" instead of exposing the raw signed token. Linkifying a
  // plain-text footer would print the whole 60-char base64 URL, which wraps
  // across two lines and reads as spam.
  return {
    subject,
    body: appendUnsubscribeFooter(withSignature, lead.email),
    html: toHtmlBody(withSignature) + unsubscribeFooterHtml(lead.email),
  };
}

/** HTML counterpart of appendUnsubscribeFooter — same link, readable anchor text. */
export function unsubscribeFooterHtml(leadEmail: string): string {
  const url = unsubscribeUrl(leadEmail);
  return (
    `<br />\n<br />\n<span style="color:#8a8a8a;font-size:12px">` +
    `Don't want to hear from us again? <a href="${url}" style="color:#8a8a8a">Unsubscribe</a>` +
    `</span>`
  );
}
