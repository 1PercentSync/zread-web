import { readFileSync, existsSync } from "node:fs";
import { join } from "node:path";

const CONTENT_DIR = join(process.cwd(), "content");

export interface RepoMeta {
  slug: string;
  name: string;
  github?: string;
  pageCount: number;
  updatedAt: string;
}

export interface WikiPage {
  slug: string;
  title: string;
  file: string;
  section: string;
  group?: string;
  level?: "Beginner" | "Intermediate" | "Advanced";
}

export interface Wiki {
  id: string;
  generated_at: string;
  language: string;
  pages: WikiPage[];
}

export interface NavSection {
  name: string;
  groups: NavGroup[];
}

export interface NavGroup {
  name: string | null;
  pages: WikiPage[];
}

export function getRepos(): RepoMeta[] {
  const file = join(CONTENT_DIR, "repos.json");
  if (!existsSync(file)) return [];
  return JSON.parse(readFileSync(file, "utf-8"));
}

export function getWiki(repoSlug: string): Wiki | null {
  const file = join(CONTENT_DIR, repoSlug, "wiki.json");
  if (!existsSync(file)) return null;
  return JSON.parse(readFileSync(file, "utf-8"));
}

export function getPageContent(repoSlug: string, fileName: string): string {
  const file = join(CONTENT_DIR, repoSlug, fileName);
  if (!existsSync(file)) return "";
  return readFileSync(file, "utf-8");
}

export function buildNavigation(pages: WikiPage[]): NavSection[] {
  const sections: NavSection[] = [];
  const sectionMap = new Map<string, NavSection>();

  for (const page of pages) {
    let section = sectionMap.get(page.section);
    if (!section) {
      section = { name: page.section, groups: [] };
      sectionMap.set(page.section, section);
      sections.push(section);
    }

    const groupName = page.group || null;
    let group = section.groups.find((g) => g.name === groupName);
    if (!group) {
      group = { name: groupName, pages: [] };
      section.groups.push(group);
    }
    group.pages.push(page);
  }

  return sections;
}

export function slugify(text: string): string {
  return text
    .replace(/<[^>]*>/g, "")
    .toLowerCase()
    .replace(/[^\w\u4e00-\u9fff\s-]/g, "")
    .replace(/\s+/g, "-");
}

export function escapeHtml(str: string): string {
  return str
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;");
}

export function extractHeadings(markdown: string): { depth: number; text: string; id: string }[] {
  const headings: { depth: number; text: string; id: string }[] = [];
  const lines = markdown.split("\n");
  let inCodeBlock = false;

  for (const line of lines) {
    if (line.trim().startsWith("```")) {
      inCodeBlock = !inCodeBlock;
      continue;
    }
    if (inCodeBlock) continue;

    const match = line.match(/^(#{2,3})\s+(.+)$/);
    if (match) {
      const text = match[2].trim();
      const id = slugify(text);
      headings.push({ depth: match[1].length, text, id });
    }
  }

  return headings;
}
