// Query-resolution tests, centered on the two failure modes that pull in opposite
// directions:
//   FALSE NEGATIVE — a referential follow-up loses the thread (the original bug the
//   resolver was built for).
//   FALSE POSITIVE — a standalone question about a NEW subject gets the previous
//   subject grafted onto it, which biases retrieval, fails grounding, and lands the
//   run in the generic safe summary.
//
// Every case here is deterministic: each one exercises a path that returns BEFORE
// the LLM call, so the suite needs no model and no network.
// Run: npm run test:resolve
//
// dotenv is loaded even though no case here reaches the model or the database: the
// resolver module imports createCompletion, which imports the db client, which
// throws at module load when DATABASE_URL is unset. The env requirement comes from
// the import graph, not from anything this suite asserts.
import "dotenv/config";
import {
  resolveQuery,
  isTopicShift,
  hasReferentialMarker,
  isLikelyFollowUp,
} from "../src/lib/ai/resolveQuery";
import type { ChatTurn } from "../src/lib/ai/resolveQuery";

let passed = 0;
let failed = 0;
function check(name: string, cond: boolean, detail = "") {
  if (cond) {
    passed++;
    console.log(`  PASS  ${name}`);
  } else {
    failed++;
    console.log(`  FAIL  ${name}${detail ? "  :: " + detail : ""}`);
  }
}

// The reported conversation: two turns about cyber security, then a new subject.
const cyberHistory: ChatTurn[] = [
  { role: "user", content: "Cyber Security" },
  {
    role: "assistant",
    content:
      "Cyber security roles include SOC analyst, penetration tester and security engineer. Skills to focus on: networking, Linux, SIEM tools.",
  },
  { role: "user", content: "Average salary in Cyber Security" },
  {
    role: "assistant",
    content:
      "Entry-level cyber security salaries in India typically range from 4-8 LPA; experienced security engineers earn more.",
  },
];

console.log("\n-- referential markers --");
check(
  "existential 'there' is NOT a reference",
  !hasReferentialMarker("Is there any career in fine arts?")
);
check("deictic 'that' IS a reference", hasReferentialMarker("What skills does that role need?"));
check("pronoun 'it' IS a reference", hasReferentialMarker("Is it a good long-term choice?"));
check("'what about' IS a reference", hasReferentialMarker("What about salary?"));

console.log("\n-- follow-up heuristic --");
check(
  "the reported query is no longer classed a follow-up",
  !isLikelyFollowUp("Is there any career in fine arts?")
);
check("short fragments still go to the resolver", isLikelyFollowUp("and the roadmap?"));

console.log("\n-- elliptical corrections --");
// A correction restates the SUBJECT and leans on the conversation for the verb. It
// carries no pronoun and no deictic, so hasReferentialMarker cannot see it; long
// enough ones also clear the short-fragment shortcut. Unrecognized, "I mean devops
// and cloud." reached the gates verbatim, matching neither RESOURCE_TERMS nor any
// external-tool gate — so the learning sections were gated out and no external
// search ran, on the very turn the user was correcting course.
check(
  "a 5-word correction is a follow-up ('I mean X')",
  isLikelyFollowUp("I mean devops and cloud.")
);
check(
  "an 'actually' correction is a follow-up",
  isLikelyFollowUp("Actually I want to focus on cloud engineering")
);
check(
  "an additive tail is a follow-up ('... as well')",
  isLikelyFollowUp("Kubernetes and Terraform as well")
);
check(
  "corrections do NOT become referential markers",
  !hasReferentialMarker("I mean devops and cloud.") &&
    !hasReferentialMarker("Actually, is there any career in fine arts?")
);
// The reason the correction patterns live in their own list: hasReferentialMarker is
// also the early-return in isTopicShift and graftsHistoryTopic. Had corrections been
// added there, a correction-SHAPED topic change would have both guards disabled and
// would get the old subject grafted on — the exact contamination this module guards.
check(
  "a correction-shaped topic change is still a topic shift",
  isTopicShift("Actually, is there any career in fine arts?", cyberHistory)
);
check(
  "an unrelated long question is still not a follow-up",
  !isLikelyFollowUp("What is the average salary for a data engineer in India?")
);

console.log("\n-- topic-shift detection --");
check(
  "new subject after cyber security is a shift",
  isTopicShift("Is there any career in fine arts?", cyberHistory)
);
check(
  "a same-subject standalone question is NOT a shift",
  !isTopicShift("What is the average salary for a cyber security engineer?", cyberHistory)
);
check(
  "a referential follow-up is never a shift, however novel its wording",
  !isTopicShift("Does that role require a postgraduate degree in forensics?", cyberHistory)
);
check("no history means no shift", !isTopicShift("Is there any career in fine arts?", []));
check(
  "a short fragment is never a shift (it is elliptical, not a new subject)",
  !isTopicShift("fine arts?", cyberHistory)
);

console.log("\n-- resolveQuery (LLM-free paths) --");
const results = await Promise.all([
  resolveQuery("Is there any career in fine arts?", cyberHistory),
  resolveQuery("Is there any career in fine arts?", []),
  resolveQuery("What is the average salary for a data scientist in Bangalore?", cyberHistory),
]);
check(
  "the reported query survives resolution unchanged",
  results[0] === "Is there any career in fine arts?",
  results[0]
);
check("first turn passes through", results[1] === "Is there any career in fine arts?", results[1]);
check(
  "an unrelated standalone question passes through",
  results[2] === "What is the average salary for a data scientist in Bangalore?",
  results[2]
);

console.log(`\n${passed} passed, ${failed} failed`);
process.exit(failed > 0 ? 1 : 0);
