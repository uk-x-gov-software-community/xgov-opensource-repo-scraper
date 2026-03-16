import yaml from "js-yaml";
import { writeFileSync, readFileSync, mkdirSync, existsSync, copyFileSync } from "fs";
import { join } from "path";
import { gzipSync } from "zlib";
import { Command } from "commander";

const program = new Command();
const GITHUB_TOKEN = process.env.GITHUB_TOKEN;
const GRAPHQL_URL = "https://api.github.com/graphql";
const BATCH_SIZE = 3; // orgs per GraphQL query (tested max with issues sub-connection)
const CONCURRENCY = 1; // sequential requests to avoid secondary rate limits
const CHANGE_DETECT_BATCH = 50; // orgs per change detection query (no issues = higher limit)
const INTER_BATCH_DELAY_MS = 2000; // delay between batches
const MAX_RETRIES = 5;

async function getOrgs() {
  const allDepartments = yaml.load(
    await (
      await fetch(
        "https://raw.githubusercontent.com/chrisns/government.github.com/add-uk-public-sector-orgs-202602/_data/governments.yml"
      )
    ).text()
  );
  const researchDepts = yaml.load(
    await (
      await fetch(
        "https://raw.githubusercontent.com/github/government.github.com/gh-pages/_data/research.yml"
      )
    ).text()
  );
  return [].concat(
    allDepartments["U.K. Councils"],
    allDepartments["U.K. Central"],
    researchDepts["U.K"]
  );
}

const delay = (ms) => new Promise((r) => setTimeout(r, ms));

async function graphqlFetch(query) {
  for (let attempt = 0; attempt < MAX_RETRIES; attempt++) {
    let resp;
    try {
      resp = await fetch(GRAPHQL_URL, {
        method: "POST",
        headers: {
          Authorization: `bearer ${GITHUB_TOKEN}`,
          "Content-Type": "application/json",
          "User-Agent": "xgov-opensource-repo-scraper",
        },
        body: JSON.stringify({ query }),
      });
    } catch (err) {
      const waitMs = Math.min(2000 * Math.pow(2, attempt), 60000);
      console.log(
        `Network error (${err.message}), retrying in ${Math.ceil(waitMs / 1000)}s (attempt ${attempt + 1}/${MAX_RETRIES})...`
      );
      await delay(waitMs);
      continue;
    }

    if (resp.status === 403 || resp.status === 429 || resp.status === 502) {
      const retryAfter = resp.headers.get("retry-after");
      const waitMs = retryAfter
        ? parseInt(retryAfter, 10) * 1000
        : Math.min(2000 * Math.pow(2, attempt), 120000);
      console.log(
        `Rate limit/server error (${resp.status}), retrying in ${Math.ceil(waitMs / 1000)}s (attempt ${attempt + 1}/${MAX_RETRIES})...`
      );
      await delay(waitMs);
      continue;
    }

    if (!resp.ok) {
      throw new Error(`GraphQL HTTP ${resp.status}: ${await resp.text()}`);
    }

    const json = await resp.json();
    if (json.errors) {
      const fatal = json.errors.filter((e) => e.type !== "NOT_FOUND");
      if (fatal.length && !json.data) {
        throw new Error(`GraphQL errors: ${JSON.stringify(fatal)}`);
      }
    }
    return json;
  }
  throw new Error(`Failed after ${MAX_RETRIES} retries`);
}

function buildRepoQuery(entries) {
  const fragments = entries.map(({ alias, login, cursor }) => {
    const afterArg = cursor ? `, after: "${cursor}"` : "";
    return `
    ${alias}: repositoryOwner(login: "${login}") {
      repositories(first: 100, orderBy: {field: UPDATED_AT, direction: DESC}${afterArg}) {
        totalCount
        pageInfo { hasNextPage endCursor }
        nodes {
          owner { login }
          name
          description
          url
          isArchived
          licenseInfo { key name spdxId }
          stargazerCount
          primaryLanguage { name }
          forkCount
          issues(states: OPEN) { totalCount }
          createdAt
          updatedAt
          pushedAt
        }
      }
    }`;
  });
  return `{ rateLimit { cost remaining resetAt } ${fragments.join("\n")} }`;
}

