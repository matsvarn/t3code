// @effect-diagnostics nodeBuiltinImport:off - resolves the mock ACP agent script path relative to this test file.
import * as NodePath from "node:path";
import * as NodeURL from "node:url";

import * as NodeServices from "@effect/platform-node/NodeServices";
import { describe, expect, it } from "@effect/vitest";
import { ThreadId } from "@t3tools/contracts";
import * as Effect from "effect/Effect";
import * as Exit from "effect/Exit";
import * as FileSystem from "effect/FileSystem";
import * as Schema from "effect/Schema";
import * as ChildProcessSpawner from "effect/unstable/process/ChildProcessSpawner";

import {
  applyDevinAcpModelSelection,
  buildDevinAcpSpawnInput,
  composeDevinFusionSlug,
  devinAcpSpawnArgs,
  parseDevinFusionSlug,
  registerDevinModelCatalog,
  resolveDevinAcpBaseModelId,
  resolveDevinModelSelectionValue,
  splitDevinModelVariant,
  stageDevinMcpConfig,
  makeDevinAcpRuntime,
} from "./DevinAcpSupport.ts";
import { execScriptSource, writeFakeCli } from "../../testUtils/fakeCli.ts";

const __dirname = NodePath.dirname(NodeURL.fileURLToPath(import.meta.url));

const DevinMcpConfigShape = Schema.Struct({
  mcpServers: Schema.Struct({
    "t3-code": Schema.Struct({
      url: Schema.String,
      transport: Schema.String,
      headers: Schema.Struct({ Authorization: Schema.String }),
    }),
  }),
});
const decodeDevinMcpConfig = Schema.decodeUnknownEffect(Schema.fromJsonString(DevinMcpConfigShape));
const decodeJsonLine = Schema.decodeUnknownSync(Schema.fromJsonString(Schema.Unknown));

describe("devinAcpSpawnArgs", () => {
  it("passes Devin's least-permissive mode for approval-required", () => {
    expect(devinAcpSpawnArgs("approval-required")).toEqual(["--permission-mode", "auto", "acp"]);
  });

  it("maps runtime modes onto Devin permission modes", () => {
    expect(devinAcpSpawnArgs("auto-accept-edits")).toEqual([
      "--permission-mode",
      "accept-edits",
      "acp",
    ]);
    expect(devinAcpSpawnArgs("auto")).toEqual(["--permission-mode", "smart", "acp"]);
    expect(devinAcpSpawnArgs("full-access")).toEqual(["--permission-mode", "dangerous", "acp"]);
  });

  it("spawns a bare acp server when no runtime mode is set", () => {
    expect(devinAcpSpawnArgs()).toEqual(["acp"]);
    expect(devinAcpSpawnArgs(undefined)).toEqual(["acp"]);
  });

  it("puts the agent type after the acp subcommand", () => {
    expect(devinAcpSpawnArgs("auto", "summarizer")).toEqual([
      "--permission-mode",
      "smart",
      "acp",
      "--agent-type",
      "summarizer",
    ]);
    expect(devinAcpSpawnArgs(undefined, "review")).toEqual(["acp", "--agent-type", "review"]);
  });

  it("relays to Devin Cloud only for the default agent", () => {
    expect(devinAcpSpawnArgs("auto", undefined, true)).toEqual([
      "--permission-mode",
      "smart",
      "acp",
      "--cloud",
    ]);
    // `--agent-type` is a local-agent flag the cloud relay ignores — explicit
    // agent types must stay local even when the instance is cloud-enabled.
    expect(devinAcpSpawnArgs("auto", "summarizer", true)).toEqual([
      "--permission-mode",
      "smart",
      "acp",
      "--agent-type",
      "summarizer",
    ]);
  });
});

