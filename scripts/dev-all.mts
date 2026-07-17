// dev:all — run the MCP server and the Next dev server together, with the dev
// server pre-wired to USE the MCP server (MCP_ENABLED=true). This is the
// demo-safe entrypoint: `npm run dev` alone leaves MCP off, so every gated tool
// quietly takes the direct DB path. One command, both processes, MCP in the loop.
//
// Cross-platform on purpose (Windows/macOS/Linux): a tiny spawn harness instead of
// a `concurrently`/`&`-style shell line, so it works the same in every terminal.
import "dotenv/config";
import { spawn, type ChildProcess } from "node:child_process";
import { checkMcpHealth } from "../src/lib/agent/tools/mcpClient";

const MCP_URL = process.env.MCP_URL ?? "http://127.0.0.1:3333/mcp";
const children: ChildProcess[] = [];
let shuttingDown = false;

// If either process dies, take the whole thing down — a half-up dev:all (Next
// running, MCP dead) is exactly the silent-fallback state this command prevents.
function shutdown(code: number): void {
  if (shuttingDown) return;
  shuttingDown = true;
  for (const c of children) {
    try {
      c.kill();
    } catch {
      // already gone
    }
  }
  process.exit(code);
}

function run(name: string, script: string, env: NodeJS.ProcessEnv): void {
  // shell:true so `npm` resolves to npm.cmd on Windows.
  const child = spawn("npm", ["run", script], { stdio: ["ignore", "inherit", "inherit"], env, shell: true });
  child.on("exit", (code) => {
    console.log(`[dev:all] '${name}' exited (${code ?? "signal"}) — stopping the other process.`);
    shutdown(code ?? 1);
  });
  children.push(child);
}

for (const sig of ["SIGINT", "SIGTERM"] as const) process.on(sig, () => shutdown(0));

console.log("[dev:all] starting MCP server + Next dev (MCP_ENABLED=true) …");
run("mcp:server", "mcp:server", { ...process.env });
run("dev", "dev", { ...process.env, MCP_ENABLED: "true", MCP_URL });

// Non-blocking readiness ping so the terminal shows when MCP is genuinely live and
// tools will run over the protocol — without holding up the dev server.
void (async () => {
  for (let i = 0; i < 30 && !shuttingDown; i++) {
    const h = await checkMcpHealth(1000);
    if (h.reachable) {
      console.log(`[dev:all] MCP server is live at ${h.url} — gated tools will run over the protocol.`);
      return;
    }
    await new Promise((resolve) => setTimeout(resolve, 1000));
  }
  if (!shuttingDown) console.log(`[dev:all] WARNING: MCP server not reachable at ${MCP_URL} yet — tools would fall back to direct.`);
})();
