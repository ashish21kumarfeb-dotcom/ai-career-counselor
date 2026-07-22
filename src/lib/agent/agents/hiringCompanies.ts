// Hiring-companies extraction: turn the SOURCED web results from the live-hiring
// lane (searchHiringCompanies) into structured, per-company entities for the
// dedicated "Hiring Companies" section that answers a company/entity-discovery
// query ("top AI firms hiring in Berlin", "companies hiring DevOps in Germany").
//
// This is the "extract companies/entities" step in the flow
//   intent -> external search (Tavily) -> EXTRACT companies -> render section.
//
// SAFETY — the risk here is inventing a company, so grounding is enforced in CODE
// (coerceHiringCompanies), never trusted from the model:
//   - SOURCED-ONLY: every company's `sourceUrl` MUST be one of the retrieved result
//     URLs. A company the model attaches to a url we did not retrieve is dropped.
//   - NO GUESSED DOMAINS: `website` is kept only when it is an http(s) url whose host
//     appears in the retrieved set; a plausible-but-unseen company domain becomes null.
//   - NO INVENTED FIELDS: roles/location/whyMatched come only from the source text; the
//     prompt forbids filling them from model knowledge, and empty is left empty.
//   - FAULT-TOLERANT: any LLM/parse failure degrades to [] (the caller still returns a
//     valid envelope) — it never throws into the retrieval fan-out and never fabricates.
import { CHAT_MODEL } from "../../ai/client";
import { createCompletion } from "../../ai/usage";
import { hiringCompanySchema, type ExternalResult, type HiringCompany } from "./contracts";

// The bare host of a url, or "" when it is not a usable http(s) url. Mirrors the
// provenance labelling used across the external lanes.
function hostOf(url: string): string {
  try {
    const u = new URL(url);
    if (u.protocol !== "http:" && u.protocol !== "https:") return "";
    return u.hostname.replace(/^www\./, "");
  } catch {
    return "";
  }
}

function isPlainObject(v: unknown): v is Record<string, unknown> {
  return typeof v === "object" && v !== null && !Array.isArray(v);
}

// Deterministic grounding of the model's raw output against the retrieved results.
// Pure — exported so the sourced-only / no-invention guarantees are unit-testable
// without an LLM. Drops anything it cannot tie back to a retrieved source.
export function coerceHiringCompanies(
  raw: unknown,
  results: ExternalResult[]
): HiringCompany[] {
  // The only sources a company may be attributed to, and the only hosts a website
  // may live on. Built from what we actually retrieved — the invention firewall.
  const urlToHost = new Map<string, string>();
  const allowedHosts = new Set<string>();
  for (const r of results) {
    urlToHost.set(r.url, r.source || hostOf(r.url));
    const h = r.source || hostOf(r.url);
    if (h) allowedHosts.add(h);
  }

  // Tolerate the model returning {companies:[...]}, a bare array, or {results:[...]}.
  const list = Array.isArray(raw)
    ? raw
    : isPlainObject(raw)
      ? (raw.companies ?? raw.results ?? raw.items)
      : undefined;
  if (!Array.isArray(list)) return [];

  const out: HiringCompany[] = [];
  const seen = new Set<string>();
  for (const item of list) {
    if (!isPlainObject(item)) continue;

    const name = typeof item.name === "string" ? item.name.trim() : "";
    if (!name) continue;
    const key = name.toLowerCase();
    if (seen.has(key)) continue;

    // Sourced-only: the company must point at a url we actually retrieved.
    const sourceUrl = typeof item.sourceUrl === "string" ? item.sourceUrl.trim() : "";
    if (!urlToHost.has(sourceUrl)) continue;
    const sourceName = urlToHost.get(sourceUrl) || hostOf(sourceUrl);

    // Website only when it is an http(s) url whose host we actually saw — never a
    // guessed company domain.
    let website: string | null = null;
    if (typeof item.website === "string") {
      const w = item.website.trim();
      const wHost = hostOf(w);
      if (wHost && allowedHosts.has(wHost)) website = w;
    }

    const roles = Array.isArray(item.roles)
      ? Array.from(
          new Set(
            item.roles
              .filter((r): r is string => typeof r === "string")
              .map((r) => r.trim())
              .filter((r) => r.length > 0)
          )
        )
      : [];

    const whyRaw = typeof item.whyMatched === "string" ? item.whyMatched.trim() : "";
    const locRaw = typeof item.location === "string" ? item.location.trim() : "";

    const company: HiringCompany = {
      name,
      whyMatched: whyRaw || null,
      roles,
      location: locRaw || null,
      website,
      sourceUrl,
      sourceName,
    };
    // Validate the shape at the boundary; skip anything malformed rather than throw.
    const parsed = hiringCompanySchema.safeParse(company);
    if (!parsed.success) continue;
    seen.add(key);
    out.push(parsed.data);
  }
  // Cap so a pathological payload cannot balloon the section.
  return out.slice(0, 8);
}

