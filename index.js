import { writeFileSync, readFileSync, mkdirSync, readdirSync, unlinkSync, statSync } from "fs";
import { join, dirname } from "path";
import { fileURLToPath } from "url";
import { Octokit } from "@octokit/rest";
import { throttling } from "@octokit/plugin-throttling";
import yaml from "js-yaml";
import { Command } from "commander";

// ---------------------------------------------------------------------------
// Constants
// ---------------------------------------------------------------------------

const GOVS_YML_URL =
  "https://raw.githubusercontent.com/chrisns/government.github.com/add-uk-public-sector-orgs-202602/_data/governments.yml";
const RESEARCH_YML_URL =
  "https://raw.githubusercontent.com/github/government.github.com/gh-pages/_data/research.yml";

const __dirname = dirname(fileURLToPath(import.meta.url));
const CACHE_DIR = join(__dirname, ".cache");

// Concurrency 10: yields 8-12 req/s at typical GitHub API latency (500-800ms).
// Well under the secondary rate limit of 15 req/s and 100 concurrent requests.
// GITHUB_TOKEN in Actions provides 1,000 req/hour; ~222 requests for ~201 orgs
// uses only ~22% of the primary budget. With ETag caching, subsequent runs get
// ~90% of responses as free 304s, making the budget essentially unlimited.
const DEFAULT_CONCURRENCY = 10;

// Default cache TTL in seconds -- a secondary guard so we don't re-request
// within this window even if we have an ETag. Keeps things polite.
const DEFAULT_CACHE_TTL = 300; // 5 minutes

// Cache entries older than this are pruned on startup.
const CACHE_MAX_AGE_DAYS = 7;

// ---------------------------------------------------------------------------
// Octokit setup with throttle plugin
// ---------------------------------------------------------------------------

const ThrottledOctokit = Octokit.plugin(throttling);

function createOctokit() {
  return new ThrottledOctokit({
    auth: process.env.GITHUB_TOKEN,
    throttle: {
      onRateLimit: (retryAfter, options, octokit, retryCount) => {
        octokit.log.warn(
          `Rate limit hit for ${options.method} ${options.url} -- retry after ${retryAfter}s (attempt ${retryCount + 1})`
        );
        // Retry twice then give up
        return retryCount < 2;
      },
      onSecondaryRateLimit: (retryAfter, options, octokit, retryCount) => {
        octokit.log.warn(
          `Secondary rate limit hit for ${options.method} ${options.url} -- retry after ${retryAfter}s (attempt ${retryCount + 1})`
        );
        return retryCount < 2;
      },
    },
  });
}

// ---------------------------------------------------------------------------
// ETag-based disk cache
//
// Cache file format (.cache/{org}.json):
//   { etag: "W/\"abc123\"", data: [...repos], lastFetched: "2026-03-07T..." }
//
// On subsequent requests we send If-None-Match with the stored ETag.
// GitHub returns 304 (Not Modified) when nothing changed -- this response is
// FREE and does not count against the primary rate limit. This is the single
// biggest performance win: on a typical nightly run ~90% of orgs are unchanged,
// so ~90% of our requests cost zero quota.
// ---------------------------------------------------------------------------

function ensureCacheDir() {
  mkdirSync(CACHE_DIR, { recursive: true });
}

function cachePath(org) {
  // Sanitise org name for filesystem safety
  return join(CACHE_DIR, `${org.replace(/[^a-zA-Z0-9_-]/g, "_")}.json`);
}

function readCache(org) {
  try {
    const raw = readFileSync(cachePath(org), "utf-8");
    return JSON.parse(raw);
  } catch {
    return null;
  }
}

function writeCache(org, etag, data) {
  ensureCacheDir();
  const entry = { etag, data, lastFetched: new Date().toISOString() };
  writeFileSync(cachePath(org), JSON.stringify(entry));
}

function isCacheFresh(entry, ttlSeconds) {
  if (!entry || !entry.lastFetched) return false;
  const age = (Date.now() - new Date(entry.lastFetched).getTime()) / 1000;
  return age < ttlSeconds;
}

