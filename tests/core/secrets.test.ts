// biome-ignore-all lint/suspicious/noTemplateCurlyInString: the tests assert literal ${VAR} references
import { describe, expect, it } from "vitest";
import { type McpServerDefinition, McpServerDefinitionSchema } from "../../src/core/schema.js";
import {
  findLiteralSecrets,
  isSecretKey,
  looksSecretValue,
  redactSecrets,
} from "../../src/core/secrets.js";

// In-memory fake values only. None of these is a real credential.
const FAKE_TOKEN = "sk-fake-0123456789abcdefghijklmnop";
const FAKE_GH = "ghp_fakeFAKEfake0123456789";

function assertValid(servers: Readonly<Record<string, McpServerDefinition>>): void {
  for (const def of Object.values(servers)) {
    expect(McpServerDefinitionSchema.safeParse(def).success).toBe(true);
  }
}

describe("isSecretKey", () => {
  it("matches credential-like names and ignores ordinary ones", () => {
    expect(isSecretKey("GITHUB_TOKEN")).toBe(true);
    expect(isSecretKey("Authorization")).toBe(true);
    expect(isSecretKey("api-key")).toBe(true);
    expect(isSecretKey("LOG_LEVEL")).toBe(false);
    expect(isSecretKey("region")).toBe(false);
  });
});

describe("looksSecretValue", () => {
  it("recognises token prefixes and long mixed tokens, after an auth prefix", () => {
    expect(looksSecretValue(FAKE_TOKEN)).toBe(true);
    expect(looksSecretValue(`Bearer ${FAKE_TOKEN}`)).toBe(true);
    expect(looksSecretValue("abcdefghij0123456789abcdefghij01")).toBe(true);
  });

  it("rejects short words, references, and empty values", () => {
    expect(looksSecretValue("info")).toBe(false);
    expect(looksSecretValue("")).toBe(false);
    expect(looksSecretValue("Bearer ")).toBe(false);
    expect(looksSecretValue("${GITHUB_TOKEN}")).toBe(false);
    expect(looksSecretValue("abcdefghijklmnopqrstuvwxyzabcdef")).toBe(false);
  });
});

