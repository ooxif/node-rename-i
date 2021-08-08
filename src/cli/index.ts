#!/usr/bin/env node

import { constants as fsConstants } from "node:fs";
import {
  access,
  mkdtemp,
  rename as fsRename,
  rmdir,
  stat,
} from "node:fs/promises";
import { basename, dirname, isAbsolute, join, normalize } from "node:path";
import { cwd, exit } from "node:process";

import chalk from "chalk";
import { globby } from "globby";
import inquirer from "inquirer";
import type { Question } from "inquirer";
import yargs from "yargs";
import { hideBin } from "yargs/helpers";

import version from "../version.js";

const argv = yargs(hideBin(process.argv))
  .scriptName("rename-i")
  .version(version)
  .usage("Usage: $0 [DIRECTORY]")
  .epilog("Copyright (c) 2021 oo@xif.at")
  .example([
    ["$0", "Run in the current directory"],
    [
      "$0 path/to/dir",
      "Run in the specified directory (relative to the current directory",
    ],
    ["$0 /path/to/dir", "Run in the specified directory"],
  ])
  .help().argv;

enum Type {
  File = "file",
  Directory = "directory",
}

enum Method {
  NDigitsSequence = "n-digits sequence (per directory)",
  Regex = "regex",
}

const error = (message: string): void => {
  console.error(`${chalk.red("ERROR")} ${message}`);
};

class ExitError {
  public message?: string;
  public code: number;

  constructor(message?: string, code = -1) {
    this.message = message;
    this.code = code;
  }
}

const die = (message?: string, code = -1): void => {
  throw new ExitError(message, code);
};

const confirm = async (message: string): Promise<boolean> => {
  const result = await inquirer.prompt([
    {
      default: false,
      message,
      name: "ok",
      type: "confirm",
    },
  ]);

  return result.ok;
};

const input = async (
  message: string,
  longMessage?: string,
  options: Question = {}
): Promise<string | number> => {
  const opts = {
    message:
      longMessage == null
        ? `${message}:`
        : `${message}:\n\n${longMessage}\n\nInput:`,
    name: "value",
    type: "input",
    ...options,
  };

  if (opts?.default === "") {
    delete opts.default;
  }

  do {
    const result = await inquirer.prompt([opts]);
    const { value } = result;

    if (value !== "") {
      return value;
    }

    error(`Input ${message.toLowerCase()}`);
  } while (true); // eslint-disable-line no-constant-condition
};

const checkDirectoryStat = async (path: string): Promise<boolean> => {
  let message: string | null = null;

  try {
    if (!(await stat(path)).isDirectory()) {
      message = `${path} is not a directory`;
    }
  } catch {
    message = `${path} is not found`;
  }

  if (message != null) {
    error(message);

    return false;
  }

  const [readable, writable] = await Promise.all([
    access(path, fsConstants.R_OK)
      .then(() => true)
      .catch(() => false),
    access(path, fsConstants.W_OK)
      .then(() => true)
      .catch(() => false),
  ]);

  if (!readable) {
    message = writable
      ? `${path} is not readable`
      : `${path} is not readable/writable`;
  } else if (!writable) {
    message = `${path} is not writable`;
  }

  if (message != null) {
    error(message);

    return false;
  }

  return true;
};

const resolveBaseDirectory = async (
  cwd: string,
  dir?: string
): Promise<string> => {
  let target: string;

  if (dir != null && dir !== "") {
    target = isAbsolute(dir) ? dir : normalize(join(cwd, dir));
  } else {
    target = cwd;
  }

  if (!(await checkDirectoryStat(target))) {
    die();
  }

  console.log(`Running in ${target}`);

  return target;
};

const promptType = async (): Promise<Type> => {
  const result = await inquirer.prompt([
    {
      choices: [Type.File, Type.Directory],
      default: Type.File,
      message: "Target type:",
      name: "type",
      type: "list",
    },
  ]);

  return result.type;
};

const glob = async (
  targetDir: string,
  type: Type,
  pattern: string
): Promise<string[]> => {
  const opts = {
    cwd: targetDir,
    dot: true,
    followSymbolicLinks: false,
    onlyDirectories: type === Type.Directory,
    onlyFiles: type === Type.File,
  };

  const paths =
    type === Type.Directory
      ? await globby(pattern, { ...opts, deep: 1, onlyDirectories: true })
      : await globby(pattern, { ...opts, onlyFiles: true });

  // natural sort
  const collator = new Intl.Collator(undefined, {
    numeric: true,
    sensitivity: "base",
  });
  paths.sort(collator.compare);

  return paths;
};

