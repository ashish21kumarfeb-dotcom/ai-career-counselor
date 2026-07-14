// Single source of truth for the dynamic profile-onboarding fields.
//
// Both the onboarding UI (which fields to render for the selected user type) and
// the server-side mapping (answers -> user_profiles columns + `details` jsonb)
// read from here, so the two can never drift.
//
// Design (approved hybrid schema): the 6 common columns stay the canonical
// contract every downstream reader (dashboard, Profile Agent, prompt builder)
// already uses. Each field's `mapsTo` says whether its answer lands in one of
// those columns or in the type-specific `details` jsonb. Fields that map to
// `details` are keyed by `key` inside that JSON object.
//
// IMPORTANT (parent_guardian): the user is a parent/guardian asking on behalf of
// their CHILD. The common columns therefore describe the child (education =
// child's class, interests = child's interests) and careerGoal = the parent's
// concern. Downstream summaries/prompt must frame these as the child's, not the
// parent's — see agents/profile.ts and nodes/generate.ts.

// The user types offered in onboarding. `job_switcher` is intentionally absent —
// it remains valid in the DB enum for legacy rows but is folded into
// working_professional going forward.
export const OFFERED_USER_TYPES = [
  "student",
  "fresher",
  "working_professional",
  "parent_guardian",
] as const;

export type OfferedUserType = (typeof OFFERED_USER_TYPES)[number];

// The 6 common columns an answer can map to. Anything else goes to `details`.
export type ProfileColumn =
  | "education"
  | "currentRole"
  | "skills"
  | "interests"
  | "careerGoal"
  | "location";

export type OnboardingFieldDef = {
  // Form field name AND, for `mapsTo: "details"`, the JSON property key.
  key: string;
  label: string;
  placeholder?: string;
  hint?: string;
  kind: "text" | "textarea" | "choice";
  // Only for kind === "choice".
  options?: { value: string; label: string }[];
  mapsTo: ProfileColumn | "details";
};

// Step-1 choice cards. Kept here so the offered types, their copy, and their
// field sets live in one file.
export type UserTypeCard = {
  value: OfferedUserType;
  title: string;
  description: string;
  emoji: string;
};

export const USER_TYPE_CARDS: UserTypeCard[] = [
  {
    value: "student",
    title: "Student",
    description: "Still studying and exploring where to head next.",
    emoji: "🎓",
  },
  {
    value: "fresher",
    title: "Fresher",
    description: "Recently graduated and ready to start out.",
    emoji: "🌱",
  },
  {
    value: "working_professional",
    title: "Working professional",
    description: "Employed — looking to grow or switch careers.",
    emoji: "💼",
  },
  {
    value: "parent_guardian",
    title: "Parent / Guardian",
    description: "Seeking career guidance for my child.",
    emoji: "👪",
  },
];

// Human-readable labels for the stored user_type enum. Covers legacy
// `job_switcher`, which is folded into "Working professional" for display (we do
// NOT rewrite the stored value — no backfill). Shared by the dashboard, Profile
// Agent, and prompt builder so the labels can't drift.
export const USER_TYPE_LABELS: Record<string, string> = {
  student: "Student",
  fresher: "Fresher",
  working_professional: "Working professional",
  job_switcher: "Working professional",
  parent_guardian: "Parent / Guardian",
};

