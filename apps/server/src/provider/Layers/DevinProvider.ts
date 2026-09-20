import {
  type CustomModelSetting,
  type DevinSettings,
  type ModelCapabilities,
  type SelectProviderOptionDescriptor,
  type ServerProvider,
  type ServerProviderModel,
  type ServerProviderSlashCommand,
} from "@t3tools/contracts";
// @effect-diagnostics nodeBuiltinImport:off - os.tmpdir() keeps probe sessions out of project cwd lists.
import * as NodeOS from "node:os";

import * as EffectAcpSchema from "effect-acp/schema";
import * as EffectAcpErrors from "effect-acp/errors";
import { causeErrorTag } from "@t3tools/shared/observability";
import * as Cause from "effect/Cause";
import * as Crypto from "effect/Crypto";
import * as DateTime from "effect/DateTime";
import * as Effect from "effect/Effect";
import * as Exit from "effect/Exit";
import * as FileSystem from "effect/FileSystem";
import * as Option from "effect/Option";
import * as Path from "effect/Path";
import * as Result from "effect/Result";
import * as Schema from "effect/Schema";
import { HttpClient } from "effect/unstable/http";
import { ChildProcess, ChildProcessSpawner } from "effect/unstable/process";
import { createModelCapabilities } from "@t3tools/shared/model";
import { resolveSpawnCommand } from "@t3tools/shared/shell";

import {
  buildServerProvider,
  COMPACT_SLASH_COMMAND,
  isCommandMissingCause,
  parseGenericCliVersion,
  providerModelsFromSettings,
  spawnAndCollect,
  type ServerProviderDraft,
} from "../providerSnapshot.ts";
import {
  enrichProviderSnapshotWithVersionAdvisory,
  type ProviderMaintenanceCapabilities,
} from "../providerMaintenance.ts";
import {
  DEVIN_DEFAULT_MODEL_SLUG,
  DEVIN_EFFORT_OPTION_ID,
  DEVIN_FUSION_MODEL_SLUG,
  DEVIN_FUSION_OPTION_IDS,
  type DevinEffortFamily,
  makeDevinAcpRuntime,
  parseDevinFusionSlug,
  readDevinApiKey,
  registerDevinModelCatalog,
  splitDevinModelEffort,
} from "../acp/DevinAcpSupport.ts";

const DEVIN_PRESENTATION = {
  displayName: "Devin",
  supportsConversationRollback: false,
  badgeLabel: "Early Access",
  showInteractionModeToggle: false,
} as const;
const EMPTY_CAPABILITIES: ModelCapabilities = createModelCapabilities({
  optionDescriptors: [],
});

const VERSION_PROBE_TIMEOUT_MS = 4_000;
// `initialize` is a single local round trip, so this is generous even on slow machines.
const DEVIN_ACP_INITIALIZE_TIMEOUT_MS = 8_000;
// `session/new` boots the agent (skills scan, session DB) — slower than initialize
// but still a local round trip.
const DEVIN_ACP_SESSION_PROBE_TIMEOUT_MS = 20_000;

const DEVIN_BUILT_IN_MODELS: ReadonlyArray<ServerProviderModel> = [
  {
    slug: DEVIN_DEFAULT_MODEL_SLUG,
    name: "Adaptive",
    isCustom: false,
    capabilities: EMPTY_CAPABILITIES,
  },
];

/**
 * Commands T3 owns (permissions, models, sessions, auth, workspace roots) or
 * that duplicate built-in UI. Everything else the agent advertises passes
 * through to the command palette.
 */
const DEVIN_FILTERED_SLASH_COMMANDS = new Set([
  "mode",
  "normal",
  "accept-edits",
  "smart",
  "plan",
  "ask",
  "bypass",
  "yolo",
  "dangerous",
  "autonomous",
  "model",
  "fast",
  "login",
  "logout",
  "status",
  "exit",
  "quit",
  "new",
  "clear",
  "resume",
  "continue",
  "ls",
  "list-sessions",
  "rm-session",
  "rename-session",
  "title",
  "export",
  "update",
  "config",
  "theme",
  "shortcuts",
  "workspace",
  "workspaces",
  "add-dir",
  "remove-dir",
  "undo-add-dir",
  "mcp",
]);

