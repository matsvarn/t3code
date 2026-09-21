import {
  type DevinSettings,
  type ProviderOptionSelection,
  type RuntimeMode,
  type ThreadId,
} from "@t3tools/contracts";
import * as Crypto from "effect/Crypto";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import * as Path from "effect/Path";
import * as Schema from "effect/Schema";
import * as Scope from "effect/Scope";
import * as ChildProcessSpawner from "effect/unstable/process/ChildProcessSpawner";
import type * as EffectAcpErrors from "effect-acp/errors";
import { normalizeModelSlug } from "@t3tools/shared/model";
import { ProviderDriverKind } from "@t3tools/contracts";

import * as AcpSessionRuntime from "./AcpSessionRuntime.ts";

const DEVIN_AUTH_METHOD_BROWSER = "devin-browser";
const DEVIN_DRIVER_KIND = ProviderDriverKind.make("devin");

// The CLI is Windsurf-derived: the ACP session token lives in
// `$XDG_DATA_HOME/devin/credentials.toml` under `windsurf_api_key`, and the ACP
// `authenticate` request accepts it via `_meta.api_key`. `devin auth status` /
// `devin models list` validate the token against a different endpoint and can
// report "Not logged in" even when ACP auth works, so the file plus a real
// `authenticate` call is the source of truth here.
const DEVIN_API_KEY_PATTERN = /windsurf_api_key\s*=\s*"([^"]+)"/;

const encodeJson = Schema.encodeSync(Schema.fromJsonString(Schema.Unknown));

/**
 * The stored Devin ACP session token, if the user is signed in. Every ACP
 * caller must authenticate with it explicitly — the `devin-browser` method
 * starts a PKCE browser login when no `api_key` is passed, so sessions spawned
 * without it would steal focus.
 */
export const readDevinApiKey = (environment: NodeJS.ProcessEnv) =>
  Effect.gen(function* () {
    const fs = yield* FileSystem.FileSystem;
    const path = yield* Path.Path;
    const home = environment.HOME?.trim() || undefined;
    const dataHome =
      (environment.XDG_DATA_HOME?.trim() || undefined) ??
      (home !== undefined ? path.join(home, ".local", "share") : undefined);
    if (dataHome === undefined) {
      return Option.none<string>();
    }
    const contents = yield* fs
      .readFileString(path.join(dataHome, "devin", "credentials.toml"))
      .pipe(Effect.option);
    if (Option.isNone(contents)) {
      return Option.none<string>();
    }
    const match = DEVIN_API_KEY_PATTERN.exec(contents.value);
    const apiKey = match?.[1]?.trim();
    return apiKey ? Option.some(apiKey) : Option.none();
  });

/**
 * Devin connects to `session/new` mcpServers but never registers their tools —
 * its callable MCP registry only contains servers from `mcp_config` files.
 * T3 stages the session-scoped `t3-code` server under a per-thread directory
 * and exposes it through `additionalDirectories`, which Devin scans for
 * `.devin/mcp_config*.json`. Returns the directory to pass to the session.
 */
export const stageDevinMcpConfig = (
  stateDir: string,
  threadId: ThreadId,
  session: { readonly endpoint: string; readonly authorizationHeader: string },
) =>
  Effect.gen(function* () {
    const fs = yield* FileSystem.FileSystem;
    const path = yield* Path.Path;
    const directory = path.join(stateDir, "devin-mcp", threadId);
    yield* fs.makeDirectory(path.join(directory, ".devin"), { recursive: true });
    yield* fs.writeFileString(
      path.join(directory, ".devin", "mcp_config.local.json"),
      `${encodeJson({
        mcpServers: {
          "t3-code": {
            url: session.endpoint,
            transport: "http",
            headers: { Authorization: session.authorizationHeader },
          },
        },
      })}\n`,
    );
    return directory;
  });

type DevinAcpRuntimeDevinSettings = Pick<DevinSettings, "binaryPath"> &
  Partial<Pick<DevinSettings, "cloud">>;

interface DevinAcpRuntimeInput extends Omit<
  AcpSessionRuntime.AcpSessionRuntimeOptions,
  "authMethodId" | "clientCapabilities" | "spawn"
> {
  readonly childProcessSpawner: ChildProcessSpawner.ChildProcessSpawner["Service"];
  readonly devinSettings: DevinAcpRuntimeDevinSettings | null | undefined;
  /**
   * The stored session token (see {@link readDevinApiKey}). Only set this when
   * a real token exists: without `api_key`, `authenticate` falls back to the
   * PKCE browser flow. When absent, `authenticate` is skipped entirely and the
   * session surfaces the agent's auth-required error instead.
   */
  readonly devinApiKey?: string;
  readonly environment?: NodeJS.ProcessEnv;
  readonly runtimeMode?: RuntimeMode;
}

