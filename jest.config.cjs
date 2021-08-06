module.exports = {
  preset: "ts-jest",
  testEnvironment: "node",
  // "**/" due to a bug.
  // @see https://github.com/facebook/jest/issues/7108
  testMatch: ["**/test/**/*.test.ts"],
};
