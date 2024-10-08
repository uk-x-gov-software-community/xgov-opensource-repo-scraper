"use strict";

import yaml from "js-yaml";
import { Octokit } from "@octokit/core";

import Octokat from "octokat";
import Promise from "bluebird";
import { writeFileSync } from "fs";
import { Command } from "commander";

const octo = new Octokat({
  token: process.env.GITHUB_TOKEN,
});

const octokit = new Octokit({
  auth: process.env.GITHUB_TOKEN,
});

const program = new Command();

async function getOrgs() {
  const allDepartments = yaml.safeLoad(
    await (
      await fetch(
        "https://raw.githubusercontent.com/github/government.github.com/gh-pages/_data/governments.yml"
      )
    ).text()
  );
  return [].concat(
    allDepartments["U.K. Councils"],
    allDepartments["U.K. Central"]
  );
}

const slowDownDelay = 50;

async function outputIt(data, outputFile) {
  if (outputFile) {
    writeFileSync(outputFile, JSON.stringify(await data, null, 2));
  } else {
    process.stdout.write(JSON.stringify(await data, null, 2));
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
  .option("-s, --sbom <outputfile>", "Save sboms to a file")
  .description(
    "Get consolodated data for all UK Government departments and agencies"
  )
  .action(async (options) => {
    const orgs = await getOrgs();
    let allRepos = [];
    for (const org of orgs) {
      const repos = await getRepos(org);
      allRepos = allRepos.concat(repos);
    }
    if (options.sbom) {
      const sboms = [];
      for (const repo of allRepos) {
        const sbom = await getSbom(repo);
        if (sbom) sboms.push(sbom);
      }
      outputIt(sboms, options.sbom);
    }
    return outputIt(allRepos, options.write);
  });

function formatRepoResult(result) {
  return {
    owner: result.owner.login,
    name: result.name,
    url: result.html.url,
    archived: result.archived,
    license: result.license,
    stargazersCount: result.stargazersCount,
    language: result.language,
    forksCount: result.forksCount,
    openIssuesCount: result.openIssuesCount,
  };
}

const getSbom = async (repo) => {
  await Promise.delay(slowDownDelay); //slow down to appease github rate limiting
  console.log(`Collecting SBOM for ${repo.owner}/${repo.name}`);
  let attempts = 0;
  while (attempts < 3) {
    try {
      return (
        await octokit.request(
          "GET /repos/{owner}/{repo}/dependency-graph/sbom",
          {
            owner: repo.owner,
            repo: repo.name,
            headers: {
              "X-GitHub-Api-Version": "2022-11-28",
            },
          }
        )
      ).data.sbom;
    } catch (e) {
      if (e.status === 404) {
        console.log(`No SBOM for ${repo.owner}/${repo.name}`);
        return null;
      }
      attempts++;
      if (attempts === 3) {
        console.error(
          `Failed to fetch SBOM for ${repo.owner}/${repo.name} after 3 attempts`
        );
        throw e;
      }
      console.log(`Attempt ${attempts} failed, retrying...`);
      await Promise.delay(slowDownDelay * 2); // Increase delay between retries
    }
  }
};

async function fetchAll(org) {
  let aggregate = [];
  try {
    let response = await octo.orgs(org).repos.fetch({ per_page: 100 });
    aggregate = [response];

    console.log(`fetched page 1 for ${org}`);
    let i = 1;
    await Promise.delay(slowDownDelay);
    while (response.nextPage) {
      i++;
      response = await response.nextPage();
      console.log(`fetched page ${i} for ${org}`);
      await Promise.delay(slowDownDelay);
      aggregate.push(response);
    }
  } catch (error) {
    if (error.status === 404) console.log(`${org} has no repos`);
    else throw error;
  }
  return aggregate;
}

async function getRepos(org) {
  return (await fetchAll(org))
    .flat()
    .filter((repo) => repo.visibility === "public")
    .map(formatRepoResult);
}

program
  .command("get-sbom")
  .argument("<org>", "The GitHub organisation")
  .argument("<repo>", "The repository")
  .option("-w, --write <outputfile>", "Save output to a file")
  .description("Get the SBOM for a repo")
  .action(async (org, repo, options) =>
    outputIt(await getSbom({ owner: org, name: repo }), options.sbom)
  );

program.parse();
