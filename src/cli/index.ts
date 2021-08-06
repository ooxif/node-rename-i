#!/usr/bin/env node

/* tslint:disable no-implicit-dependencies */
import { constants as fsConstants } from "node:fs";
import {
  access,
  mkdtemp,
  rename as fsRename,
  rmdir,
  stat,
} from "node:fs/promises";
import { basename, dirname, join } from "node:path";
import { cwd, exit } from "node:process";
/* tslint:enable no-implicit-dependencies */

import chalk from "chalk";
import { globby } from "globby";
import inquirer from "inquirer";
import fuzzyPath from "inquirer-fuzzy-path";

enum Type {
  File = "file",
  Directory = "directory",
}

inquirer.registerPrompt("fuzzypath", fuzzyPath);

const error = (message: string): void => {
  // tslint:disable-next-line no-console
  console.error(`${chalk.red("ERROR")} ${message}`);
};

class ExitError {
  public message?: string;
  public code: number;

  constructor(message?: string, code: number = -1) {
    this.message = message;
    this.code = code;
  }
}

const promptTargetDir = async (baseDir: string): Promise<string> => {
  let targetDir: string;

  do {
    const result = await inquirer.prompt([
      {
        default: baseDir,
        itemType: "directory",
        message: "Target directory:",
        name: "path",
        rootPath: baseDir,
        suggestOnly: true,
        type: "fuzzypath",
      },
    ]);

    targetDir = result.path;

    if (targetDir === "") {
      error("Specify directory");

      continue;
    }

    try {
      await access(targetDir, fsConstants.R_OK);

      if ((await stat(targetDir)).isDirectory()) {
        break;
      }

      error(`${targetDir} is not a directory`);
    } catch {
      error(`Cannot access to ${targetDir}`);
    }
  } while (true);

  return targetDir;
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

  paths.sort();

  return paths;
};

const confirm = async (message: string): Promise<boolean> => {
  const result = await inquirer.prompt([
    {
      message,
      name: "ok",
      type: "confirm",
    },
  ]);

  return result.ok;
};

const input = async (
  message: string,
  longMessage?: string
): Promise<string> => {
  do {
    const result = await inquirer.prompt([
      {
        message:
          longMessage == null
            ? `${message}:`
            : `${message}:\n\n${longMessage}\n\nInput:`,
        name: "tmp",
        type: "input",
      },
    ]);

    const value = result.tmp;

    if (value !== "") {
      return value;
    }

    error(`Input ${message.toLowerCase()}`);
  } while (true);
};

const promptPaths = async (
  targetDir: string,
  type: Type
): Promise<string[]> => {
  let pattern: string;

  do {
    pattern = await input("Glob pattern");

    const paths = await glob(targetDir, type, pattern);

    if (!paths.length) {
      error(`${pattern} does not match`);

      continue;
    }

    paths.forEach((path) => {
      // tslint:disable-next-line no-console
      console.log(path);
    });

    if (await confirm("OK?")) {
      return paths;
    }
  } while (true);
};

interface IRename {
  from: string;
  to: string;
}

const promptRenameRule = async (paths: string[]): Promise<IRename[]> => {
  do {
    const pattern = await input(
      "Regex pattern",
      "The pattern will apply to the base name of the path"
    );

    try {
      // tslint:disable-next-line no-unused-expression
      new RegExp(pattern);
    } catch (e) {
      error(e.message);

      continue;
    }

    const caseSensitive = await confirm("Case sensitive?");
    const regexp = caseSensitive
      ? new RegExp(pattern, "i")
      : new RegExp(pattern);

    const exists = paths.some((path) => regexp.test(basename(path)));

    if (!exists) {
      error("The pattern does not match any paths");

      continue;
    }

    const replacement = await input(
      "Replacement",
      `
          $$: Inserts a "$".
          $&: Inserts the matched substring.
          $\`: Inserts the portion of the string that precedes the matched substring.
          $': Inserts the portion of the string that follows the matched substring.
          $n: Where n is a positive integer less than 100, inserts the nth parenthesized submatch string, provided the first argument was a RegExp object. Note that this is 1-indexed. If a group n is not present (e.g., if group is 3), it will be replaced as a literal (e.g., $3).
        `
        .replaceAll(/\n +/g, "\n")
        .trim()
    );

    const renames: IRename[] = paths.map((path) => ({
      from: path,
      to: join(dirname(path), basename(path).replace(regexp, replacement)),
    }));

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

    const overrides: IRename[] = (
      await Promise.all(
        renames.map(async (rename): Promise<IRename | null> => {
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
    ).filter((rename) => rename) as IRename[];

    if (overrides.length) {
      overrides.forEach((rename) => {
        error(`Override: ${rename.from} => ${basename(rename.to)}`);
      });

      continue;
    }

    renames.forEach((rename) => {
      // tslint:disable-next-line no-console
      console.log(`${rename.from} => ${basename(rename.to)}`);
    });

    if (await confirm("OK?")) {
      return renames;
    }
  } while (true);
};

const renameAll = async (renames: IRename[]): Promise<void> => {
  const dirs = new Map<string, IRename[]>();

  renames.forEach((rename) => {
    const dir = dirname(rename.from).toLowerCase();

    if (dirs.has(dir)) {
      dirs.get(dir)!.push(rename);
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

      const tmpRenames: IRename[] = [];

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

      if (rmDir) {
        try {
          await rmdir(tmpDir!);
        } catch (e) {
          error(`Failed to rmdir: ${tmpDir}`);
        }
      }
    })
  );
};

(async (): Promise<void> => {
  const CWD = cwd();
  const targetDir = await promptTargetDir(CWD);
  const type = await promptType();
  const paths = await promptPaths(targetDir, type);
  const renames = await promptRenameRule(paths);
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
