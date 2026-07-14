// Unit tests for the dynamic-onboarding field config + mapAnswersToProfile().
// Pure — no DB, no LLM. Verifies each user type maps its answers to the correct
// common columns vs. the `details` jsonb, that blanks are dropped, and that stray
// keys are ignored.
// Run: npm run test:fields
import {
  ONBOARDING_FIELDS,
  OFFERED_USER_TYPES,
  USER_TYPE_CARDS,
  RESUME_STEP_TYPES,
  showsResumeStep,
  mapAnswersToProfile,
  unmapProfileToAnswers,
  resolveOfferedType,
  type ProfileForEdit,
} from "../src/lib/profile/fields";

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

// --- Config integrity ---------------------------------------------------------
console.log("\n== config integrity ==");
check("job_switcher is NOT offered", !(OFFERED_USER_TYPES as readonly string[]).includes("job_switcher"));
check("parent_guardian IS offered", (OFFERED_USER_TYPES as readonly string[]).includes("parent_guardian"));
check("4 user types offered", OFFERED_USER_TYPES.length === 4, String(OFFERED_USER_TYPES.length));
check("a card exists for every offered type", OFFERED_USER_TYPES.every((t) => USER_TYPE_CARDS.some((c) => c.value === t)));

// --- Resume step gating -------------------------------------------------------
console.log("\n== resume step gating ==");
check("resume step: fresher included", showsResumeStep("fresher"));
check("resume step: working_professional included", showsResumeStep("working_professional"));
check("resume step: student excluded", !showsResumeStep("student"));
check("resume step: parent_guardian excluded", !showsResumeStep("parent_guardian"));
check("resume step: exactly 2 types", RESUME_STEP_TYPES.size === 2, String(RESUME_STEP_TYPES.size));
check("resume step: all eligible types are offered", [...RESUME_STEP_TYPES].every((t) => (OFFERED_USER_TYPES as readonly string[]).includes(t)));

for (const type of OFFERED_USER_TYPES) {
  const fields = ONBOARDING_FIELDS[type];
  const keys = fields.map((f) => f.key);
  check(`${type}: has fields`, fields.length > 0);
  check(`${type}: unique field keys`, new Set(keys).size === keys.length, keys.join(","));
  check(`${type}: every field maps to a known target`, fields.every((f) => ["details", "yearsExperience", "education", "currentRole", "skills", "interests", "careerGoal", "location"].includes(f.mapsTo)));
  check(`${type}: choice fields declare options`, fields.every((f) => f.kind !== "choice" || (f.options?.length ?? 0) > 0));
  check(`${type}: collects a location`, fields.some((f) => f.mapsTo === "location"));
}

// --- Student mapping ----------------------------------------------------------
console.log("\n== student mapping ==");
const student = mapAnswersToProfile("student", {
  currentClassYear: "Class 11, Science",
  stream: "PCM",
  interests: "coding, robotics",
  favoriteSubjects: "Physics, Maths",
  confusedOptions: "Engineering vs. Design",
  targetExams: "JEE",
  location: "Delhi",
});
check("student: education = class/year", student.education === "Class 11, Science", String(student.education));
check("student: interests -> column", student.interests === "coding, robotics", String(student.interests));
check("student: confusedOptions -> careerGoal", student.careerGoal === "Engineering vs. Design", String(student.careerGoal));
check("student: location -> column", student.location === "Delhi", String(student.location));
check("student: stream -> details", student.details?.stream === "PCM", JSON.stringify(student.details));
check("student: favoriteSubjects -> details", student.details?.favoriteSubjects === "Physics, Maths", JSON.stringify(student.details));
check("student: targetExams -> details", student.details?.targetExams === "JEE", JSON.stringify(student.details));
check("student: no currentRole/skills", student.currentRole === null && student.skills === null);

