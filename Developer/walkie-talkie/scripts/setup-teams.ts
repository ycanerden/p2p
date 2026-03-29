// Setup script: Initialize team groups and assign tasks to all agents
// Run: bun setup-teams.ts

import {
  createRoomGroup,
  assignTask,
  getAllRoomGroups
} from "../src/room-manager.ts";

interface TeamSetup {
  groupName: string;
  topic: string;
  description: string;
  icon: string;
  color: string;
  agents: Array<{
    name: string;
    tasks: Array<{
      id: string;
      title: string;
      dueHours?: number;
    }>;
  }>;
}

const TEAMS: TeamSetup[] = [
  {
    groupName: "Phase 2 Core Team",
    topic: "Phase 2 Execution",
    description: "Main coordination for Phase 2 shipping - CORS, dashboard, testing",
    icon: "🚀",
    color: "#ff6b6b",
    agents: [
      {
        name: "Claude-Code",
        tasks: [
          { id: "COORD-001", title: "Coordinate all tasks & unblock team" },
          { id: "COORD-002", title: "Monitor dashboard and status" },
          { id: "COORD-003", title: "Facilitate team communication" },
        ],
      },
      {
        name: "Greg",
        tasks: [
          { id: "TASK-001", title: "Deploy CORS fix to production", dueHours: 1 },
          { id: "TASK-001B", title: "Verify CORS headers on deployed server" },
          { id: "TASK-006-B", title: "Finalize WebRTC signaling layer" },
        ],
      },
      {
        name: "Batman",
        tasks: [
          { id: "TASK-002", title: "Validate dashboard live data integration", dueHours: 2 },
          { id: "TASK-002B", title: "Fix any CORS or data format issues" },
          { id: "TASK-005", title: "Security audit - rate limiting & tokens", dueHours: 3 },
        ],
      },
      {
        name: "Goblin",
        tasks: [
          { id: "TASK-003", title: "Stress test: 5 agents × 60 seconds", dueHours: 2 },
          { id: "TASK-003B", title: "Monitor latency and error rates" },
          { id: "TASK-006", title: "WebRTC P2P bridge tools implementation" },
        ],
      },
      {
        name: "Friday",
        tasks: [
          { id: "TASK-004", title: "Code review: Layer 2 WebRTC plan", dueHours: 1 },
          { id: "TASK-004B", title: "Verify signaling requirements & security" },
          { id: "TASK-006-C", title: "Review P2P integration code" },
        ],
      },
      {
        name: "Gemini",
        tasks: [
          { id: "TASK-006-A", title: "Finish agent-bridge.share_file tool" },
          { id: "TASK-006-B", title: "Finish agent-bridge.assign_task tool" },
          { id: "TASK-006-C", title: "Finish agent-bridge.p2p_status tool" },
        ],
      },
    ],
  },

  {
    groupName: "WebRTC Architecture",
    topic: "P2P Bridge Implementation",
    description: "WebRTC P2P signaling, peer discovery, fallback modes",
    icon: "🌐",
    color: "#4ecdc4",
    agents: [
      {
        name: "Greg",
        tasks: [
          { id: "WEBRTC-001", title: "Implement peer discovery mechanism" },
          { id: "WEBRTC-002", title: "Add ICE candidate handling" },
          { id: "WEBRTC-003", title: "Implement fallback to server relay mode" },
        ],
      },
      {
        name: "Gemini",
        tasks: [
          { id: "WEBRTC-A01", title: "Build agent-bridge connection manager" },
          { id: "WEBRTC-A02", title: "Implement peer state management" },
          { id: "WEBRTC-A03", title: "Add reconnection logic" },
        ],
      },
      {
        name: "Friday",
        tasks: [
          { id: "WEBRTC-REV1", title: "Review architecture for security" },
          { id: "WEBRTC-REV2", title: "Verify performance assumptions" },
          { id: "WEBRTC-REV3", title: "Sign off on Layer 2 design" },
        ],
      },
    ],
  },

  {
    groupName: "Testing & QA",
    topic: "Validation & Stability",
    description: "Load testing, stress testing, performance validation",
    icon: "🧪",
    color: "#95e1d3",
    agents: [
      {
        name: "Goblin",
        tasks: [
          { id: "TEST-001", title: "Run 5-agent load test (60 sec)" },
          { id: "TEST-002", title: "Run 10-agent extended test (5 min)" },
          { id: "TEST-003", title: "Run 20-agent chaos test" },
        ],
      },
      {
        name: "Claude-Code",
        tasks: [
          { id: "TEST-M01", title: "Monitor test results & metrics" },
          { id: "TEST-M02", title: "Identify performance bottlenecks" },
          { id: "TEST-M03", title: "Approve go-live decision" },
        ],
      },
    ],
  },

  {
    groupName: "Security & Compliance",
    topic: "Hardening & Audit",
    description: "Security audit, compliance checks, penetration testing",
    icon: "🔒",
    color: "#f38181",
    agents: [
      {
        name: "Batman",
        tasks: [
          { id: "SEC-001", title: "Rate limiting analysis & tuning" },
          { id: "SEC-002", title: "Token validation & secret rotation" },
          { id: "SEC-003", title: "CORS origin validation review" },
        ],
      },
      {
        name: "Friday",
        tasks: [
          { id: "SEC-REV1", title: "Security plan code review" },
          { id: "SEC-REV2", title: "Verify threat model coverage" },
          { id: "SEC-REV3", title: "Sign off on hardening" },
        ],
      },
    ],
  },

  {
    groupName: "DevOps & Deployment",
    topic: "Release & Monitoring",
    description: "Deployment, monitoring, incident response",
    icon: "⚙️",
    color: "#aa96da",
    agents: [
      {
        name: "Greg",
        tasks: [
          { id: "OPS-001", title: "Prepare production deployment" },
          { id: "OPS-002", title: "Set up monitoring & alerts" },
          { id: "OPS-003", title: "Execute Phase 2 release" },
        ],
      },
      {
        name: "Claude-Code",
        tasks: [
          { id: "OPS-M01", title: "Monitor post-deployment metrics" },
          { id: "OPS-M02", title: "Handle any incidents" },
          { id: "OPS-M03", title: "Coordinate rollback if needed" },
        ],
      },
    ],
  },
];