function devinAcpPermissionArgs(runtimeMode?: RuntimeMode): ReadonlyArray<string> {
  // Devin's modes: "auto" (read-only tools only), "accept-edits", "smart",
  // "dangerous". `auto` is the least permissive and the closest match for
  // T3's approval-required mode. Passing it explicitly also overrides any
  // ambient DEVIN_PERMISSION_MODE.
  switch (runtimeMode) {
    case "approval-required":
      return ["--permission-mode", "auto"];
    case "auto-accept-edits":
      return ["--permission-mode", "accept-edits"];
    case "auto":
      return ["--permission-mode", "smart"];
    case "full-access":
      return ["--permission-mode", "dangerous"];
    default:
      return [];
  }
}

export function devinAcpSpawnArgs(
  runtimeMode?: RuntimeMode,
  agentType?: "summarizer" | "review",
  cloud?: boolean,
): ReadonlyArray<string> {
  return [
    // `--permission-mode` is a global flag and must precede the `acp` subcommand.
    ...devinAcpPermissionArgs(runtimeMode),
    "acp",
    // `--cloud` relays ACP to Devin's cloud endpoint; `--agent-type` is a
    // local-agent flag the relay ignores, so explicit agent types stay local.
    ...(agentType ? (["--agent-type", agentType] as const) : cloud ? (["--cloud"] as const) : []),
  ];
}

export function buildDevinAcpSpawnInput(
  devinSettings: DevinAcpRuntimeDevinSettings | null | undefined,
  cwd: string,
  environment?: NodeJS.ProcessEnv,
  runtimeMode?: RuntimeMode,
  agentType?: "summarizer" | "review",
): AcpSessionRuntime.AcpSpawnInput {
  return {
    command: devinSettings?.binaryPath || "devin",
    args: devinAcpSpawnArgs(runtimeMode, agentType, devinSettings?.cloud === true),
    cwd,
    ...(environment ? { env: environment } : {}),
  };
}

export const makeDevinAcpRuntime = (
  input: DevinAcpRuntimeInput,
  options?: { readonly agentType?: "summarizer" | "review" },
): Effect.Effect<
  AcpSessionRuntime.AcpSessionRuntime["Service"],
  EffectAcpErrors.AcpError,
  Crypto.Crypto | Scope.Scope
> =>
  Effect.gen(function* () {
    const acpContext = yield* Layer.build(
      AcpSessionRuntime.layer({
        ...input,
        spawn: buildDevinAcpSpawnInput(
          input.devinSettings,
          input.cwd,
          input.environment,
          input.runtimeMode,
          options?.agentType,
        ),
        ...(input.devinApiKey
          ? {
              authMethodId: DEVIN_AUTH_METHOD_BROWSER,
              authenticateMeta: { api_key: input.devinApiKey },
            }
          : {}),
      }).pipe(
        Layer.provide(
          Layer.succeed(ChildProcessSpawner.ChildProcessSpawner, input.childProcessSpawner),
        ),
      ),
    );
    return yield* Effect.service(AcpSessionRuntime.AcpSessionRuntime).pipe(
      Effect.provide(acpContext),
    );
  });

/**
 * Devin's default model selector. Unlike Grok's product slug, "adaptive" is a
 * real model id the CLI accepts (`devin --model adaptive`), so it is sent over
 * the wire when selected.
 */
export const DEVIN_DEFAULT_MODEL_SLUG = "adaptive";

/**
 * Devin's "fusion" family composes a lead model + effort with a sidekick model
 * into a single selector, e.g.
 * `fusion-claude-fable-5-1-medium-sidekick-swe-2-medium`. T3 surfaces it as one
 * "Fusion" picker entry whose option descriptors carry the parts; the composed
 * slug is sent as the model value.
 */
export const DEVIN_FUSION_MODEL_SLUG = "fusion";

export const DEVIN_FUSION_OPTION_IDS = {
  lead: "lead",
  leadEffort: "leadEffort",
  sidekick: "sidekick",
} as const;

const DEVIN_FUSION_EFFORT_PATTERN = /^(none|minimal|low|medium|high|xhigh|max)(-(fast|priority))?$/;

/**
 * One trailing variant token on a model slug — effort tiers (`-high`,
 * `-high-fast`, `-high-priority`, `-none`), `-thinking`, `-fast`, the `-1m`
 * context suffix, and underscore-separated legacy `MODEL_*` tails
 * (`MODEL_GPT_5_2_XHIGH`, `MODEL_CLAUDE_4_5_OPUS_THINKING`).
 */
