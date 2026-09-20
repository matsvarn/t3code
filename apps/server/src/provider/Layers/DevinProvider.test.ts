// @effect-diagnostics nodeBuiltinImport:off - resolves the mock ACP agent script path relative to this test file.
import * as NodePath from "node:path";
import * as NodeURL from "node:url";

import * as NodeServices from "@effect/platform-node/NodeServices";
import { describe, expect, it } from "@effect/vitest";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Schema from "effect/Schema";
import { DevinSettings } from "@t3tools/contracts";

import {
  buildDevinModelsFromConfigOptions,
  buildInitialDevinProviderSnapshot,
  checkDevinProviderStatus,
  devinSlashCommandsFromInitialize,
} from "./DevinProvider.ts";
import { execScriptSource, writeFakeCli } from "../../testUtils/fakeCli.ts";

const decodeDevinSettings = Schema.decodeSync(DevinSettings);
const __dirname = NodePath.dirname(NodeURL.fileURLToPath(import.meta.url));

describe("buildDevinModelsFromConfigOptions", () => {
  it("reads the model select's options and marks the current value as default", () => {
    const models = buildDevinModelsFromConfigOptions([
      {
        id: "mode",
        name: "Mode",
        type: "select",
        currentValue: "auto",
        options: [{ value: "auto", name: "Auto" }],
      },
      {
        id: "model",
        name: "Model",
        type: "select",
        currentValue: "swe-2-max",
        options: [
          { value: "adaptive", name: "Adaptive" },
          { value: "swe-2-max", name: "SWE-2 Max" },
          { value: "claude-opus-5-high", name: "Claude Opus 5 High" },
        ],
      },
    ]);
    expect(models.map((model) => [model.slug, model.isDefault ?? false])).toEqual([
      ["adaptive", false],
      ["swe-2-max", true],
      ["claude-opus-5-high", false],
    ]);
  });

  it("collapses fusion combinations into one model with lead/effort/sidekick descriptors", () => {
    const models = buildDevinModelsFromConfigOptions([
      {
        id: "model",
        name: "Model",
        type: "select",
        currentValue: "swe-2-max",
        options: [
          { value: "swe-2-max", name: "SWE-2 Max" },
          {
            value: "fusion-claude-fable-5-1-medium-sidekick-swe-2-medium",
            name: "Fusion (Claude Fable 5.1 Medium + SWE-2 Medium)",
          },
          {
            value: "fusion-claude-fable-5-1-high-sidekick-swe-2-high",
            name: "Fusion (Claude Fable 5.1 High + SWE-2 High)",
          },
          {
            value: "fusion-gpt-6-astra-xhigh-sidekick-glm-5-2",
            name: "Fusion (GPT-6 Astra XHigh + GLM-5.2)",
          },
        ],
      },
    ]);

    expect(models.map((model) => model.slug)).toEqual(["fusion", "swe-2-max"]);

    const fusion = models[0]!;
    expect(fusion.name).toBe("Fusion");
    expect(fusion.isDefault).toBeUndefined();
    const descriptors = fusion.capabilities?.optionDescriptors ?? [];
    expect(descriptors.map((descriptor) => descriptor.id)).toEqual([
      "lead",
      "leadEffort",
      "sidekick",
    ]);

    const [lead, leadEffort, sidekick] = descriptors;
    expect(lead?.type === "select" && lead.options).toEqual([
      { id: "claude-fable-5-1", label: "Claude Fable 5.1", isDefault: true },
      { id: "gpt-6-astra", label: "GPT-6 Astra" },
    ]);
    expect(lead?.type === "select" && lead.currentValue).toBe("claude-fable-5-1");

    expect(leadEffort?.type === "select" && leadEffort.options).toEqual([
      { id: "medium", label: "Medium", isDefault: true },
      { id: "high", label: "High" },
      { id: "xhigh", label: "XHigh" },
    ]);

    expect(sidekick?.type === "select" && sidekick.options).toEqual([
      { id: "swe-2-medium", label: "SWE-2 Medium", isDefault: true },
      { id: "swe-2-high", label: "SWE-2 High" },
      { id: "glm-5-2", label: "GLM-5.2" },
    ]);
  });

  it("prefills the fusion descriptors from the session's active combination", () => {
    const models = buildDevinModelsFromConfigOptions([
      {
        id: "model",
        name: "Model",
        type: "select",
        currentValue: "fusion-gpt-6-astra-high-sidekick-swe-2-high",
        options: [
          {
            value: "fusion-claude-fable-5-1-medium-sidekick-swe-2-medium",
            name: "Fusion (Claude Fable 5.1 Medium + SWE-2 Medium)",
          },
          {
            value: "fusion-gpt-6-astra-high-sidekick-swe-2-high",
            name: "Fusion (GPT-6 Astra High + SWE-2 High)",
          },
        ],
      },
    ]);

    const fusion = models.find((model) => model.slug === "fusion")!;
    expect(fusion.isDefault).toBe(true);
    const descriptors = fusion.capabilities?.optionDescriptors ?? [];
    const currentValues = descriptors.map((descriptor) =>
      descriptor.type === "select" ? descriptor.currentValue : undefined,
    );
    expect(currentValues).toEqual(["gpt-6-astra", "high", "swe-2-high"]);
  });

  it("collapses effort variants into one model per family with an Effort descriptor", () => {
    const models = buildDevinModelsFromConfigOptions([
      {
        id: "model",
        name: "Model",
        type: "select",
        currentValue: "swe-2-max",
        options: [
          { value: "adaptive", name: "Adaptive" },
          { value: "swe-2-high", name: "SWE-2 High" },
          { value: "swe-2-medium", name: "SWE-2 Medium" },
          { value: "swe-2-max", name: "SWE-2 Max" },
          { value: "claude-opus-5-high", name: "Claude Opus 5 High" },
          { value: "claude-opus-5-low", name: "Claude Opus 5 Low" },
          { value: "MODEL_GPT_5_2_LOW", name: "GPT-5.2 Low Thinking" },
          { value: "MODEL_GPT_5_2_MEDIUM", name: "GPT-5.2 Medium Thinking" },
          { value: "swe-1-6-fast", name: "SWE-1.6 Fast" },
        ],
      },
    ]);

    expect(models.map((model) => model.slug)).toEqual([
      "adaptive",
      "swe-2",
      "claude-opus-5",
      "MODEL_GPT_5_2",
      "swe-1-6-fast",
    ]);

    const swe2 = models[1]!;
    expect(swe2.name).toBe("SWE-2");
    expect(swe2.isDefault).toBe(true);
    expect(swe2.aliases).toEqual(["swe-2-high", "swe-2-medium", "swe-2-max"]);
    const descriptor = swe2.capabilities?.optionDescriptors?.[0];
    expect(descriptor?.id).toBe("effort");
    expect(descriptor?.type === "select" && descriptor.currentValue).toBe("swe-2-max");
    expect(descriptor?.type === "select" && descriptor.options).toEqual([
      { id: "swe-2-medium", label: "Medium" },
      { id: "swe-2-high", label: "High" },
      { id: "swe-2-max", label: "Max", isDefault: true },
    ]);

    const gpt52 = models[3]!;
    expect(gpt52.name).toBe("GPT-5.2");
    expect(
      gpt52.capabilities?.optionDescriptors?.[0]?.type === "select" &&
        gpt52.capabilities.optionDescriptors[0].options.map((option) => option.label),
    ).toEqual(["Low Thinking", "Medium Thinking"]);
  });

  it("prefills the family default from the bare variant's display name", () => {
    const models = buildDevinModelsFromConfigOptions([
      {
        id: "model",
        name: "Model",
        type: "select",
        currentValue: "claude-opus-5-high",
        options: [
          { value: "glm-5-2", name: "GLM-5.2 High" },
          { value: "glm-5-2-max", name: "GLM-5.2 Max" },
          { value: "claude-opus-5-high", name: "Claude Opus 5 High" },
          { value: "claude-opus-5-low", name: "Claude Opus 5 Low" },
        ],
      },
    ]);

    const glm = models.find((model) => model.slug === "glm-5-2")!;
    const descriptor = glm.capabilities?.optionDescriptors?.[0];
    // The bare slug is named "GLM-5.2 High" — it's an alias for the high tier,
    // not a "Default" choice.
    expect(descriptor?.type === "select" && descriptor.options).toEqual([
      { id: "glm-5-2", label: "High", isDefault: true },
      { id: "glm-5-2-max", label: "Max" },
    ]);

    const opus = models.find((model) => model.slug === "claude-opus-5")!;
    expect(opus.isDefault).toBe(true);
  });

  it("folds thinking/1M suffixes into a Variant descriptor", () => {
    const models = buildDevinModelsFromConfigOptions([
      {
        id: "model",
        name: "Model",
        type: "select",
        currentValue: undefined,
        options: [
          { value: "claude-opus-4-6", name: "Claude Opus 4.6" },
          { value: "claude-opus-4-6-1m", name: "Claude Opus 4.6 1M" },
          { value: "claude-opus-4-6-thinking", name: "Claude Opus 4.6 Thinking" },
          { value: "claude-opus-4-6-thinking-1m", name: "Claude Opus 4.6 Thinking 1M" },
          { value: "glm-5-2", name: "GLM-5.2 High" },
          { value: "glm-5-2-1m", name: "GLM-5.2 High 1M" },
          { value: "glm-5-2-max", name: "GLM-5.2 Max" },
          { value: "glm-5-2-max-1m", name: "GLM-5.2 Max 1M" },
          { value: "glm-5-2-none", name: "GLM-5.2 No Thinking" },
          { value: "glm-5-2-none-1m", name: "GLM-5.2 No Thinking 1M" },
        ],
      },
    ]);

    expect(models.map((model) => model.slug)).toEqual(["claude-opus-4-6", "glm-5-2"]);

    const opus = models[0]!;
    expect(opus.name).toBe("Claude Opus 4.6");
    const opusDescriptor = opus.capabilities?.optionDescriptors?.[0];
    expect(opusDescriptor?.label).toBe("Variant");
    expect(opusDescriptor?.type === "select" && opusDescriptor.options).toEqual([
      { id: "claude-opus-4-6", label: "Default", isDefault: true },
      { id: "claude-opus-4-6-1m", label: "1M" },
      { id: "claude-opus-4-6-thinking", label: "Thinking" },
      { id: "claude-opus-4-6-thinking-1m", label: "Thinking 1M" },
    ]);

    const glm = models[1]!;
    expect(glm.name).toBe("GLM-5.2");
    const glmDescriptor = glm.capabilities?.optionDescriptors?.[0];
    expect(glmDescriptor?.label).toBe("Effort");
    expect(
      glmDescriptor?.type === "select" && glmDescriptor.options.map((option) => option.label),
    ).toEqual(["No Thinking", "No Thinking 1M", "High", "High 1M", "Max", "Max 1M"]);
  });

  it("collapses opaque-slug variants by shared display-name base", () => {
    const models = buildDevinModelsFromConfigOptions([
      {
        id: "model",
        name: "Model",
        type: "select",
        currentValue: "MODEL_PRIVATE_14",
        options: [
          { value: "MODEL_PRIVATE_11", name: "Claude Haiku 4.5" },
          { value: "MODEL_PRIVATE_12", name: "GPT-5.1 No Thinking" },
          { value: "MODEL_PRIVATE_13", name: "GPT-5.1 Low Thinking" },
          { value: "MODEL_PRIVATE_14", name: "GPT-5.1 Medium Thinking" },
          { value: "MODEL_PRIVATE_15", name: "GPT-5.1 High Thinking" },
          { value: "MODEL_PRIVATE_2", name: "Claude Sonnet 4.5" },
          { value: "MODEL_PRIVATE_3", name: "Claude Sonnet 4.5 Thinking" },
        ],
      },
    ]);

    expect(models.map((model) => model.slug)).toEqual([
      "MODEL_PRIVATE_11",
      "gpt-5-1",
      "claude-sonnet-4-5",
    ]);

    const gpt51 = models[1]!;
    expect(gpt51.name).toBe("GPT-5.1");
    expect(gpt51.isDefault).toBe(true);
    expect(gpt51.aliases).toEqual([
      "MODEL_PRIVATE_12",
      "MODEL_PRIVATE_13",
      "MODEL_PRIVATE_14",
      "MODEL_PRIVATE_15",
    ]);
    const gpt51Descriptor = gpt51.capabilities?.optionDescriptors?.[0];
    expect(gpt51Descriptor?.label).toBe("Effort");
    expect(
      gpt51Descriptor?.type === "select" && gpt51Descriptor.options.map((option) => option.id),
    ).toEqual(["MODEL_PRIVATE_12", "MODEL_PRIVATE_13", "MODEL_PRIVATE_14", "MODEL_PRIVATE_15"]);

    const sonnet = models[2]!;
    expect(sonnet.name).toBe("Claude Sonnet 4.5");
    const sonnetDescriptor = sonnet.capabilities?.optionDescriptors?.[0];
    expect(sonnetDescriptor?.label).toBe("Variant");
    expect(sonnetDescriptor?.type === "select" && sonnetDescriptor.options).toEqual([
      { id: "MODEL_PRIVATE_2", label: "Default", isDefault: true },
      { id: "MODEL_PRIVATE_3", label: "Thinking" },
    ]);
  });

  it("flattens grouped options and ignores non-model options", () => {
    const models = buildDevinModelsFromConfigOptions([
      {
        id: "model",
        name: "Model",
        type: "select",
        currentValue: "a",
        options: [
          {
            group: "g1",
            name: "Group",
            options: [
              { value: "a", name: "A" },
              { value: "b", name: "B" },
            ],
          },
        ],
      },
    ]);
    expect(models.map((model) => model.slug)).toEqual(["a", "b"]);
  });

  it("returns no models without a model select", () => {
    expect(buildDevinModelsFromConfigOptions(undefined)).toEqual([]);
    expect(buildDevinModelsFromConfigOptions([])).toEqual([]);
  });
});

