/**
 * DevinSkills — skill discovery for the `$` picker via `devin skills list`.
 *
 * Devin already scans its user dirs (`~/.config/devin/skills`,
 * `~/.config/cognition/skills`, `~/.agents/skills`) and project dirs
 * (`.devin/skills`, `.cognition/skills`, `.agents/skills` under cwd) itself,
 * so shelling out keeps precedence, validation, and trigger metadata in one
 * place instead of reimplementing the scan. The command is cwd-sensitive —
 * project skills only resolve when it runs inside the workspace.
 *
 * `triggers` maps onto the contract's invocation flags: a skill without the
 * "user" trigger cannot be started from the composer (`userInvocable:
 * false`), and one without "model" is hidden from the agent's own skill tool
 * (`userInvocationOnly`).
 *
 * @module provider/Drivers/DevinSkills
 */
import type { DevinSettings, ServerProviderSkill } from "@t3tools/contracts";
import * as Effect from "effect/Effect";
import * as Schema from "effect/Schema";
import * as Option from "effect/Option";
import { ChildProcess, ChildProcessSpawner } from "effect/unstable/process";
import { resolveSpawnCommand } from "@t3tools/shared/shell";
import { fromLenientJson } from "@t3tools/shared/schemaJson";

import { spawnAndCollect } from "../providerSnapshot.ts";

const SKILLS_LIST_TIMEOUT_MS = 6_000;

const DevinSkillListEntry = Schema.Struct({
  name: Schema.String,
  description: Schema.optionalKey(Schema.String),
  triggers: Schema.optionalKey(Schema.Array(Schema.String)),
  base_dir: Schema.optionalKey(Schema.String),
  display_name: Schema.optionalKey(Schema.String),
});
const DevinSkillList = Schema.Array(DevinSkillListEntry);
const decodeSkillList = Schema.decodeUnknownOption(fromLenientJson(DevinSkillList));

export const discoverDevinSkills = (
  devinSettings: DevinSettings,
  cwd: string,
  environment: NodeJS.ProcessEnv,
): Effect.Effect<
  ReadonlyArray<ServerProviderSkill>,
  never,
  ChildProcessSpawner.ChildProcessSpawner
> =>
  Effect.gen(function* () {
    const command = devinSettings.binaryPath || "devin";
    const spawnCommand = yield* resolveSpawnCommand(command, ["skills", "list", "--json"], {
      env: environment,
    });
    const output = yield* spawnAndCollect(
      command,
      ChildProcess.make(spawnCommand.command, spawnCommand.args, {
        env: environment,
        cwd,
        shell: spawnCommand.shell,
      }),
    );
    if (output.code !== 0) {
      return [];
    }
    const decoded = decodeSkillList(output.stdout);
    if (Option.isNone(decoded)) {
      return [];
    }
    return decoded.value.flatMap((entry) => {
      const name = entry.name.trim();
      const baseDir = entry.base_dir?.trim();
      if (!name || !baseDir) {
        return [];
      }
      const triggers = new Set(entry.triggers ?? []);
      const description = entry.description?.trim();
      const displayName = entry.display_name?.trim();
      return [
        {
          name,
          path: `${baseDir}/SKILL.md`,
          enabled: true,
          ...(description ? { description } : {}),
          ...(displayName && displayName !== name ? { displayName } : {}),
          ...(triggers.has("user") ? {} : { userInvocable: false }),
          ...(triggers.has("model") ? {} : { userInvocationOnly: true }),
        } satisfies ServerProviderSkill,
      ];
    });
  }).pipe(
    // Discovery feeds a picker; a missing binary or a hung CLI must not fail
    // the workspace snapshot, so every failure collapses to an empty list.
    Effect.timeoutOption(SKILLS_LIST_TIMEOUT_MS),
    Effect.map(Option.getOrElse((): ReadonlyArray<ServerProviderSkill> => [])),
    Effect.orElseSucceed((): ReadonlyArray<ServerProviderSkill> => []),
  );
