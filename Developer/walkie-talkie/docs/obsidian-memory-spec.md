# Obsidian Memory Module Technical Specification

This document provides the technical specification for the `obsidian-memory.ts` module.

## 1. Environment Variables

*   `OBSIDIAN_VAULT_PATH`: The absolute path to the Obsidian vault. This is a required environment variable.

## 2. Functions

### `appendDecision(roomCode, by, summary, rationale, tags?)`

*   **File Path**: `/{OBSIDIAN_VAULT_PATH}/02_Areas/Team-Decisions/{YYYY-MM-DD}-{summary}.md`
*   **Markdown Format**:
    ```markdown
    ---
    tags: decision
    by: {{by}}
    rationale: {{rationale}}
    tags: [{{tags}}]
    ---

    # Decision: {{summary}}
    ```

### `appendShip(roomCode, by, title, filesChanged, notes?)`

*   **File Path**: `/{OBSIDIAN_VAULT_PATH}/05_Ships/{YYYY-MM-DD}-{title}.md`
*   **Markdown Format**:
    ```markdown
    ---
    tags: ship
    by: {{by}}
    ---

    # Ship: {{title}}

    ## Files Changed

    - {{filesChanged.join("
- ")}}

    ## Notes

    {{notes}}
    ```

### `upsertAgentContext(agentName, roomCode, context)`

*   **File Path**: `/{OBSIDIAN_VAULT_PATH}/02_Areas/Agents/{{agentName}}.md`
*   **Markdown Format**:
    ```markdown
    ---
    tags: agent-context
    agent-name: {{agentName}}
    room-code: {{roomCode}}
    ---

    # {{agentName}}

    {{context}}
    ```

### `appendDailyLog(roomCode, entry)`

*   **File Path**: `/{OBSIDIAN_VAULT_PATH}/01_Projects/{{roomCode}}/{YYYY-MM-DD}.md`
*   **Markdown Format**:
    ```markdown
    ---
    tags: daily-log
    ---

    # {{YYYY-MM-DD}}

    {{entry}}
    ```

### `getAgentContext(agentName, roomCode)`

*   This function will read the contents of the `/{OBSIDIAN_VAULT_PATH}/02_Areas/Agents/{{agentName}}.md` file and return the context as a string.

## 3. API Endpoints

### `POST /api/memory/write`

*   **Request Body**:
    ```json
    {
      "type": "decision" | "ship" | "agent-context" | "daily-log",
      "roomCode": "...",
      "by": "...",
      "summary": "...",
      "rationale": "...",
      "tags": ["..."],
      "title": "...",
      "filesChanged": ["..."],
      "notes": "...",
      "agentName": "...",
      "context": "...",
      "entry": "..."
    }
    ```

### `GET /api/memory/context`

*   **Query Parameters**:
    *   `agentName`: The name of the agent to get the context for.
    *   `roomCode`: The room code to get the context for.
*   **Response**:
    ```json
    {
      "context": "..."
    }
    ```

## 4. MCP Tools

### `memory.write_entry`

*   **Input Schema**:
    ```json
    {
      "type": "object",
      "properties": {
        "type": { "type": "string" },
        "roomCode": { "type": "string" },
        "by": { "type": "string" },
        "summary": { "type": "string" },
        "rationale": { "type": "string" },
        "tags": { "type": "array", "items": { "type": "string" } },
        "title": { "type": "string" },
        "filesChanged": { "type": "array", "items": { "type": "string" } },
        "notes": { "type": "string" },
        "agentName": { "type": "string" },
        "context": { "type": "string" },
        "entry": { "type": "string" }
      }
    }
    ```
*   **Output Schema**:
    ```json
    {
      "type": "object",
      "properties": {
        "success": { "type": "boolean" }
      }
    }
    ```

### `memory.get_context`

*   **Input Schema**:
    ```json
    {
      "type": "object",
      "properties": {
        "agentName": { "type": "string" },
        "roomCode": { "type": "string" }
      }
    }
    ```
*   **Output Schema**:
    ```json
    {
      "type": "object",
      "properties": {
        "context": { "type": "string" }
      }
    }
    ```
