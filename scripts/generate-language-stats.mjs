#!/usr/bin/env node

import { execFileSync } from "node:child_process";
import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

const PAGE_SIZE = 100;
const DEFAULT_OUTPUT_DIR = "assets";

const REPOSITORIES_QUERY = `
  query OwnedRepositories($after: String) {
    viewer {
      login
      repositories(
        first: ${PAGE_SIZE}
        after: $after
        ownerAffiliations: OWNER
        orderBy: { field: NAME, direction: ASC }
      ) {
        pageInfo {
          hasNextPage
          endCursor
        }
        nodes {
          isArchived
          isFork
          isPrivate
          languages(first: 100, orderBy: { field: SIZE, direction: DESC }) {
            edges {
              size
              node {
                color
                name
              }
            }
          }
        }
      }
    }
  }
`;

const FALLBACK_COLORS = [
  "#58a6ff",
  "#a371f7",
  "#3fb950",
  "#f0883e",
  "#f778ba",
  "#d29922",
  "#39c5cf",
  "#db6d28",
];

function parseArguments(argv) {
  const options = {
    asOf: new Date().toISOString().slice(0, 10),
    input: null,
    outputDir: DEFAULT_OUTPUT_DIR,
  };

  for (let index = 0; index < argv.length; index += 1) {
    const argument = argv[index];
    const value = argv[index + 1];

    if (argument === "--input" && value) {
      options.input = value;
      index += 1;
    } else if (argument === "--output-dir" && value) {
      options.outputDir = value;
      index += 1;
    } else if (argument === "--as-of" && value) {
      options.asOf = value;
      index += 1;
    } else if (argument === "--help") {
      options.help = true;
    } else {
      throw new Error(`Unknown or incomplete argument: ${argument}`);
    }
  }

  if (!/^\d{4}-\d{2}-\d{2}$/.test(options.asOf)) {
    throw new Error("--as-of must use YYYY-MM-DD format");
  }

  return options;
}

function runGraphql(after = null) {
  const argumentsForGh = ["api", "graphql", "-f", `query=${REPOSITORIES_QUERY}`];

  if (after) {
    argumentsForGh.push("-F", `after=${after}`);
  }

  const output = execFileSync("gh", argumentsForGh, {
    encoding: "utf8",
    maxBuffer: 32 * 1024 * 1024,
  });

  return JSON.parse(output);
}

function fetchOwnedRepositories() {
  const repositories = [];
  let cursor = null;
  let login = null;

  do {
    const response = runGraphql(cursor);
    const viewer = response?.data?.viewer;

    if (!viewer?.repositories) {
      throw new Error("GitHub returned an unexpected repositories response");
    }

    login ??= viewer.login;
    repositories.push(...viewer.repositories.nodes);

    const pageInfo = viewer.repositories.pageInfo;
    cursor = pageInfo.hasNextPage ? pageInfo.endCursor : null;
  } while (cursor);

  return { login, repositories };
}

function loadInput(path) {
  const input = JSON.parse(readFileSync(resolve(path), "utf8"));

  if (!Array.isArray(input.repositories)) {
    throw new Error("Input JSON must contain a repositories array");
  }

  return input;
}

function colorFor(name, declaredColor) {
  if (/^#[0-9a-f]{6}$/i.test(declaredColor ?? "")) {
    return declaredColor;
  }

  const hash = [...name].reduce((value, character) => value + character.codePointAt(0), 0);
  return FALLBACK_COLORS[hash % FALLBACK_COLORS.length];
}

export function aggregateLanguageStats(input, asOf) {
  const totals = new Map();
  const repositories = input.repositories ?? [];

  for (const repository of repositories) {
    for (const edge of repository.languages?.edges ?? []) {
      const name = edge?.node?.name;
      const bytes = Number(edge?.size ?? 0);

      if (!name || !Number.isFinite(bytes) || bytes <= 0) continue;

      const current = totals.get(name) ?? {
        bytes: 0,
        color: colorFor(name, edge.node.color),
        name,
      };

      current.bytes += bytes;
      totals.set(name, current);
    }
  }

  const classifiedBytes = [...totals.values()].reduce((sum, language) => sum + language.bytes, 0);
  const languages = [...totals.values()]
    .sort((left, right) => right.bytes - left.bytes || left.name.localeCompare(right.name))
    .map((language) => ({
      ...language,
      percentage: classifiedBytes === 0 ? 0 : (language.bytes / classifiedBytes) * 100,
    }));

  return {
    asOf,
    classifiedBytes,
    languageCount: languages.length,
    languages,
    login: input.login ?? null,
    methodology: "GitHub Linguist language bytes aggregated across owned repositories",
    repositories: {
      archived: repositories.filter((repository) => repository.isArchived).length,
      forks: repositories.filter((repository) => repository.isFork).length,
      private: repositories.filter((repository) => repository.isPrivate).length,
      public: repositories.filter((repository) => !repository.isPrivate).length,
      total: repositories.length,
    },
  };
}