function buildChangeDetectionQuery(orgs) {
  const fragments = orgs.map((login, i) => {
    return `
    o${i}: repositoryOwner(login: "${login}") {
      repositories(first: 1, orderBy: {field: PUSHED_AT, direction: DESC}) {
        totalCount
        nodes { pushedAt }
      }
    }`;
  });
  return `{ rateLimit { cost remaining resetAt } ${fragments.join("\n")} }`;
}

function formatRepo(node) {
  if (!node) return null;
  return {
    owner: node.owner.login,
    name: node.name,
    description: node.description,
    url: node.url,
    archived: node.isArchived,
    license: node.licenseInfo,
    stargazersCount: node.stargazerCount,
    language: node.primaryLanguage?.name ?? null,
    forksCount: node.forkCount,
    openIssuesCount: node.issues.totalCount,
    createdAt: node.createdAt,
    updatedAt: node.updatedAt,
    pushedAt: node.pushedAt,
  };
}

async function checkRateLimit(rateLimit) {
  if (rateLimit && rateLimit.remaining < 50) {
    const resetAt = new Date(rateLimit.resetAt);
    const waitMs = resetAt - Date.now() + 1000;
    if (waitMs > 0) {
      console.log(
        `Rate limit low (${rateLimit.remaining} remaining), waiting ${Math.ceil(waitMs / 1000)}s...`
      );
      await new Promise((r) => setTimeout(r, waitMs));
    }
  }
}

async function detectChangedOrgs(orgs, cache) {
  if (!cache) return new Set(orgs);

  console.log("Running change detection...");
  const changed = new Set();
  const batches = [];
  for (let i = 0; i < orgs.length; i += CHANGE_DETECT_BATCH) {
    batches.push(orgs.slice(i, i + CHANGE_DETECT_BATCH));
  }

  for (let i = 0; i < batches.length; i += CONCURRENCY) {
    const concurrent = batches.slice(i, i + CONCURRENCY);
    const results = await Promise.allSettled(
      concurrent.map((batch) => graphqlFetch(buildChangeDetectionQuery(batch)))
    );

    if (i + CONCURRENCY < batches.length) {
      await delay(INTER_BATCH_DELAY_MS);
    }

    for (let b = 0; b < results.length; b++) {
      if (results[b].status === "rejected") {
        concurrent[b].forEach((org) => changed.add(org));
        continue;
      }
      const data = results[b].value.data;
      await checkRateLimit(data?.rateLimit);

      for (let j = 0; j < concurrent[b].length; j++) {
        const org = concurrent[b][j];
        const orgData = data?.[`o${j}`];
        if (!orgData) {
          changed.add(org);
          continue;
        }
        const repos = orgData.repositories;
        const latestPush = repos.nodes[0]?.pushedAt ?? null;
        const cached = cache[org];
        if (
          !cached ||
          cached.totalCount !== repos.totalCount ||
          cached.latestPushedAt !== latestPush
        ) {
          changed.add(org);
        }
      }
    }
  }

  console.log(
    `Change detection: ${changed.size} orgs changed, ${orgs.length - changed.size} cached`
  );
  return changed;
}

