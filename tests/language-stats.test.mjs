import assert from "node:assert/strict";
import test from "node:test";

import {
  aggregateLanguageStats,
  renderSvg,
} from "../scripts/generate-language-stats.mjs";

const fixture = {
  login: "octocat",
  repositories: [
    {
      isArchived: false,
      isFork: false,
      isPrivate: false,
      languages: {
        edges: [
          { size: 7_000, node: { color: "#3178c6", name: "TypeScript" } },
          { size: 3_000, node: { color: "#f1e05a", name: "JavaScript" } },
        ],
      },
    },
    {
      isArchived: true,
      isFork: false,
      isPrivate: true,
      languages: {
        edges: [
          { size: 5_000, node: { color: "#3572A5", name: "Python" } },
          { size: 5_000, node: { color: "#3178c6", name: "TypeScript" } },
        ],
      },
    },
    {
      isArchived: false,
      isFork: true,
      isPrivate: true,
      languages: { edges: [] },
    },
  ],
};

test("aggregates language bytes without exposing repository names", () => {
  const stats = aggregateLanguageStats(fixture, "2026-08-14");

  assert.equal(stats.repositories.total, 3);
  assert.equal(stats.repositories.public, 1);
  assert.equal(stats.repositories.private, 2);
  assert.equal(stats.repositories.archived, 1);
  assert.equal(stats.repositories.forks, 1);
  assert.equal(stats.classifiedBytes, 20_000);
  assert.deepEqual(
    stats.languages.map(({ bytes, name, percentage }) => ({ bytes, name, percentage })),
    [
      { bytes: 12_000, name: "TypeScript", percentage: 60 },
      { bytes: 5_000, name: "Python", percentage: 25 },
      { bytes: 3_000, name: "JavaScript", percentage: 15 },
    ],
  );
  assert.equal(JSON.stringify(stats).includes("repository-name"), false);
});

test("renders an accessible, self-contained SVG", () => {
  const svg = renderSvg(aggregateLanguageStats(fixture, "2026-08-14"));

  assert.match(svg, /^<svg /);
  assert.match(svg, /role="img" aria-labelledby="title description"/);
  assert.match(svg, /TypeScript/);
  assert.match(svg, /60\.0%/);
  assert.match(svg, /public \+ private/);
  assert.match(svg, /private repository names are never published/);
  assert.doesNotMatch(svg, /<script/);
});
