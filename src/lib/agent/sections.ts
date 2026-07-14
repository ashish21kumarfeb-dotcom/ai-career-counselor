// Shared, LLM-free helpers for building the DB-backed response sections
// (agencies, resources, courses). Extracted verbatim from nodes/generate.ts so
// the same mappers can be reused by the Career Data Agent and the Recommendation
// Agent without either one re-implementing (or re-inventing) verified data.
//
// CRITICAL GUARANTEE preserved: every item here is mapped DIRECTLY from a tool
// result row — the LLM never writes these. A requested-but-empty section yields
// items: [] plus an explicit "no verified data" note, never invented data.
import type { RetrievedDocument } from "../documents/queries";
import type { RetrievedAgency } from "../agencies/queries";
import type { ResourceItem, AgencyItem, Sourced, SectionName } from "./schema";

// Course-like heuristic: real course/certification providers. Deliberately narrow
// (matches provider names + "course"/"certificat") so a learning-guide URL such as
// MDN's /docs/Learn is treated as a resource, not a course.
export function isCourseLike(doc: RetrievedDocument): boolean {
  const hay = `${doc.sourceUrl ?? ""} ${doc.content}`;
  return /certificat|course|coursera|udemy|freecodecamp|grow\.google|nptel|\bedx\b/i.test(hay);
}

export function titleOf(content: string): string {
  const label = content.split(":")[0].trim();
  if (label && label.length <= 90) return label;
  return content.length > 90 ? `${content.slice(0, 87).trim()}...` : content.trim();
}

export function toResourceItem(doc: RetrievedDocument): ResourceItem {
  return { title: titleOf(doc.content), type: doc.type, url: doc.sourceUrl };
}

export function toAgencyItem(a: RetrievedAgency): AgencyItem {
  return {
    name: a.name,
    location: a.location,
    services: a.services,
    website: a.website,
    source: a.sourceUrl,
  };
}

export function sourced<T>(items: T[], emptyNote: string): Sourced<T> {
  return items.length > 0 ? { items } : { items: [], note: emptyNote };
}

// Pure, LLM-free construction of the DB-backed sections. When both resources and
// courses are requested, the retrieved docs are partitioned so each link appears
// in exactly one bucket.
export function buildDbSections(
  sections: SectionName[],
  agencies: RetrievedAgency[],
  resourceDocs: RetrievedDocument[]
): {
  agencies?: Sourced<AgencyItem>;
  resources?: Sourced<ResourceItem>;
  courses?: Sourced<ResourceItem>;
} {
  const out: {
    agencies?: Sourced<AgencyItem>;
    resources?: Sourced<ResourceItem>;
    courses?: Sourced<ResourceItem>;
  } = {};

  if (sections.includes("agencies")) {
    out.agencies = sourced(
      agencies.map(toAgencyItem),
      "No verified agencies found for this query."
    );
  }

  const wantResources = sections.includes("resources");
  const wantCourses = sections.includes("courses");
  if (wantResources || wantCourses) {
    let resDocs = resourceDocs;
    let courseDocs = resourceDocs;
    if (wantResources && wantCourses) {
      // partition so each link appears once
      courseDocs = resourceDocs.filter(isCourseLike);
      resDocs = resourceDocs.filter((d) => !isCourseLike(d));
    } else if (wantCourses) {
      courseDocs = resourceDocs.filter(isCourseLike);
    }
    if (wantResources) {
      out.resources = sourced(
        resDocs.map(toResourceItem),
        "No verified resources found for this query."
      );
    }
    if (wantCourses) {
      out.courses = sourced(
        courseDocs.map(toResourceItem),
        "No verified courses found for this query."
      );
    }
  }

  return out;
}
