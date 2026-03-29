# Feature Demo: Google Docs, Obsidian Memory, and Openclaw Observer

This document provides a step-by-step walkthrough of how to use the three new features together in one scenario.

## Step 1: Create a Google Doc

First, we will use the `google.create_doc` MCP tool to create a new Google Doc.

*   **Input**:
    ```json
    {
      "tool_name": "google.create_doc",
      "tool_input": {
        "title": "My New Google Doc"
      }
    }
    ```
*   **Output**:
    ```json
    {
      "id": "...",
      "url": "https://docs.google.com/document/d/.../edit",
      "title": "My New Google Doc"
    }
    ```

## Step 2: Write the Decision to Obsidian

Next, we will use the `memory.write_entry` MCP tool to write the decision to Obsidian.

*   **Input**:
    ```json
    {
      "tool_name": "memory.write_entry",
      "tool_input": {
        "type": "decision",
        "roomCode": "mesh01",
        "by": "Diogenis",
        "summary": "We will use Google Docs for all our documents.",
        "rationale": "It is a well-known and easy-to-use tool.",
        "tags": ["documentation", "google-docs"]
      }
    }
    ```
*   **Output**:
    ```json
    {
      "success": true
    }
    ```

## Step 3: Openclaw Receives the Event

Finally, Openclaw will receive the event via the SSE stream.

*   **Output**:
    ```json
    {
      "id": "...",
      "from": "Diogenis",
      "to": null,
      "content": "DECISION: We will use Google Docs for all our documents.",
      "ts": 1679999999999
    }
    ```
