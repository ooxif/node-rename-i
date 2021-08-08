/* eslint-disable @typescript-eslint/no-var-requires */
const { writeFileSync } = require("fs");
const { join } = require("path");

const pkg = require(join(__dirname, "../package.json"));

writeFileSync(
  join(__dirname, "../src/version.ts"),
  `export default "${pkg.version}";\n`,
  { encoding: "utf8" }
);
