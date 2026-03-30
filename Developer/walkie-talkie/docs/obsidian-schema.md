# Obsidian Memory Schema Proposal (TASK-D1)

This document outlines a proposed Obsidian vault structure for our team of AI agents. It is based on a hybrid of the PARA and Zettelkasten methods, designed to be both action-oriented and knowledge-driven.

## 1. Top-Level Folder Structure (PARA)

The vault will be organized into four top-level folders, based on the PARA method:

*   **`01_Projects`**: Short-term efforts with a specific goal and deadline. Each project will have its own sub-folder.
*   **`02_Areas`**: Ongoing responsibilities that require a standard of performance over time. This will include folders for each agent, as well as general areas like "Team Coordination" and "System Health." A `Team-Decisions` sub-folder will be used to store cross-session decisions.
*   **`03_Resources`**: Topics of ongoing interest or reference material. This will include our Zettelkasten slip-box, as well as folders for things like "Code Snippets," "Meeting Notes," and "Research."
*   **`04_Archives`**: Completed projects or inactive areas/resources.
*   **`05_Ships`**: A folder for deployment logs.

## 2. Note Templates

To ensure consistency, we will use a set of note templates for common document types.

### `project-template.md`

```markdown
---
tags: project
status: active
owner:
deadline:
---

# {{title}}

## Goal

...

## Deliverables

- [ ] ...

## Tasks

- [ ] ...
```

### `agent-context-template.md`

```markdown
---
tags: agent-context
agent-name:
model:
skills:
---

# {{agent-name}}

## Current Status

...

## Current Tasks

- [ ] ...

## Recent Activity

...
```

### `zettel-template.md`

```markdown
---
tags: zettel
---

# {{title}}

...

## Connections

- [[...]]
```

## 3. Naming Conventions

To ensure that files are easy to find and understand, we will use the following naming conventions:

*   **Projects**: `YYYY-MM-DD - Project Name` (e.g., `2026-03-29 - Internationalization Coursework`)
*   **Meeting Notes**: `YYYY-MM-DD - Meeting Name` (e.g., `2026-03-29 - Weekly Sync`)
*   **Zettelkasten Notes**: `YYYYMMDDHHMMSS - Note Title` (e.g., `20260329103000 - The Benefits of a Hybrid PARA-Zettelkasten System`)

## 4. Zettelkasten Integration

Our Zettelkasten slip-box will live in the `03_Resources/Zettelkasten` folder. This will be where we store our atomic, interconnected notes on various topics. We will use the `zettel-template.md` for all new notes in the slip-box.

## 5. Next Steps

I believe this structure will provide a solid foundation for our shared memory. I welcome feedback and suggestions from the team. Once we have agreed on a schema, I will create the initial folder structure and templates.
