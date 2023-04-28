"use strict";

import yaml from "js-yaml";
import Octokat from "octokat";
import { Octokit } from "@octokit/core";
import Promise from "bluebird";
import { writeFileSync } from "fs";

const octokit = new Octokit({
  auth: process.env.GITHUB_TOKEN,
});

const octo = new Octokat({
  token: process.env.GITHUB_TOKEN,
});

const formatResult = (result) => {
  return {
    owner: result.owner.login,
    name: result.name,
    url: result.html.url,
    archived: result.archived,
    license: result.license,
    stargazersCount: result.stargazersCount,
    // watchersCount: result.watchersCount, // github api appears to be returning the same as the stargazersCount?!
    language: result.language,
    forksCount: result.forksCount,
    openIssuesCount: result.openIssuesCount,
  };
};

const fetchAll = async (org, args) => {
  let response = await octo
    .orgs(org)
    .repos.fetch({ per_page: process.env.NODE_ENV === "dev" ? 10 : 100 });
  let aggregate = [response];

  console.log(`fetched page 1 for ${org}`);
  let i = 1;
  await Promise.delay(50); //slow down to appease github rate limiting
  while (response.nextPage && process.env.NODE_ENV !== "dev") {
    i++;
    response = await response.nextPage();
    console.log(`fetched page ${i} for ${org}`);
    await Promise.delay(50); //slow down to appease github rate limiting
    aggregate.push(response);
  }
  return aggregate;
};

const allDepartments = yaml.safeLoad(
  await (
    await fetch(
      "https://raw.githubusercontent.com/github/government.github.com/gh-pages/_data/governments.yml"
    )
  ).text()
);

const UKDepartments =
  process.env.NODE_ENV === "dev"
    ? ["ukhomeoffice"]
    : [].concat(
        allDepartments["U.K. Councils"],
        allDepartments["U.K. Central"]
      );

const allReposForAllUKDepartments = await Promise.mapSeries(
  UKDepartments,
  fetchAll
);

const fetchAllSboms = async (repo) => {
  await Promise.delay(1700); //slow down to appease github rate limiting
  console.log(`Collecting SBOM for ${repo.owner.login}/${repo.name}`);
  try {
    return (
      await octokit.request("GET /repos/{owner}/{repo}/dependency-graph/sbom", {
        owner: repo.owner.login,
        repo: repo.name,
        headers: {
          "X-GitHub-Api-Version": "2022-11-28",
        },
      })
    ).data.sbom;
  } catch (e) {
    if (e.status != 404) {
      throw e;
    }
  }
};

const formatSboms = (sbom) => {
  return {
    name: sbom.name,
    packages: sbom?.packages?.map((pkg) => {
      return `${pkg.name}@${pkg.versionInfo}`;
    }),
  };
};

const formattedResults = allReposForAllUKDepartments.flat(2).map(formatResult);

const allSbomsForAllUKDepartments = await Promise.mapSeries(
  allReposForAllUKDepartments.flat(2),
  fetchAllSboms
);
const formattedSboms = allSbomsForAllUKDepartments
  .filter((sbom) => sbom?.name)
  .map(formatSboms);

console.log("writing results to file");

writeFileSync("./public/repos.json", JSON.stringify(formattedResults));
writeFileSync("./public/sboms.json", JSON.stringify(formattedSboms));
console.log("done");