async function fetchAllRepos(orgs, cacheDir) {
  const startTime = Date.now();
  let cache = null;

  if (cacheDir && existsSync(`${cacheDir}/repos-by-org.json`)) {
    try {
      cache = JSON.parse(readFileSync(`${cacheDir}/repos-by-org.json`, "utf8"));
      console.log(
        `Loaded cache: ${Object.keys(cache).length} orgs cached`
      );
    } catch {
      console.log("Cache file corrupt, fetching all orgs fresh");
    }
  }

  const changedOrgs = await detectChangedOrgs(orgs, cache);
  const orgsToFetch = orgs.filter((o) => changedOrgs.has(o));

  console.log(
    `Fetching ${orgsToFetch.length} orgs via GraphQL (batch=${BATCH_SIZE}, concurrency=${CONCURRENCY})`
  );

  const reposByOrg = cache ? { ...cache } : {};
  let queue = orgsToFetch.map((login) => ({
    login,
    cursor: null,
    alias: null,
  }));
  let totalQueries = 0;

  while (queue.length > 0) {
    const batches = [];
    for (let i = 0; i < queue.length; i += BATCH_SIZE) {
      const batch = queue.slice(i, i + BATCH_SIZE).map((item, j) => ({
        ...item,
        alias: `o${j}`,
      }));
      batches.push(batch);
    }

    const nextQueue = [];

    for (let i = 0; i < batches.length; i += CONCURRENCY) {
      const concurrent = batches.slice(i, i + CONCURRENCY);

      const results = await Promise.allSettled(
        concurrent.map(async (batch) => {
          const query = buildRepoQuery(batch);
          return { batch, result: await graphqlFetch(query) };
        })
      );

      if (i + CONCURRENCY < batches.length) {
        await delay(INTER_BATCH_DELAY_MS);
      }

      for (const outcome of results) {
        if (outcome.status === "rejected") {
          console.error("Query failed:", outcome.reason?.message);
          continue;
        }

        const { batch, result } = outcome.value;
        totalQueries++;
        await checkRateLimit(result.data?.rateLimit);

        for (const entry of batch) {
          const orgData = result.data?.[entry.alias];
          if (!orgData) continue;

          const repos = orgData.repositories;
          const validNodes = repos.nodes.filter((n) => n !== null);
          const formatted = validNodes.map(formatRepo).filter(Boolean);

          if (!reposByOrg[entry.login]) {
            reposByOrg[entry.login] = {
              totalCount: repos.totalCount,
              latestPushedAt: null,
              repos: [],
            };
          }

          if (!entry.cursor) {
            reposByOrg[entry.login].repos = formatted;
            reposByOrg[entry.login].totalCount = repos.totalCount;
          } else {
            reposByOrg[entry.login].repos.push(...formatted);
          }

          if (repos.pageInfo.hasNextPage) {
            nextQueue.push({
              login: entry.login,
              cursor: repos.pageInfo.endCursor,
            });
          } else {
            const orgRepos = reposByOrg[entry.login].repos;
            reposByOrg[entry.login].latestPushedAt =
              orgRepos.length > 0
                ? orgRepos.reduce(
                    (max, r) =>
                      r.pushedAt > max ? r.pushedAt : max,
                    orgRepos[0].pushedAt
                  )
                : null;
            console.log(
              `  ${entry.login}: ${orgRepos.length} repos`
            );
          }
        }
      }
    }

    queue = nextQueue;
    if (queue.length > 0) {
      console.log(`  ...${queue.length} orgs need more pages`);
    }
  }

  if (cacheDir) {
    mkdirSync(cacheDir, { recursive: true });
    writeFileSync(
      `${cacheDir}/repos-by-org.json`,
      JSON.stringify(reposByOrg, null, 2)
    );
    console.log(`Cache saved to ${cacheDir}/repos-by-org.json`);
  }

  const allRepos = [];
  for (const org of orgs) {
    if (reposByOrg[org]) {
      allRepos.push(...reposByOrg[org].repos);
    }
  }

  const elapsed = ((Date.now() - startTime) / 1000).toFixed(1);
  console.log(
    `Done in ${elapsed}s: ${allRepos.length} repos from ${orgs.length} orgs (${totalQueries} GraphQL queries)`
  );

  return allRepos;
}

