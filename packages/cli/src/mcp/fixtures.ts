// SPDX-FileCopyrightText: 2026 Pithy
// SPDX-License-Identifier: MIT

import type { Scope } from "./clients";

/**
 * One realistic config document per client, per scope — the corpus every writer is tested against.
 *
 * **Every fixture already holds a server Pithy did not write, and that server is what the tests are
 * really about.** A writer that produces a correct `pithy` entry and drops the adopter's Playwright
 * server beside it has failed at the only thing that matters here: these are files Pithy does not own.
 * So each fixture carries `survives` — the exact bytes of the neighboring entry — and every write,
 * rewrite and removal asserts those bytes are still present, unchanged, afterwards.
 *
 * **They are TypeScript rather than files on disk** so the document and the claim about it sit together,
 * and so the corpus needs no enrollment in the repository's file sweeps. Each one is a plausible
 * document for its tool — sibling keys the tool actually writes (`numStartups`, `theme`,
 * `GOOSE_PROVIDER`), comments where the format allows them, and the tool's own spelling throughout.
 *
 * `packages/cli/src/mcp/clients.test.ts` holds the corpus to the registry: a row whose declared paths
 * are not all covered here fails, so a client cannot be added without a document to prove it works.
 */

/** One document, and the bytes that must survive every operation performed on it. */
export interface Fixture {
  /** The file's contents before Pithy touches it. */
  readonly document: string;
  /** Bytes belonging to the adopter that must appear, verbatim, after any write or removal. */
  readonly survives: readonly string[];
  /** The name of the unrelated server the document declares — what `survives` is about. */
  readonly neighbor: string;
}

