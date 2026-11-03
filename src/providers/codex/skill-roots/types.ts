// what HQ takes from a skill file's frontmatter: its identity and the arguments it asks for
export type ISkillFrontmatter = {
  name: string;
  description: string;
  argumentHint: string | null;
};

// a skill read from one of the operator's extra roots, with the file it was read from
export type IRootSkill = ISkillFrontmatter & { path: string };