describe("redactSecrets", () => {
  it("leaves ordinary env values and existing references untouched", () => {
    const servers: Record<string, McpServerDefinition> = {
      tool: {
        transport: "stdio",
        command: "node",
        env: { LOG_LEVEL: "info", GITHUB_TOKEN: "${GITHUB_TOKEN}" },
      },
    };
    const result = redactSecrets(servers);
    expect(result.findings).toEqual([]);
    expect(result.original).toEqual({});
    expect(result.safe).toEqual(servers);
  });

  it("replaces a secret env value with a reference named after the env key", () => {
    const servers: Record<string, McpServerDefinition> = {
      github: {
        transport: "stdio",
        command: "npx",
        env: { GITHUB_TOKEN: FAKE_GH, LOG_LEVEL: "info" },
      },
    };
    const result = redactSecrets(servers);
    expect(result.safe.github).toEqual({
      transport: "stdio",
      command: "npx",
      env: { GITHUB_TOKEN: "${GITHUB_TOKEN}", LOG_LEVEL: "info" },
    });
    expect(result.findings).toEqual([
      { server: "github", field: "env", key: "GITHUB_TOKEN", varName: "GITHUB_TOKEN" },
    ]);
    expect(result.original.github).toEqual(servers.github);
    expect(findLiteralSecrets(result.safe)).toEqual([]);
  });

  it("keeps the Bearer prefix on an authorization header", () => {
    const servers: Record<string, McpServerDefinition> = {
      linear: {
        transport: "http",
        url: "https://mcp.example.test/mcp",
        headers: { Authorization: `Bearer ${FAKE_TOKEN}` },
      },
    };
    const result = redactSecrets(servers);
    expect(result.safe.linear).toEqual({
      transport: "http",
      url: "https://mcp.example.test/mcp",
      headers: { Authorization: "Bearer ${LINEAR_AUTHORIZATION}" },
    });
    expect(findLiteralSecrets(result.safe)).toEqual([]);
    assertValid(result.safe);
  });

  it("redacts the query parameter of a url", () => {
    const servers: Record<string, McpServerDefinition> = {
      search: {
        transport: "sse",
        url: "https://search.example.test/sse?region=eu&api_key=fakekey-value-0001",
      },
    };
    const result = redactSecrets(servers);
    expect(result.safe.search).toEqual({
      transport: "sse",
      url: "https://search.example.test/sse?region=eu&api_key=${SEARCH_API_KEY}",
    });
    expect(findLiteralSecrets(result.safe)).toEqual([]);
    assertValid(result.safe);
  });

  it("redacts a userinfo password in a url", () => {
    const servers: Record<string, McpServerDefinition> = {
      db: {
        transport: "http",
        url: "https://user:hunter2hunter2@db.example.test/mcp",
      },
    };
    const result = redactSecrets(servers);
    expect(result.safe.db).toEqual({
      transport: "http",
      url: "https://user:${DB_PASSWORD}@db.example.test/mcp",
    });
    assertValid(result.safe);
  });

  it("handles secret-like flags and token-shaped positional args", () => {
    const servers: Record<string, McpServerDefinition> = {
      svc: {
        transport: "stdio",
        command: "svc",
        args: ["--api-key", FAKE_TOKEN, "--region=eu", `--token=${FAKE_GH}`, FAKE_TOKEN],
      },
    };
    const result = redactSecrets(servers);
    expect(result.safe.svc).toEqual({
      transport: "stdio",
      command: "svc",
      args: ["--api-key", "${SVC_API_KEY}", "--region=eu", "--token=${SVC_TOKEN}", "${SVC_ARG4}"],
    });
    expect(findLiteralSecrets(result.safe)).toEqual([]);
    assertValid(result.safe);
  });

  it("does not treat paths as secrets", () => {
    const servers: Record<string, McpServerDefinition> = {
      local: {
        transport: "stdio",
        command: "node",
        args: ["/srv/projects/mcp-server-v2/dist/index-build-2024-release.js"],
      },
    };
    const result = redactSecrets(servers);
    expect(result.findings).toEqual([]);
    expect(result.safe).toEqual(servers);
  });

  it("suffixes a name that collides with a different value, and shares one for an equal value", () => {
    const servers: Record<string, McpServerDefinition> = {
      a: { transport: "stdio", command: "a", env: { TOKEN: FAKE_TOKEN } },
      b: { transport: "stdio", command: "b", env: { TOKEN: `${FAKE_TOKEN}-other` } },
      c: { transport: "stdio", command: "c", env: { TOKEN: FAKE_TOKEN } },
    };
    const result = redactSecrets(servers);
    expect(result.safe.a?.transport === "stdio" && result.safe.a.env).toEqual({
      TOKEN: "${TOKEN}",
    });
    expect(result.safe.b?.transport === "stdio" && result.safe.b.env).toEqual({
      TOKEN: "${B_TOKEN}",
    });
    expect(result.safe.c?.transport === "stdio" && result.safe.c.env).toEqual({
      TOKEN: "${TOKEN}",
    });
    expect(findLiteralSecrets(result.safe)).toEqual([]);
  });

  it("avoids names the caller has already taken", () => {
    const servers: Record<string, McpServerDefinition> = {
      a: { transport: "stdio", command: "a", env: { TOKEN: FAKE_TOKEN } },
    };
    const result = redactSecrets(servers, new Set(["TOKEN"]));
    expect(result.safe.a?.transport === "stdio" && result.safe.a.env).toEqual({
      TOKEN: "${A_TOKEN}",
    });
  });

  it("does not mutate its input", () => {
    const servers: Record<string, McpServerDefinition> = {
      github: {
        transport: "stdio",
        command: "npx",
        args: ["--api-key", FAKE_TOKEN],
        env: { GITHUB_TOKEN: FAKE_GH },
      },
    };
    const snapshot = structuredClone(servers);
    redactSecrets(servers);
    expect(servers).toEqual(snapshot);
  });
});