async function getRepos(org) {
  const repos = [];
  let cursor = null;

  do {
    const query = buildRepoQuery([{ alias: "o0", login: org, cursor }]);
    const result = await graphqlFetch(query);
    const orgData = result.data?.o0;
    if (!orgData) break;

    const pageRepos = orgData.repositories;
    const validNodes = pageRepos.nodes.filter((n) => n !== null);
    repos.push(...validNodes.map(formatRepo).filter(Boolean));
    cursor = pageRepos.pageInfo.hasNextPage
      ? pageRepos.pageInfo.endCursor
      : null;
  } while (cursor);

  return repos;
}

async function outputIt(data, outputFile) {
  const json = JSON.stringify(await data, null, 2);
  if (outputFile) {
    writeFileSync(outputFile, json);
  } else {
    process.stdout.write(json);
  }
}

program
  .command("get-orgs")
  .description(
    "Get a list of all the UK Government departments and agencies from GitHub"
  )
  .option("-w, --write <outputfile>", "Save output to a file")
  .action(async (options) => outputIt(getOrgs(), options.write));

program
  .command("get-repos")
  .argument("<org>", "The GitHub organisation to get the repos for")
  .description("Get a list of all the repositories for a given org GitHub")
  .option("-w, --write <outputfile>", "Save output to a file")
  .action(async (org, options) => outputIt(getRepos(org), options.write));

program
  .command("get-all")
  .option("-w, --write <outputfile>", "Save output to a file")
  .option("--cache-dir <dir>", "Directory for caching org data between runs")
  .option("--chunk <n>", "Chunk index (0-based) for parallel fan-out", parseInt)
  .option("--total-chunks <n>", "Total number of chunks for parallel fan-out", parseInt)
  .description(
    "Get consolidated data for all UK Government departments and agencies"
  )
  .action(async (options) => {
    let orgs = await getOrgs();
    if (options.totalChunks > 1 && options.chunk !== undefined) {
      const total = orgs.length;
      orgs = orgs.filter((_, i) => i % options.totalChunks === options.chunk);
      console.log(
        `Chunk ${options.chunk + 1}/${options.totalChunks}: processing ${orgs.length}/${total} orgs (round-robin)`
      );
    }
    const allRepos = await fetchAllRepos(orgs, options.cacheDir);
    return outputIt(allRepos, options.write);
  });

program
  .command("merge-chunks")
  .description("Merge chunk JSON files into a single output")
  .option("-w, --write <outputfile>", "Save merged output to a file")
  .argument("<files...>", "Chunk JSON files to merge")
  .action(async (files, options) => {
    const allRepos = [];
    for (const file of files) {
      const data = JSON.parse(readFileSync(file, "utf8"));
      allRepos.push(...data);
    }
    console.log(`Merged ${files.length} chunks: ${allRepos.length} total repos`);
    return outputIt(allRepos, options.write);
  });

// ---------- REST API fetch helper ----------

/**
 * Performs a REST API GET request with retry logic for rate limits and server errors.
 * Returns { status, data, headers } on success or 404.
 * Retries on 403/429 (rate limit) and 5xx (server error) with appropriate backoff.
 */
async function restFetch(url) {
  for (let attempt = 0; attempt < MAX_RETRIES; attempt++) {
    let resp;
    try {
      resp = await fetch(url, {
        headers: {
          Authorization: `bearer ${GITHUB_TOKEN}`,
          Accept: "application/vnd.github+json",
          "User-Agent": "xgov-opensource-repo-scraper",
        },
      });
    } catch (err) {
      const waitMs = Math.min(2000 * Math.pow(2, attempt), 60000);
      console.log(
        `Network error (${err.message}), retrying in ${Math.ceil(waitMs / 1000)}s (attempt ${attempt + 1}/${MAX_RETRIES})...`
      );
      await delay(waitMs);
      continue;
    }

    // 404 is a valid "not found" response, not an error
    if (resp.status === 404) {
      return { status: 404, data: null, headers: resp.headers };
    }

    // Rate limit or abuse detection — retry with backoff
    if (resp.status === 403 || resp.status === 429) {
      const retryAfter = resp.headers.get("retry-after");
      const waitMs = retryAfter
        ? parseInt(retryAfter, 10) * 1000
        : Math.min(2000 * Math.pow(2, attempt), 120000);
      console.log(
        `Rate limit (${resp.status}), retrying in ${Math.ceil(waitMs / 1000)}s (attempt ${attempt + 1}/${MAX_RETRIES})...`
      );
      await delay(waitMs);
      continue;
    }

    // Server errors — exponential backoff
    if (resp.status >= 500) {
      const waitMs = Math.min(2000 * Math.pow(2, attempt), 60000);
      console.log(
        `Server error (${resp.status}), retrying in ${Math.ceil(waitMs / 1000)}s (attempt ${attempt + 1}/${MAX_RETRIES})...`
      );
      await delay(waitMs);
      continue;
    }

    if (!resp.ok) {
      throw new Error(`REST HTTP ${resp.status}: ${await resp.text()}`);
    }

    const data = await resp.json();
    return { status: resp.status, data, headers: resp.headers };
  }
  throw new Error(`REST fetch failed after ${MAX_RETRIES} retries: ${url}`);
}