export function buildInitialDevinProviderSnapshot(
  devinSettings: DevinSettings,
): Effect.Effect<ServerProviderDraft> {
  return Effect.gen(function* () {
    const checkedAt = yield* Effect.map(DateTime.now, DateTime.formatIso);
    const models = devinModelsFromSettings(devinSettings.customModels);

    if (!devinSettings.enabled) {
      return buildServerProvider({
        presentation: DEVIN_PRESENTATION,
        enabled: false,
        checkedAt,
        models,
        probe: {
          installed: false,
          version: null,
          status: "warning",
          auth: { status: "unknown" },
          message: "Devin is disabled in T3 Code settings.",
        },
      });
    }

    return buildServerProvider({
      presentation: DEVIN_PRESENTATION,
      enabled: true,
      checkedAt,
      models,
      probe: {
        installed: true,
        version: null,
        status: "warning",
        auth: { status: "unknown" },
        message: "Checking Devin CLI availability...",
      },
    });
  });
}

function devinModelsFromSettings(
  customModels: ReadonlyArray<CustomModelSetting> | undefined,
  builtInModels: ReadonlyArray<ServerProviderModel> = DEVIN_BUILT_IN_MODELS,
): ReadonlyArray<ServerProviderModel> {
  return providerModelsFromSettings(builtInModels, customModels ?? [], EMPTY_CAPABILITIES);
}

/**
 * Models advertised through the session's `model` config option — the only place
 * Devin publishes its full catalog (it populates neither `models` in session
 * responses nor `modelState` in `initialize`). The option's `currentValue` marks
 * the session's active model as the default.
 *
 * Devin enumerates every fusion combination as its own select entry (~175 of
 * them), so they're collapsed here into a single "Fusion" model whose option
 * descriptors carry lead/effort/sidekick choices. The adapter composes the
 * concrete slug from those selections at apply time. Ordinary models get the
 * same treatment one dimension down: `<base>-<effort>` variants (`swe-2-max`,
 * `claude-opus-5-high-fast`, `MODEL_GPT_5_2_LOW`) collapse into one model per
 * family with an "Effort" descriptor whose option ids are the exact variant
 * slugs.
 */
export function buildDevinModelsFromConfigOptions(
  configOptions: ReadonlyArray<EffectAcpSchema.SessionConfigOption> | null | undefined,
): ReadonlyArray<ServerProviderModel> {
  const modelOption = configOptions?.find(
    (option) => option.id === "model" && option.type === "select",
  );
  if (!modelOption || modelOption.type !== "select") {
    return [];
  }
  const currentValue = modelOption.currentValue;
  const seen = new Set<string>();
  const models: ServerProviderModel[] = [];
  const fusionEntries: Array<{ slug: string; name: string }> = [];
  const effortGroups = new Map<string, Array<{ slug: string; name: string }>>();
  const effortFamilies = new Map<string, DevinEffortFamily>();
  for (const entry of modelOption.options) {
    // Options may be a flat list or grouped under headers; Devin serves a flat list.
    const items = "options" in entry ? entry.options : [entry];
    for (const item of items) {
      const slug = item.value.trim();
      if (!slug || seen.has(slug)) continue;
      seen.add(slug);
      const name = item.name.trim() || slug;
      if (parseDevinFusionSlug(slug)) {
        fusionEntries.push({ slug, name });
        continue;
      }
      const { base } = splitDevinModelEffort(slug);
      const group = effortGroups.get(base);
      if (group) {
        group.push({ slug, name });
      } else {
        effortGroups.set(base, [{ slug, name }]);
      }
    }
  }
  for (const [base, members] of effortGroups) {
    if (members.length === 1) {
      const member = members[0]!;
      models.push({
        slug: member.slug,
        name: member.name,
        isCustom: false,
        ...(member.slug === currentValue ? { isDefault: true } : {}),
        capabilities: EMPTY_CAPABILITIES,
      });
      continue;
    }
    const model = buildDevinEffortFamilyModel(base, members, currentValue);
    models.push(model);
    effortFamilies.set(base, {
      defaultSlug: members.find((member) => member.slug === currentValue)?.slug ?? members[0]!.slug,
      variants: new Set(members.map((member) => member.slug)),
    });
  }
  registerDevinModelCatalog({
    fusionSlugs: fusionEntries.map((entry) => entry.slug),
    effortFamilies,
  });
  const fusionModel = buildDevinFusionModel(fusionEntries, currentValue);
  return fusionModel ? [fusionModel, ...models] : models;
}