describe("buildDevinAcpSpawnInput", () => {
  it("defaults to `devin` on PATH and threads cwd through", () => {
    expect(buildDevinAcpSpawnInput(null, "/tmp/work")).toEqual({
      command: "devin",
      args: ["acp"],
      cwd: "/tmp/work",
    });
  });

  it("honours a configured binary path", () => {
    const spawn = buildDevinAcpSpawnInput(
      { binaryPath: "/opt/devin/bin/devin" },
      "/tmp/work",
      undefined,
      "full-access",
    );
    expect(spawn.command).toBe("/opt/devin/bin/devin");
    expect(spawn.args).toEqual(["--permission-mode", "dangerous", "acp"]);
  });

  it("appends --cloud for cloud-enabled instances", () => {
    expect(buildDevinAcpSpawnInput({ binaryPath: "", cloud: true }, "/tmp/work").args).toEqual([
      "acp",
      "--cloud",
    ]);
  });
});

describe("resolveDevinAcpBaseModelId", () => {
  it("falls back to Devin's adaptive router", () => {
    expect(resolveDevinAcpBaseModelId(undefined)).toBe("adaptive");
    expect(resolveDevinAcpBaseModelId(null)).toBe("adaptive");
    expect(resolveDevinAcpBaseModelId("")).toBe("adaptive");
    expect(resolveDevinAcpBaseModelId("   ")).toBe("adaptive");
  });

  it("passes explicit model slugs through", () => {
    expect(resolveDevinAcpBaseModelId("opus")).toBe("opus");
    expect(resolveDevinAcpBaseModelId("  sonnet-4.6  ")).toBe("sonnet-4.6");
  });
});

describe("parseDevinFusionSlug", () => {
  it("splits lead, effort, and sidekick out of a composed slug", () => {
    expect(parseDevinFusionSlug("fusion-claude-fable-5-1-medium-sidekick-swe-2-medium")).toEqual({
      lead: "claude-fable-5-1",
      leadEffort: "medium",
      sidekick: "swe-2-medium",
    });
    expect(parseDevinFusionSlug("fusion-gpt-5-6-sol-high-fast-sidekick-swe-2-high")).toEqual({
      lead: "gpt-5-6-sol",
      leadEffort: "high-fast",
      sidekick: "swe-2-high",
    });
    expect(
      parseDevinFusionSlug("fusion-gpt-6-astra-xhigh-sidekick-gpt-5-6-luna-high-priority"),
    ).toEqual({
      lead: "gpt-6-astra",
      leadEffort: "xhigh",
      sidekick: "gpt-5-6-luna-high-priority",
    });
  });

  it("treats a head without an effort token as effortless", () => {
    expect(parseDevinFusionSlug("fusion-glm-5-2-sidekick-swe-2-medium")).toEqual({
      lead: "glm-5-2",
      leadEffort: undefined,
      sidekick: "swe-2-medium",
    });
  });

  it("rejects non-fusion and malformed slugs", () => {
    expect(parseDevinFusionSlug("adaptive")).toBeUndefined();
    expect(parseDevinFusionSlug("fusion")).toBeUndefined();
    expect(parseDevinFusionSlug("fusion-swe-2-medium")).toBeUndefined();
    expect(parseDevinFusionSlug("fusion--sidekick-")).toBeUndefined();
    expect(parseDevinFusionSlug("swe-2-medium-sidekick-fusion")).toBeUndefined();
  });
});

describe("composeDevinFusionSlug", () => {
  it("round-trips through parseDevinFusionSlug", () => {
    const slug = "fusion-claude-opus-5-high-fast-sidekick-gpt-5-6-sol-high";
    expect(composeDevinFusionSlug(parseDevinFusionSlug(slug)!)).toBe(slug);
  });

  it("omits the effort segment when the lead has none", () => {
    expect(
      composeDevinFusionSlug({ lead: "glm-5-2", leadEffort: undefined, sidekick: "swe-2-high" }),
    ).toBe("fusion-glm-5-2-sidekick-swe-2-high");
  });
});