const promptPaths = async (
  targetDir: string,
  type: Type
): Promise<string[]> => {
  let pattern: string | null = null;

  do {
    pattern = (await input(
      "Glob pattern",
      `
          *: Matches everything except slashes (path separators).
          **: Matches zero or more directories.
          ?: Matches any single character except slashes (path separators).
          [seq]: Matches any character in sequence.
          \\: Matching special characters ($^*+?()[]) as literals.
          [[:digit:]]: POSIX character classes.
          ?(pattern-list): Matches zero or one occurrence of the given patterns.
          *(pattern-list): Matches zero or more occurrences of the given patterns.
          *(pattern-list): Matches one or more occurrences of the given patterns.
          @(pattern-list): Matches one of the given patterns
          !(pattern-list): Matches anything except one of the given patterns.
          {}: Bash style brace expansions.
          [1-5]: Regexp character classes.
          (a|b): Regex groups.
        `
        .replaceAll(/\n +/g, "\n")
        .trim(),
      {
        default: pattern,
      }
    )) as string;

    const paths = await glob(targetDir, type, pattern);

    if (!paths.length) {
      error(`${pattern} does not match`);

      continue;
    }

    paths.forEach((path) => {
      console.log(path);
    });

    if (await confirm("OK?")) {
      return paths;
    }
  } while (true); // eslint-disable-line no-constant-condition
};

const promptMethod = async (): Promise<Method> => {
  const result = await inquirer.prompt([
    {
      choices: [Method.NDigitsSequence, Method.Regex],
      default: Method.NDigitsSequence,
      message: "Method:",
      name: "method",
      type: "list",
    },
  ]);

  return result.method;
};

interface Rename {
  from: string;
  to: string;
}

const promptRenameRule = async (
  paths: string[],
  method: Method
): Promise<Rename[]> => {
  let pattern = method === Method.NDigitsSequence ? ".*" : "";
  let replacement = "";
  let start = 1;
  let width = 0;

  do {
    pattern = (await input(
      "Regex pattern",
      "The pattern will apply to the base name of the path",
      { default: pattern }
    )) as string;

    try {
      new RegExp(pattern);
    } catch (e) {
      error(e.message);

      continue;
    }

    const caseSensitive = await confirm("Case sensitive?");
    const regexp = caseSensitive
      ? new RegExp(pattern, "i")
      : new RegExp(pattern);

    const matches = paths.filter((path) => regexp.test(basename(path)));

    if (!matches.length) {
      error("The pattern does not match any paths");

      continue;
    }

    matches.forEach((path) => {
      console.log(path);
    });

    if (!(await confirm("OK?"))) {
      continue;
    }

    let renames: Rename[];

    if (method === Method.NDigitsSequence) {
      start = (await input(
        "Start",
        "a number that the sequence starts with. Basically 0 or 1.",
        {
          default: start,
          type: "number",
          validate: (input) =>
            input < 0 ? "Start must be greater than 0" : true,
        }
      )) as number;

      width = (await input(
        "Zerofill width",
        "The zero-filled width of the sequence. `0` means `auto`, `1` means disable zerofill",
        {
          default: width,
          type: "number",
          validate: (input) =>
            input < 0 ? "Zerofill width must be greater than 0" : true,
        }
      )) as number;

      renames = Array.from(
        matches
          .reduce((map, path) => {
            const dir = dirname(path);

            if (map.has(dir)) {
              map.get(dir)?.push(path);
            } else {
              map.set(dir, [path]);
            }

            return map;
          }, new Map<string, string[]>())
          .entries()
      )
        .map(([, items]) => {
          const zerofill = width ? width : String(items.length).length;

          return items.map((path, i) => {
            const b = basename(path);
            const idx = b.indexOf(".");
            const seq = String(i + start).padStart(zerofill, "0");

            return {
              from: path,
              to: join(
                dirname(path),
                idx >= 0 ? `${seq}${b.substring(idx)}` : seq
              ),
            };
          });
        })
        .flat();
    } else {
      replacement = (await input(
        "Replacement",
        `
          $$: Inserts a "$".
          $&: Inserts the matched substring.
          $\`: Inserts the portion of the string that precedes the matched substring.
          $': Inserts the portion of the string that follows the matched substring.
          $n: Where n is a positive integer less than 100, inserts the nth parenthesized submatch string, provided the first argument was a RegExp object. Note that this is 1-indexed. If a group n is not present (e.g., if group is 3), it will be replaced as a literal (e.g., $3).
        `
          .replaceAll(/\n +/g, "\n")
          .trim(),
        { default: replacement }
      )) as string;

      renames = matches.map((path) => ({
        from: path,
        to: join(dirname(path), basename(path).replace(regexp, replacement)),
      }));
    }

    const conflicts = new Map<string, string>();
    const toBeRenamed = new Set<string>();
    let hasConflict = false;

    renames.forEach((rename) => {
      const lowerNewPath = rename.to.toLowerCase();

      if (conflicts.has(lowerNewPath)) {
        hasConflict = true;
        error(
          `Conflict: ${conflicts.get(lowerNewPath)} vs ${rename.from} to ${
            rename.to
          }`
        );

        return;
      }

      conflicts.set(lowerNewPath, rename.from);
      toBeRenamed.add(rename.from.toLowerCase());
    });

    if (hasConflict) {
      continue;
    }

    const overrides: Rename[] = (
      await Promise.all(
        renames.map(async (rename): Promise<Rename | null> => {
          if (toBeRenamed.has(rename.to.toLowerCase())) {
            return null;
          }

          try {
            await access(rename.to, fsConstants.R_OK);

            return rename;
          } catch {
            return null;
          }
        })
      )
    ).filter((rename) => rename) as Rename[];

    if (overrides.length) {
      overrides.forEach((rename) => {
        error(`Override: ${rename.from} => ${basename(rename.to)}`);
      });

      continue;
    }

    renames.forEach((rename) => {
      console.log(`${rename.from} => ${basename(rename.to)}`);
    });

    if (await confirm("OK?")) {
      return renames;
    }
  } while (true); // eslint-disable-line no-constant-condition
};