function pruneStaleCache() {
  try {
    ensureCacheDir();
    const cutoff = Date.now() - CACHE_MAX_AGE_DAYS * 24 * 60 * 60 * 1000;
    for (const file of readdirSync(CACHE_DIR)) {
      const fp = join(CACHE_DIR, file);
      try {
        const st = statSync(fp);
        if (st.mtimeMs < cutoff) {
          unlinkSync(fp);
        }
      } catch {
        // ignore individual file errors
      }
    }
  } catch {
    // cache dir may not exist yet -- that's fine
  }
}

// ---------------------------------------------------------------------------
// Concurrency limiter
// ---------------------------------------------------------------------------

function concurrencyLimiter(limit) {
  let active = 0;
  const queue = [];

  function next() {
    if (queue.length === 0 || active >= limit) return;
    active++;
    const { fn, resolve, reject } = queue.shift();
    fn().then(resolve, reject).finally(() => {
      active--;
      next();
    });
  }

  return function run(fn) {
    return new Promise((resolve, reject) => {
      queue.push({ fn, resolve, reject });
      next();
    });
  };
}

// ---------------------------------------------------------------------------
// Fetch UK government org list
// ---------------------------------------------------------------------------

async function getOrgs() {
  const [govRes, researchRes] = await Promise.all([
    fetch(GOVS_YML_URL),
    fetch(RESEARCH_YML_URL),
  ]);

  if (!govRes.ok) throw new Error(`Failed to fetch governments.yml: ${govRes.status}`);
  if (!researchRes.ok) throw new Error(`Failed to fetch research.yml: ${researchRes.status}`);

  const allDepartments = yaml.load(await govRes.text());
  const researchDepts = yaml.load(await researchRes.text());

  return [].concat(
    allDepartments["U.K. Councils"] || [],
    allDepartments["U.K. Central"] || [],
    researchDepts["U.K"] || []
  );
}

// ---------------------------------------------------------------------------
// Format a single repo object from the GitHub API response
// ---------------------------------------------------------------------------

function formatRepo(repo) {
  return {
    owner: repo.owner?.login,
    name: repo.name,
    url: repo.html_url,
    description: repo.description,
    archived: repo.archived,
    license: repo.license,
    stargazersCount: repo.stargazers_count,
    language: repo.language,
    forksCount: repo.forks_count,
    openIssuesCount: repo.open_issues_count,
    createdAt: repo.created_at,
    updatedAt: repo.updated_at,
    pushedAt: repo.pushed_at,
  };
}

// ---------------------------------------------------------------------------
// Fetch repos for a single org (with ETag caching)
// ---------------------------------------------------------------------------

async function getReposForOrg(octokit, org, { useCache = true, cacheTtl = DEFAULT_CACHE_TTL } = {}) {
  const cached = useCache ? readCache(org) : null;

  // Secondary TTL guard: if we fetched recently, skip the network entirely
  if (cached && useCache && isCacheFresh(cached, cacheTtl)) {
    return { repos: cached.data, status: "ttl-hit" };
  }

  // Build conditional request headers (ETag)
  const headers = {};
  if (cached?.etag && useCache) {
    headers["If-None-Match"] = cached.etag;
  }

  try {
    // Fetch the first page with ETag header.
    // If GitHub returns 304 the Octokit request will throw with status 304.
    const firstPage = await octokit.request("GET /orgs/{org}/repos", {
      org,
      per_page: 100,
      type: "public",
      headers,
    });

    // 200 -- org data has changed, collect all pages
    const etag = firstPage.headers.etag || null;
    let allRepos = firstPage.data;

    // Follow pagination via Link header
    let nextUrl = parseLinkNext(firstPage.headers.link);
    while (nextUrl) {
      const page = await octokit.request(nextUrl);
      allRepos = allRepos.concat(page.data);
      nextUrl = parseLinkNext(page.headers.link);
    }

    const formatted = allRepos.map(formatRepo);

    if (useCache && etag) {
      writeCache(org, etag, formatted);
    }

    return { repos: formatted, status: "fetched" };
  } catch (err) {
    if (err.status === 304) {
      // FREE request -- org unchanged, use cached data
      return { repos: cached.data, status: "etag-hit" };
    }
    if (err.status === 404) {
      // Org doesn't exist (renamed/deleted) -- return empty
      return { repos: [], status: "not-found" };
    }
    throw err;
  }
}