export const ONBOARDING_FIELDS: Record<OfferedUserType, OnboardingFieldDef[]> = {
  student: [
    { key: "currentClassYear", label: "Current class / year", placeholder: "e.g. Class 11, Science", kind: "text", mapsTo: "education" },
    { key: "stream", label: "Stream / subjects", placeholder: "e.g. PCM, Commerce", kind: "text", mapsTo: "details" },
    { key: "interests", label: "Interests", placeholder: "e.g. coding, design, biology", kind: "textarea", mapsTo: "interests" },
    { key: "favoriteSubjects", label: "Favourite subjects", placeholder: "e.g. Maths, Physics", kind: "text", mapsTo: "details" },
    { key: "confusedOptions", label: "Career options you're confused between", hint: "It's fine to be unsure — list what you're weighing up.", placeholder: "e.g. Engineering vs. Design", kind: "textarea", mapsTo: "careerGoal" },
    { key: "targetExams", label: "Target exams (if any)", placeholder: "e.g. JEE, NEET, none yet", kind: "text", mapsTo: "details" },
    { key: "location", label: "Location", placeholder: "e.g. Delhi, India", kind: "text", mapsTo: "location" },
  ],
  fresher: [
    { key: "highestEducation", label: "Highest education", placeholder: "e.g. B.Tech", kind: "text", mapsTo: "education" },
    { key: "degreeSpecialization", label: "Degree / specialization", placeholder: "e.g. Computer Science", kind: "text", mapsTo: "details" },
    { key: "graduationYear", label: "Graduation year", placeholder: "e.g. 2025", kind: "text", mapsTo: "details" },
    { key: "skills", label: "Skills", hint: "Comma-separated is fine.", placeholder: "e.g. Python, SQL, communication", kind: "textarea", mapsTo: "skills" },
    { key: "projects", label: "Projects / internships", placeholder: "e.g. built a portfolio site; 3-month marketing internship", kind: "textarea", mapsTo: "details" },
    { key: "careerGoal", label: "Career goal", placeholder: "e.g. Become a backend developer", kind: "textarea", mapsTo: "careerGoal" },
    { key: "preferredRole", label: "Preferred job role", placeholder: "e.g. Data Analyst", kind: "text", mapsTo: "details" },
    { key: "location", label: "Location", placeholder: "e.g. Bengaluru, India", kind: "text", mapsTo: "location" },
  ],
  working_professional: [
    { key: "currentRole", label: "Current role", placeholder: "e.g. Sales Associate", kind: "text", mapsTo: "currentRole" },
    { key: "yearsOfExperience", label: "Years of experience", placeholder: "e.g. 4", kind: "text", mapsTo: "details" },
    { key: "currentIndustry", label: "Current industry", placeholder: "e.g. FMCG, IT services", kind: "text", mapsTo: "details" },
    { key: "skills", label: "Skills", hint: "Comma-separated is fine.", placeholder: "e.g. Excel, CRM, team leadership", kind: "textarea", mapsTo: "skills" },
    { key: "careerGoal", label: "Career goal", placeholder: "e.g. Move into business analytics", kind: "textarea", mapsTo: "careerGoal" },
    {
      key: "growOrSwitch",
      label: "Are you looking to grow in your current field or switch career?",
      kind: "choice",
      options: [
        { value: "grow", label: "Grow in my current field" },
        { value: "switch", label: "Switch to a different career" },
      ],
      mapsTo: "details",
    },
    { key: "targetRoleIndustry", label: "Target role / industry (if switching)", placeholder: "e.g. Data Analyst in fintech", kind: "text", mapsTo: "details" },
    { key: "location", label: "Location", placeholder: "e.g. Pune, India", kind: "text", mapsTo: "location" },
  ],
  parent_guardian: [
    { key: "childEducation", label: "Child's current class / education level", placeholder: "e.g. Class 10", kind: "text", mapsTo: "education" },
    { key: "childStream", label: "Child's stream / subjects", placeholder: "e.g. Science, Commerce", kind: "text", mapsTo: "details" },
    { key: "childInterests", label: "Child's interests", placeholder: "e.g. sports, drawing, computers", kind: "textarea", mapsTo: "interests" },
    { key: "childStrengths", label: "Child's strengths", placeholder: "e.g. strong in maths, good communicator", kind: "textarea", mapsTo: "details" },
    { key: "parentConcern", label: "Your concern / guidance need", hint: "What would you like help with as a parent?", placeholder: "e.g. Which stream suits my child?", kind: "textarea", mapsTo: "careerGoal" },
    { key: "targetExams", label: "Target exams / career options (if any)", placeholder: "e.g. NEET, or unsure", kind: "text", mapsTo: "details" },
    { key: "location", label: "Location", placeholder: "e.g. Jaipur, India", kind: "text", mapsTo: "location" },
  ],
};

// The mapped shape written to `user_profiles` (common columns + details jsonb).
export type MappedProfile = {
  userType: OfferedUserType;
  education: string | null;
  currentRole: string | null;
  skills: string | null;
  interests: string | null;
  careerGoal: string | null;
  location: string | null;
  details: Record<string, string> | null;
};

function normalize(value: unknown): string | null {
  if (typeof value !== "string") return null;
  const trimmed = value.trim();
  return trimmed.length > 0 ? trimmed : null;
}

// Map a flat set of raw onboarding answers to the persisted profile shape. Only
// keys defined for `userType` are read (stray keys are ignored), so the output is
// robust to whatever a client sends. Non-string / blank answers become null
// (columns) or are omitted (details); details is null when nothing type-specific
// was provided.
export function mapAnswersToProfile(
  userType: OfferedUserType,
  answers: Record<string, unknown>
): MappedProfile {
  const columns: Record<ProfileColumn, string | null> = {
    education: null,
    currentRole: null,
    skills: null,
    interests: null,
    careerGoal: null,
    location: null,
  };
  const details: Record<string, string> = {};

  for (const field of ONBOARDING_FIELDS[userType]) {
    const value = normalize(answers[field.key]);
    if (value === null) continue;
    if (field.mapsTo === "details") {
      details[field.key] = value;
    } else {
      columns[field.mapsTo] = value;
    }
  }

  return {
    userType,
    ...columns,
    details: Object.keys(details).length > 0 ? details : null,
  };
}

// Fallback label for a details key with no matching field def (e.g. a key from an
// older field set): "childStrengths" -> "Child strengths".
function prettifyKey(key: string): string {
  return key
    .replace(/([A-Z])/g, " $1")
    .replace(/^./, (c) => c.toUpperCase())
    .trim();
}

// Turn a stored `details` jsonb object into display-ready { label, value } rows,
// using the type's field config for the exact onboarding label and, for choice
// fields, the option's human label (e.g. "switch" -> "Switch to a different
// career"). Non-string / blank values are skipped. Shared by the dashboard, the
// Profile Agent summary, and the prompt builder.
export function detailEntries(
  userType: string,
  details: Record<string, unknown> | null | undefined
): { key: string; label: string; value: string }[] {
  if (!details) return [];
  const defs =
    (ONBOARDING_FIELDS as Record<string, OnboardingFieldDef[]>)[userType] ?? [];
  const byKey = new Map(defs.map((f) => [f.key, f]));
  const out: { key: string; label: string; value: string }[] = [];
  for (const [key, raw] of Object.entries(details)) {
    if (typeof raw !== "string" || raw.trim().length === 0) continue;
    const def = byKey.get(key);
    const label = def?.label ?? prettifyKey(key);
    const value =
      def?.kind === "choice"
        ? def.options?.find((o) => o.value === raw)?.label ?? raw
        : raw;
    out.push({ key, label, value });
  }
  return out;
}
