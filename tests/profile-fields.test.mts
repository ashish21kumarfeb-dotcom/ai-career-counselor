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
  check(`${type}: every field maps to a column or details`, fields.every((f) => f.mapsTo === "details" || ["education", "currentRole", "skills", "interests", "careerGoal", "location"].includes(f.mapsTo)));
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
check("wp: growOrSwitch -> details", wp.details?.growOrSwitch === "switch", JSON.stringify(wp.details));
check("wp: yoe/industry/target -> details",
  wp.details?.yearsOfExperience === "4" &&
  wp.details?.currentIndustry === "FMCG" &&
  wp.details?.targetRoleIndustry === "Data Analyst in fintech",
  JSON.stringify(wp.details));

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

console.log(`\n================  ${passed} passed, ${failed} failed  ================`);
process.exit(failed === 0 ? 0 : 1);
