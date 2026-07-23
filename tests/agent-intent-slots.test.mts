// Structured intent + slot extraction, and the lane-derivation module built on
// it. Everything here is pure — the extraction parse/fallback path is exercised
// with fixture strings, never a network call.
// Run: npm run test:slots
import "dotenv/config";
import {
  parseExtraction,
  intentSlotsSchema,
  EMPTY_SLOTS,
  type IntentSlots,
  type IntentExtraction,
} from "../src/lib/ai/extractIntent";
import {
  deriveLanesFromRegex,
  deriveLanesFromSlots,
  resolveLanes,
  shadowCompare,
} from "../src/lib/agent/lanes";
import { agencyGate } from "../src/lib/agent/schema";
import { resolveSearchStrategy } from "../src/lib/external/searchStrategy";

let passed = 0;
let failed = 0;
function check(name: string, cond: boolean, detail = "") {
  if (cond) { passed++; console.log(`  PASS  ${name}`); }
  else { failed++; console.log(`  FAIL  ${name}${detail ? "  :: " + detail : ""}`); }
}

function slots(over: Partial<IntentSlots> = {}): IntentSlots {
  return { ...EMPTY_SLOTS, ...over };
}
function extraction(over: Partial<IntentExtraction> = {}): IntentExtraction {
  return { intent: "other", slots: EMPTY_SLOTS, degraded: false, ...over };
}

console.log("\n== parseExtraction: valid output, off-list labels, malformed JSON ==");
{
  const good = parseExtraction(JSON.stringify({
    intent: "company_discovery", role: "devops engineer", location: "Berlin",
    industry: null, seniority: null, company: null, skills: ["kubernetes"],
    hiring: true, wantsProvider: false, wantsFacts: false, freshness: "recent",
  }));
  check("valid output parses", !good.degraded && good.intent === "company_discovery");
  check("slots carried through", good.slots.role === "devops engineer" && good.slots.hiring === true);

  const offList = parseExtraction(JSON.stringify({
    intent: "find_me_a_job", role: "nurse", location: null, industry: null,
    seniority: null, company: null, skills: [], hiring: false,
    wantsProvider: false, wantsFacts: false, freshness: "none",
  }));
  check("off-list label degrades to 'other' but KEEPS valid slots", offList.intent === "other" && !offList.degraded && offList.slots.role === "nurse");

  const malformed = parseExtraction("not json at all");
  check("malformed JSON -> degraded fallback", malformed.degraded && malformed.intent === "other");
  const badShape = parseExtraction(JSON.stringify({ intent: "career_advice", role: 42 }));
  check("wrong-shape slots -> degraded fallback", badShape.degraded);
  check("EMPTY_SLOTS validates against its own schema", intentSlotsSchema.safeParse(EMPTY_SLOTS).success);
}

console.log("\n== deriveLanesFromSlots: golden table ==");
{
  const hiringQ = deriveLanesFromSlots(slots({ hiring: true, role: "devops" }), "company_discovery");
  check("hiring slot opens the hiring lane", hiringQ.hiring === true);
  check("pure discovery suppresses market/articles (mirrors companyDiscoveryGate)", !hiringQ.market && !hiringQ.articles);

  const hiringWithFacts = deriveLanesFromSlots(slots({ hiring: true, wantsFacts: true }), "company_discovery");
  check("discovery + facts keeps market open (mirrors marketAnalysisRequested)", hiringWithFacts.market === true);

  const provider = deriveLanesFromSlots(slots({ wantsProvider: true }), "agency_search");
  check("wantsProvider opens agencies", provider.agencies === true);

  const learning = deriveLanesFromSlots(slots({ skills: ["sql"] }), "skill_guidance");
  check("learning signal opens roadmaps + resources", learning.roadmaps && learning.resources);

  const facts = deriveLanesFromSlots(slots({ wantsFacts: true }), "job_search");
  check("wantsFacts opens market + articles", facts.market && facts.articles);

  const nothing = deriveLanesFromSlots(slots(), "other");
  check("empty slots open nothing", Object.values(nothing).every((v) => v === false), JSON.stringify(nothing));
}

console.log("\n== resolveLanes: fallback, transition OR, and the agency invariant ==");
{
  const q = "how do I become a data analyst?";
  check("absent extraction -> regex verbatim", JSON.stringify(resolveLanes(q)) === JSON.stringify(deriveLanesFromRegex(q)));
  check("degraded extraction -> regex verbatim", JSON.stringify(resolveLanes(q, extraction({ degraded: true }))) === JSON.stringify(deriveLanesFromRegex(q)));

  // Transition OR: slots that open nothing must never LOSE a lane regex opens.
  const merged = resolveLanes(q, extraction({ intent: "other", slots: slots() }));
  const regex = deriveLanesFromRegex(q);
  check("orWithRegex keeps every regex-opened lane", (Object.keys(regex) as Array<keyof typeof regex>).every((k) => !regex[k] || merged[k]), JSON.stringify({ merged, regex }));

  // THE invariant: slots asking for agencies on a query whose fail-closed gate
  // says no must NOT open the sensitive DB lane.
  const liveQ = "latest consulting firms hiring in Germany";
  check("fixture sanity: agencyGate vetoes the live-business query", agencyGate(liveQ) === false);
  const widened = resolveLanes(liveQ, extraction({ intent: "agency_search", slots: slots({ wantsProvider: true, hiring: true }) }));
  check("slots can NEVER widen the agencies lane past agencyGate", widened.agencies === false, JSON.stringify(widened));
  const curatedQ = "recommend verified consulting agencies in Delhi";
  const allowed = resolveLanes(curatedQ, extraction({ intent: "agency_search", slots: slots({ wantsProvider: true }) }));
  check("curated agency query stays open (gate passes)", allowed.agencies === true);

  // slots-primary mode (v3 flag) still enforces the invariant.
  const primary = resolveLanes(liveQ, extraction({ intent: "agency_search", slots: slots({ wantsProvider: true }) }), { orWithRegex: false });
  check("invariant holds with orWithRegex:false too", primary.agencies === false);
}

console.log("\n== shadowCompare: the rollout evidence ==");
{
  const q = "recommend verified consulting agencies in Delhi";
  const agreeing = shadowCompare(q, extraction({ intent: "agency_search", slots: slots({ wantsProvider: true }) }));
  check("comparison reports both derivations", !!agreeing.slotLanes && !!agreeing.regexLanes);
  const disagreeing = shadowCompare(q, extraction({ intent: "other", slots: slots() }));
  check("disagreement is detected", disagreeing.agree === false, JSON.stringify(disagreeing));
}

console.log("\n== searchStrategy: the freshness override ==");
{
  const q = "software engineer demand outlook";
  const base = resolveSearchStrategy(q);
  check("no slots -> regex table unchanged", base.strategy.corpus === "general");
  const breaking = resolveSearchStrategy(q, { freshness: "breaking" });
  check("freshness 'breaking' forces the news corpus", breaking.strategy.corpus === "news" && breaking.strategy.days === 30, JSON.stringify(breaking));
  const evergreen = resolveSearchStrategy(q, { freshness: "evergreen" });
  check("'evergreen' leaves the regex table authoritative", JSON.stringify(evergreen) === JSON.stringify(base));
  const none = resolveSearchStrategy(q, { freshness: "none" });
  check("'none' leaves the regex table authoritative", JSON.stringify(none) === JSON.stringify(base));
}

console.log(`\n================  ${passed} passed, ${failed} failed  ================`);
process.exit(failed === 0 ? 0 : 1);