/**
 * The shared leading words across a family's display names ("SWE-2 Max" +
 * "SWE-2 Medium" → "SWE-2"), truncated to a whole-word boundary so each
 * variant's remainder reads as its effort label ("Max", "Medium").
 */
function devinCommonNamePrefix(names: ReadonlyArray<string>): string {
  let prefix = names[0] ?? "";
  for (const name of names.slice(1)) {
    let index = 0;
    while (index < prefix.length && index < name.length && prefix[index] === name[index]) {
      index += 1;
    }
    prefix = prefix.slice(0, index);
    if (!prefix) break;
  }
  if (names.some((name) => name.length > prefix.length && name[prefix.length] !== " ")) {
    const boundary = prefix.lastIndexOf(" ");
    prefix = boundary > 0 ? prefix.slice(0, boundary) : "";
  }
  return prefix.trimEnd();
}

function buildDevinEffortFamilyModel(
  base: string,
  members: ReadonlyArray<{ slug: string; name: string }>,
  currentValue: string | undefined,
): ServerProviderModel {
  const namePrefix = devinCommonNamePrefix(members.map((member) => member.name));
  const activeSlug = members.some((member) => member.slug === currentValue)
    ? currentValue
    : undefined;
  const defaultSlug = activeSlug ?? members[0]!.slug;
  return {
    slug: base,
    name: namePrefix || devinSlugLabel(base),
    isCustom: false,
    ...(activeSlug ? { isDefault: true } : {}),
    aliases: members.filter((member) => member.slug !== base).map((member) => member.slug),
    capabilities: {
      ...EMPTY_CAPABILITIES,
      optionDescriptors: [
        {
          id: DEVIN_EFFORT_OPTION_ID,
          label: "Effort",
          type: "select",
          options: members.map((member) => ({
            id: member.slug,
            label: member.name.slice(namePrefix.length).trim() || "Default",
            ...(member.slug === defaultSlug ? { isDefault: true } : {}),
          })),
          currentValue: defaultSlug,
        },
      ],
    },
  };
}

const DEVIN_FUSION_NAME_PATTERN = /^Fusion \((.+) \+ (.+)\)$/;

// Trailing words stripped from a lead's display name ("Claude Opus 5 High Fast"
// → "Claude Opus 5").
const DEVIN_FUSION_NAME_EFFORT_WORDS =
  /^(none|minimal|low|medium|high|xhigh|max|fast|priority|thinking)$/i;

const DEVIN_FUSION_EFFORT_ORDER = [
  "none",
  "minimal",
  "low",
  "medium",
  "high",
  "xhigh",
  "max",
] as const;

const DEVIN_FUSION_TOKEN_LABELS: Record<string, string> = {
  none: "None",
  minimal: "Minimal",
  low: "Low",
  medium: "Medium",
  high: "High",
  xhigh: "XHigh",
  max: "Max",
  fast: "Fast",
  priority: "Priority",
  swe: "SWE",
  gpt: "GPT",
  glm: "GLM",
  grok: "Grok",
};

// Labels for slugs the display name doesn't cover (acronyms stay uppercase,
// everything else capitalizes).
function devinSlugLabel(slug: string): string {
  return slug
    .split("-")
    .map((token) =>
      token.length === 0
        ? token
        : (DEVIN_FUSION_TOKEN_LABELS[token] ?? token.charAt(0).toUpperCase() + token.slice(1)),
    )
    .join(" ");
}

function devinFusionEffortRank(effort: string): number {
  const base = effort.split("-")[0] ?? effort;
  const rank = DEVIN_FUSION_EFFORT_ORDER.indexOf(
    base as (typeof DEVIN_FUSION_EFFORT_ORDER)[number],
  );
  return (
    (rank === -1 ? DEVIN_FUSION_EFFORT_ORDER.length : rank) * 10 + (effort.includes("-") ? 1 : 0)
  );
}

