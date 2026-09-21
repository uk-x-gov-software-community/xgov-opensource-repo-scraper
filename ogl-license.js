// ---------- Open Government Licence detection ----------
//
// GitHub identifies licences with the licensee library. licensee has no
// definition for the UK Open Government Licence, so GitHub reports every OGL
// repository as { key: "other", name: "Other", spdxId: "NOASSERTION" }. The
// OGL is the standard licence for UK public sector information, so that gap
// mislabels a large part of the estate this project measures.
//
// This module reads the licence file text for those repositories only and
// recovers the real SPDX identifier: OGL-UK-1.0, OGL-UK-2.0 or OGL-UK-3.0.

// Candidate licence paths at the default branch. Both spellings are needed.
// UK departments use LICENSE and LICENCE in roughly equal measure.
const OGL_FILES = [
  "LICENSE",
  "LICENCE",
  "LICENSE.md",
  "LICENCE.md",
  "LICENSE.txt",
  "LICENCE.txt",
  "COPYING",
];

const OGL_BATCH_SIZE = 20; // repos per GraphQL query (7 blob lookups each)

const OGL_URL_VERSION_RE = /open-government-licence\/version\/(\d)/i;
const OGL_TEXT_VERSION_RE =
  /open[- ]government[- ]licen[cs]e\s*(?:\(ogl\))?[\s,(–-]*(?:version\s*)?v?\.?\s*(\d)/i;
const OGL_VERSIONS = ["1", "2", "3"];
const OGL_BASE_URL =
  "https://www.nationalarchives.gov.uk/doc/open-government-licence";

// Licence texts cross-reference each other, so a plain substring match on
// "Open Government Licence" produces false positives. Two patterns matter:
//   * The Non-Commercial Government Licence names the OGL part way through.
//   * The full OGL text names Creative Commons in its "Further context" note.
// The markers below identify which licence a file names FIRST.
const LICENSE_MARKERS = [
  ["ogl", /open[- ]government[- ]licen[cs]e/i],
  ["ncgl", /non[- ]commercial[- ]government[- ]licen[cs]e/i],
  ["mit", /permission is hereby granted, free of charge|MIT licen[cs]e/i],
  ["apache", /apache licen[cs]e,?\s*version 2/i],
  ["gpl", /gnu (general|lesser|affero) public licen[cs]e/i],
  ["bsd", /redistribution and use in source and binary forms/i],
  ["mpl", /mozilla public licen[cs]e/i],
  ["cc", /creative commons/i],
  [
    "unlicense",
    /this is free and unencumbered software released into the public domain/i,
  ],
];

// Dual-licensed repos put the code under one licence and the documentation
// under the OGL: "all documentation is licensed under the Open Government
// Licence. All code is licensed under the MIT license." The leaderboard
// reports the licence of the code, so this phrasing rejects the repo.
const CODE_SCOPE_RE = /\b(code|software|source)\b/i;
const CODE_SCOPE_WINDOW = 120;

function oglLicense(version) {
  if (!version) {
    return {
      key: "ogl-uk",
      name: "Open Government Licence",
      spdxId: null,
      url: `${OGL_BASE_URL}/`,
    };
  }
  return {
    key: `ogl-uk-${version}.0`,
    name: `Open Government Licence v${version}.0`,
    spdxId: `OGL-UK-${version}.0`,
    url: `${OGL_BASE_URL}/version/${version}/`,
  };
}

/** Returns every licence marker in the text, in the order that they appear. */
function licenseMarkers(text) {
  return LICENSE_MARKERS.map(([id, pattern]) => ({
    id,
    at: text.search(pattern),
  }))
    .filter((marker) => marker.at !== -1)
    .sort((a, b) => a.at - b.at);
}

/** Reads the OGL version from the text. Returns "1", "2", "3" or null. */
function oglVersion(text) {
  const match =
    text.match(OGL_URL_VERSION_RE) || text.match(OGL_TEXT_VERSION_RE);
  return match && OGL_VERSIONS.includes(match[1]) ? match[1] : null;
}

/**
 * Decides whether a repository holds the OGL, from its candidate licence
 * files in path order. The first file that names any licence decides the
 * result. Returns an OGL licence object, or null.
 */
function detectOglLicense(files) {
  for (const text of files) {
    const markers = licenseMarkers(text);
    if (markers.length === 0) continue;
    if (markers[0].id !== "ogl") return null;

    const codeClaim = markers
      .slice(1)
      .some(({ at }) =>
        CODE_SCOPE_RE.test(text.slice(Math.max(0, at - CODE_SCOPE_WINDOW), at))
      );
    if (codeClaim) return null;

    return oglLicense(oglVersion(text));
  }
  return null;
}

export {
  OGL_FILES,
  OGL_BATCH_SIZE,
  LICENSE_MARKERS,
  oglLicense,
  licenseMarkers,
  oglVersion,
  detectOglLicense,
};