const DEVIN_VARIANT_TAIL_PATTERN =
  /(?:-(?:none|minimal|low|medium|high|xhigh|max|thinking|fast|priority|1m)|_(?:NONE|MINIMAL|LOW|MEDIUM|HIGH|XHIGH|THINKING))$/i;

/**
 * Strips trailing variant tokens off a model slug, iterating so stacked
 * variants fold into their base family (`glm-5-2-max-1m` → `glm-5-2`,
 * `claude-opus-4-6-thinking-1m` → `claude-opus-4-6`). `variant` is the stripped
 * tail, empty for bare slugs.
 */
export function splitDevinModelVariant(slug: string): {
  readonly base: string;
  readonly variant: string;
} {
  let base = slug.trim();
  const tokens: Array<string> = [];
  for (;;) {
    const match = DEVIN_VARIANT_TAIL_PATTERN.exec(base);
    if (!match || match.index === 0) {
      break;
    }
    tokens.unshift(match[0].slice(1).toLowerCase());
    base = base.slice(0, match.index);
  }
  return { base, variant: tokens.join("-") };
}

export interface DevinFusionSelection {
  readonly lead: string;
  readonly leadEffort: string | undefined;
  readonly sidekick: string;
}

/**
 * Splits a composed fusion slug into its parts: `fusion-<lead>-<effort>-sidekick-<sidekick>`.
 * Lead and sidekick tokens may themselves contain dashes and effort suffixes, so
 * the `-sidekick-` marker is the only reliable separator and the effort is the
 * head's trailing effort token, when present.
 */
export function parseDevinFusionSlug(slug: string): DevinFusionSelection | undefined {
  const trimmed = slug.trim();
  const marker = "-sidekick-";
  const markerIndex = trimmed.indexOf(marker);
  if (!trimmed.startsWith(`${DEVIN_FUSION_MODEL_SLUG}-`) || markerIndex < 0) {
    return undefined;
  }
  const head = trimmed.slice(DEVIN_FUSION_MODEL_SLUG.length + 1, markerIndex);
  const sidekick = trimmed.slice(markerIndex + marker.length);
  if (!head || !sidekick) {
    return undefined;
  }
  const segments = head.split("-");
  for (let index = 1; index < segments.length; index += 1) {
    const effort = segments.slice(index).join("-");
    if (DEVIN_FUSION_EFFORT_PATTERN.test(effort)) {
      return {
        lead: segments.slice(0, index).join("-"),
        leadEffort: effort,
        sidekick,
      };
    }
  }
  return { lead: head, leadEffort: undefined, sidekick };
}

export function composeDevinFusionSlug(selection: DevinFusionSelection): string {
  const head = selection.leadEffort ? `${selection.lead}-${selection.leadEffort}` : selection.lead;
  return `${DEVIN_FUSION_MODEL_SLUG}-${head}-sidekick-${selection.sidekick}`;
}

/**
 * Fusion combinations are curated, not a free cross product — Devin's agent
 * rejects unadvertised slugs. The provider registers the last-probed catalog so
 * composed selections that miss it can snap to the closest advertised one
 * instead of surfacing an agent error for an impossible pick. Effort families
 * (`swe-2` → `swe-2-max`/…` `-medium`) are recorded for the same reason: a
 * collapsed model slug alone isn't dispatchable without its default variant.
 */
export interface DevinEffortFamily {
  readonly defaultSlug: string;
  readonly variants: ReadonlySet<string>;
}

export const DEVIN_EFFORT_OPTION_ID = "effort";

let devinModelCatalog:
  | {
      readonly fusion: {
        readonly ordered: ReadonlyArray<string>;
        readonly set: ReadonlySet<string>;
        /** The catalog's advertised fusion default — the only valid value
         * to send when a composed slug can't be formed or matched, since
         * bare `fusion` is not itself a dispatchable catalog entry. */
        readonly defaultSlug: string | undefined;
      };
      readonly families: ReadonlyMap<string, DevinEffortFamily>;
    }
  | undefined;

export function registerDevinModelCatalog(input: {
  readonly fusionSlugs: ReadonlyArray<string>;
  readonly effortFamilies: ReadonlyMap<string, DevinEffortFamily>;
  readonly defaultFusionSlug?: string | undefined;
}): void {
  devinModelCatalog = {
    fusion: {
      ordered: input.fusionSlugs,
      set: new Set(input.fusionSlugs),
      defaultSlug: input.defaultFusionSlug,
    },
    families: input.effortFamilies,
  };
}

