/**
 * src/commands/init-types.ts — types shared by the `yoke init` import pipeline (source listing, selection, drafting).
 */
import type { McpServerDefinition } from "../core/schema.js";

/** A failure the user can fix by changing inputs or files. Maps to exit 1. */
export class InitError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "InitError";
  }
}

export { UsageError } from "./exit.js";

export type SourceToken =
  | { readonly kind: "harness"; readonly name: string; readonly mcpsOnly: boolean }
  | { readonly kind: "file"; readonly path: string };

export interface InstructionCandidate {
  readonly path: string;
  readonly content: string;
  /** Harness name, "file" for an explicit path, or "existing" for the repo's canonical instructions file. */
  readonly origin: string;
}

export interface HarnessImport {
  readonly harness: string;
  readonly project: Readonly<Record<string, McpServerDefinition>>;
  readonly local: Readonly<Record<string, McpServerDefinition>>;
  /** Servers found only at user level in the native config, keyed by name. Init writes them to the user-scope file. */
  readonly user: Readonly<Record<string, McpServerDefinition>>;
  readonly instructions: InstructionCandidate | undefined;
}

export type HarnessAvailability =
  | { readonly kind: "available"; readonly data: HarnessImport }
  | { readonly kind: "empty" }
  | { readonly kind: "unreadable"; readonly reason: string }
  | { readonly kind: "unsupported" };

export interface ImportSources {
  readonly harnesses: readonly {
    readonly name: string;
    readonly availability: HarnessAvailability;
  }[];
  readonly files: readonly InstructionCandidate[];
}

export interface ImportSelection {
  readonly harnesses: readonly HarnessImport[];
  readonly instructions: InstructionCandidate | undefined;
}

/** The user-scope yoke.yaml (U5): merged text, backed up before overwrite, created with mode 0600. */
export interface UserTextIntent {
  readonly kind: "text";
  readonly scope: "user";
  readonly path: string;
  readonly content: string;
  readonly ifExists: "overwrite-with-backup";
  readonly mode: number;
}

export type ProjectWriteIntent =
  | {
      readonly kind: "text";
      readonly scope: "project" | "local";
      readonly path: string;
      readonly content: string;
      readonly ifExists: "fail" | "overwrite-with-backup" | "keep";
    }
  | {
      readonly kind: "ensure-lines";
      readonly scope: "project";
      readonly path: string;
      readonly lines: readonly string[];
    };
