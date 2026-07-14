// Integration tests for the load-bearing onboarding path:
//   request body -> profileRequestSchema -> mapAnswersToProfile -> MappedProfile
// This is exactly what src/app/api/profile/route.ts runs. The sibling suites
// test validation (test:validation) and mapping (test:fields) in isolation; this
// one wires them together the way production does, and pins the type-switch
// safety guarantee (answers for one user type can't leak in under another).
// Pure — no DB, no LLM.
// Run: npm run test:onboarding
import {
  profileRequestSchema,
} from "../src/lib/profile/validation";
import {
  ONBOARDING_FIELDS,
  OFFERED_USER_TYPES,
  mapAnswersToProfile,
  unmapProfileToAnswers,
  type OfferedUserType,
  type MappedProfile,
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

// Run a raw request body through the exact production pipeline: validate, then
// map. Returns null when validation rejects the body (the route replies 400).
function pipeline(body: unknown): MappedProfile | null {
  const parsed = profileRequestSchema.safeParse(body);
  if (!parsed.success) return null;
  return mapAnswersToProfile(parsed.data.userType, parsed.data.answers);
}

// The keys a given type is allowed to persist into `details` (mapsTo: "details").
function detailKeysFor(type: OfferedUserType): Set<string> {
  return new Set(
    ONBOARDING_FIELDS[type]
      .filter((f) => f.mapsTo === "details")
      .map((f) => f.key)
  );
}

// --- 1. ONBOARDING_FIELDS exists for every offered type -----------------------
console.log("\n== onboarding fields present for all offered types ==");
for (const type of ["student", "fresher", "working_professional", "parent_guardian"] as const) {
  const fields = ONBOARDING_FIELDS[type];
  check(`${type}: field set defined + non-empty`, Array.isArray(fields) && fields.length > 0, String(fields?.length));
}
check("exactly the 4 offered types are keyed", Object.keys(ONBOARDING_FIELDS).sort().join(",") === [...OFFERED_USER_TYPES].sort().join(","), Object.keys(ONBOARDING_FIELDS).join(","));

// --- 2. Full valid payloads pass validation for all 4 types -------------------
// (The validation suite only checks empty answers; here we submit a realistic,
// fully-populated payload per type through the whole pipeline.)
console.log("\n== full valid payloads accepted end-to-end ==");

const studentMapped = pipeline({
  userType: "student",
  answers: {
    currentClassYear: "Class 11, Science",
    stream: "PCM",
    interests: "coding, robotics",
    favoriteSubjects: "Physics, Maths",
    confusedOptions: "Engineering vs. Design",
    targetExams: "JEE",
    location: "Delhi, India",
  },
});
check("student: pipeline accepted", studentMapped !== null);
check("student: education column from class/year", studentMapped?.education === "Class 11, Science", String(studentMapped?.education));
check("student: interests column", studentMapped?.interests === "coding, robotics", String(studentMapped?.interests));
check("student: confusedOptions -> careerGoal", studentMapped?.careerGoal === "Engineering vs. Design", String(studentMapped?.careerGoal));
check("student: location column", studentMapped?.location === "Delhi, India", String(studentMapped?.location));
check("student: details are only type-specific extras",
  !!studentMapped && Object.keys(studentMapped.details ?? {}).every((k) => detailKeysFor("student").has(k)),
  JSON.stringify(studentMapped?.details));
check("student: no work columns", studentMapped?.currentRole === null && studentMapped?.skills === null && studentMapped?.yearsExperience === null);

const fresherMapped = pipeline({
  userType: "fresher",
  answers: {
    highestEducation: "B.Tech",
    degreeSpecialization: "Computer Science",
    graduationYear: "2025",
    skills: "Python, SQL, communication",
    projects: "built a portfolio site",
    careerGoal: "Become a backend developer",
    preferredRole: "Data Analyst",
    location: "Bengaluru, India",
  },
});
check("fresher: pipeline accepted", fresherMapped !== null);
check("fresher: education column", fresherMapped?.education === "B.Tech", String(fresherMapped?.education));
check("fresher: skills column", fresherMapped?.skills === "Python, SQL, communication", String(fresherMapped?.skills));
check("fresher: careerGoal column", fresherMapped?.careerGoal === "Become a backend developer", String(fresherMapped?.careerGoal));
check("fresher: details are only type-specific extras",
  !!fresherMapped && Object.keys(fresherMapped.details ?? {}).every((k) => detailKeysFor("fresher").has(k)),
  JSON.stringify(fresherMapped?.details));
check("fresher: degree/gradYear/projects/preferredRole in details",
  fresherMapped?.details?.degreeSpecialization === "Computer Science" &&
  fresherMapped?.details?.graduationYear === "2025" &&
  fresherMapped?.details?.projects === "built a portfolio site" &&
  fresherMapped?.details?.preferredRole === "Data Analyst",
  JSON.stringify(fresherMapped?.details));

const wpMapped = pipeline({
  userType: "working_professional",
  answers: {
    currentRole: "Sales Associate",
    yearsOfExperience: "4",
    currentIndustry: "FMCG",
    skills: "Excel, CRM, team leadership",
    careerGoal: "Move into business analytics",
    growOrSwitch: "switch",
    targetRoleIndustry: "Data Analyst in fintech",
    location: "Pune, India",
  },
});
check("working_professional: pipeline accepted", wpMapped !== null);
check("working_professional: currentRole column", wpMapped?.currentRole === "Sales Associate", String(wpMapped?.currentRole));
check("working_professional: yearsExperience -> dedicated integer column", wpMapped?.yearsExperience === 4, String(wpMapped?.yearsExperience));
check("working_professional: yearsExperience NOT duplicated into details", wpMapped?.details?.yearsOfExperience === undefined, JSON.stringify(wpMapped?.details));
check("working_professional: choice value mapped", wpMapped?.details?.growOrSwitch === "switch", JSON.stringify(wpMapped?.details));
check("working_professional: details are only type-specific extras",
  !!wpMapped && Object.keys(wpMapped.details ?? {}).every((k) => detailKeysFor("working_professional").has(k)),
  JSON.stringify(wpMapped?.details));

// working_professional without a years answer: the integer column stays null.
const wpNoYears = pipeline({
  userType: "working_professional",
  answers: { currentRole: "Analyst", skills: "SQL", careerGoal: "Lead", location: "Remote" },
});
check("working_professional: yearsExperience null when omitted", wpNoYears?.yearsExperience === null, String(wpNoYears?.yearsExperience));

// --- 3. parent_guardian is child-framed; careerGoal is the parent's concern ---
console.log("\n== parent_guardian child-framing ==");
const parentMapped = pipeline({
  userType: "parent_guardian",
  answers: {
    childEducation: "Class 10",
    childStream: "Science",
    childInterests: "sports, computers",
    childStrengths: "strong in maths",
    parentConcern: "Which stream suits my child?",
    targetExams: "NEET",
    location: "Jaipur, India",
  },
});
check("parent_guardian: pipeline accepted", parentMapped !== null);
check("parent_guardian: child education -> education column", parentMapped?.education === "Class 10", String(parentMapped?.education));
check("parent_guardian: child interests -> interests column", parentMapped?.interests === "sports, computers", String(parentMapped?.interests));
check("parent_guardian: careerGoal represents the parent's concern", parentMapped?.careerGoal === "Which stream suits my child?", String(parentMapped?.careerGoal));
check("parent_guardian: child-specific extras -> details",
  parentMapped?.details?.childStream === "Science" &&
  parentMapped?.details?.childStrengths === "strong in maths" &&
  parentMapped?.details?.targetExams === "NEET",
  JSON.stringify(parentMapped?.details));
check("parent_guardian: details are only type-specific extras",
  !!parentMapped && Object.keys(parentMapped.details ?? {}).every((k) => detailKeysFor("parent_guardian").has(k)),
  JSON.stringify(parentMapped?.details));

// --- 4. Rejected submissions -------------------------------------------------
console.log("\n== rejected submissions ==");
check("job_switcher rejected for new onboarding", pipeline({ userType: "job_switcher", answers: {} }) === null);
check("unknown userType rejected", pipeline({ userType: "freelancer", answers: {} }) === null);
check("missing userType rejected", pipeline({ answers: {} }) === null);
check("over-length text rejected (2001 chars)", pipeline({ userType: "fresher", answers: { skills: "x".repeat(2001) } }) === null);
check("max-length text accepted (2000 chars)", pipeline({ userType: "fresher", answers: { skills: "x".repeat(2000) } }) !== null);

// --- 5. Type-switch safety ---------------------------------------------------
// Stale answers belonging to a DIFFERENT user type must not survive. Validation
// strips unknown keys (so they never reach the mapper), and the mapper only reads
// keys defined for the submitted type. Either layer alone is enough; we assert
// the full path is clean.
console.log("\n== type-switch safety ==");

// (a) Through the pipeline: submit working_professional answers under `student`.
const crossType = pipeline({
  userType: "student",
  answers: {
    // legitimate student answer
    currentClassYear: "Class 11",
    // stale working_professional-only answers — must be dropped
    currentRole: "Sales Associate",
    yearsOfExperience: "9",
    growOrSwitch: "switch",
    currentIndustry: "FMCG",
  },
});
check("cross-type: pipeline still accepts (unknown keys stripped, not rejected)", crossType !== null);
check("cross-type: legit student answer kept", crossType?.education === "Class 11", String(crossType?.education));
check("cross-type: WP currentRole did NOT leak into currentRole column", crossType?.currentRole === null, String(crossType?.currentRole));
check("cross-type: WP yearsOfExperience did NOT leak into yearsExperience", crossType?.yearsExperience === null, String(crossType?.yearsExperience));
check("cross-type: WP-only keys absent from details",
  !!crossType && !["growOrSwitch", "currentIndustry"].some((k) => (crossType.details ?? {})[k] !== undefined),
  JSON.stringify(crossType?.details));
check("cross-type: details only holds valid student detail keys",
  !!crossType && Object.keys(crossType.details ?? {}).every((k) => detailKeysFor("student").has(k)),
  JSON.stringify(crossType?.details));

// (b) At the validation layer directly: stripped keys are gone from parsed data.
const parsedCross = profileRequestSchema.safeParse({
  userType: "student",
  answers: { currentClassYear: "Class 11", currentRole: "X", yearsOfExperience: "9" },
});
check("cross-type: validation strips foreign keys",
  parsedCross.success && !("currentRole" in parsedCross.data.answers) && !("yearsOfExperience" in parsedCross.data.answers),
  parsedCross.success ? JSON.stringify(parsedCross.data.answers) : "parse failed");

// (c) At the mapper directly: foreign keys are ignored even if they reach it.
const mapperCross = mapAnswersToProfile("student", { currentClassYear: "Class 12", currentRole: "X", yearsOfExperience: 9 as unknown as string });
check("cross-type: mapper ignores foreign currentRole", mapperCross.currentRole === null, String(mapperCross.currentRole));
check("cross-type: mapper ignores foreign yearsOfExperience", mapperCross.yearsExperience === null, String(mapperCross.yearsExperience));

// --- 6. Edit flow: stored row round-trips through unmap + pipeline ------------
console.log("\n== edit flow round-trip ==");

function rowFrom(userType: string, mapped: MappedProfile): ProfileForEdit {
  return {
    userType,
    education: mapped.education,
    currentRole: mapped.currentRole,
    skills: mapped.skills,
    interests: mapped.interests,
    careerGoal: mapped.careerGoal,
    location: mapped.location,
    yearsExperience: mapped.yearsExperience,
    details: mapped.details,
  };
}

// For every offered type, mapping the unmapped answers reproduces the stored row.
for (const type of OFFERED_USER_TYPES) {
  const mapped = pipeline({
    userType: type,
    answers: Object.fromEntries(
      ONBOARDING_FIELDS[type].map((f) => [
        f.key,
        f.kind === "number" ? "3" : f.kind === "choice" ? (f.options?.[0]?.value ?? "x") : `${f.key}-value`,
      ])
    ),
  });
  check(`${type}: pipeline produced a row`, mapped !== null);
  if (!mapped) continue;
  const { userType: resolvedType, answers } = unmapProfileToAnswers(rowFrom(type, mapped));
  check(`${type}: unmap resolves same type`, resolvedType === type, resolvedType);
  const remapped = mapAnswersToProfile(resolvedType, answers);
  check(`${type}: row survives unmap -> remap unchanged`, JSON.stringify(remapped) === JSON.stringify(mapped), JSON.stringify(remapped));
}

// Details values are restored into the correct fields on edit.
const wpRow = rowFrom("working_professional", wpMapped as MappedProfile);
const wpUnmapped = unmapProfileToAnswers(wpRow);
check("edit: choice detail restored to its field", wpUnmapped.answers.growOrSwitch === "switch", wpUnmapped.answers.growOrSwitch);
check("edit: string detail restored to its field", wpUnmapped.answers.currentIndustry === "FMCG", wpUnmapped.answers.currentIndustry);
check("edit: yearsExperience integer restored as string", wpUnmapped.answers.yearsOfExperience === "4", wpUnmapped.answers.yearsOfExperience);

// Legacy job_switcher rows are treated safely as working_professional on edit.
const legacyRow = rowFrom("working_professional", wpMapped as MappedProfile);
legacyRow.userType = "job_switcher";
const legacyUnmapped = unmapProfileToAnswers(legacyRow);
check("edit: legacy job_switcher row -> working_professional", legacyUnmapped.userType === "working_professional", legacyUnmapped.userType);
check("edit: legacy row still restores its answers", legacyUnmapped.answers.currentRole === "Sales Associate", legacyUnmapped.answers.currentRole);

console.log(`\n================  ${passed} passed, ${failed} failed  ================`);
process.exit(failed === 0 ? 0 : 1);