interface DevinFusionChoice {
  readonly id: string;
  readonly label: string;
}

interface DevinFusionDefaults {
  readonly lead: string | undefined;
  readonly leadEffort: string | undefined;
  readonly sidekick: string | undefined;
}

function buildDevinFusionModel(
  entries: ReadonlyArray<{ slug: string; name: string }>,
  currentValue: string | undefined,
): ServerProviderModel | undefined {
  if (entries.length === 0) {
    return undefined;
  }
  const leads = new Map<string, DevinFusionChoice>();
  const efforts = new Map<string, DevinFusionChoice>();
  const sidekicks = new Map<string, DevinFusionChoice>();
  const parsedEntries: Array<{
    lead: string;
    leadEffort: string | undefined;
    sidekick: string;
  }> = [];

  for (const entry of entries) {
    const parsed = parseDevinFusionSlug(entry.slug);
    if (!parsed) continue;
    parsedEntries.push(parsed);
    const nameParts = DEVIN_FUSION_NAME_PATTERN.exec(entry.name);
    const leadName = nameParts?.[1]?.trim();
    const sidekickName = nameParts?.[2]?.trim();

    if (!leads.has(parsed.lead)) {
      let label: string | undefined;
      if (leadName) {
        // "Claude Opus 5 High Fast" → "Claude Opus 5": the effort is already its
        // own control, so strip trailing effort words from the lead label.
        const words = leadName.split(/\s+/);
        while (words.length > 1 && DEVIN_FUSION_NAME_EFFORT_WORDS.test(words[words.length - 1]!)) {
          words.pop();
        }
        label = words.join(" ");
      }
      leads.set(parsed.lead, { id: parsed.lead, label: label || devinSlugLabel(parsed.lead) });
    }
    if (parsed.leadEffort && !efforts.has(parsed.leadEffort)) {
      efforts.set(parsed.leadEffort, {
        id: parsed.leadEffort,
        label: devinSlugLabel(parsed.leadEffort),
      });
    }
    if (!sidekicks.has(parsed.sidekick)) {
      sidekicks.set(parsed.sidekick, {
        id: parsed.sidekick,
        label: sidekickName ?? devinSlugLabel(parsed.sidekick),
      });
    }
  }

  if (leads.size === 0 || sidekicks.size === 0) {
    return undefined;
  }

  // Prefer the session's active combination as the prefill; fall back to the
  // first advertised one. Parts that aren't advertised (a stale currentValue)
  // drop out so no select points at a missing option.
  const parsedCurrent = currentValue ? parseDevinFusionSlug(currentValue) : undefined;
  const requested: DevinFusionDefaults = parsedCurrent ??
    parsedEntries[0] ?? { lead: undefined, leadEffort: undefined, sidekick: undefined };
  const defaults: DevinFusionDefaults = {
    lead: requested.lead && leads.has(requested.lead) ? requested.lead : undefined,
    leadEffort:
      requested.leadEffort && efforts.has(requested.leadEffort) ? requested.leadEffort : undefined,
    sidekick:
      requested.sidekick && sidekicks.has(requested.sidekick) ? requested.sidekick : undefined,
  };

  const effortChoices = [...efforts.values()].sort(
    (a, b) => devinFusionEffortRank(a.id) - devinFusionEffortRank(b.id),
  );
  const optionDescriptors: SelectProviderOptionDescriptor[] = [
    {
      id: DEVIN_FUSION_OPTION_IDS.lead,
      label: "Lead model",
      type: "select",
      options: [...leads.values()].map((choice) => ({
        ...choice,
        ...(choice.id === defaults.lead ? { isDefault: true } : {}),
      })),
      ...(defaults.lead ? { currentValue: defaults.lead } : {}),
    },
    ...(effortChoices.length > 0
      ? [
          {
            id: DEVIN_FUSION_OPTION_IDS.leadEffort,
            label: "Lead effort",
            type: "select",
            options: effortChoices.map((choice) => ({
              ...choice,
              ...(choice.id === defaults.leadEffort ? { isDefault: true } : {}),
            })),
            ...(defaults.leadEffort ? { currentValue: defaults.leadEffort } : {}),
          } satisfies SelectProviderOptionDescriptor,
        ]
      : []),
    {
      id: DEVIN_FUSION_OPTION_IDS.sidekick,
      label: "Sidekick model",
      type: "select",
      options: [...sidekicks.values()].map((choice) => ({
        ...choice,
        ...(choice.id === defaults.sidekick ? { isDefault: true } : {}),
      })),
      ...(defaults.sidekick ? { currentValue: defaults.sidekick } : {}),
    },
  ];

  return {
    slug: DEVIN_FUSION_MODEL_SLUG,
    name: "Fusion",
    isCustom: false,
    ...(parsedCurrent ? { isDefault: true } : {}),
    capabilities: {
      ...EMPTY_CAPABILITIES,
      optionDescriptors,
    },
  };
}