describe("devinSlashCommandsFromInitialize", () => {
  it("publishes agent commands while filtering T3-owned commands", () => {
    const commands = devinSlashCommandsFromInitialize({
      protocolVersion: 1,
      _meta: {
        availableCommands: [
          { name: "compact", description: "Compress history", input: { hint: "what to keep" } },
          { name: "model", description: "Switch model" },
          { name: "logout", description: "Sign out" },
          { name: "chains", description: "Inspect chains", input: { hint: "<id>" } },
          { name: "megaplan", description: "Megaplan controls" },
        ],
      },
    });
    expect(commands.map((command) => command.name)).toEqual(["compact", "chains", "megaplan"]);
    expect(commands[0]?.input).toEqual({ hint: "what to keep" });
  });

  it("keeps compact available without command metadata", () => {
    for (const _meta of [undefined, {}, { availableCommands: "invalid" }]) {
      expect(
        devinSlashCommandsFromInitialize({ protocolVersion: 1, ...(_meta ? { _meta } : {}) }).map(
          (command) => command.name,
        ),
      ).toEqual(["compact"]);
    }
  });
});

describe("buildInitialDevinProviderSnapshot", () => {
  it.effect("returns a disabled snapshot by default — Devin is opt-in", () =>
    Effect.gen(function* () {
      const snapshot = yield* buildInitialDevinProviderSnapshot(decodeDevinSettings({}));
      expect(snapshot.enabled).toBe(false);
      expect(snapshot.status).toBe("disabled");
      expect(snapshot.installed).toBe(false);
      expect(snapshot.message).toContain("disabled");
    }),
  );

  it.effect("returns a pending snapshot when enabled", () =>
    Effect.gen(function* () {
      const snapshot = yield* buildInitialDevinProviderSnapshot(
        decodeDevinSettings({ enabled: true }),
      );
      expect(snapshot.enabled).toBe(true);
      expect(snapshot.installed).toBe(true);
      expect(snapshot.status).toBe("warning");
      expect(snapshot.version).toBeNull();
      expect(snapshot.message).toContain("Checking Devin");
      expect(snapshot.supportsConversationRollback).toBe(false);
    }),
  );
});