describe("splitDevinModelVariant", () => {
  it("splits hyphenated effort tails, including fast/priority modifiers", () => {
    expect(splitDevinModelVariant("claude-opus-5-high-fast")).toEqual({
      base: "claude-opus-5",
      variant: "high-fast",
    });
    expect(splitDevinModelVariant("gpt-5-6-sol-medium-priority")).toEqual({
      base: "gpt-5-6-sol",
      variant: "medium-priority",
    });
    expect(splitDevinModelVariant("swe-2-max")).toEqual({ base: "swe-2", variant: "max" });
    expect(splitDevinModelVariant("gpt-5-4-none")).toEqual({ base: "gpt-5-4", variant: "none" });
  });

  it("splits underscore-separated MODEL_ variant tails", () => {
    expect(splitDevinModelVariant("MODEL_GPT_5_2_XHIGH")).toEqual({
      base: "MODEL_GPT_5_2",
      variant: "xhigh",
    });
    expect(splitDevinModelVariant("MODEL_GOOGLE_GEMINI_3_0_FLASH_MINIMAL")).toEqual({
      base: "MODEL_GOOGLE_GEMINI_3_0_FLASH",
      variant: "minimal",
    });
    expect(splitDevinModelVariant("MODEL_CLAUDE_4_5_OPUS_THINKING")).toEqual({
      base: "MODEL_CLAUDE_4_5_OPUS",
      variant: "thinking",
    });
  });

  it("stacks thinking, fast, and 1m context tails onto the base", () => {
    expect(splitDevinModelVariant("claude-opus-4-6-thinking")).toEqual({
      base: "claude-opus-4-6",
      variant: "thinking",
    });
    expect(splitDevinModelVariant("glm-5-2-max-1m")).toEqual({
      base: "glm-5-2",
      variant: "max-1m",
    });
    expect(splitDevinModelVariant("claude-sonnet-4-6-thinking-1m")).toEqual({
      base: "claude-sonnet-4-6",
      variant: "thinking-1m",
    });
    expect(splitDevinModelVariant("swe-1-6-fast")).toEqual({
      base: "swe-1-6",
      variant: "fast",
    });
  });

  it("leaves bare and non-variant slugs whole", () => {
    expect(splitDevinModelVariant("adaptive")).toEqual({ base: "adaptive", variant: "" });
    expect(splitDevinModelVariant("MODEL_PRIVATE_11")).toEqual({
      base: "MODEL_PRIVATE_11",
      variant: "",
    });
    expect(splitDevinModelVariant("swe-1-7-lightning")).toEqual({
      base: "swe-1-7-lightning",
      variant: "",
    });
  });
});