/** The corpus, keyed by client id and then by scope. */
export const FIXTURES: Readonly<Record<string, Partial<Record<Scope, Fixture>>>> = {
  "claude-code": {
    project: {
      document: `{
  "mcpServers": {
    "playwright": {
      "type": "stdio",
      "command": "npx",
      "args": ["-y", "@playwright/mcp@latest"]
    }
  }
}
`,
      survives: [
        `"playwright": {
      "type": "stdio",
      "command": "npx",
      "args": ["-y", "@playwright/mcp@latest"]
    }`,
      ],
      neighbor: "playwright",
    },
    user: {
      // `~/.claude.json` is Claude Code's own state file. The keys around `mcpServers` are the ones that
      // make this the most dangerous write in the table, so the fixture carries them.
      document: `{
  "numStartups": 42,
  "mcpServers": {
    "playwright": {
      "type": "stdio",
      "command": "npx",
      "args": ["-y", "@playwright/mcp@latest"]
    }
  },
  "projects": {
    "/home/you/app": {
      "hasTrustDialogAccepted": true
    }
  }
}
`,
      survives: [`"numStartups": 42`, `"hasTrustDialogAccepted": true`],
      neighbor: "playwright",
    },
  },

  cursor: {
    project: {
      document: `{
  "mcpServers": {
    "playwright": {
      "command": "npx",
      "args": ["-y", "@playwright/mcp@latest"]
    }
  }
}
`,
      survives: [
        `"playwright": {
      "command": "npx",
      "args": ["-y", "@playwright/mcp@latest"]
    }`,
      ],
      neighbor: "playwright",
    },
    user: {
      document: `{
  "mcpServers": {
    "linear": {
      "url": "https://mcp.linear.app/mcp"
    }
  }
}
`,
      survives: [
        `"linear": {
      "url": "https://mcp.linear.app/mcp"
    }`,
      ],
      neighbor: "linear",
    },
  },

  vscode: {
    project: {
      // JSONC, and the comment is the point: VS Code's own docs write one, and a writer that eats it
      // has rewritten a file the adopter reads.
      document: `{
  // Servers this workspace offers to agent mode.
  "servers": {
    "playwright": {
      "type": "stdio",
      "command": "npx",
      "args": ["-y", "@playwright/mcp@latest"]
    }
  },
  "inputs": []
}
`,
      survives: ["// Servers this workspace offers to agent mode.", `"inputs": []`],
      neighbor: "playwright",
    },
    user: {
      document: `{
  "servers": {
    "github": {
      "type": "http",
      "url": "https://api.githubcopilot.com/mcp/"
    }
  }
}
`,
      survives: [
        `"github": {
      "type": "http",
      "url": "https://api.githubcopilot.com/mcp/"
    }`,
      ],
      neighbor: "github",
    },
  },

  gemini: {
    project: {
      document: `{
  "theme": "Default",
  "mcpServers": {
    "playwright": {
      "command": "npx",
      "args": ["-y", "@playwright/mcp@latest"]
    }
  }
}
`,
      survives: [`"theme": "Default"`],
      neighbor: "playwright",
    },
    user: {
      document: `{
  "mcpServers": {
    "playwright": {
      "command": "npx",
      "args": ["-y", "@playwright/mcp@latest"]
    }
  }
}
`,
      survives: [
        `"playwright": {
      "command": "npx",
      "args": ["-y", "@playwright/mcp@latest"]
    }`,
      ],
      neighbor: "playwright",
    },
  },

  "claude-desktop": {
    user: {
      document: `{
  "mcpServers": {
    "filesystem": {
      "command": "npx",
      "args": ["-y", "@modelcontextprotocol/server-filesystem", "/home/you/notes"]
    }
  }
}
`,
      survives: [
        `"filesystem": {
      "command": "npx",
      "args": ["-y", "@modelcontextprotocol/server-filesystem", "/home/you/notes"]
    }`,
      ],
      neighbor: "filesystem",
    },
  },

  cline: {
    user: {
      document: `{
  "mcpServers": {
    "playwright": {
      "command": "npx",
      "args": ["-y", "@playwright/mcp@latest"],
      "disabled": false,
      "autoApprove": []
    }
  }
}
`,
      survives: [`"disabled": false`],
      neighbor: "playwright",
    },
  },

  zed: {
    project: {
      document: `{
  // Zed reads this per worktree.
  "context_servers": {
    "playwright": {
      "source": "custom",
      "command": "npx",
      "args": ["-y", "@playwright/mcp@latest"]
    }
  }
}
`,
      survives: ["// Zed reads this per worktree.", `"source": "custom"`],
      neighbor: "playwright",
    },
    user: {
      document: `{
  "theme": "One Dark",
  "context_servers": {
    "linear": {
      "url": "https://mcp.linear.app/mcp"
    }
  }
}
`,
      survives: [`"theme": "One Dark"`],
      neighbor: "linear",
    },
  },

  codex: {
    project: {
      document: `[mcp_servers.playwright]
command = "npx"
args = ["-y", "@playwright/mcp@latest"]
`,
      survives: [
        `[mcp_servers.playwright]
command = "npx"
args = ["-y", "@playwright/mcp@latest"]`,
      ],
      neighbor: "playwright",
    },
    user: {
      // A top-level key above the tables, which is where TOML puts one and where a naive writer
      // appending to the wrong place would strand it.
      document: `model = "o3"
approval_policy = "on-request"

[mcp_servers.playwright]
command = "npx"
args = ["-y", "@playwright/mcp@latest"]

[tui]
notifications = true
`,
      survives: [
        `model = "o3"`,
        `[tui]
notifications = true`,
      ],
      neighbor: "playwright",
    },
  },

  goose: {
    user: {
      document: `GOOSE_PROVIDER: anthropic
GOOSE_MODEL: claude-opus-5
extensions:
  developer:
    type: builtin
    name: developer
    enabled: true
    timeout: 300
`,
      survives: [
        "GOOSE_PROVIDER: anthropic",
        `  developer:
    type: builtin
    name: developer
    enabled: true
    timeout: 300`,
      ],
      neighbor: "developer",
    },
  },

  continue: {
    project: {
      document: `name: extra-servers
version: 0.0.1
schema: v1
mcpServers:
  - name: playwright
    type: stdio
    command: npx
    args:
      - "-y"
      - "@playwright/mcp@latest"
`,
      survives: [
        `  - name: playwright
    type: stdio
    command: npx
    args:
      - "-y"
      - "@playwright/mcp@latest"`,
      ],
      neighbor: "playwright",
    },
    user: {
      document: `name: my-config
version: 0.0.1
schema: v1
models:
  - name: sonnet
    provider: anthropic
    model: claude-sonnet-5
mcpServers:
  - name: playwright
    type: stdio
    command: npx
    args:
      - "-y"
      - "@playwright/mcp@latest"
`,
      survives: [
        `models:
  - name: sonnet
    provider: anthropic
    model: claude-sonnet-5`,
        `  - name: playwright`,
      ],
      neighbor: "playwright",
    },
  },
};
