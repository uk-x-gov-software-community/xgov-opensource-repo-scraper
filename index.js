import yaml from "js-yaml";
import { writeFileSync, readFileSync, mkdirSync, existsSync } from "fs";
import { join } from "path";
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

// ---------- SBOM helper functions ----------

/**
 * Convert an SPDX 2.3 package object to a CycloneDX 1.5 component.
 * Extracts PURL from externalRefs if available.
 */
function spdxPackageToCycloneDx(pkg) {
  const purlRef = (pkg.externalRefs || []).find(
    (r) => r.referenceType === "purl"
  );
  const purl = purlRef?.referenceLocator || null;
  return {
    type: "library",
    ...(purl ? { "bom-ref": purl, purl } : {}),
    name: pkg.name,
    version: pkg.versionInfo || "",
    ...(pkg.licenseDeclared && pkg.licenseDeclared !== "NOASSERTION"
      ? { licenses: [{ expression: pkg.licenseDeclared }] }
      : {}),
  };
}

/**
 * Deduplicate CycloneDX components by PURL (or name@version if no PURL).
 * First occurrence wins.
 */
function deduplicateComponents(components) {
  const seen = new Map();
  for (const comp of components) {
    const key = comp.purl || `${comp.name}@${comp.version}`;
    if (!seen.has(key)) seen.set(key, comp);
  }
  return Array.from(seen.values());
}

/**
 * Generate the top-level CycloneDX 1.5 catalog SBOM listing all repos
 * as components, with metadata properties from GitHub.
 */
function generateCatalogSbom(repos, manifest) {
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
    components: repos.map((repo) => {
      const key = `${repo.owner}/${repo.name}`;
      const hasSbom = manifest[key]?.status === "ok";
      return {
        type: "application",
        name: repo.name,
        version: repo.pushedAt || repo.updatedAt || "unknown",
        description: repo.description || "",
        group: repo.owner,
        externalReferences: [{ type: "website", url: repo.url }],
        ...(repo.license?.spdxId && repo.license.spdxId !== "NOASSERTION"
          ? { licenses: [{ license: { id: repo.license.spdxId } }] }
          : {}),
        properties: [
          { name: "github:language", value: repo.language || "" },
          { name: "github:stars", value: String(repo.stargazersCount || 0) },
          { name: "github:forks", value: String(repo.forksCount || 0) },
          { name: "github:archived", value: String(repo.archived || false) },
          { name: "github:has-sbom", value: String(hasSbom) },
        ],
      };
    }),
  };
}

// ---------- fetch-sboms command ----------

