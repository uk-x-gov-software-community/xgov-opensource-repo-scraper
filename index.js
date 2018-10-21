"use strict"
const _ = require('lodash')
const yaml = require('js-yaml')
const request = require('request-promise')
const Octokat = require('octokat')

const octo = new Octokat({
  token: process.env.GITHUB_TOKEN,
  // acceptHeader: "application/vnd.github.black-panther-preview+json" // Header for using Community Profile Preview API
})

const formatResult = result => {
  return {
    owner: result.owner.login,
    name: result.name,
    url: result.html.url,
    archived: result.archived,
    license: result.license ? result.license.name : null,
    stargazersCount: result.stargazersCount,
    watchersCount: result.watchersCount,
    language: result.language,
    forksCount: result.forksCount,
    archived: result.archived,
    openIssuesCount: result.openIssuesCount,
  }
}

const pushResultsToGithub = (results) => {
  if (!process.env.GITHUB_REPO) {
    // if no repo specified just output the results
    console.log(JSON.stringify(results))
    return
  }
  let repo = octo.repos(process.env.GITHUB_ORG, process.env.GITHUB_REPO)
  return repo.contents("repos.json").fetch({ ref: "gh-pages" })
    .catch(error => {
      console.log(repos)
      return false
    })
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
  let aggregate = response

  while (response.nextPage) {
    console.log(`fetched a page for ${org}`)
    response = await response.nextPage()
    aggregate = _.concat(response)
  }
  return aggregate
}



request('https://raw.githubusercontent.com/github/government.github.com/gh-pages/_data/governments.yml')
  .then(yaml.safeLoad)
  .then(fullList => _.concat(fullList['U.K. Councils'], fullList['U.K. Councils'], fullList['U.K. Central']))
  .map(org => fetchAll(org))
  .then(_.flatten)
  .map(formatResult)
  .then(pushResultsToGithub)