// --- Fresher mapping ----------------------------------------------------------
console.log("\n== fresher mapping ==");
const fresher = mapAnswersToProfile("fresher", {
  highestEducation: "B.Tech",
  degreeSpecialization: "CSE",
  graduationYear: "2025",
  skills: "Python, SQL",
  projects: "portfolio site",
  careerGoal: "Backend developer",
  preferredRole: "Data Analyst",
  location: "Bengaluru",
});
check("fresher: education -> column", fresher.education === "B.Tech", String(fresher.education));
check("fresher: skills -> column", fresher.skills === "Python, SQL", String(fresher.skills));
check("fresher: careerGoal -> column", fresher.careerGoal === "Backend developer", String(fresher.careerGoal));
check("fresher: degree/gradYear/projects/preferredRole -> details",
  fresher.details?.degreeSpecialization === "CSE" &&
  fresher.details?.graduationYear === "2025" &&
  fresher.details?.projects === "portfolio site" &&
  fresher.details?.preferredRole === "Data Analyst",
  JSON.stringify(fresher.details));

// --- Working professional mapping --------------------------------------------
console.log("\n== working_professional mapping ==");
const wp = mapAnswersToProfile("working_professional", {
  currentRole: "Sales Associate",
  yearsOfExperience: "4",
  currentIndustry: "FMCG",
  skills: "Excel, CRM",
  careerGoal: "Move into analytics",
  growOrSwitch: "switch",
  targetRoleIndustry: "Data Analyst in fintech",
  location: "Pune",
});
check("wp: currentRole -> column", wp.currentRole === "Sales Associate", String(wp.currentRole));
check("wp: skills -> column", wp.skills === "Excel, CRM", String(wp.skills));
check("wp: careerGoal -> column", wp.careerGoal === "Move into analytics", String(wp.careerGoal));
check("wp: yearsExperience -> dedicated integer column", wp.yearsExperience === 4, String(wp.yearsExperience));
check("wp: yearsExperience NOT in details", wp.details?.yearsOfExperience === undefined, JSON.stringify(wp.details));
check("wp: growOrSwitch -> details", wp.details?.growOrSwitch === "switch", JSON.stringify(wp.details));
check("wp: industry/target -> details",
  wp.details?.currentIndustry === "FMCG" &&
  wp.details?.targetRoleIndustry === "Data Analyst in fintech",
  JSON.stringify(wp.details));

// yearsExperience parsing: strings, blanks, and non-numeric input.
check("wp: yearsExperience parses '10'", mapAnswersToProfile("working_professional", { yearsOfExperience: "10" }).yearsExperience === 10);
check("wp: yearsExperience blank -> null", mapAnswersToProfile("working_professional", { yearsOfExperience: "" }).yearsExperience === null);
check("wp: yearsExperience number input -> value", mapAnswersToProfile("working_professional", { yearsOfExperience: 7 as unknown as string }).yearsExperience === 7);
check("wp: yearsExperience non-numeric -> null", mapAnswersToProfile("working_professional", { yearsOfExperience: "abc" }).yearsExperience === null);
check("student: yearsExperience null (field absent)", mapAnswersToProfile("student", { location: "Delhi" }).yearsExperience === null);

// --- Parent/guardian mapping (child-framed) -----------------------------------
console.log("\n== parent_guardian mapping ==");
const parent = mapAnswersToProfile("parent_guardian", {
  childEducation: "Class 10",
  childStream: "Science",
  childInterests: "sports, computers",
  childStrengths: "strong in maths",
  parentConcern: "Which stream suits my child?",
  targetExams: "NEET",
  location: "Jaipur",
});
check("parent: child education -> education column", parent.education === "Class 10", String(parent.education));
check("parent: child interests -> interests column", parent.interests === "sports, computers", String(parent.interests));
check("parent: parent concern -> careerGoal column", parent.careerGoal === "Which stream suits my child?", String(parent.careerGoal));
check("parent: child stream/strengths + exams -> details",
  parent.details?.childStream === "Science" &&
  parent.details?.childStrengths === "strong in maths" &&
  parent.details?.targetExams === "NEET",
  JSON.stringify(parent.details));