// ---------- SBOM helper ----------

// ---------- fetch-sboms command ----------

program
  .command("fetch-sboms")
  .description(
    "Fetch SPDX SBOMs from GitHub for repos, with incremental caching and rate-limit awareness"
  )
  .requiredOption("--repos-file <path>", "Path to repos.json")
  .requiredOption("--cache-dir <dir>", "SBOM cache directory")
  .option("--budget <n>", "Max API calls this run (default 95)", parseInt)
  .option("--max-hours <n>", "Time limit in hours (default 5)", parseFloat)
  .option("--reverse", "Process new repos in reverse star order (low stars first)")
  .option("--delay <ms>", "Delay between requests in ms (default 37000)", parseInt)
  .action(async (options) => {
    const repos = JSON.parse(readFileSync(options.reposFile, "utf8"));
    const cacheDir = options.cacheDir;
    const budget = options.budget ?? 95;
    const maxMs = (options.maxHours ?? 5) * 60 * 60 * 1000;
    const startTime = Date.now();

    // Ensure cache directories exist
    mkdirSync(join(cacheDir, "spdx"), { recursive: true });

    // Load or initialise the SBOM manifest
    const manifestPath = join(cacheDir, "sbom-manifest.json");
    let manifest = {};
    if (existsSync(manifestPath)) {
      try {
        manifest = JSON.parse(readFileSync(manifestPath, "utf8"));
      } catch {
        console.log("Manifest file corrupt, starting fresh");
      }
    }

    // Build priority queue:
    //  1. Changed repos (pushedAt differs from last fetch)
    //  2. New repos (never fetched)
    //  3. Stale repos (fetched > 30 days ago — re-check in case GitHub added new manifest support)
    const STALE_MS = 30 * 24 * 60 * 60 * 1000; // 30 days
    const now = Date.now();
    const changed = [];
    const newRepos = [];
    const stale = [];
    let skipped = 0;

    for (const repo of repos) {
      const key = `${repo.owner}/${repo.name}`;
      const entry = manifest[key];

      if (!entry) {
        newRepos.push(repo);
      } else if (entry.pushedAt !== repo.pushedAt) {
        changed.push(repo);
      } else if (now - new Date(entry.fetchedAt).getTime() > STALE_MS) {
        stale.push(repo);
      } else {
        skipped++;
      }
    }

    // Within each tier, sort by stars descending (most popular first)
    // --reverse: process from low-star end so local runs don't overlap with CI
    if (options.reverse) {
      newRepos.sort((a, b) => (a.stargazersCount || 0) - (b.stargazersCount || 0));
      stale.sort((a, b) => (a.stargazersCount || 0) - (b.stargazersCount || 0));
    } else {
      newRepos.sort((a, b) => (b.stargazersCount || 0) - (a.stargazersCount || 0));
      stale.sort((a, b) => (b.stargazersCount || 0) - (a.stargazersCount || 0));
    }

    const queue = [...changed, ...newRepos, ...stale];
    console.log(
      `SBOM fetch queue: ${changed.length} changed, ${newRepos.length} new, ${stale.length} stale (>30d), ${skipped} fresh (budget: ${budget})`
    );

    let apiCalls = 0;
    let okCount = 0;
    let notFoundCount = 0;
    let errorCount = 0;
    const SBOM_DELAY_MS = options.delay ?? 37000; // default 37s between requests (100/hr rate limit)

    for (const repo of queue) {
      // Check budget
      if (apiCalls >= budget) {
        console.log(`Budget exhausted (${apiCalls}/${budget}), stopping`);
        break;
      }

      // Check time limit
      if (Date.now() - startTime >= maxMs) {
        console.log(
          `Time limit reached (${options.maxHours}h), stopping after ${apiCalls} calls`
        );
        break;
      }

      const key = `${repo.owner}/${repo.name}`;
      const sbomUrl = `https://api.github.com/repos/${repo.owner}/${repo.name}/dependency-graph/sbom`;
      let lastStatus = 0;

      try {
        const { status, data, headers } = await restFetch(sbomUrl);
        lastStatus = status;
        apiCalls++;

        if (status === 200) {
          // Save SPDX file
          const spdxDir = join(cacheDir, "spdx", repo.owner);
          mkdirSync(spdxDir, { recursive: true });
          writeFileSync(
            join(spdxDir, `${repo.name}.json`),
            JSON.stringify(data, null, 2)
          );
          manifest[key] = {
            fetchedAt: new Date().toISOString(),
            pushedAt: repo.pushedAt,
            status: "ok",
          };
          okCount++;
          console.log(`  [ok]  ${key}`);
        } else if (status === 404) {
          manifest[key] = {
            fetchedAt: new Date().toISOString(),
            pushedAt: repo.pushedAt,
            status: "404",
          };
          notFoundCount++;
          console.log(`  [404] ${key}`);
        }

        // Check rate limit headers — stop if exhausted, or adapt delay
        const remaining = headers.get("x-ratelimit-remaining");
        const resetHeader = headers.get("x-ratelimit-reset");
        if (remaining !== null && parseInt(remaining, 10) === 0) {
          if (resetHeader) {
            const waitSec = Math.max(0, parseInt(resetHeader, 10) - Math.floor(Date.now() / 1000)) + 5;
            console.log(`Rate limit exhausted, waiting ${waitSec}s for reset...`);
            await delay(waitSec * 1000);
          } else {
            console.log("Rate limit exhausted (x-ratelimit-remaining: 0), stopping");
            break;
          }
        }
      } catch (err) {
        manifest[key] = {
          fetchedAt: new Date().toISOString(),
          pushedAt: repo.pushedAt,
          status: "error",
        };
        errorCount++;
        console.error(`  [err] ${key}: ${err.message}`);
      }

      // Save manifest every 50 requests so progress isn't lost
      if (apiCalls % 50 === 0) {
        writeFileSync(manifestPath, JSON.stringify(manifest, null, 2));
      }

      // Only delay after successful SBOM fetches (404s don't consume rate limit)
      if (lastStatus === 200) {
        await delay(SBOM_DELAY_MS);
      }
    }

    // Save manifest
    writeFileSync(manifestPath, JSON.stringify(manifest, null, 2));
    const elapsed = ((Date.now() - startTime) / 1000).toFixed(1);
    console.log(
      `SBOM fetch complete in ${elapsed}s: ${apiCalls} API calls, ${okCount} ok, ${notFoundCount} not found, ${errorCount} errors`
    );
  });