describe("resolveDevinModelSelectionValue", () => {
  const CATALOG = [
    "fusion-claude-fable-5-1-medium-sidekick-swe-2-medium",
    "fusion-claude-fable-5-1-medium-sidekick-swe-2-high",
    "fusion-claude-fable-5-1-medium-fast-sidekick-swe-2-medium",
    "fusion-claude-fable-5-1-medium-fast-sidekick-swe-2-high",
    "fusion-gpt-6-astra-xhigh-sidekick-glm-5-2",
  ];

  it("sends non-fusion selections through untouched", () => {
    expect(resolveDevinModelSelectionValue("swe-2-max", undefined)).toBe("swe-2-max");
    expect(resolveDevinModelSelectionValue(undefined, undefined)).toBe("adaptive");
  });

  it("falls back to the catalog's fusion default when options are incomplete", () => {
    registerDevinModelCatalog({
      fusionSlugs: CATALOG,
      effortFamilies: new Map(),
      defaultFusionSlug: "fusion-claude-fable-5-1-medium-sidekick-swe-2-medium",
    });
    expect(resolveDevinModelSelectionValue("fusion", undefined)).toBe(
      "fusion-claude-fable-5-1-medium-sidekick-swe-2-medium",
    );
    expect(
      resolveDevinModelSelectionValue("fusion", [{ id: "lead", value: "claude-fable-5-1" }]),
    ).toBe("fusion-claude-fable-5-1-medium-sidekick-swe-2-medium");
    // Without an advertised default the bare family id is the only option left.
    registerDevinModelCatalog({ fusionSlugs: CATALOG, effortFamilies: new Map() });
    expect(resolveDevinModelSelectionValue("fusion", undefined)).toBe("fusion");
  });

  it("composes lead, effort, and sidekick selections into the advertised slug", () => {
    registerDevinModelCatalog({ fusionSlugs: CATALOG, effortFamilies: new Map() });
    expect(
      resolveDevinModelSelectionValue("fusion", [
        { id: "lead", value: "claude-fable-5-1" },
        { id: "leadEffort", value: "medium" },
        { id: "sidekick", value: "swe-2-medium" },
      ]),
    ).toBe("fusion-claude-fable-5-1-medium-sidekick-swe-2-medium");
  });

  it("snaps an unadvertised sidekick to the same family for that head", () => {
    registerDevinModelCatalog({ fusionSlugs: CATALOG, effortFamilies: new Map() });
    // medium-fast + swe-2-medium isn't advertised for this head; swe-2-high is.
    expect(
      resolveDevinModelSelectionValue("fusion", [
        { id: "lead", value: "claude-fable-5-1" },
        { id: "leadEffort", value: "medium-fast" },
        { id: "sidekick", value: "swe-2-medium" },
      ]),
    ).toBe("fusion-claude-fable-5-1-medium-fast-sidekick-swe-2-medium");
    expect(
      resolveDevinModelSelectionValue("fusion", [
        { id: "lead", value: "claude-fable-5-1" },
        { id: "leadEffort", value: "medium-fast" },
        { id: "sidekick", value: "glm-5-2" },
      ]),
    ).toBe("fusion-claude-fable-5-1-medium-fast-sidekick-swe-2-medium");
  });

  it("falls back to the fusion default when the lead+effort isn't advertised", () => {
    registerDevinModelCatalog({
      fusionSlugs: CATALOG,
      effortFamilies: new Map(),
      defaultFusionSlug: "fusion-claude-fable-5-1-medium-sidekick-swe-2-medium",
    });
    expect(
      resolveDevinModelSelectionValue("fusion", [
        { id: "lead", value: "claude-fable-5-1" },
        { id: "leadEffort", value: "low" },
        { id: "sidekick", value: "swe-2-medium" },
      ]),
    ).toBe("fusion-claude-fable-5-1-medium-sidekick-swe-2-medium");
  });

  it("dispatches the exact variant slug for collapsed effort families", () => {
    registerDevinModelCatalog({
      fusionSlugs: [],
      effortFamilies: new Map([
        ["swe-2", { defaultSlug: "swe-2-max", variants: new Set(["swe-2-medium", "swe-2-max"]) }],
      ]),
    });
    expect(
      resolveDevinModelSelectionValue("swe-2", [{ id: "effort", value: "swe-2-medium" }]),
    ).toBe("swe-2-medium");
    // Missing or stale picks resolve to the family's default variant.
    expect(resolveDevinModelSelectionValue("swe-2", undefined)).toBe("swe-2-max");
    expect(resolveDevinModelSelectionValue("swe-2", [{ id: "effort", value: "swe-2-low" }])).toBe(
      "swe-2-max",
    );
  });

  it("passes stored variant slugs through untouched", () => {
    // A thread that stored the concrete slug before the collapse keeps its pick.
    expect(resolveDevinModelSelectionValue("swe-2-medium", undefined)).toBe("swe-2-medium");
  });

  it("dispatches member slugs verbatim for name-grouped families", () => {
    registerDevinModelCatalog({
      fusionSlugs: [],
      effortFamilies: new Map([
        [
          "gpt-5-1",
          {
            defaultSlug: "MODEL_PRIVATE_12",
            variants: new Set([
              "MODEL_PRIVATE_12",
              "MODEL_PRIVATE_13",
              "MODEL_PRIVATE_14",
              "MODEL_PRIVATE_15",
            ]),
          },
        ],
      ]),
    });
    expect(
      resolveDevinModelSelectionValue("gpt-5-1", [{ id: "effort", value: "MODEL_PRIVATE_14" }]),
    ).toBe("MODEL_PRIVATE_14");
    expect(resolveDevinModelSelectionValue("gpt-5-1", undefined)).toBe("MODEL_PRIVATE_12");
  });
});