function parseLinkNext(linkHeader) {
  if (!linkHeader) return null;
  const match = linkHeader.match(/<([^>]+)>;\s*rel="next"/);
  return match ? match[1] : null;
}

// ---------------------------------------------------------------------------
// Fetch repos for a single org (no cache, simple)
// ---------------------------------------------------------------------------

async function getRepos(octokit, org) {
  const { repos } = await getReposForOrg(octokit, org, { useCache: false });
  return repos;
}

// ---------------------------------------------------------------------------
// Fetch all orgs with concurrency control, caching, and progress
// ---------------------------------------------------------------------------

async function getAll(octokit, orgs, { concurrency, useCache, cacheTtl }) {
  const limiter = concurrencyLimiter(concurrency);
  const startTime = Date.now();

  const counts = { fetched: 0, etagHit: 0, ttlHit: 0, notFound: 0, error: 0 };
  let completed = 0;
  const total = orgs.length;

  const results = await Promise.allSettled(
    orgs.map((org) =>
      limiter(async () => {
        try {
          const { repos, status } = await getReposForOrg(octokit, org, {
            useCache,
            cacheTtl,
          });

          if (status === "fetched") counts.fetched++;
          else if (status === "etag-hit") counts.etagHit++;
          else if (status === "ttl-hit") counts.ttlHit++;
          else if (status === "not-found") counts.notFound++;

          completed++;
          if (completed % 20 === 0 || completed === total) {
            const elapsed = ((Date.now() - startTime) / 1000).toFixed(1);
            console.log(
              `[${completed}/${total}] ${elapsed}s -- ` +
              `fetched:${counts.fetched} etag-hit:${counts.etagHit} ` +
              `ttl-hit:${counts.ttlHit} not-found:${counts.notFound} error:${counts.error}`
            );
          }

          return repos;
        } catch (err) {
          counts.error++;
          completed++;
          console.error(`Error fetching ${org}: ${err.message}`);
          return [];
        }
      })
    )
  );

  const allRepos = results.flatMap((r) => (r.status === "fulfilled" ? r.value : []));

  // Final summary
  const elapsed = ((Date.now() - startTime) / 1000).toFixed(1);
  console.log(
    `\nDone in ${elapsed}s -- ${allRepos.length} repos from ${total} orgs\n` +
    `  API fetches : ${counts.fetched}\n` +
    `  ETag hits   : ${counts.etagHit} (free -- no rate-limit cost)\n` +
    `  TTL hits    : ${counts.ttlHit} (skipped -- within cache TTL)\n` +
    `  Not found   : ${counts.notFound}\n` +
    `  Errors      : ${counts.error}`
  );

  return allRepos;
}

// ---------------------------------------------------------------------------
// SBOM generation -- CycloneDX 1.5 catalog
//
// A CycloneDX "catalog" captures an inventory of software components without
// implying they form a single dependency tree. Each GitHub repo becomes a
// component of type "application". This is the idiomatic way to represent a
// government-wide catalogue of open-source projects.
// ---------------------------------------------------------------------------

function generateSbom(repos) {
  return {
    bomFormat: "CycloneDX",
    specVersion: "1.5",
    version: 1,
    metadata: {
      timestamp: new Date().toISOString(),
      component: {
        type: "application",
        name: "xgov-opensource-repo-scraper",
        version: "2.0.0",
        description: "UK Government open source repository catalogue",
      },
    },
    components: repos.map((repo) => ({
      type: "application",
      name: repo.name,
      version: repo.pushedAt || repo.updatedAt || "unknown",
      description: repo.description || "",
      group: repo.owner,
      externalReferences: [
        {
          type: "website",
          url: repo.url,
        },
      ],
      ...(repo.license?.spdx_id && repo.license.spdx_id !== "NOASSERTION"
        ? {
            licenses: [
              {
                license: {
                  id: repo.license.spdx_id,
                },
              },
            ],
          }
        : {}),
      properties: [
        { name: "github:language", value: repo.language || "" },
        { name: "github:stars", value: String(repo.stargazersCount || 0) },
        { name: "github:forks", value: String(repo.forksCount || 0) },
        { name: "github:archived", value: String(repo.archived || false) },
      ],
    })),
  };
}