// The retrieved results as a compact, numbered evidence block the model extracts
// from. Each row shows the exact url to copy into `sourceUrl`, so the model never
// has to guess a source.
function evidenceBlock(results: ExternalResult[]): string {
  return results
    .map((r, i) => {
      const snippet = r.snippet ? ` — ${r.snippet.slice(0, 300)}` : "";
      return `[${i + 1}] ${r.title}\n    url: ${r.url}\n    source: ${r.source}${snippet}`;
    })
    .join("\n");
}

const SYSTEM_PROMPT = `You extract REAL companies from web search results for a career assistant. You are given a user's query and a numbered list of SOURCED web results. Identify the distinct companies/organizations that the results present as HIRING or relevant to the query, and return them as structured JSON.

Respond with a single JSON object of exactly this shape:
{
  "companies": [
    {
      "name": "<company name>",
      "whyMatched": "<one short phrase on why it matched, taken from the source text>",
      "roles": ["<hiring role>", "..."],
      "location": "<city/country if the source states it, else null>",
      "website": "<a careers/company url that appears in the results, else null>",
      "sourceUrl": "<the exact url of the result you took this company from>"
    }
  ]
}

STRICT RULES:
- ONLY include companies that actually appear in the provided results. Never add a company from your own knowledge.
- "sourceUrl" MUST be copied verbatim from the "url:" line of the result you used. Do not invent or modify it.
- "website" MUST be a url that literally appears in the results. If you are not sure, use null. Never guess a company's domain.
- "roles", "location", and "whyMatched" MUST come from the source text. If the source does not state roles, use []. If it does not state a location, use null.
- Do not include job boards, aggregators, or article publishers as "companies" — only the employers being written about. If a result is only an article/list, extract the employers it names, attributing each to that result's url.
- Return at most 8 companies. If the results name no real companies, return {"companies": []}.
- Output ONLY the JSON object, nothing else.`;

// Extract structured companies from the sourced hiring results. Best-effort: returns
// [] on empty input or any failure. The pure grounding (coerceHiringCompanies) runs
// on the model output, so nothing unsourced escapes even if the model misbehaves.
export async function extractHiringCompanies(
  query: string,
  results: ExternalResult[]
): Promise<HiringCompany[]> {
  if (results.length === 0) return [];

  const user = `User query: ${JSON.stringify(query)}

SOURCED WEB RESULTS (extract companies only from these):
${evidenceBlock(results)}

Produce the JSON object now.`;

  try {
    const completion = await createCompletion("hiring_extraction", {
      model: CHAT_MODEL,
      temperature: 0,
      max_tokens: 900,
      response_format: { type: "json_object" },
      messages: [
        { role: "system", content: SYSTEM_PROMPT },
        { role: "user", content: user },
      ],
    });
    const rawText = completion.choices[0]?.message?.content ?? "";
    let payload: unknown;
    try {
      payload = JSON.parse(rawText);
    } catch (error) {
      console.error("[hiring-extraction] model returned non-JSON; dropping companies.", error);
      return [];
    }
    return coerceHiringCompanies(payload, results);
  } catch (error) {
    console.error("[hiring-extraction] extraction failed; degrading to []:", error);
    return [];
  }
}