describe("applyDevinAcpModelSelection", () => {
  it.effect("dispatches the composed fusion slug through setModel", () =>
    Effect.gen(function* () {
      registerDevinModelCatalog({
        fusionSlugs: ["fusion-claude-fable-5-1-high-sidekick-swe-2-high"],
        effortFamilies: new Map(),
      });
      let applied: string | undefined;
      const runtime = {
        setModel: (model: string) => {
          applied = model;
          return Effect.void;
        },
      };
      yield* applyDevinAcpModelSelection({
        runtime,
        model: "fusion",
        selections: [
          { id: "lead", value: "claude-fable-5-1" },
          { id: "leadEffort", value: "high" },
          { id: "sidekick", value: "swe-2-high" },
        ],
        mapError: (cause) => cause,
      });
      expect(applied).toBe("fusion-claude-fable-5-1-high-sidekick-swe-2-high");
    }),
  );

  it.effect("dispatches plain model slugs unchanged", () =>
    Effect.gen(function* () {
      let applied: string | undefined;
      const runtime = {
        setModel: (model: string) => {
          applied = model;
          return Effect.void;
        },
      };
      yield* applyDevinAcpModelSelection({
        runtime,
        model: "swe-2-max",
        mapError: (cause) => cause,
      });
      expect(applied).toBe("swe-2-max");
    }),
  );
});

it.layer(NodeServices.layer)("stageDevinMcpConfig", (it) => {
  it.effect("writes a t3-code mcp_config.local.json under a per-thread .devin directory", () =>
    Effect.gen(function* () {
      const fs = yield* FileSystem.FileSystem;
      const stateDir = yield* fs.makeTempDirectoryScoped({ prefix: "t3code-devin-mcp-" });
      const directory = yield* stageDevinMcpConfig(stateDir, ThreadId.make("thread-mcp-stage"), {
        endpoint: "http://127.0.0.1:13773/mcp",
        authorizationHeader: "Bearer t3-test-credential",
      });
      expect(directory).toBe(NodePath.join(stateDir, "devin-mcp", "thread-mcp-stage"));
      const written = yield* fs.readFileString(
        NodePath.join(directory, ".devin", "mcp_config.local.json"),
      );
      const parsed = yield* decodeDevinMcpConfig(written);
      expect(parsed.mcpServers["t3-code"]).toEqual({
        url: "http://127.0.0.1:13773/mcp",
        transport: "http",
        headers: { Authorization: "Bearer t3-test-credential" },
      });
    }),
  );

  it.effect("re-stages with the refreshed credential on restart", () =>
    Effect.gen(function* () {
      const fs = yield* FileSystem.FileSystem;
      const stateDir = yield* fs.makeTempDirectoryScoped({ prefix: "t3code-devin-mcp-" });
      const threadId = ThreadId.make("thread-mcp-restage");
      yield* stageDevinMcpConfig(stateDir, threadId, {
        endpoint: "http://127.0.0.1:13773/mcp",
        authorizationHeader: "Bearer old-token",
      });
      yield* stageDevinMcpConfig(stateDir, threadId, {
        endpoint: "http://127.0.0.1:13773/mcp",
        authorizationHeader: "Bearer new-token",
      });
      const written = yield* fs.readFileString(
        NodePath.join(
          stateDir,
          "devin-mcp",
          "thread-mcp-restage",
          ".devin",
          "mcp_config.local.json",
        ),
      );
      expect(written).toContain("Bearer new-token");
      expect(written).not.toContain("old-token");
    }),
  );
});

