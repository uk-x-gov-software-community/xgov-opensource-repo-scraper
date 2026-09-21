import test from "node:test";
import assert from "node:assert/strict";
import { detectOglLicense, oglVersion } from "../ogl-license.js";

const OGL_V3_HEAD = `Open Government License v3
--------------------------

https://www.nationalarchives.gov.uk/doc/open-government-licence/version/3/

You are encouraged to use and re-use the Information that is available under
this licence freely and flexibly, with only a few conditions.

The Licensor grants you a worldwide, royalty-free, perpetual, non-exclusive
licence to use the Information subject to the conditions below.`;

const OGL_V3_TAIL = `

Further context

This licence is Open Definition compliant and is compatible with the Creative
Commons Attribution License 4.0 and the Open Data Commons Attribution License.`;

const MIT = `MIT License

Copyright (c) 2020 Crown Copyright

Permission is hereby granted, free of charge, to any person obtaining a copy
of this software and associated documentation files (the "Software"), to deal
in the Software without restriction.`;

test("identifies the OGL version 3", () => {
  const license = detectOglLicense([OGL_V3_HEAD]);
  assert.equal(license.spdxId, "OGL-UK-3.0");
  assert.equal(license.key, "ogl-uk-3.0");
  assert.equal(license.name, "Open Government Licence v3.0");
  assert.match(license.url, /\/open-government-licence\/version\/3\/$/);
});

test("accepts the full OGL text that names Creative Commons at the end", () => {
  const license = detectOglLicense([OGL_V3_HEAD + OGL_V3_TAIL]);
  assert.equal(license.spdxId, "OGL-UK-3.0");
});

test("identifies an older OGL version", () => {
  const license = detectOglLicense([
    "This software is licensed under the Open Government Licence v2.0.",
  ]);
  assert.equal(license.spdxId, "OGL-UK-2.0");
});

test("reads the version from the National Archives URL", () => {
  const license = detectOglLicense([
    "This code is released under the [Open Government Licence]" +
      "(http://www.nationalarchives.gov.uk/doc/open-government-licence/version/1/).",
  ]);
  assert.equal(license.spdxId, "OGL-UK-1.0");
});

test("reads a version that a hyphen separates", () => {
  assert.equal(oglVersion("licensed under the Open Government License - version 3"), "3");
});

test("returns the generic licence when the text gives no version", () => {
  const license = detectOglLicense([
    "This work is licensed under the Open Government Licence.",
  ]);
  assert.equal(license.key, "ogl-uk");
  assert.equal(license.spdxId, null);
});

test("accepts the American spelling", () => {
  assert.equal(
    detectOglLicense(["Licensed under the Open Government License v3."]).spdxId,
    "OGL-UK-3.0"
  );
});

test("rejects the Non-Commercial Government Licence", () => {
  const ncgl = `http://www.nationalarchives.gov.uk/doc/non-commercial-government-licence/version/2/

Non-Commercial Government Licence for public sector information

This licence does not cover Information that is available under the Open
Government Licence.`;
  assert.equal(detectOglLicense([ncgl]), null);
});

test("rejects a repo whose code is under another licence", () => {
  const dual = `# License

Copyright 2016 NERC BAS.

Unless stated otherwise, all documentation is licensed under the Open
Government License - version 3. All code is licensed under the MIT license.`;
  assert.equal(detectOglLicense([dual]), null);
});

test("accepts an OGL note that explains a Creative Commons source", () => {
  const note = `[Open Government licence][ogl-licence-3.0]

Copyright (c) 2024 Crown Copyright NHS England

> The content of this repo has been adapted from a fork of another project
> available under a Creative Commons licence.

[ogl-licence-3.0]: https://www.nationalarchives.gov.uk/doc/open-government-licence/version/3/`;
  assert.equal(detectOglLicense([note]).spdxId, "OGL-UK-3.0");
});

test("rejects a licence file that is not an OGL", () => {
  assert.equal(detectOglLicense([MIT]), null);
});

test("the first licence file decides the result", () => {
  assert.equal(detectOglLicense([MIT, OGL_V3_HEAD]), null);
  assert.equal(detectOglLicense([OGL_V3_HEAD, MIT]).spdxId, "OGL-UK-3.0");
});

test("skips a file that names no licence", () => {
  const license = detectOglLicense(["Copyright 2024 Crown Copyright", OGL_V3_HEAD]);
  assert.equal(license.spdxId, "OGL-UK-3.0");
});

test("returns null when there is no licence file", () => {
  assert.equal(detectOglLicense([]), null);
});
