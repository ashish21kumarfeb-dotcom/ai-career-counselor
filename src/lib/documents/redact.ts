// PII redaction applied at DOCUMENT-WRITE TIME.
//
// Resumes are the one place a user hands us a dense block of personal data —
// email, phone, national ID numbers — and that block then flows into three places
// that outlive the request: the `documents` table, the `memory` table (the resume
// route extracts durable facts from the same text), and every future LLM prompt
// that retrieves it for grounding. Redacting at read time would be too late for
// the first two, so it happens before the insert. What is never stored cannot
// leak from storage, cannot be sent to a model provider, and cannot be recovered
// by a later bug in retrieval scoping.
//
// DELIBERATELY NARROW. Each pattern targets an identifier that is (a) directly
// identifying on its own and (b) useless for career advice — the counselor does
// not need a phone number to recommend a roadmap. Things that LOOK personal but
// carry real signal are left alone on purpose: names, employers, job titles,
// universities, cities, and profile URLs (LinkedIn/GitHub) all inform the advice
// and are what the user came here to get advice about. Over-redaction here would
// degrade grounding while adding little privacy, since the profile row already
// holds the user's name and location by design.
//
// Idempotent: the replacement tokens contain no digits or "@", so running this
// over already-redacted text is a no-op. Callers may therefore apply it
// defensively without tracking whether it already ran.

export type RedactionCounts = Record<string, number>;

export type RedactionResult = {
  text: string;
  counts: RedactionCounts;
  redacted: boolean;
};

// Ordered — earlier patterns claim their digits first, which is what keeps the
// broader numeric patterns from mangling a more specific one. A 12-digit Aadhaar
// would otherwise be partly consumed by the 10-digit phone pattern, and an email's
// local part can contain digit runs, so email comes first of all.
const PATTERNS: Array<{ label: string; token: string; re: RegExp }> = [
  {
    label: "email",
    token: "[REDACTED_EMAIL]",
    re: /[A-Za-z0-9._%+-]+@[A-Za-z0-9.-]+\.[A-Za-z]{2,}/g,
  },
  {
    // US SSN, in its conventional separated form only. Bare 9-digit runs are not
    // matched: too many benign numbers are 9 digits.
    label: "ssn",
    token: "[REDACTED_ID]",
    re: /\b\d{3}-\d{2}-\d{4}\b/g,
  },
  {
    // Indian PAN: five letters, four digits, one letter. Distinctive enough that
    // false positives are effectively impossible in prose.
    label: "pan",
    token: "[REDACTED_ID]",
    re: /\b[A-Z]{5}\d{4}[A-Z]\b/g,
  },
  {
    // Payment-card-length digit runs (13–16 digits, optionally grouped). Resumes
    // should never contain one; when they do it is an accident worth catching.
    label: "card",
    token: "[REDACTED_ID]",
    re: /\b(?:\d[ -]?){13,16}\b/g,
  },
  {
    // Indian Aadhaar: 12 digits, usually in groups of four.
    label: "aadhaar",
    token: "[REDACTED_ID]",
    re: /\b\d{4}[ -]?\d{4}[ -]?\d{4}\b/g,
  },
  {
    // Phone numbers. The pattern matches a LOOSE shape — an optional country
    // code, an optional area code in parentheses, then two to four digit groups
    // in any of the common groupings — and leaves the actual decision to the
    // digit-count guard below. Written the other way round (a tight regex per
    // format) it missed real numbers: "+91 98765 43210" is two groups, "+1
    // 415-555-0134" is three, and a rule demanding three dropped the first
    // silently. Loose-match-then-count covers both without an alternation per
    // country, and the guard is what keeps "2019-2023" and "10 000" out.
    label: "phone",
    token: "[REDACTED_PHONE]",
    re: /(?:\+\d{1,3}[ .-]?)?(?:\(\d{2,5}\)[ .-]?)?\d{2,5}(?:[ .-]?\d{2,5}){1,3}/g,
  },
];

// A phone candidate must carry at least 10 digits to count. The phone regex is
// permissive about grouping so it can catch the many ways people write a number;
// this check is what stops it from eating short numeric spans like "2019 2023"
// or "10 000". Applied as a replacer predicate rather than tightened into the
// regex because digit COUNT across optional separators is not expressible there
// without an unreadable alternation.
function isPhoneLike(match: string): boolean {
  const digits = match.replace(/\D/g, "").length;
  return digits >= 10 && digits <= 13;
}

export function redactPII(input: string): RedactionResult {
  const counts: RedactionCounts = {};
  let text = input;

  for (const { label, token, re } of PATTERNS) {
    text = text.replace(re, (match) => {
      if (label === "phone" && !isPhoneLike(match)) return match;
      counts[label] = (counts[label] ?? 0) + 1;
      return token;
    });
  }

  return { text, counts, redacted: Object.keys(counts).length > 0 };
}
