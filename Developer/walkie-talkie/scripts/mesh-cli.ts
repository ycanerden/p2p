#!/usr/bin/env bun
// mesh-cli.ts — Simple CLI for Mesh agent coordination
// Usage:
//   bun mesh-cli.ts join <room> <name>    — Generate MCP config to join a room
//   bun mesh-cli.ts new                   — Create a new room
//   bun mesh-cli.ts status <room>         — Check room status
//   bun mesh-cli.ts send <room> <name> <message> — Send a message

const SERVER = process.env.MESH_SERVER || "https://trymesh.chat";
const [, , command, ...args] = process.argv;

async function main() {
  switch (command) {
    case "join": {
      const [room, name] = args;
      if (!room || !name) {
        console.log("Usage: mesh join <room> <name>");
        console.log("Example: mesh join mesh01 MyAgent");
        process.exit(1);
      }
      const config = {
        mcpServers: {
          mesh: {
            url: `${SERVER}/mcp?room=${room}&name=${encodeURIComponent(name)}`,
          },
        },
      };
      console.log("\n  Add this to your MCP config:\n");
      console.log(JSON.stringify(config, null, 2));
      console.log(`\n  Then restart your AI tool. ${name} will auto-connect to room ${room}.\n`);
      break;
    }

    case "new": {
      const res = await fetch(`${SERVER}/rooms/new`);
      const data = await res.json();
      console.log(`\n  Room created: ${data.room}`);
      console.log(`  Dashboard: ${SERVER}/dashboard?room=${data.room}`);
      console.log(`\n  Join with: bun mesh-cli.ts join ${data.room} YourName\n`);
      break;
    }

    case "status": {
      const [room] = args;
      if (!room) { console.log("Usage: mesh status <room>"); process.exit(1); }
      const [presRes, taskRes] = await Promise.all([
        fetch(`${SERVER}/api/presence?room=${encodeURIComponent(room)}`),
        fetch(`${SERVER}/tasks/room/${encodeURIComponent(room)}`),
      ]);
      const presence = await presRes.json();
      const tasks = await taskRes.json();

      console.log(`\n  Room: ${room}`);
      console.log(`  Agents online:`);
      if (presence.agents?.length) {
        for (const a of presence.agents) {
          const status = a.status === "online" ? "●" : "○";
          console.log(`    ${status} ${a.agent_name}${a.hostname ? ` (${a.hostname})` : ""}`);
        }
      } else {
        console.log("    (none)");
      }
      if (tasks.tasks?.length) {
        console.log(`  Tasks: ${tasks.count}`);
        for (const t of tasks.tasks) {
          const icon = t.status === "done" ? "✓" : t.status === "in_progress" ? "→" : "○";
          console.log(`    ${icon} [${t.task_id}] ${t.task_title} — ${t.agent_name} (${t.status})`);
        }
      }
      console.log("");
      break;
    }

    case "send": {
      const [room, name, ...msgParts] = args;
      const message = msgParts.join(" ");
      if (!room || !name || !message) {
        console.log("Usage: mesh send <room> <name> <message>");
        process.exit(1);
      }
      const res = await fetch(`${SERVER}/api/send?room=${encodeURIComponent(room)}&name=${encodeURIComponent(name)}`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ message }),
      });
      const data = await res.json();
      if (data.ok) {
        console.log(`  Sent to room ${room} as ${name}.`);
      } else {
        console.log(`  Error: ${data.error}`);
      }
      break;
    }

    default:
      console.log(`
  Mesh CLI — Agent Coordination Tool

  Commands:
    mesh new                          Create a new room
    mesh join <room> <name>           Get MCP config to join a room
    mesh status <room>                See who's online and current tasks
    mesh send <room> <name> <msg>     Send a message to the room

  Examples:
    bun mesh-cli.ts new
    bun mesh-cli.ts join mesh01 Claude
    bun mesh-cli.ts status mesh01
    bun mesh-cli.ts send mesh01 Claude "Hello team!"

  Server: ${SERVER}
`);
  }
}

main().catch(console.error);
