"use strict";

import yaml from "js-yaml";
import Octokat from "octokat";
import Promise from "bluebird";
import { writeFileSync } from "fs";
import { Command } from "commander";

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

const octo = new Octokat({
  token: process.env.GITHUB_TOKEN,
});

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
  .description(
    "Get consolodated data for all UK Government departments and agencies"
  )
  .action(async (options) =>
    outputIt(
      (await Promise.all(await getOrgs()).map(await getRepos)).flat(),
      options.write
    )
  );

program.parse();

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

async function fetchAll(org) {
  let aggregate = [];
  try {
    let response = await octo.orgs(org).repos.fetch({ per_page: 100 });
    aggregate = [response];

    console.log(`fetched page 1 for ${org}`);
    let i = 1;
    await Promise.delay(50);
    while (response.nextPage) {
      i++;
      response = await response.nextPage();
      console.log(`fetched page ${i} for ${org}`);
      await Promise.delay(50);
      aggregate.push(response);
    }
  } catch (error) {
    console.error(error);
  }
  return aggregate;
}

async function getRepos(org) {
  return (await fetchAll(org)).flat().map(formatRepoResult);
}
