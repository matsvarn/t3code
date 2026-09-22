/**
 * DevinSkillDispatch — rewrites `$skill` composer mentions into the `/name`
 * form Devin's ACP expands.
 *
 * Verified against `devin acp`: `$name` arrives as literal text while `/name`
 * expands anywhere in a prompt, so every mention of a known user-invocable
 * skill is rewritten in place. Unlike Claude Code there is no last-block
 * positioning constraint to work around.
 *
 * @module provider/Drivers/DevinSkillDispatch
 */

/**
 * Same token shape the composer and timeline chips recognise
 * (`packages/shared/src/composerInlineTokens.ts`), so a rendered chip and a
 * dispatched skill are always the same set.
 */
const SKILL_MENTION_PATTERN =
  /(^|\s)\p{Sc}(?![0-9][0-9_]*(?:[kKmMbBtT]|[eE][0-9]+)?(?:\s|$))(?=[a-zA-Z0-9:_-]*[a-zA-Z])([a-zA-Z0-9][a-zA-Z0-9:_-]*)(?=\s|$)/gu;
const HAS_SKILL_MENTION_PATTERN = new RegExp(SKILL_MENTION_PATTERN.source, "u");

/** Cheap gate so `$20` in prose does not spawn `devin skills list`. */
export function hasDevinSkillMention(prompt: string): boolean {
  return HAS_SKILL_MENTION_PATTERN.test(prompt);
}

/**
 * Replace each `$name` mention naming a known skill with `/name`. Mentions
 * that are not discovered skills stay literal — `$HOME` in prose must not
 * become a command.
 */
export function rewriteDevinSkillMentions(prompt: string, skillNames: ReadonlySet<string>): string {
  return prompt.replace(SKILL_MENTION_PATTERN, (match, prefix: string, name: string) =>
    skillNames.has(name) ? `${prefix}/${name}` : match,
  );
}
