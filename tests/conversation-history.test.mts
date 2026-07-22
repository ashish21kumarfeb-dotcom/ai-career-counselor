// Conversation-history tests. LIVE — hits the real conversations /
// conversation_messages tables, because every property under test is a property
// of the STORE: that the window keeps the newest turns, that the cascade actually
// deletes, and above all that one user cannot open another user's thread. A
// stubbed repository would assert that the stub does what the stub does.
//
// Creates two throwaway users (the tables are user-scoped by foreign key, so
// there is no synthetic-subject trick available here as there is for rate limits)
// and deletes everything it made at the end.
// Run: npm run test:conversations    (needs DATABASE_URL)
import "dotenv/config";
import { eq, inArray } from "drizzle-orm";
import { db } from "../src/db";
import { conversationMessages, conversations, users } from "../src/db/schema";
import {
  appendMessage,
  createConversation,
  getConversationMessages,
  getRecentTurns,
  listConversations,
  openConversation,
  MAX_HISTORY_TURNS,
  MAX_MESSAGE_CHARS,
} from "../src/lib/conversations/queries";
import { summarizeAssistantTurn } from "../src/lib/conversations/summarize";

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

const stamp = Math.floor(Math.random() * 1e9);
const emails = [`test-conv-a-${stamp}@example.test`, `test-conv-b-${stamp}@example.test`];
const userIds: string[] = [];

try {
  const created = await db
    .insert(users)
    .values(emails.map((email) => ({ email })))
    .returning({ id: users.id });
  userIds.push(...created.map((r) => r.id));
  const [alice, bob] = userIds;

  console.log("\n== a thread is created and owned ==");
  const convId = await createConversation(alice, "  What careers suit a data analyst?  ");
  check("createConversation returns an id", typeof convId === "string" && convId.length > 0);
  check("owner can open it", (await openConversation(convId, alice)) === convId);

  console.log("\n== ownership is enforced, not assumed ==");
  // The property the whole module exists to protect: a conversation id travels in
  // a request body, so accepting one without checking who owns it would let any
  // authenticated user read and extend anyone else's conversation.
  check("a stranger cannot open it", (await openConversation(convId, bob)) === undefined);
  check(
    "a stranger reads it as empty",
    (await getConversationMessages(convId, bob)).length === 0
  );
  const bobConv = await createConversation(bob, "Bob's thread");
  check("the owner cannot open someone else's", (await openConversation(bobConv, alice)) === undefined);

  console.log("\n== turns round-trip in order ==");
  await appendMessage({ conversationId: convId, role: "user", content: "First question" });
  await appendMessage({ conversationId: convId, role: "assistant", content: "First answer" });
  await appendMessage({ conversationId: convId, role: "user", content: "Second question" });

  const turns = await getRecentTurns(convId);
  check("all three turns returned", turns.length === 3, String(turns.length));
  check(
    "oldest first",
    turns[0].content === "First question" && turns[2].content === "Second question",
    JSON.stringify(turns.map((t) => t.content))
  );
  check(
    "roles round-trip",
    turns[0].role === "user" && turns[1].role === "assistant",
    JSON.stringify(turns.map((t) => t.role))
  );

  console.log("\n== the window keeps the NEWEST turns ==");
  // A LIMIT over an ascending scan would keep the OLDEST turns — the exact
  // opposite of a conversation window, and a bug that looks fine until a thread
  // outgrows the limit and the assistant starts answering as if it were turn 3.
  const longConv = await createConversation(alice, "long thread");
  for (let i = 0; i < MAX_HISTORY_TURNS + 5; i++) {
    await appendMessage({ conversationId: longConv, role: "user", content: `turn ${i}` });
  }
  const window = await getRecentTurns(longConv);
  check("window is capped", window.length === MAX_HISTORY_TURNS, String(window.length));
  check(
    "the LAST turn survives the cap",
    window[window.length - 1].content === `turn ${MAX_HISTORY_TURNS + 4}`,
    window[window.length - 1].content
  );
  check(
    "the earliest turns are the ones dropped",
    window[0].content === "turn 5",
    window[0].content
  );

  console.log("\n== oversized turns cannot grow the prompt ==");
  const huge = "x".repeat(MAX_MESSAGE_CHARS * 3);
  await appendMessage({ conversationId: bobConv, role: "user", content: huge });
  const bobTurns = await getRecentTurns(bobConv);
  check(
    "content clipped at the write",
    bobTurns[0].content.length <= MAX_MESSAGE_CHARS,
    String(bobTurns[0].content.length)
  );

  console.log("\n== the thread list is ordered by recency ==");
  const list = await listConversations(alice);
  check("both of this user's threads listed", list.length === 2, String(list.length));
  check("most recently active first", list[0].id === longConv, JSON.stringify(list.map((c) => c.id)));
  check("title is trimmed", list[1].title === "What careers suit a data analyst?", String(list[1].title));
  check("other users' threads are absent", !list.some((c) => c.id === bobConv));

  console.log("\n== deleting a thread deletes its turns ==");
  // Enforced by ON DELETE CASCADE in the schema, not by application code —
  // orphaned turns would stay retrievable by any future window query.
  await db.delete(conversations).where(eq(conversations.id, bobConv));
  const orphans = await db
    .select({ id: conversationMessages.id })
    .from(conversationMessages)
    .where(eq(conversationMessages.conversationId, bobConv));
  check("no orphaned messages remain", orphans.length === 0, String(orphans.length));

  console.log("\n== the assistant turn is the WHOLE answer ==");
  // A follow-up like "and the roadmap for that?" can only resolve if the stored
  // turn contains what the user actually saw, not just the prose section.
  const flat = summarizeAssistantTurn({
    ai_suggestion: "Data analysis is a strong fit.",
    roadmap: { items: ["Learn SQL", "Build a portfolio"], suggested: true },
    skill_focus: ["SQL", "Python"],
    next_steps: ["Ship one dashboard"],
    resources: { items: [{ title: "SQL Basics", type: "career_data", url: null }] },
    agencies: { items: [{ name: "Acme Careers", location: null, services: null, website: null, source: null }] },
  });
  check("prose included", flat.includes("Data analysis is a strong fit."));
  check("roadmap included", flat.includes("Learn SQL"));
  check("skills included", flat.includes("SQL, Python"));
  check("next steps included", flat.includes("Ship one dashboard"));
  check("resource titles included", flat.includes("SQL Basics"));
  check("agency names included", flat.includes("Acme Careers"));
  check("empty sections flatten to nothing", summarizeAssistantTurn({}) === "");
  check("an absent response flattens to nothing", summarizeAssistantTurn(undefined) === "");
} finally {
  // Always clean up, including after a failed assertion. Conversations cascade to
  // their messages; users must go last (the conversations reference them).
  if (userIds.length) {
    await db.delete(conversations).where(inArray(conversations.userId, userIds));
    await db.delete(users).where(inArray(users.id, userIds));
  }
  console.log("\n(cleaned up test users and threads)");
}

console.log(`\n${failed === 0 ? "ALL PASS" : "FAILURES"} — passed: ${passed}, failed: ${failed}`);
process.exit(failed === 0 ? 0 : 1);
