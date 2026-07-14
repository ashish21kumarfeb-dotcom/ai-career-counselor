// Unit tests for the profile request schema (dynamic per-type validation).
// Pure — no DB, no LLM. Verifies offered types pass, job_switcher is rejected,
// choice fields are constrained, stray keys are stripped, and blanks normalize.
// Run: npm run test:validation
import { profileRequestSchema } from "../src/lib/profile/validation";

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

console.log("\n== accepted user types ==");
for (const userType of ["student", "fresher", "working_professional", "parent_guardian"]) {
  const res = profileRequestSchema.safeParse({ userType, answers: {} });
  check(`${userType} accepted (empty answers)`, res.success, res.success ? "" : JSON.stringify(res.error.flatten()));
}

console.log("\n== rejected user types ==");
check("job_switcher rejected", !profileRequestSchema.safeParse({ userType: "job_switcher", answers: {} }).success);
check("unknown type rejected", !profileRequestSchema.safeParse({ userType: "banana", answers: {} }).success);
check("missing userType rejected", !profileRequestSchema.safeParse({ answers: {} }).success);

console.log("\n== choice field constraint (growOrSwitch) ==");
const grow = profileRequestSchema.safeParse({ userType: "working_professional", answers: { growOrSwitch: "grow" } });
check("growOrSwitch=grow accepted", grow.success && grow.data.answers.growOrSwitch === "grow");
const switchRes = profileRequestSchema.safeParse({ userType: "working_professional", answers: { growOrSwitch: "switch" } });
check("growOrSwitch=switch accepted", switchRes.success);
check("growOrSwitch=nonsense rejected", !profileRequestSchema.safeParse({ userType: "working_professional", answers: { growOrSwitch: "sideways" } }).success);
const noChoice = profileRequestSchema.safeParse({ userType: "working_professional", answers: { growOrSwitch: "" } });
check("growOrSwitch empty -> null", noChoice.success && noChoice.data.answers.growOrSwitch === null, noChoice.success ? String(noChoice.data.answers.growOrSwitch) : "parse failed");

console.log("\n== normalization + stray keys ==");
const student = profileRequestSchema.safeParse({
  userType: "student",
  answers: { currentClassYear: "  Class 11  ", interests: "", bogus: "ignore me" },
});
check("student parses", student.success);
if (student.success) {
  const a = student.data.answers;
  check("trimmed value", a.currentClassYear === "Class 11", String(a.currentClassYear));
  check("blank -> null", a.interests === null, String(a.interests));
  check("stray key stripped", !("bogus" in a), JSON.stringify(a));
}

console.log("\n== max length guard ==");
const tooLong = profileRequestSchema.safeParse({
  userType: "fresher",
  answers: { skills: "x".repeat(2001) },
});
check("2001-char answer rejected", !tooLong.success);

console.log(`\n================  ${passed} passed, ${failed} failed  ================`);
process.exit(failed === 0 ? 0 : 1);