// --- Blank + stray-key handling ----------------------------------------------
console.log("\n== normalization ==");
const sparse = mapAnswersToProfile("student", {
  currentClassYear: "  Class 9  ",
  stream: "   ",
  interests: "",
  bogusKey: "should be ignored",
});
check("blank column answer -> null", sparse.interests === null, String(sparse.interests));
check("whitespace-only detail -> omitted", sparse.details === null || sparse.details.stream === undefined, JSON.stringify(sparse.details));
check("column value trimmed", sparse.education === "Class 9", String(sparse.education));
check("stray key ignored", !(sparse.details && "bogusKey" in sparse.details), JSON.stringify(sparse.details));

const empty = mapAnswersToProfile("fresher", {});
check("no answers -> details null", empty.details === null, JSON.stringify(empty.details));
check("no answers -> all columns null", [empty.education, empty.currentRole, empty.skills, empty.interests, empty.careerGoal, empty.location].every((v) => v === null));
check("userType always echoed", empty.userType === "fresher");

// --- unmapProfileToAnswers (edit prefill) ------------------------------------
console.log("\n== unmap / edit prefill ==");

// A stored row -> answers -> mapped again should reproduce the mapped shape.
function rowFrom(userType: string, answers: Record<string, string>): ProfileForEdit {
  const m = mapAnswersToProfile(userType as "student", answers);
  return {
    userType,
    education: m.education,
    currentRole: m.currentRole,
    skills: m.skills,
    interests: m.interests,
    careerGoal: m.careerGoal,
    location: m.location,
    yearsExperience: m.yearsExperience,
    details: m.details,
  };
}

const wpAnswers = { currentRole: "Sales Associate", yearsOfExperience: "6", currentIndustry: "FMCG", skills: "Excel", careerGoal: "Analytics", growOrSwitch: "switch", targetRoleIndustry: "Data Analyst", location: "Pune" };
const wpRow = rowFrom("working_professional", wpAnswers);
const wpUnmapped = unmapProfileToAnswers(wpRow);
check("unmap: userType preserved", wpUnmapped.userType === "working_professional");
check("unmap: currentRole prefilled", wpUnmapped.answers.currentRole === "Sales Associate", wpUnmapped.answers.currentRole);
check("unmap: yearsExperience stringified", wpUnmapped.answers.yearsOfExperience === "6", wpUnmapped.answers.yearsOfExperience);
check("unmap: choice value prefilled", wpUnmapped.answers.growOrSwitch === "switch", wpUnmapped.answers.growOrSwitch);
check("unmap: details field prefilled", wpUnmapped.answers.currentIndustry === "FMCG", wpUnmapped.answers.currentIndustry);

// Round-trip for every type: map(unmap(row)) deep-equals the original mapped row.
for (const type of OFFERED_USER_TYPES) {
  const answers: Record<string, string> = {};
  for (const f of ONBOARDING_FIELDS[type]) {
    answers[f.key] = f.kind === "number" ? "4" : f.kind === "choice" ? (f.options?.[0]?.value ?? "x") : `${f.key}-val`;
  }
  const row = rowFrom(type, answers);
  const re = mapAnswersToProfile(type, unmapProfileToAnswers(row).answers);
  check(`round-trip ${type}: columns + years + details match`,
    JSON.stringify(re) === JSON.stringify(mapAnswersToProfile(type, answers)),
    JSON.stringify(re));
}

// Legacy job_switcher folds into working_professional for editing.
check("resolveOfferedType: job_switcher -> working_professional", resolveOfferedType("job_switcher") === "working_professional");
check("resolveOfferedType: known passes through", resolveOfferedType("student") === "student");
check("resolveOfferedType: unknown -> working_professional", resolveOfferedType("banana") === "working_professional");
const legacyRow = rowFrom("working_professional", { currentRole: "Lead" });
legacyRow.userType = "job_switcher";
check("unmap: legacy job_switcher -> working_professional", unmapProfileToAnswers(legacyRow).userType === "working_professional");

console.log(`\n================  ${passed} passed, ${failed} failed  ================`);
process.exit(failed === 0 ? 0 : 1);