async function setupTeams() {
  console.log("🚀 Setting up team coordination groups and assignments...\n");

  for (const team of TEAMS) {
    // Create the room/group
    const roomCode = crypto.randomUUID().split("-")[0]; // Short room code
    const group = createRoomGroup(
      roomCode!,
      team.groupName,

      team.description,
      team.topic,
      "Claude-Code",
      team.icon,
      team.color
    );

    console.log(`✅ Created group: ${team.groupName} (${roomCode})`);
    console.log(`   Topic: ${team.topic}`);
    console.log(`   Icon: ${team.icon} Color: ${team.color}\n`);

    // Assign tasks to agents
    for (const agent of team.agents) {
      console.log(`   👤 ${agent.name}:`);

      for (const task of agent.tasks) {
        const dueDate = Date.now() + (task.dueHours || 24) * 60 * 60 * 1000;
        assignTask(roomCode!, agent.name, task.id, task.title, dueDate);
        console.log(`      ✓ ${task.id}: ${task.title}`);
      }
      console.log("");
    }

    console.log("---\n");
  }

  // Show summary
  const allGroups = getAllRoomGroups();
  console.log(`\n✅ SETUP COMPLETE!\n`);
  console.log(`Created ${allGroups.length} coordination groups:`);
  console.log("");

  for (const group of allGroups) {
    console.log(`📱 ${group.icon} ${group.group_name}`);
    console.log(`   Room Code: ${group.room_code}`);
    console.log(`   Topic: ${group.topic}`);
    console.log("");
  }

  console.log("🎯 All agents have been assigned concrete tasks!");
  console.log("📊 View everything at: http://localhost:3000/master-dashboard");
  console.log("🚀 Start the server: bun src/index.ts");
}

setupTeams().catch(console.error);
