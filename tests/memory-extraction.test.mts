// Memory extraction tests. Two parts:
//   A) deterministic unit tests for the guards (isValidMemoryKey, isGrounded)
//   B) live integration tests for the extraction quality categories (hit Groq)
// Run: npm run test:memory   (requires GROQ_API_KEY)
import "dotenv/config";
import { extractMemories, isValidMemoryKey, isGrounded } from "../src/lib/ai/memory";

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
const lc = (m: { value: string }) => m.value.toLowerCase();

// ---------------------------------------------------------------------------
console.log("\n== A. Unit: isValidMemoryKey (allowlist) ==");
check("accepts the fixed vocabulary", ["target_role_or_company", "work_preferences", "constraints", "timeline", "actions_taken"].every(isValidMemoryKey));
check("rejects non-canonical keys", ["project_timeline", "interview_prep_timeline", "sql_learning_preference", "goal"].every((k) => !isValidMemoryKey(k)));
check("rejects bad format", !isValidMemoryKey("Timeline") && !isValidMemoryKey("") && !isValidMemoryKey("TIMELINE"));

console.log("\n== A. Unit: isGrounded ==");
check("keeps grounded paraphrase", isGrounded("User may switch jobs soon", "I may switch jobs soon."));
check("keeps grounded w/ matching number", isGrounded("User plans to switch within 4 months", "I will switch within 4 months."));
check("number guard drops wrong number", !isGrounded("switch within 3 months", "I will switch within 4 months."));
check("drops wholesale fabrication", !isGrounded("software engineer at Google", "What should my job search plan look like?"));

// ---------------------------------------------------------------------------
console.log("\n== B. Live extraction categories ==");

async function run(label: string, input: string) {
  const res = await extractMemories(input);
  console.log(`\n[${label}] input: ${JSON.stringify(input)}`);
  console.log(`  -> ${JSON.stringify(res)}`);
  // cross-cutting: every returned key is one of the allowed fixed keys
  check(`${label}: all keys allowed`, res.every((m) => isValidMemoryKey(m.key)));
  return res;
}

// Test 1 — relative + absolute timeline must both be kept, merged
{
  const r = await run("T1 relative+absolute", "Okay then i will take one month extra to prepare. Within 4 months i will switch.");
  const merged = r.find((m) => /\b4\b/.test(m.value) && /(one|1)\b|extra/i.test(m.value));
  check("T1: one memory merges relative(one/extra) + absolute(4)", !!merged, JSON.stringify(r));
}

// Test 2 — multiple related facts in one message
{
  const r = await run("T2 multi-fact", "I want to prepare SQL daily and focus more on interview questions than theory.");
  const m = r.find((x) => ["sql", "daily", "interview", "theor"].every((t) => lc(x).includes(t)));
  check("T2: value keeps sql+daily+interview+theory together", !!m, JSON.stringify(r));
}

// Test 3 — context-dependent fragment becomes self-contained
{
  const r = await run("T3 self-contained", "From now on, explain this topic with real project examples.");
  const m = r.find((x) => lc(x).includes("project") && lc(x).includes("example") && /(explan|prefer)/.test(lc(x)));
  check("T3: self-contained 'real project examples' preference", !!m, JSON.stringify(r));
  check("T3: does not store the raw 'this topic' fragment", r.every((x) => !lc(x).includes("this topic")));
}

// Test 4 — do not infer missing facts
{
  const r = await run("T4 no-inference", "I may switch jobs soon.");
  const m = r.find((x) => lc(x).includes("switch") && lc(x).includes("job"));
  check("T4: keeps the stated 'may switch jobs' fact", !!m, JSON.stringify(r));
  const invented = r.find((x) => /\d|developer|engineer|\.net|full[\s-]?stack|google|salary|\$|month|week|year/i.test(x.value));
  check("T4: invents no role/company/salary/timeline", !invented, invented ? JSON.stringify(invented) : "");
}

// Test 5 — ignore non-durable message
{
  const r = await run("T5 non-durable", "Okay thanks, I will check it later.");
  check("T5: returns [] for non-durable message", r.length === 0, JSON.stringify(r));
}

console.log(`\n================  ${passed} passed, ${failed} failed  ================`);
process.exit(failed === 0 ? 0 : 1);