function escapeXml(value) {
  return String(value)
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;")
    .replaceAll('"', "&quot;")
    .replaceAll("'", "&apos;");
}

function formatBytes(bytes) {
  const units = ["B", "KiB", "MiB", "GiB"];
  let value = bytes;
  let unitIndex = 0;

  while (value >= 1024 && unitIndex < units.length - 1) {
    value /= 1024;
    unitIndex += 1;
  }

  const digits = value >= 100 || unitIndex === 0 ? 0 : 1;
  return `${value.toFixed(digits)} ${units[unitIndex]}`;
}

function formatPercentage(value) {
  if (value > 0 && value < 0.1) return "&lt;0.1%";
  return `${value.toFixed(1)}%`;
}

function displayLanguages(stats, limit = 8) {
  const visible = stats.languages.slice(0, limit);
  const hidden = stats.languages.slice(limit);

  if (hidden.length > 0) {
    const bytes = hidden.reduce((sum, language) => sum + language.bytes, 0);
    visible.push({
      bytes,
      color: "#6e7681",
      name: `Other (${hidden.length})`,
      percentage: stats.classifiedBytes === 0 ? 0 : (bytes / stats.classifiedBytes) * 100,
    });
  }

  return visible;
}

export function renderSvg(stats) {
  const featured = displayLanguages(stats);
  const barX = 36;
  const barWidth = 828;
  let usedWidth = 0;
  const segments = featured.map((language, index) => {
    const remainingWidth = barWidth - usedWidth;
    const width = index === featured.length - 1
      ? remainingWidth
      : Math.max(0, Math.min(remainingWidth, barWidth * (language.percentage / 100)));
    const segment = `<rect x="${(barX + usedWidth).toFixed(2)}" y="96" width="${width.toFixed(2)}" height="14" fill="${escapeXml(language.color)}"/>`;
    usedWidth += width;
    return segment;
  }).join("\n    ");

  const entries = stats.languages.slice(0, 8).map((language, index) => {
    const column = index % 2;
    const row = Math.floor(index / 2);
    const x = 36 + column * 414;
    const y = 151 + row * 43;
    const detail = `${formatPercentage(language.percentage)} · ${formatBytes(language.bytes)}`;

    return `<g transform="translate(${x} ${y})">
      <circle cx="7" cy="-5" r="6" fill="${escapeXml(language.color)}"/>
      <text class="language" x="24" y="0">${escapeXml(language.name)}</text>
      <text class="detail" x="390" y="0" text-anchor="end">${detail}</text>
    </g>`;
  }).join("\n    ");

  const repositoryLabel = `${stats.repositories.total} owned repositories · public + private`;
  const summaryLabel = `${stats.languageCount} languages · ${formatBytes(stats.classifiedBytes)} classified`;
  const accessibleSummary = stats.languages.slice(0, 8)
    .map((language) => `${language.name} ${language.percentage.toFixed(1)} percent`)
    .join(", ");

  return `<svg xmlns="http://www.w3.org/2000/svg" width="900" height="350" viewBox="0 0 900 350" role="img" aria-labelledby="title description">
  <title id="title">Language atlas for ${escapeXml(stats.login ?? "this GitHub profile")}</title>
  <desc id="description">Aggregate GitHub Linguist statistics across ${stats.repositories.total} owned public and private repositories. ${escapeXml(accessibleSummary)}.</desc>
  <defs>
    <linearGradient id="background" x1="0" y1="0" x2="1" y2="1">
      <stop offset="0" stop-color="#0d1117"/>
      <stop offset="1" stop-color="#161b22"/>
    </linearGradient>
    <clipPath id="language-bar">
      <rect x="36" y="96" width="828" height="14" rx="7"/>
    </clipPath>
    <filter id="shadow" x="-5%" y="-5%" width="110%" height="115%">
      <feDropShadow dx="0" dy="4" stdDeviation="8" flood-color="#010409" flood-opacity="0.45"/>
    </filter>
    <style>
      text { font-family: -apple-system, BlinkMacSystemFont, "Segoe UI", Helvetica, Arial, sans-serif; }
      .eyebrow { fill: #8b949e; font-size: 12px; font-weight: 600; letter-spacing: 1.6px; }
      .heading { fill: #f0f6fc; font-size: 27px; font-weight: 700; }
      .summary { fill: #8b949e; font-size: 13px; }
      .language { fill: #e6edf3; font-size: 15px; font-weight: 600; }
      .detail { fill: #8b949e; font-size: 13px; font-variant-numeric: tabular-nums; }
      .footer { fill: #6e7681; font-size: 12px; }
    </style>
  </defs>
  <rect x="8" y="8" width="884" height="334" rx="16" fill="url(#background)" stroke="#30363d" filter="url(#shadow)"/>
  <text class="eyebrow" x="36" y="40">CODE ACROSS MY REPOSITORIES</text>
  <text class="heading" x="36" y="72">Language atlas</text>
  <text class="summary" x="864" y="43" text-anchor="end">${escapeXml(repositoryLabel)}</text>
  <text class="summary" x="864" y="68" text-anchor="end">${escapeXml(summaryLabel)}</text>
  <g clip-path="url(#language-bar)">
    ${segments}
  </g>
  ${entries}
  <line x1="36" y1="309" x2="864" y2="309" stroke="#21262d"/>
  <text class="footer" x="36" y="329">GitHub Linguist · byte-weighted · generated ${escapeXml(stats.asOf)}</text>
  <text class="footer" x="864" y="329" text-anchor="end">Aggregate only · private repository names are never published</text>
</svg>
`;
}

