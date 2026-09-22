import { expect, it } from "@effect/vitest";
import { DevinSettings } from "@t3tools/contracts";
import * as Effect from "effect/Effect";
import * as Schema from "effect/Schema";
import * as Sink from "effect/Sink";
import * as Stream from "effect/Stream";
import * as ChildProcess from "effect/unstable/process/ChildProcess";
import * as ChildProcessSpawner from "effect/unstable/process/ChildProcessSpawner";

import { discoverDevinSkills } from "./DevinSkills.ts";

const decodeSettings = Schema.decodeSync(DevinSettings);

function skillsSpawner(
  handler: (command: ChildProcess.StandardCommand) => {
    readonly stdout?: string;
    readonly stderr?: string;
    readonly exitCode?: number;
  },
) {
  return ChildProcessSpawner.make((command) => {
    if (!ChildProcess.isStandardCommand(command)) {
      return Effect.die("Expected a standard command");
    }
    const result = handler(command);
    return Effect.succeed(
      ChildProcessSpawner.makeHandle({
        pid: ChildProcessSpawner.ProcessId(1),
        exitCode: Effect.succeed(ChildProcessSpawner.ExitCode(result.exitCode ?? 0)),
        isRunning: Effect.succeed(false),
        kill: () => Effect.void,
        unref: Effect.succeed(Effect.void),
        stdin: Sink.drain,
        stdout: Stream.encodeText(Stream.make(result.stdout ?? "")),
        stderr: Stream.encodeText(Stream.make(result.stderr ?? "")),
        all: Stream.empty,
        getInputFd: () => Sink.drain,
        getOutputFd: () => Stream.empty,
      }),
    );
  });
}

it.effect("maps `devin skills list --json` entries into provider skills at the workspace cwd", () =>
  Effect.gen(function* () {
    let spawned: ChildProcess.StandardCommand | undefined;
    const spawner = skillsSpawner((command) => {
      spawned = command;
      return {
        stdout: JSON.stringify([
          {
            name: "grilling",
            description: "Stress-test a plan",
            base_dir: "/Users/test/.agents/skills/grilling",
            triggers: ["user", "model"],
          },
          {
            name: "audit",
            display_name: "audit",
            base_dir: "/workspace/.devin/skills/audit",
            triggers: ["model"],
          },
          {
            name: "deploy",
            base_dir: "/workspace/.agents/skills/deploy",
            triggers: ["user"],
          },
          { name: "", base_dir: "/ignored" },
        ]),
      };
    });

    const skills = yield* discoverDevinSkills(
      decodeSettings({ binaryPath: "/usr/local/bin/devin" }),
      "/workspace",
      {},
    ).pipe(Effect.provideService(ChildProcessSpawner.ChildProcessSpawner, spawner));

    expect(spawned?.command).toBe("/usr/local/bin/devin");
    expect(spawned?.args).toEqual(["skills", "list", "--json"]);
    expect(spawned?.options.cwd).toBe("/workspace");
    expect(skills).toEqual([
      {
        name: "grilling",
        description: "Stress-test a plan",
        path: "/Users/test/.agents/skills/grilling/SKILL.md",
        enabled: true,
      },
      {
        name: "audit",
        path: "/workspace/.devin/skills/audit/SKILL.md",
        enabled: true,
        // No "user" trigger: the composer must not offer it under `$`.
        userInvocable: false,
      },
      {
        name: "deploy",
        path: "/workspace/.agents/skills/deploy/SKILL.md",
        enabled: true,
        // No "model" trigger: only the user can start it.
        userInvocationOnly: true,
      },
    ]);
  }),
);

it.effect("returns an empty list when the CLI exits non-zero", () =>
  Effect.gen(function* () {
    const skills = yield* discoverDevinSkills(
      decodeSettings({ binaryPath: "/usr/local/bin/devin" }),
      "/workspace",
      {},
    ).pipe(
      Effect.provideService(
        ChildProcessSpawner.ChildProcessSpawner,
        skillsSpawner(() => ({ stderr: "not logged in", exitCode: 1 })),
      ),
    );
    expect(skills).toEqual([]);
  }),
);

it.effect("returns an empty list when the CLI emits malformed JSON", () =>
  Effect.gen(function* () {
    const skills = yield* discoverDevinSkills(
      decodeSettings({ binaryPath: "/usr/local/bin/devin" }),
      "/workspace",
      {},
    ).pipe(
      Effect.provideService(
        ChildProcessSpawner.ChildProcessSpawner,
        skillsSpawner(() => ({ stdout: "not json" })),
      ),
    );
    expect(skills).toEqual([]);
  }),
);