const runDevinCliCommand = (
  devinSettings: DevinSettings,
  args: ReadonlyArray<string>,
  environment: NodeJS.ProcessEnv,
) =>
  Effect.gen(function* () {
    const command = devinSettings.binaryPath || "devin";
    const spawnCommand = yield* resolveSpawnCommand(command, args, { env: environment });
    return yield* spawnAndCollect(
      command,
      ChildProcess.make(spawnCommand.command, spawnCommand.args, {
        env: environment,
        shell: spawnCommand.shell,
      }),
    );
  });

const decodeAvailableCommands = Schema.decodeUnknownOption(Schema.Array(Schema.Unknown));
const decodeAvailableCommand = Schema.decodeUnknownOption(EffectAcpSchema.AvailableCommand);

export function devinSlashCommandsFromInitialize(
  initialized: EffectAcpSchema.InitializeResponse,
): ReadonlyArray<ServerProviderSlashCommand> {
  const commands = decodeAvailableCommands(initialized._meta?.availableCommands);
  const byName = new Map<string, ServerProviderSlashCommand>([
    [COMPACT_SLASH_COMMAND.name, COMPACT_SLASH_COMMAND],
  ]);
  for (const entry of Option.getOrElse(commands, () => [])) {
    const decoded = decodeAvailableCommand(entry);
    if (Option.isNone(decoded)) continue;
    const command = decoded.value;
    const name = command.name.trim();
    if (!name || DEVIN_FILTERED_SLASH_COMMANDS.has(name.toLowerCase())) continue;
    const description = command.description.trim();
    const hint = command.input?.hint.trim();
    byName.set(name, {
      name,
      ...(description ? { description } : {}),
      ...(hint ? { input: { hint } } : {}),
    });
  }
  return [...byName.values()];
}

/**
 * Reads command metadata from `initialize._meta`. This never calls `authenticate`
 * or `session/new`, so it cannot open a browser login — safe when signed out.
 */
const discoverDevinSlashCommandsViaAcpInitialize = (
  devinSettings: DevinSettings,
  environment: NodeJS.ProcessEnv,
) =>
  Effect.gen(function* () {
    const childProcessSpawner = yield* ChildProcessSpawner.ChildProcessSpawner;
    const acp = yield* makeDevinAcpRuntime({
      devinSettings,
      environment,
      childProcessSpawner,
      cwd: process.cwd(),
      clientInfo: { name: "t3-code-provider-probe", version: "0.0.0" },
    });
    const initialized = yield* acp.initialize();
    return devinSlashCommandsFromInitialize(initialized);
  }).pipe(Effect.scoped);

/**
 * Authenticates with the stored session token and opens a throwaway session:
 * `session/new` is the only call that returns the full model catalog
 * (`configOptions`) alongside the session modes. Passing the token via
 * `_meta.api_key` keeps the probe non-interactive — a rejected token fails the
 * request instead of starting a browser login. The temp-directory cwd keeps
 * probe sessions out of the user's per-project `devin list` output.
 */