// The tail carries its own model+effort ("swe-2-medium", "gpt-5-6-luna-high");
// strip the trailing effort token to compare model families when snapping.
function stripDevinFusionTailEffort(tail: string): string {
  const segments = tail.split("-");
  for (let index = 1; index < segments.length; index += 1) {
    if (DEVIN_FUSION_EFFORT_PATTERN.test(segments.slice(index).join("-"))) {
      return segments.slice(0, index).join("-");
    }
  }
  return tail;
}

function snapDevinFusionSlug(selection: DevinFusionSelection): string {
  const catalog = devinModelCatalog?.fusion;
  const composed = composeDevinFusionSlug(selection);
  if (!catalog || catalog.set.has(composed)) {
    return composed;
  }
  const head = selection.leadEffort ? `${selection.lead}-${selection.leadEffort}` : selection.lead;
  const prefix = `${DEVIN_FUSION_MODEL_SLUG}-${head}-sidekick-`;
  const tails = catalog.ordered
    .filter((slug) => slug.startsWith(prefix))
    .map((slug) => slug.slice(prefix.length));
  if (tails.length === 0) {
    // The lead+effort itself isn't advertised — snap to the catalog's fusion
    // default; bare `fusion` is rejected as a config value.
    return catalog.defaultSlug ?? DEVIN_FUSION_MODEL_SLUG;
  }
  // Keep the lead+effort; snap the sidekick to the closest advertised one:
  // same family+effort, then same family, then the canonical swe-2-medium.
  const family = stripDevinFusionTailEffort(selection.sidekick);
  const familyEffort = selection.sidekick.slice(family.length + 1);
  const tail =
    tails.find(
      (candidate) =>
        stripDevinFusionTailEffort(candidate) === family &&
        candidate.slice(family.length + 1) === familyEffort,
    ) ??
    tails.find((candidate) => stripDevinFusionTailEffort(candidate) === family) ??
    (tails.includes("swe-2-medium") ? "swe-2-medium" : tails[0]!);
  return `${prefix}${tail}`;
}

export function resolveDevinAcpBaseModelId(model: string | null | undefined): string {
  const trimmed = model?.trim();
  const base = trimmed && trimmed.length > 0 ? trimmed : DEVIN_DEFAULT_MODEL_SLUG;
  return normalizeModelSlug(base, DEVIN_DRIVER_KIND) ?? DEVIN_DEFAULT_MODEL_SLUG;
}

/**
 * The model value sent over ACP. For the `fusion` picker entry, lead/effort/
 * sidekick selections compose the concrete slug; without a complete selection
 * the catalog's advertised fusion default is sent, since the bare `fusion`
 * family id is rejected as a config value. For collapsed effort families the
 * carries the exact variant slug, so it dispatches verbatim (the family's
 * default covers missing or stale picks).
 */
export function resolveDevinModelSelectionValue(
  model: string | null | undefined,
  selections: ReadonlyArray<ProviderOptionSelection> | null | undefined,
): string {
  const base = resolveDevinAcpBaseModelId(model);
  const pick = (id: string) => {
    const value = selections?.find((selection) => selection.id === id)?.value;
    return typeof value === "string" && value.trim().length > 0 ? value.trim() : undefined;
  };
  if (base === DEVIN_FUSION_MODEL_SLUG) {
    const lead = pick(DEVIN_FUSION_OPTION_IDS.lead);
    const leadEffort = pick(DEVIN_FUSION_OPTION_IDS.leadEffort);
    const sidekick = pick(DEVIN_FUSION_OPTION_IDS.sidekick);
    if (lead && sidekick) {
      return snapDevinFusionSlug({ lead, leadEffort, sidekick });
    }
    // Missing picks (e.g. a turn that resent no options): the family slug is
    // not dispatchable, so fall back to the catalog's fusion default.
    return devinModelCatalog?.fusion.defaultSlug ?? base;
  }
  const family = devinModelCatalog?.families.get(base);
  if (family) {
    const effort = pick(DEVIN_EFFORT_OPTION_ID);
    return effort && family.variants.has(effort) ? effort : family.defaultSlug;
  }
  return base;
}

interface DevinAcpModelSelectionRuntime {
  readonly setModel: (model: string) => Effect.Effect<unknown, EffectAcpErrors.AcpError>;
}

export function applyDevinAcpModelSelection<E>(input: {
  readonly runtime: DevinAcpModelSelectionRuntime;
  readonly model: string | null | undefined;
  readonly selections?: ReadonlyArray<ProviderOptionSelection> | null | undefined;
  readonly mapError: (cause: EffectAcpErrors.AcpError) => E;
}): Effect.Effect<void, E> {
  return input.runtime
    .setModel(resolveDevinModelSelectionValue(input.model, input.selections))
    .pipe(Effect.mapError(input.mapError), Effect.asVoid);
}