function serializableStats(stats) {
  return {
    ...stats,
    languages: stats.languages.map((language) => ({
      bytes: language.bytes,
      color: language.color,
      name: language.name,
      percentage: Number(language.percentage.toFixed(4)),
    })),
  };
}

function writeOutputs(stats, outputDirectory) {
  const resolvedOutputDirectory = resolve(outputDirectory);
  const svgPath = resolve(resolvedOutputDirectory, "language-stats.svg");
  const jsonPath = resolve(resolvedOutputDirectory, "language-stats.json");

  mkdirSync(dirname(svgPath), { recursive: true });
  writeFileSync(svgPath, renderSvg(stats), "utf8");
  writeFileSync(jsonPath, `${JSON.stringify(serializableStats(stats), null, 2)}\n`, "utf8");

  return { jsonPath, svgPath };
}

function printHelp() {
  process.stdout.write(`Usage: node scripts/generate-language-stats.mjs [options]\n\n`);
  process.stdout.write(`Options:\n`);
  process.stdout.write(`  --input FILE        Read a fixture instead of querying GitHub\n`);
  process.stdout.write(`  --output-dir DIR    Write SVG and JSON to DIR (default: assets)\n`);
  process.stdout.write(`  --as-of YYYY-MM-DD  Override the generated date\n`);
  process.stdout.write(`  --help              Show this help\n`);
}

function main() {
  const options = parseArguments(process.argv.slice(2));

  if (options.help) {
    printHelp();
    return;
  }

  const input = options.input ? loadInput(options.input) : fetchOwnedRepositories();
  const stats = aggregateLanguageStats(input, options.asOf);
  const paths = writeOutputs(stats, options.outputDir);

  process.stdout.write(
    `Generated ${paths.svgPath} and ${paths.jsonPath} from ${stats.repositories.total} repositories and ${stats.languageCount} languages.\n`,
  );
}

const isEntrypoint = process.argv[1]
  && import.meta.url === pathToFileURL(resolve(process.argv[1])).href;

if (isEntrypoint) {
  try {
    main();
  } catch (error) {
    process.stderr.write(`${error instanceof Error ? error.message : error}\n`);
    process.exitCode = 1;
  }
}