it.layer(NodeServices.layer)("checkDevinProviderStatus", (it) => {
  it.effect("reports the binary as missing when the binary path does not resolve", () =>
    Effect.gen(function* () {
      const snapshot = yield* checkDevinProviderStatus(
        decodeDevinSettings({
          enabled: true,
          binaryPath: "/definitely/not/installed/devin-binary",
        }),
      );
      expect(snapshot.enabled).toBe(true);
      expect(snapshot.installed).toBe(false);
      expect(snapshot.status).toBe("error");
      expect(snapshot.message).toMatch(/not installed|not on PATH|Failed to execute/);
    }),
  );

  // A stand-in for the Devin CLI: `version` prints canned output and `acp`
  // execs the mock ACP agent so initialize/authenticate/session/new work.
  const writeFakeDevinCli = (input: { readonly acp: boolean }) =>
    Effect.gen(function* () {
      const fs = yield* FileSystem.FileSystem;
      const dir = yield* fs.makeTempDirectoryScoped({ prefix: "t3code-devin-probe-" });
      const mockAgentPath = NodePath.resolve(__dirname, "../../../scripts/acp-mock-agent.ts");
      const devinPath = writeFakeCli({
        directory: dir,
        name: "devin",
        source: [
          'if (process.argv[2] === "version") {',
          '  process.stdout.write("devin 3000.10.31 (abcdef)\\n");',
          "  process.exit(0);",
          "}",
          'if (!process.argv.includes("acp")) process.exit(1);',
          ...(input.acp ? [execScriptSource({ scriptPath: mockAgentPath })] : ["process.exit(3);"]),
          "",
        ].join("\n"),
      });
      return { devinPath, dir };
    });

  // Credentials live under `$XDG_DATA_HOME/devin/credentials.toml` — a separate
  // temp dir, since the fake CLI binary itself is named `devin` in its own dir.
  const writeDevinCredentials = Effect.fnUntraced(function* () {
    const fs = yield* FileSystem.FileSystem;
    const dataDir = yield* fs.makeTempDirectoryScoped({ prefix: "t3code-devin-xdg-" });
    yield* fs.makeDirectory(NodePath.join(dataDir, "devin"));
    yield* fs.writeFileString(
      NodePath.join(dataDir, "devin", "credentials.toml"),
      'windsurf_api_key = "devin-test-session-token"\n',
    );
    return dataDir;
  });

  it.effect("reports ready with ACP-discovered models when credentials exist", () =>
    Effect.gen(function* () {
      const snapshot = yield* Effect.scoped(
        Effect.gen(function* () {
          const { devinPath } = yield* writeFakeDevinCli({ acp: true });
          const dataDir = yield* writeDevinCredentials();
          return yield* checkDevinProviderStatus(
            decodeDevinSettings({ enabled: true, binaryPath: devinPath }),
            { ...process.env, XDG_DATA_HOME: dataDir },
          );
        }),
      );

      expect(snapshot.status).toBe("ready");
      expect(snapshot.version).toBe("3000.10.31");
      expect(snapshot.auth).toEqual({
        status: "authenticated",
        type: "cached_token",
        label: "Devin account",
      });
      // The mock agent's `model` config option advertises "default" as current.
      const slugs = snapshot.models.map((model) => model.slug);
      expect(slugs).toContain("default");
      expect(slugs).toContain("composer-2");
      expect(snapshot.models.find((model) => model.slug === "default")?.isDefault).toBe(true);
    }),
  );

  it.effect("reports unauthenticated without credentials and never starts a session", () =>
    Effect.gen(function* () {
      const snapshot = yield* Effect.scoped(
        Effect.gen(function* () {
          const { devinPath } = yield* writeFakeDevinCli({ acp: true });
          const fs = yield* FileSystem.FileSystem;
          // No credentials.toml written — XDG_DATA_HOME points at an empty store.
          const dataDir = yield* fs.makeTempDirectoryScoped({ prefix: "t3code-devin-xdg-" });
          return yield* checkDevinProviderStatus(
            decodeDevinSettings({ enabled: true, binaryPath: devinPath }),
            { ...process.env, XDG_DATA_HOME: dataDir },
          );
        }),
      );

      expect(snapshot.status).toBe("error");
      expect(snapshot.auth.status).toBe("unauthenticated");
      expect(snapshot.message).toContain("devin auth login");
    }),
  );

  it.effect("reports unauthenticated when the stored token is rejected", () =>
    Effect.gen(function* () {
      const snapshot = yield* Effect.scoped(
        Effect.gen(function* () {
          const { devinPath } = yield* writeFakeDevinCli({ acp: true });
          const dataDir = yield* writeDevinCredentials();
          return yield* checkDevinProviderStatus(
            decodeDevinSettings({ enabled: true, binaryPath: devinPath }),
            { ...process.env, XDG_DATA_HOME: dataDir, T3_ACP_FAIL_AUTHENTICATE: "1" },
          );
        }),
      );

      expect(snapshot.status).toBe("error");
      expect(snapshot.auth.status).toBe("unauthenticated");
      expect(snapshot.message).toContain("devin auth login");
    }),
  );

  it.effect("warns with fallback models when the ACP session probe fails", () =>
    Effect.gen(function* () {
      const snapshot = yield* Effect.scoped(
        Effect.gen(function* () {
          const { devinPath } = yield* writeFakeDevinCli({ acp: false });
          const dataDir = yield* writeDevinCredentials();
          return yield* checkDevinProviderStatus(
            decodeDevinSettings({ enabled: true, binaryPath: devinPath }),
            { ...process.env, XDG_DATA_HOME: dataDir },
          );
        }),
      );

      expect(snapshot.status).toBe("warning");
      expect(snapshot.installed).toBe(true);
      expect(snapshot.auth.status).toBe("unknown");
      expect(snapshot.models.map((model) => model.slug)).toEqual(["adaptive"]);
      expect(snapshot.message).toContain("ACP session probe failed");
      expect(snapshot.slashCommands.map((command) => command.name)).toEqual(["compact"]);
    }),
  );
});