// ---------- merge-sbom-cache command ----------

program
  .command("merge-sbom-cache")
  .description("Merge a supplementary SBOM cache into the primary cache")
  .requiredOption("--primary <dir>", "Primary cache directory")
  .requiredOption("--supplement <dir>", "Supplementary cache directory to merge in")
  .action(async (options) => {
    const primaryDir = options.primary;
    const supplementDir = options.supplement;

    // Load manifests
    const primaryManifestPath = join(primaryDir, "sbom-manifest.json");
    const supplementManifestPath = join(supplementDir, "sbom-manifest.json");

    let primaryManifest = {};
    if (existsSync(primaryManifestPath)) {
      primaryManifest = JSON.parse(readFileSync(primaryManifestPath, "utf8"));
    }
    let supplementManifest = {};
    if (existsSync(supplementManifestPath)) {
      supplementManifest = JSON.parse(readFileSync(supplementManifestPath, "utf8"));
    }

    let added = 0;
    let skipped = 0;
    for (const [key, entry] of Object.entries(supplementManifest)) {
      if (!primaryManifest[key]) {
        primaryManifest[key] = entry;
        // Copy SPDX file if it exists
        const [owner, name] = key.split("/");
        const srcPath = join(supplementDir, "spdx", owner, `${name}.json`);
        if (existsSync(srcPath)) {
          const destDir = join(primaryDir, "spdx", owner);
          mkdirSync(destDir, { recursive: true });
          copyFileSync(srcPath, join(destDir, `${name}.json`));
        }
        added++;
      } else {
        skipped++;
      }
    }

    writeFileSync(primaryManifestPath, JSON.stringify(primaryManifest, null, 2));
    console.log(`Merge complete: ${added} added, ${skipped} already present`);
  });

