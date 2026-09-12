import { readFile } from 'node:fs/promises';

const path = new URL('../skills/social-memory/SKILL.md', import.meta.url);
const source = await readFile(path, 'utf8');
if (!source.startsWith('---\n') || !/\nname: social-memory\n/.test(source)) {
  throw new Error('Social Memory Skill has invalid frontmatter');
}
const description = source.match(/\ndescription: (.+)\n/)?.[1] ?? '';
if (description.length < 20 || /TODO|placeholder/i.test(source)) {
  throw new Error('Social Memory Skill is incomplete');
}
process.stdout.write('Social Memory Skill is valid.\n');