it.layer(NodeServices.layer)("makeDevinAcpRuntime", (it) => {
  const writeFakeDevinCli = () =>
    Effect.gen(function* () {
      const fs = yield* FileSystem.FileSystem;
      const dir = yield* fs.makeTempDirectoryScoped({ prefix: "t3code-devin-acp-" });
      const mockAgentPath = NodePath.resolve(__dirname, "../../../scripts/acp-mock-agent.ts");
      return writeFakeCli({
        directory: dir,
        name: "devin",
        source: [
          'if (!process.argv.includes("acp")) process.exit(1);',
          execScriptSource({ scriptPath: mockAgentPath }),
          "",
        ].join("\n"),
      });
    });

  it.effect("skips authenticate entirely when no api key is provided", () =>
    Effect.gen(function* () {
      const devinPath = yield* writeFakeDevinCli();
      const exit = yield* Effect.exit(
        Effect.scoped(
          Effect.gen(function* () {
            const spawner = yield* ChildProcessSpawner.ChildProcessSpawner;
            const acp = yield* makeDevinAcpRuntime({
              devinSettings: { binaryPath: devinPath },
              // The mock rejects `authenticate` — succeeding here proves the
              // request was never sent (the browser-popup bug).
              environment: { ...process.env, T3_ACP_FAIL_AUTHENTICATE: "1" },
              childProcessSpawner: spawner,
              cwd: "/tmp",
              clientInfo: { name: "test", version: "0" },
            });
            yield* acp.start();
          }),
        ),
      );
      expect(Exit.isSuccess(exit)).toBe(true);
    }),
  );

  it.effect("sends authenticate with the stored api key when provided", () =>
    Effect.gen(function* () {
      const devinPath = yield* writeFakeDevinCli();
      const exit = yield* Effect.exit(
        Effect.scoped(
          Effect.gen(function* () {
            const spawner = yield* ChildProcessSpawner.ChildProcessSpawner;
            const acp = yield* makeDevinAcpRuntime({
              devinSettings: { binaryPath: devinPath },
              environment: { ...process.env, T3_ACP_FAIL_AUTHENTICATE: "1" },
              childProcessSpawner: spawner,
              cwd: "/tmp",
              clientInfo: { name: "test", version: "0" },
              devinApiKey: "devin-test-session-token",
            });
            yield* acp.start();
          }),
        ),
      );
      expect(Exit.isFailure(exit)).toBe(true);
    }),
  );

  it.effect("forwards additionalDirectories to session/new", () =>
    Effect.gen(function* () {
      const fs = yield* FileSystem.FileSystem;
      const devinPath = yield* writeFakeDevinCli();
      const requestLogPath = NodePath.join(
        yield* fs.makeTempDirectoryScoped({ prefix: "t3code-devin-req-" }),
        "requests.ndjson",
      );
      yield* Effect.scoped(
        Effect.gen(function* () {
          const spawner = yield* ChildProcessSpawner.ChildProcessSpawner;
          const acp = yield* makeDevinAcpRuntime({
            devinSettings: { binaryPath: devinPath },
            environment: { ...process.env, T3_ACP_REQUEST_LOG_PATH: requestLogPath },
            childProcessSpawner: spawner,
            cwd: "/tmp",
            clientInfo: { name: "test", version: "0" },
            additionalDirectories: ["/t3-state/devin-mcp/thread-1"],
          });
          yield* acp.start();
        }),
      );
      const log = yield* fs.readFileString(requestLogPath);
      const sessionNew = log
        .trim()
        .split("\n")
        .map((line) => decodeJsonLine(line))
        .find(
          (message): message is { method: string; params?: Record<string, unknown> } =>
            typeof message === "object" &&
            message !== null &&
            (message as { method?: unknown }).method === "session/new",
        );
      expect(sessionNew?.params?.additionalDirectories).toEqual(["/t3-state/devin-mcp/thread-1"]);
    }),
  );

  it.effect("forwards additionalDirectories to session/load", () =>
    Effect.gen(function* () {
      const fs = yield* FileSystem.FileSystem;
      const devinPath = yield* writeFakeDevinCli();
      const requestLogPath = NodePath.join(
        yield* fs.makeTempDirectoryScoped({ prefix: "t3code-devin-req-" }),
        "requests.ndjson",
      );
      yield* Effect.scoped(
        Effect.gen(function* () {
          const spawner = yield* ChildProcessSpawner.ChildProcessSpawner;
          const acp = yield* makeDevinAcpRuntime({
            devinSettings: { binaryPath: devinPath },
            environment: { ...process.env, T3_ACP_REQUEST_LOG_PATH: requestLogPath },
            childProcessSpawner: spawner,
            cwd: "/tmp",
            clientInfo: { name: "test", version: "0" },
            resumeSessionId: "mock-session-1",
            additionalDirectories: ["/t3-state/devin-mcp/thread-1"],
          });
          yield* acp.start();
        }),
      );
      const log = yield* fs.readFileString(requestLogPath);
      const sessionLoad = log
        .trim()
        .split("\n")
        .map((line) => decodeJsonLine(line))
        .find(
          (message): message is { method: string; params?: Record<string, unknown> } =>
            typeof message === "object" &&
            message !== null &&
            (message as { method?: unknown }).method === "session/load",
        );
      expect(sessionLoad?.params?.additionalDirectories).toEqual(["/t3-state/devin-mcp/thread-1"]);
    }),
  );
});
