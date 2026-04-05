#!/usr/bin/env node

import { createInterface } from "node:readline/promises";
import { stdin, stdout, argv } from "node:process";
import { readFileSync, writeFileSync, mkdirSync, readdirSync, existsSync } from "node:fs";
import { join, basename, resolve } from "node:path";
import { homedir } from "node:os";
import { parseArgs } from "node:util";

const CONFIG_DIR = join(homedir(), ".config", "zread-web");
const CONFIG_FILE = join(CONFIG_DIR, "config.json");

function usage() {
  console.log(`Usage: zread-web [options]

Sync zread wiki output to zread-web for deployment.
Run this command from a directory that contains .zread/wiki/.

Options:
  --web-repo <path>    Path to the zread-web repository
  --name <name>        Display name for this repo (default: folder name)
  --slug <slug>        URL slug for this repo (default: folder name, lowercased)
  --github <url>       GitHub repository URL (for source links)
  --help               Show this help message

Interactive mode:
  Run without arguments for interactive prompts.

Examples:
  zread-web --web-repo ~/zread-web --name "My Project" --github https://github.com/user/repo
  zread-web                    # interactive mode, uses saved config`);
}

function loadConfig() {
  if (!existsSync(CONFIG_FILE)) return { webRepoPath: "", repos: {} };
  return JSON.parse(readFileSync(CONFIG_FILE, "utf-8"));
}

function saveConfig(config) {
  mkdirSync(CONFIG_DIR, { recursive: true });
  writeFileSync(CONFIG_FILE, JSON.stringify(config, null, 2));
}

async function prompt(rl, question, defaultValue) {
  const suffix = defaultValue ? ` (${defaultValue})` : "";
  const answer = await rl.question(`${question}${suffix}: `);
  return answer.trim() || defaultValue || "";
}

function transformSourceLinks(markdown, githubUrl) {
  const base = githubUrl ? githubUrl.replace(/\/$/, "") : null;

  return markdown.replace(
    /\[([^\]]+)\]\((?!https?:\/\/)([^)]+)\)/g,
    (match, text, path) => {
      if (path.startsWith("#")) return match;
      // With GitHub URL: link to GitHub. Without: strip to plain text.
      return base ? `[${text}](${base}/blob/main/${path})` : text;
    }
  );
}

function syncData(config, cwd) {
  const zreadDir = join(cwd, ".zread", "wiki");
  const currentFile = join(zreadDir, "current");

  if (!existsSync(currentFile)) {
    console.error("Error: No .zread/wiki/current found in current directory.");
    console.error("Run `zread` first to generate wiki documentation.");
    process.exit(1);
  }

  const contentDir = join(config.webRepoPath, "content");
  if (!existsSync(contentDir)) {
    console.error(`Error: content/ directory not found at ${config.webRepoPath}`);
    process.exit(1);
  }

  const repoConfig = config.repos[cwd];
  const slug = repoConfig.slug;

  // Resolve current version
  const currentVersion = readFileSync(currentFile, "utf-8").trim();
  const versionDir = join(zreadDir, currentVersion);

  if (!existsSync(versionDir)) {
    console.error(`Error: Version directory not found: ${versionDir}`);
    process.exit(1);
  }

  // Copy wiki data to content/<slug>/
  const targetDir = join(contentDir, slug);
  mkdirSync(targetDir, { recursive: true });

  // Copy wiki.json
  const wikiJsonPath = join(versionDir, "wiki.json");
  if (existsSync(wikiJsonPath)) {
    const data = readFileSync(wikiJsonPath, "utf-8");
    writeFileSync(join(targetDir, "wiki.json"), data);
  }

  // Copy .md files, transforming source links if GitHub URL is set
  const files = readdirSync(versionDir);
  let pageCount = 0;
  for (const file of files) {
    if (!file.endsWith(".md")) continue;
    let content = readFileSync(join(versionDir, file), "utf-8");
    content = transformSourceLinks(content, repoConfig.github);
    writeFileSync(join(targetDir, file), content);
    pageCount++;
  }

  // Regenerate repos.json
  const reposJsonPath = join(contentDir, "repos.json");
  const repos = [];
  const dirs = readdirSync(contentDir, { withFileTypes: true });
  for (const dir of dirs) {
    if (!dir.isDirectory()) continue;
    const dirWikiJson = join(contentDir, dir.name, "wiki.json");
    if (!existsSync(dirWikiJson)) continue;

    const wiki = JSON.parse(readFileSync(dirWikiJson, "utf-8"));
    const entry = Object.values(config.repos).find((r) => r.slug === dir.name);
    repos.push({
      slug: dir.name,
      name: entry?.name || dir.name,
      github: entry?.github || undefined,
      pageCount: wiki.pages?.length || 0,
      updatedAt: wiki.generated_at || new Date().toISOString(),
    });
  }
  writeFileSync(reposJsonPath, JSON.stringify(repos, null, 2));

  saveConfig(config);

  console.log(`Synced ${pageCount} pages to content/${slug}/`);
  console.log(`repos.json updated with ${repos.length} repo(s).`);
}

async function main() {
  const { values } = parseArgs({
    options: {
      "web-repo": { type: "string" },
      name: { type: "string" },
      slug: { type: "string" },
      github: { type: "string" },
      help: { type: "boolean", short: "h" },
    },
    strict: true,
  });

  if (values.help) {
    usage();
    process.exit(0);
  }

  const cwd = process.cwd();
  const config = loadConfig();
  const hasArgs = values["web-repo"] || values.name || values.slug || values.github;

  if (hasArgs) {
    // Non-interactive mode: use arguments
    if (values["web-repo"]) {
      config.webRepoPath = resolve(values["web-repo"]);
    }
    if (!config.webRepoPath) {
      console.error("Error: --web-repo is required on first run.");
      process.exit(1);
    }

    if (!config.repos) config.repos = {};
    if (!config.repos[cwd]) {
      const folderName = basename(cwd).toLowerCase().replace(/[^a-z0-9-]/g, "-");
      config.repos[cwd] = {
        slug: values.slug || folderName,
        name: values.name || basename(cwd),
        github: values.github || undefined,
      };
    } else {
      // Update existing config with any provided overrides
      if (values.name) config.repos[cwd].name = values.name;
      if (values.slug) config.repos[cwd].slug = values.slug;
      if (values.github !== undefined) config.repos[cwd].github = values.github || undefined;
    }

    syncData(config, cwd);
  } else {
    // Interactive mode
    const rl = createInterface({ input: stdin, output: stdout });

    try {
      if (!config.webRepoPath) {
        console.log("First time setup - configure zread-web repo location.");
        config.webRepoPath = await prompt(rl, "Path to zread-web repo");
        if (!config.webRepoPath) {
          console.error("Error: zread-web repo path is required.");
          process.exit(1);
        }
        config.webRepoPath = resolve(config.webRepoPath);
      }

      if (!config.repos) config.repos = {};
      if (!config.repos[cwd]) {
        const folderName = basename(cwd).toLowerCase().replace(/[^a-z0-9-]/g, "-");
        console.log(`\nNew project detected: ${cwd}`);

        const name = await prompt(rl, "Page name for this repo", basename(cwd));
        const slug = await prompt(rl, "URL slug", folderName);
        const github = await prompt(rl, "GitHub repo URL (leave empty to skip)", "");

        config.repos[cwd] = { slug, name, github: github || undefined };
      }

      syncData(config, cwd);
    } finally {
      rl.close();
    }
  }
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
