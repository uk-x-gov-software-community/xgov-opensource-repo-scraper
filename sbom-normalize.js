// ---------- SBOM normalisation ----------
//
// GitHub's dependency-graph SBOM API is the upstream source for every SBOM we
// publish. It emits a *flat* SPDX package list whose only relationships are
// DESCRIBES and DEPENDS_ON — it carries **no dev/runtime scope** and, for
// manifests without a committed lockfile (most Maven/Gradle/Go projects), it
// emits packages with **no resolved version** (versionInfo absent / NOASSERTION).
//
// Both gaps poison downstream CVE scanning:
//   * A version-less package can only be matched by *name*, which is how the
//     consolidated SBOM produced phantom hits (e.g. a Spring4Shell "match" on a
//     spring-boot-starter-web entry that had no version at all).
//   * Build/test tooling (eslint, webpack, junit, pytest, CI actions, …) is
//     emitted alongside deployed runtime dependencies with nothing to tell them
//     apart, inflating the apparent attack surface with code that never ships.
//
// This module classifies every package at publish time so the consolidated
// CycloneDX can carry a standards-compliant `scope` (required | excluded) plus
// auditable `properties`, and a version-pinned runtime-only artifact can be
// emitted for scanners. We cannot invent versions GitHub never resolved, but we
// can stop them masquerading as scannable facts.

// Concrete, pinned version? Reject empties, NOASSERTION and unpinned ranges
// (Maven `[1.0,2.0)`, npm `^1.2.0`, etc.) — only a single fixed version can be
// reliably CVE-matched.
export function isResolvedVersion(version) {
  if (!version || typeof version !== "string") return false;
  const v = version.trim();
  if (v === "" || v.toUpperCase() === "NOASSERTION") return false;
  if (/[\s,|[\]()*^~<>=]/.test(v)) return false; // range / constraint, not a pin
  return /\d/.test(v); // must contain at least one digit
}

