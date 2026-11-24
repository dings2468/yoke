import { readFileSync } from "node:fs";
import { describe, expect, expectTypeOf, it } from "vitest";
import { parse } from "yaml";
import { type Mode, type YokeConfig, YokeConfigSchema } from "../../src/core/schema.js";

function readYaml(relative: string): unknown {
  const url = new URL(`../fixtures/schema/config/${relative}`, import.meta.url);
  return parse(readFileSync(url, "utf8"));
}

describe("yoke.yaml scope file schema", () => {
  it("parses the SPEC section 4.1 example to the expected object", () => {
    const parsed = YokeConfigSchema.parse(readYaml("spec-example.yaml"));
    expect(parsed).toEqual({
      version: 1,
      mode: "compiled",
      harnesses: ["claude", "agy"],
      mcps: {
        filesystem: {
          transport: "stdio",
          command: "npx",
          args: ["-y", "@modelcontextprotocol/server-filesystem", "."],
          env: { LOG_LEVEL: "info" },
        },
        linear: {
          transport: "http",
          url: "https://mcp.linear.app/mcp",
          // biome-ignore lint/suspicious/noTemplateCurlyInString: literal ${VAR} reference must be preserved
          headers: { Authorization: "Bearer ${LINEAR_API_KEY}" },
        },
        github: { enabled: false },
      },
      instructions: { source: "AGENTS.md", preferSymlink: true },
      session: { maxTurns: 40, includeGitDiffStat: true },
    });
  });

  // biome-ignore lint/suspicious/noTemplateCurlyInString: test title documents literal ${VAR} syntax
  it("keeps the ${LINEAR_API_KEY} reference unexpanded", () => {
    const parsed = YokeConfigSchema.parse(readYaml("spec-example.yaml"));
    const linear = parsed.mcps?.linear;
    expect(linear && linear.transport === "http" ? linear.headers?.Authorization : undefined).toBe(
      // biome-ignore lint/suspicious/noTemplateCurlyInString: literal ${VAR} reference must be preserved
      "Bearer ${LINEAR_API_KEY}",
    );
  });

  it("accepts a minimal file with only version", () => {
    expect(YokeConfigSchema.parse(readYaml("minimal.yaml"))).toEqual({ version: 1 });
  });

  it("accepts a local override with a stub and a full filesystem entry", () => {
    const parsed = YokeConfigSchema.parse(readYaml("local-override-full.yaml"));
    expect(parsed.mcps?.github).toEqual({ enabled: false });
    expect(parsed.mcps?.filesystem).toEqual({
      transport: "stdio",
      command: "npx",
      args: ["-y", "@modelcontextprotocol/server-filesystem", "./docs"],
    });
  });

  it("rejects a partial override without a transport (ambiguity B4)", () => {
    const result = YokeConfigSchema.safeParse(readYaml("local-override.yaml"));
    expect(result.success).toBe(false);
    if (result.success) {
      return;
    }
    const paths = result.error.issues.map((issue) => issue.path.join("."));
    expect(paths.some((p) => p.includes("mcps") && p.includes("filesystem"))).toBe(true);
  });

  it.each([
    "invalid-missing-version.yaml",
    "invalid-version-2.yaml",
    "invalid-mode.yaml",
    "invalid-unknown-top-key.yaml",
    "invalid-duplicate-harness.yaml",
    "invalid-harness-name.yaml",
    "invalid-maxturns.yaml",
    "invalid-null-mcps.yaml",
  ])("rejects %s", (file) => {
    expect(YokeConfigSchema.safeParse(readYaml(file)).success).toBe(false);
  });

  it("types mode as Mode or undefined", () => {
    expectTypeOf<YokeConfig["mode"]>().toEqualTypeOf<Mode | undefined>();
  });
});