const discoverDevinMetadataViaAcpSession = (
  devinSettings: DevinSettings,
  environment: NodeJS.ProcessEnv,
  apiKey: string,
) =>
  Effect.gen(function* () {
    const childProcessSpawner = yield* ChildProcessSpawner.ChildProcessSpawner;
    const acp = yield* makeDevinAcpRuntime({
      devinSettings,
      environment,
      childProcessSpawner,
      cwd: NodeOS.tmpdir(),
      clientInfo: { name: "t3-code-provider-probe", version: "0.0.0" },
      devinApiKey: apiKey,
    });
    const started = yield* acp.start();
    return {
      models: buildDevinModelsFromConfigOptions(started.sessionSetupResult.configOptions),
      slashCommands: devinSlashCommandsFromInitialize(started.initializeResult),
    };
  }).pipe(Effect.scoped);

const isAcpRequestError = Schema.is(EffectAcpErrors.AcpRequestError);

// ACP's AUTH_REQUIRED code, or an agent-side message complaining about auth.
const isDevinAuthFailure = (cause: Cause.Cause<EffectAcpErrors.AcpError>): boolean => {
  const error = Cause.findErrorOption(cause);
  if (Option.isNone(error) || !isAcpRequestError(error.value)) {
    return false;
  }
  return (
    error.value.code === -32000 ||
    /auth|credential|login|unauthorized/i.test(error.value.errorMessage)
  );
};