// ---------------------------------------------------------------------------
// Output helper
// ---------------------------------------------------------------------------

function outputData(data, outputFile) {
  const json = JSON.stringify(data, null, 2);
  if (outputFile) {
    mkdirSync(dirname(outputFile), { recursive: true });
    writeFileSync(outputFile, json);
    console.log(`Wrote ${outputFile}`);
  } else {
    process.stdout.write(json);
  }
}

// ---------------------------------------------------------------------------
// CLI
// ---------------------------------------------------------------------------

const program = new Command();
program
  .name("xgov-opensource-repo-scraper")
  .description("Scrapes UK Government open source repositories from GitHub")
  .version("2.0.0");

// -- get-orgs ---------------------------------------------------------------
program
  .command("get-orgs")
  .description("List UK Government GitHub organisations")
  .option("-w, --write <file>", "Save output to a file")
  .action(async (options) => {
    const orgs = await getOrgs();
    outputData(orgs, options.write);
  });

// -- get-repos --------------------------------------------------------------
program
  .command("get-repos")
  .argument("<org>", "GitHub organisation to query")
  .description("List public repositories for a single org")
  .option("-w, --write <file>", "Save output to a file")
  .action(async (org, options) => {
    const octokit = createOctokit();
    const repos = await getRepos(octokit, org);
    outputData(repos, options.write);
  });

// -- get-all ----------------------------------------------------------------
program
  .command("get-all")
  .description("Fetch repos for all UK Government orgs")
  .option("-w, --write <file>", "Save output to a file")
  .option("--sbom <file>", "Write CycloneDX 1.5 SBOM to file")
  .option("--no-cache", "Disable ETag/disk caching")
  .option("--cache-ttl <seconds>", "Cache TTL in seconds", String(DEFAULT_CACHE_TTL))
  .option("--concurrency <n>", "Max concurrent org fetches", String(DEFAULT_CONCURRENCY))
  .action(async (options) => {
    const octokit = createOctokit();
    const useCache = options.cache !== false;
    const cacheTtl = parseInt(options.cacheTtl, 10) || DEFAULT_CACHE_TTL;
    const concurrency = parseInt(options.concurrency, 10) || DEFAULT_CONCURRENCY;

    // Prune stale cache entries on startup
    if (useCache) {
      pruneStaleCache();
    }

    console.log(
      `Config: concurrency=${concurrency} cache=${useCache} cacheTtl=${cacheTtl}s`
    );

    const orgs = await getOrgs();
    console.log(`Found ${orgs.length} orgs\n`);

    const allRepos = await getAll(octokit, orgs, { concurrency, useCache, cacheTtl });
    outputData(allRepos, options.write);

    if (options.sbom) {
      const sbom = generateSbom(allRepos);
      mkdirSync(dirname(options.sbom), { recursive: true });
      writeFileSync(options.sbom, JSON.stringify(sbom, null, 2));
      console.log(`Wrote SBOM to ${options.sbom}`);
    }
  });

// -- generate-sbom ----------------------------------------------------------
program
  .command("generate-sbom")
  .argument("<input>", "Path to repos JSON file")
  .description("Generate CycloneDX 1.5 SBOM from a repos JSON file")
  .option("-w, --write <file>", "Save output to a file")
  .action(async (input, options) => {
    const repos = JSON.parse(readFileSync(input, "utf-8"));
    const sbom = generateSbom(repos);
    outputData(sbom, options.write);
  });

program.parse();