// purls encode the ecosystem (`pkg:<type>/…`) and frequently the pinned version
// (`…@<version>`) even when SPDX versionInfo is missing — recover both.
export function parsePurl(purl) {
  if (!purl || typeof purl !== "string") return { type: null, version: null };
  const m = /^pkg:([^/]+)\//.exec(purl);
  const type = m ? m[1].toLowerCase() : null;
  const at = purl.lastIndexOf("@");
  let version = null;
  if (at > 4) {
    const tail = purl.slice(at + 1);
    // Stop at any qualifier/subpath that follows the version.
    version = decodeURIComponent(tail.split(/[?#]/)[0]);
  }
  return { type, version };
}

// Conservative dev/build/test tooling matchers, keyed by purl ecosystem. These
// are dependencies that exist to *build or test* a project, not to run the
// deployed service — so they are out of the production attack surface. Kept
// deliberately tight (well-known names only) to avoid excluding real runtime
// code; anything unrecognised stays in scope.
const DEV_RULES = {
  npm: [
    /^@types\//,
    /^@babel\//,
    /^@storybook\//,
    /^@testing-library\//,
    /^@playwright\//,
    /^eslint/,
    /^prettier$/,
    /^stylelint/,
    /^typescript$/,
    /^ts-node$/,
    /^tsx$/,
    /^nodemon$/,
    /^concurrently$/,
    /^rimraf$/,
    /^husky$/,
    /^lint-staged$/,
    /^(jest|mocha|chai|jasmine|karma|vitest|cypress|playwright|sinon|nock|supertest|enzyme|nyc)$/,
    /^(webpack|rollup|vite|gulp|grunt|parcel|esbuild|browserify)/,
    /^(sass|node-sass|less|postcss|autoprefixer)$/,
    /^@faker-js\/faker$/,
    /^faker$/,
  ],
  maven: [
    /^junit:/,
    /^org\.junit/,
    /^org\.mockito:/,
    /^org\.assertj:/,
    /^org\.hamcrest:/,
    /^org\.testng:/,
    /^org\.testcontainers:/,
    /^org\.seleniumhq/,
    /^com\.github\.tomakehurst:wiremock/,
    /spring-boot-starter-test/,
    /-maven-plugin/,
    /-gradle-plugin/,
  ],
  gem: [
    /^(rspec|rspec-core|rspec-rails|rubocop|brakeman|capybara|pry|byebug|simplecov|webmock|vcr|database_cleaner|factory_bot|factory_bot_rails|web-console|spring|listen|guard)/,
  ],
  pypi: [
    /^(pytest|tox|nox|flake8|black|isort|mypy|pylint|bandit|pre-commit|coverage|mock|factory-boy|faker|nose|sphinx)$/,
    /^pytest-/,
  ],
  nuget: [
    /^(xunit|nunit|moq|fluentassertions|coverlet|shouldly|specflow|stylecop)/i,
    /\.tests?$/i,
    /^microsoft\.net\.test\.sdk$/i,
  ],
  composer: [
    /^phpunit\/phpunit$/,
    /^squizlabs\/php_codesniffer$/,
    /^friendsofphp\/php-cs-fixer$/,
    /^phpstan\/phpstan$/,
    /^mockery\/mockery$/,
    /^fakerphp\/faker$/,
    /^nunomaduro\/collision$/,
    /^laravel\/(sail|pint)$/,
    /^barryvdh\/laravel-debugbar$/,
  ],
};

// Ecosystems whose packages are never part of a deployed service's runtime.
const NON_RUNTIME_ECOSYSTEMS = new Set(["githubactions", "actions"]);

// Recover a Maven `group:artifact` coordinate from a purl
// (`pkg:maven/<group>/<artifact>@<version>` → `<group>:<artifact>`).
function mavenCoordinate(purl) {
  const m = /^pkg:maven\/([^@?#]+)/i.exec(purl || "");
  if (!m) return null;
  return m[1].replace("/", ":");
}

function matchesDevRule(ecosystem, name, purl) {
  const rules = DEV_RULES[ecosystem];
  if (!rules) return false;
  // Maven matchers run against the `group:artifact` coordinate; others against
  // the bare package name.
  const subject =
    ecosystem === "maven"
      ? mavenCoordinate(purl) || name || ""
      : name || "";
  return rules.some((re) => re.test(subject));
}

// Classify a single SPDX package. Returns the backfilled version plus a
// CycloneDX `scope` (required → scan it; excluded → out of the runtime attack
// surface) and the human-readable `basis` for the decision.
export function classifyPackage(pkg) {
  const purl = pkg.externalRefs?.find((r) => r.referenceType === "purl")
    ?.referenceLocator;
  const parsed = parsePurl(purl);
  const ecosystem = parsed.type;

  // Prefer SPDX versionInfo; fall back to the version embedded in the purl.
  let version = pkg.versionInfo;
  if (!isResolvedVersion(version) && isResolvedVersion(parsed.version)) {
    version = parsed.version;
  }
  const resolved = isResolvedVersion(version);

  let scope = "required";
  let basis = "runtime";
  if (ecosystem && NON_RUNTIME_ECOSYSTEMS.has(ecosystem)) {
    scope = "excluded";
    basis = "ci-action";
  } else if (matchesDevRule(ecosystem, pkg.name, purl)) {
    scope = "excluded";
    basis = "dev-tooling";
  } else if (!resolved) {
    // Name-only package: cannot be version-matched, so excluding it is what
    // stops the phantom CVE hits — but we record it so the gap stays visible.
    scope = "excluded";
    basis = "unresolved-version";
  }

  return {
    name: pkg.name,
    version: resolved ? version : undefined,
    purl: purl || undefined,
    ecosystem,
    resolved,
    scope,
    basis,
  };
}

// Roll a repo's classified packages into a CycloneDX component carrying the
// scope + auditable properties, alongside per-repo quality counters.
export function classifyRepo(packages) {
  const components = [];
  const counts = {
    packages: 0,
    resolved: 0,
    unresolved: 0,
    runtime: 0,
    excludedDev: 0,
    excludedUnresolved: 0,
    excludedCi: 0,
  };

  for (const pkg of packages) {
    const c = classifyPackage(pkg);
    counts.packages++;
    if (c.resolved) counts.resolved++;
    else counts.unresolved++;
    if (c.scope === "required") counts.runtime++;
    else if (c.basis === "dev-tooling") counts.excludedDev++;
    else if (c.basis === "unresolved-version") counts.excludedUnresolved++;
    else if (c.basis === "ci-action") counts.excludedCi++;

    components.push({
      type: "library",
      name: c.name,
      version: c.version,
      purl: c.purl,
      scope: c.scope,
      properties: [
        { name: "xgov:resolution", value: c.resolved ? "resolved" : "unresolved" },
        { name: "xgov:scope-basis", value: c.basis },
      ],
    });
  }

  return { components, counts };
}

// Sum per-repo counters into an estate-wide total.
export function emptyCounts() {
  return {
    packages: 0,
    resolved: 0,
    unresolved: 0,
    runtime: 0,
    excludedDev: 0,
    excludedUnresolved: 0,
    excludedCi: 0,
  };
}

export function addCounts(total, counts) {
  for (const k of Object.keys(counts)) {
    total[k] = (total[k] || 0) + counts[k];
  }
  return total;
}