program
  .command("fetch-sboms")
  .description(
    "Fetch SPDX SBOMs from GitHub for repos, with incremental caching and rate-limit awareness"
  )
  .requiredOption("--repos-file <path>", "Path to repos.json")
  .requiredOption("--cache-dir <dir>", "SBOM cache directory")
  .option("--budget <n>", "Max API calls this run", parseInt, 95)
  .option("--max-hours <n>", "Time limit in hours", parseFloat, 5)
  .action(async (options) => {
    const repos = JSON.parse(readFileSync(options.reposFile, "utf8"));
    const cacheDir = options.cacheDir;
    const budget = options.budget;
    const maxMs = options.maxHours * 60 * 60 * 1000;
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

    // Build priority queue: changed repos first, then backfill (by stars desc)
    const changed = [];
    const backfill = [];

    for (const repo of repos) {
      const key = `${repo.owner}/${repo.name}`;
      const entry = manifest[key];

      if (!entry) {
        // Not in manifest — backfill candidate
        backfill.push(repo);
      } else if (entry.pushedAt === repo.pushedAt) {
        // Unchanged — skip
        continue;
      } else if (repo.pushedAt > (entry.fetchedAt || "")) {
        // Repo pushed after last fetch — changed
        changed.push(repo);
      }
    }

    // Sort backfill by stargazersCount descending (most popular first)
    backfill.sort((a, b) => (b.stargazersCount || 0) - (a.stargazersCount || 0));

    const queue = [...changed, ...backfill];
    console.log(
      `SBOM fetch queue: ${changed.length} changed, ${backfill.length} backfill, ${queue.length} total (budget: ${budget})`
    );

    let apiCalls = 0;
    let okCount = 0;
    let notFoundCount = 0;
    let errorCount = 0;
    const SBOM_DELAY_MS = 37000; // 37 seconds between requests (100/hr rate limit)

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

      try {
        const { status, data, headers } = await restFetch(sbomUrl);
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

        // Check rate limit headers — stop if exhausted
        const remaining = headers.get("x-ratelimit-remaining");
        if (remaining !== null && parseInt(remaining, 10) === 0) {
          console.log("Rate limit exhausted (x-ratelimit-remaining: 0), stopping");
          break;
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

      // Delay between requests to stay under 100/hr rate limit
      if (apiCalls < budget && apiCalls < queue.length) {
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

// ---------- generate-sbom command ----------

program
  .command("generate-sbom")
  .description(
    "Generate CycloneDX 1.5 SBOM catalog and per-org dependency BOMs from cached SPDX data"
  )
  .requiredOption("--repos-file <path>", "Path to repos.json")
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

    // --- Tier 1: catalog SBOM ---
    mkdirSync(outputDir, { recursive: true });
    const catalogSbom = generateCatalogSbom(repos, manifest);
    const catalogPath = join(outputDir, "sbom.json");
    writeFileSync(catalogPath, JSON.stringify(catalogSbom, null, 2));
    console.log(
      `Tier 1: wrote catalog SBOM with ${catalogSbom.components.length} components to ${catalogPath}`
    );

    // --- Tier 2: per-org dependency BOMs ---
    const sbomOutputDir = join(outputDir, "sbom");
    mkdirSync(sbomOutputDir, { recursive: true });

    // Group repos by org and filter to those with SBOM data
    const orgRepos = new Map();
    for (const repo of repos) {
      const key = `${repo.owner}/${repo.name}`;
      if (manifest[key]?.status === "ok") {
        if (!orgRepos.has(repo.owner)) {
          orgRepos.set(repo.owner, []);
        }
        orgRepos.get(repo.owner).push(repo);
      }
    }

    let orgCount = 0;
    let totalDeps = 0;

    for (const [org, orgRepoList] of orgRepos) {
      const allComponents = [];

      for (const repo of orgRepoList) {
        const spdxPath = join(cacheDir, "spdx", repo.owner, `${repo.name}.json`);
        if (!existsSync(spdxPath)) continue;

        try {
          const spdxData = JSON.parse(readFileSync(spdxPath, "utf8"));
          const packages = spdxData?.sbom?.packages || spdxData?.packages || [];

          for (const pkg of packages) {
            // Skip the root package (SPDX documents include the repo itself)
            if (
              pkg.SPDXID === "SPDXRef-DOCUMENT" ||
              pkg.SPDXID === "SPDXRef-com.github"
            ) {
              continue;
            }
            allComponents.push(spdxPackageToCycloneDx(pkg));
          }
        } catch (err) {
          console.error(`  Error reading SPDX for ${org}/${repo.name}: ${err.message}`);
        }
      }

      if (allComponents.length === 0) continue;

      const deduplicated = deduplicateComponents(allComponents);
      const orgBom = {
        bomFormat: "CycloneDX",
        specVersion: "1.5",
        version: 1,
        metadata: {
          timestamp: new Date().toISOString(),
          component: {
            type: "application",
            name: `${org}-dependencies`,
            version: "1.0.0",
            description: `Aggregated dependencies for ${org}`,
          },
        },
        components: deduplicated,
      };

      const orgOutputPath = join(sbomOutputDir, `${org}.json`);
      writeFileSync(orgOutputPath, JSON.stringify(orgBom, null, 2));
      orgCount++;
      totalDeps += deduplicated.length;
      console.log(
        `  ${org}: ${deduplicated.length} unique dependencies (from ${orgRepoList.length} repos)`
      );
    }

    console.log(
      `Tier 2: wrote ${orgCount} per-org BOMs with ${totalDeps} total unique dependencies to ${sbomOutputDir}/`
    );
  });

program.parse();