const renameAll = async (renames: Rename[]): Promise<void> => {
  const dirs = new Map<string, Rename[]>();

  renames.forEach((rename) => {
    const dir = dirname(rename.from).toLowerCase();

    if (dirs.has(dir)) {
      dirs.get(dir)?.push(rename);
    } else {
      dirs.set(dir, [rename]);
    }
  });

  await Promise.allSettled(
    Array.from(dirs.entries()).map(async ([dir, dirRenames]): Promise<void> => {
      let tmpDir: string;

      try {
        tmpDir = await mkdtemp(join(dir, "rename-i-"));
      } catch (e) {
        error(`Failed to mkdtemp in ${dir}: ${e.message}`);

        return;
      }

      const tmpRenames: Rename[] = [];

      await Promise.allSettled(
        dirRenames.map(async (rename) => {
          const tmpPath = join(tmpDir, basename(rename.to));

          try {
            await fsRename(rename.from, tmpPath);
            tmpRenames.push({ from: tmpPath, to: rename.to });
          } catch (e) {
            error(
              `Failed to tmp-rename ${rename.from} to ${tmpPath}: ${e.message}`
            );
          }
        })
      );

      let rmDir = true;

      if (tmpRenames.length) {
        await Promise.allSettled(
          tmpRenames.map(async (rename) => {
            try {
              await fsRename(rename.from, rename.to);
            } catch (e) {
              rmDir = false;
              error(
                `Failed to rename ${rename.from} to ${rename.to}: ${e.message}`
              );
            }
          })
        );
      }

      if (rmDir && tmpDir != null) {
        try {
          await rmdir(tmpDir);
        } catch (e) {
          error(`Failed to rmdir: ${tmpDir}`);
        }
      }
    })
  );
};

interface Args {
  directory?: string;
}

const parseArgs = async (): Promise<Args> => {
  const args = await argv;
  if (!args._?.length) {
    return {};
  }

  if (args._.length > 1) {
    die("DIRECTORY argument does not take 2 or more directories");
  }

  return {
    directory: String(args._[0]),
  };
};

(async (): Promise<void> => {
  const args = await parseArgs();
  const CWD = cwd();
  const targetDir = await resolveBaseDirectory(CWD, args.directory);
  const type = await promptType();
  const paths = await promptPaths(targetDir, type);
  const method = await promptMethod();
  const renames = await promptRenameRule(paths, method);
  await renameAll(renames);
})().catch((e) => {
  if (e instanceof ExitError) {
    if (e.message != null) {
      error(e.message);
    }

    exit(e.code);
  }

  throw e;
});