// ---------- publish-sboms command ----------

program
  .command("publish-sboms")
  .description(
    "Copy cached SPDX SBOMs to output directory and add sbom links to repos.json"
  )
  .requiredOption("--repos-file <path>", "Path to repos.json (will be updated in-place)")
  .requiredOption("--cache-dir <dir>", "SBOM cache directory (same as fetch-sboms)")
  .requiredOption("--output-dir <dir>", "Output directory (e.g. ./public)")
  .action(async (options) => {
    const repos = JSON.parse(readFileSync(options.reposFile, "utf8"));
    const cacheDir = options.cacheDir;
    const outputDir = options.outputDir;

    // Load manifest
    const manifestPath = join(cacheDir, "sbom-manifest.json");
    let manifest = {};
    if (existsSync(manifestPath)) {
      try {
        manifest = JSON.parse(readFileSync(manifestPath, "utf8"));
      } catch {
        console.log("Manifest file corrupt or missing, using empty manifest");
      }
    }

    // Copy SPDX files to output and enrich repos with sbom path
    const sbomOutputDir = join(outputDir, "sbom");
    let copiedCount = 0;
    const stats = { ok: 0, notFound: 0, error: 0, pending: 0 };

    for (const repo of repos) {
      const key = `${repo.owner}/${repo.name}`;
      const entry = manifest[key];
      const s = entry?.status;

      if (s === "ok") stats.ok++;
      else if (s === "404") stats.notFound++;
      else if (s === "error") stats.error++;
      else stats.pending++;

      if (entry?.status === "ok") {
        const srcPath = join(cacheDir, "spdx", repo.owner, `${repo.name}.json`);
        if (existsSync(srcPath)) {
          const destDir = join(sbomOutputDir, repo.owner);
          mkdirSync(destDir, { recursive: true });
          writeFileSync(
            join(destDir, `${repo.name}.json.gz`),
            gzipSync(readFileSync(srcPath))
          );
          copiedCount++;
          repo.sbom = `sbom/${repo.owner}/${repo.name}.json.gz`;
        }
      }
    }

    // Write updated repos.json with sbom links
    writeFileSync(options.reposFile, JSON.stringify(repos, null, 2));
    mkdirSync(sbomOutputDir, { recursive: true });

    console.log(
      `Published ${copiedCount} SPDX SBOMs to ${sbomOutputDir}/`
    );
    console.log(
      `Coverage: ${stats.ok} ok, ${stats.notFound} no manifest, ${stats.error} errors, ${stats.pending} pending`
    );
  });

program.parse();