export const checkDevinProviderStatus = Effect.fn("checkDevinProviderStatus")(function* (
  devinSettings: DevinSettings,
  environment: NodeJS.ProcessEnv = process.env,
): Effect.fn.Return<
  ServerProviderDraft,
  never,
  ChildProcessSpawner.ChildProcessSpawner | Crypto.Crypto | FileSystem.FileSystem | Path.Path
> {
  const checkedAt = DateTime.formatIso(yield* DateTime.now);
  const fallbackModels = devinModelsFromSettings(devinSettings.customModels);

  if (!devinSettings.enabled) {
    return buildServerProvider({
      presentation: DEVIN_PRESENTATION,
      enabled: false,
      checkedAt,
      models: fallbackModels,
      probe: {
        installed: false,
        version: null,
        status: "warning",
        auth: { status: "unknown" },
        message: "Devin is disabled in T3 Code settings.",
      },
    });
  }

  const versionResult = yield* runDevinCliCommand(devinSettings, ["version"], environment).pipe(
    Effect.timeoutOption(VERSION_PROBE_TIMEOUT_MS),
    Effect.result,
  );

  if (Result.isFailure(versionResult)) {
    const error = versionResult.failure;
    yield* Effect.logWarning("Devin CLI health check failed.", {
      errorTag: error._tag,
    });
    return buildServerProvider({
      presentation: DEVIN_PRESENTATION,
      enabled: devinSettings.enabled,
      checkedAt,
      models: fallbackModels,
      probe: {
        installed: !isCommandMissingCause(error),
        version: null,
        status: "error",
        auth: { status: "unknown" },
        message: isCommandMissingCause(error)
          ? "Devin CLI (`devin`) is not installed or not on PATH."
          : "Failed to execute Devin CLI health check.",
      },
    });
  }

  if (Option.isNone(versionResult.success)) {
    return buildServerProvider({
      presentation: DEVIN_PRESENTATION,
      enabled: devinSettings.enabled,
      checkedAt,
      models: fallbackModels,
      probe: {
        installed: true,
        version: null,
        status: "error",
        auth: { status: "unknown" },
        message: "Devin CLI is installed but timed out while running `devin version`.",
      },
    });
  }

  const versionOutput = versionResult.success.value;
  const version = parseGenericCliVersion(`${versionOutput.stdout}\n${versionOutput.stderr}`);
  if (versionOutput.code !== 0) {
    yield* Effect.logWarning("Devin CLI version probe exited with a non-zero status.", {
      exitCode: versionOutput.code,
      stdoutLength: versionOutput.stdout.length,
      stderrLength: versionOutput.stderr.length,
    });
    return buildServerProvider({
      presentation: DEVIN_PRESENTATION,
      enabled: devinSettings.enabled,
      checkedAt,
      models: fallbackModels,
      probe: {
        installed: true,
        version,
        status: "error",
        auth: { status: "unknown" },
        message: "Devin CLI is installed but failed to run.",
      },
    });
  }

  // Devin's ACP server is the sole credential source in ACP mode: local CLI
  // credentials are not picked up implicitly — the host must call `authenticate`.
  // With no stored token, calling it would start a browser login, which a
  // background probe must never do, so the credentials file gates the session
  // probe. Slash commands still come from `initialize`, which needs no auth.
  const apiKey = yield* readDevinApiKey(environment);

  if (Option.isNone(apiKey)) {
    const initExit = yield* discoverDevinSlashCommandsViaAcpInitialize(
      devinSettings,
      environment,
    ).pipe(Effect.timeoutOption(DEVIN_ACP_INITIALIZE_TIMEOUT_MS), Effect.exit);
    const slashCommands = Exit.isSuccess(initExit)
      ? (Option.getOrUndefined(initExit.value) ?? [COMPACT_SLASH_COMMAND])
      : [COMPACT_SLASH_COMMAND];
    return buildServerProvider({
      presentation: DEVIN_PRESENTATION,
      enabled: devinSettings.enabled,
      checkedAt,
      models: fallbackModels,
      slashCommands,
      probe: {
        installed: true,
        version,
        status: "error",
        auth: { status: "unauthenticated" },
        message: "Devin CLI is installed but not logged in. Run `devin auth login`.",
      },
    });
  }

  const acpExit = yield* discoverDevinMetadataViaAcpSession(
    devinSettings,
    environment,
    apiKey.value,
  ).pipe(Effect.timeoutOption(DEVIN_ACP_SESSION_PROBE_TIMEOUT_MS), Effect.exit);

  const acpMetadata = Exit.isSuccess(acpExit) ? Option.getOrUndefined(acpExit.value) : undefined;
  const unauthenticated = Exit.isFailure(acpExit) && isDevinAuthFailure(acpExit.cause);
  if (!acpMetadata && !unauthenticated) {
    yield* Effect.logWarning("Devin ACP session probe failed or timed out.", {
      errorTag: Exit.isFailure(acpExit) ? causeErrorTag(acpExit.cause) : "Timeout",
    });
  }

  const models =
    acpMetadata && acpMetadata.models.length > 0
      ? devinModelsFromSettings(devinSettings.customModels, acpMetadata.models)
      : fallbackModels;

  if (unauthenticated) {
    return buildServerProvider({
      presentation: DEVIN_PRESENTATION,
      enabled: devinSettings.enabled,
      checkedAt,
      models,
      probe: {
        installed: true,
        version,
        status: "error",
        auth: { status: "unauthenticated" },
        message: "Devin CLI is installed but not logged in. Run `devin auth login`.",
      },
    });
  }

  return buildServerProvider({
    presentation: DEVIN_PRESENTATION,
    enabled: devinSettings.enabled,
    checkedAt,
    models,
    slashCommands: acpMetadata?.slashCommands ?? [COMPACT_SLASH_COMMAND],
    probe: {
      installed: true,
      version,
      // A failed session probe degrades the model picker, it does not make chats fail.
      status: acpMetadata ? "ready" : "warning",
      auth:
        acpMetadata !== undefined
          ? { status: "authenticated", type: "cached_token", label: "Devin account" }
          : { status: "unknown" },
      ...(acpMetadata
        ? {}
        : {
            message:
              "Devin CLI is installed but the ACP session probe failed. Model options may be incomplete.",
          }),
    },
  });
});

export const enrichDevinSnapshot = (input: {
  readonly snapshot: ServerProvider;
  readonly maintenanceCapabilities: ProviderMaintenanceCapabilities;
  readonly enableProviderUpdateChecks?: boolean;
  readonly publishSnapshot: (snapshot: ServerProvider) => Effect.Effect<void>;
  readonly httpClient: HttpClient.HttpClient;
}): Effect.Effect<void> => {
  const { snapshot, publishSnapshot } = input;

  return enrichProviderSnapshotWithVersionAdvisory(snapshot, input.maintenanceCapabilities, {
    enableProviderUpdateChecks: input.enableProviderUpdateChecks,
  }).pipe(
    Effect.provideService(HttpClient.HttpClient, input.httpClient),
    Effect.flatMap((enrichedSnapshot) => publishSnapshot(enrichedSnapshot)),
    Effect.catchCause((cause) =>
      Effect.logWarning("Devin version advisory enrichment failed", {
        errorTag: causeErrorTag(cause),
      }),
    ),
    Effect.asVoid,
  );
};
