"use strict"
const _ = require('lodash')
const yaml = require('js-yaml')
const request = require('request-promise')
const Octokat = require('octokat')

const octo = new Octokat({
  token: process.env.GITHUB_TOKEN,
})

const formatResult = result => {
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
  }
}

const pushResultsToGithub = (results) => {
  console.log(`count: ${results.length}`)
  if (!process.env.GITHUB_REPO) {
    // if no repo specified just output the results
    console.log(JSON.stringify(results))
    return
  }
  let repo = octo.repos(process.env.GITHUB_ORG, process.env.GITHUB_REPO)
  return repo.contents("").fetch({ ref: "gh-pages" })
    .then(tree => tree.filter(file => file.name === "repos.json")[0])
    .then(file => file.sha || null)
    .then(sha => repo.contents('repos.json').add({
      message: 'Updating repos.json',
      content: new Buffer(JSON.stringify(results)).toString("base64"),
      branch: 'gh-pages',
      sha: sha
    })
    )
}

const fetchAll = async (org, args) => {
  let response = await octo.orgs(org).repos.fetch({ per_page: 100 })
  let aggregate = [response]

  while (response.nextPage) {
    console.log(`fetched a page for ${org}`)
    response = await response.nextPage()
    aggregate.push(response)
  }
  return aggregate
}

request('https://raw.githubusercontent.com/github/government.github.com/gh-pages/_data/governments.yml')
  .then(yaml.safeLoad)
  // .then(() => ["ukhomeoffice"])
  .then(fullList => _.concat(fullList['U.K. Councils'], fullList['U.K. Councils'], fullList['U.K. Central']))
  .map(fetchAll)
  .then(_.flattenDeep)
  .map(formatResult)
  .then(pushResultsToGithub)
