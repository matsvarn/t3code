import { describe, expect, it } from "vite-plus/test";

import { hasDevinSkillMention, rewriteDevinSkillMentions } from "./DevinSkillDispatch.ts";

const SKILLS = new Set(["2spec", "implement", "review", "re-release-version"]);

describe("hasDevinSkillMention", () => {
  it("detects only chip-shaped dollar tokens", () => {
    expect(hasDevinSkillMention("use $review here")).toBe(true);
    expect(hasDevinSkillMention("$review")).toBe(true);
    expect(hasDevinSkillMention("fix the build")).toBe(false);
    expect(hasDevinSkillMention("costs $20 today")).toBe(false);
    expect(hasDevinSkillMention("echo $HOME")).toBe(true);
  });
});

describe("rewriteDevinSkillMentions", () => {
  it("leaves a prompt without a known skill untouched", () => {
    expect(rewriteDevinSkillMentions("fix the build", SKILLS)).toBe("fix the build");
    // Not a discovered skill, so it stays prose rather than becoming a command.
    expect(rewriteDevinSkillMentions("echo $HOME then $unknown", SKILLS)).toBe(
      "echo $HOME then $unknown",
    );
  });

  it("rewrites a mention at the end of the prompt", () => {
    expect(rewriteDevinSkillMentions("please $review", SKILLS)).toBe("please /review");
    expect(rewriteDevinSkillMentions("$review", SKILLS)).toBe("/review");
  });

  it("rewrites every known mention inline", () => {
    expect(rewriteDevinSkillMentions("$review the diff, then $implement the fixes", SKILLS)).toBe(
      "/review the diff, then /implement the fixes",
    );
  });

  it("dispatches a known skill whose name begins with a digit", () => {
    expect(rewriteDevinSkillMentions("use $2spec for this", SKILLS)).toBe("use /2spec for this");
  });

  it("ignores a dollar token glued to other text", () => {
    expect(rewriteDevinSkillMentions("cost is 5$implement", SKILLS)).toBe("cost is 5$implement");
  });

  it("ignores currency amounts and compact monetary expressions", () => {
    const skillsWithCurrency = new Set([...SKILLS, "20", "20k", "100M", "1e6"]);
    for (const symbol of ["$", "€", "£", "¥", "₹", "₩", "₿", "𑿝"]) {
      const prompt = `pay ${symbol}20 ${symbol}20k ${symbol}100M ${symbol}1e6 tomorrow`;
      expect(rewriteDevinSkillMentions(prompt, skillsWithCurrency)).toBe(prompt);
    }
  });
});
