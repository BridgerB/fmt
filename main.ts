/**
 * Multi-language parallel code formatter
 * Formats code using appropriate tools: Deno, Alejandra (Nix), Go, PostgreSQL, and Rust formatters
 */

import { globToRegExp } from "jsr:@std/path@^1/glob-to-regexp";

/** Ignore pattern (parsed from .fmtignore) */
interface IgnorePattern {
  pattern: string;
  regex: RegExp;
  negated: boolean;
}

/** CLI arguments */
interface Args {
  check: boolean;
  help: boolean;
}

/**
 * Parse CLI arguments
 */
function parseArgs(args: string[]): Args {
  return {
    check: args.includes("--check") || args.includes("-c"),
    help: args.includes("--help") || args.includes("-h"),
  };
}

/**
 * Show help message
 */
function showHelp(): void {
  console.log(`
fmt - Multi-language parallel code formatter

USAGE:
    fmt [OPTIONS]

OPTIONS:
    --check, -c    Check if files are formatted without modifying them
    --help, -h     Show this help message

SUPPORTED LANGUAGES:
    • JavaScript, TypeScript, JSON, Markdown, CSS, HTML, YAML (via deno fmt)
    • Nix (via alejandra)
    • Go (via goimports/gofmt)
    • SQL (via pg_format)
    • Rust (via rustfmt)

CONFIGURATION:
    fmt automatically respects .gitignore patterns. Files ignored by git
    will not be formatted. Git submodules are also automatically skipped.

    The .gitignore file is searched for starting from the current directory
    and walking up the directory tree.

EXAMPLES:
    fmt              Format all files in current directory
    fmt --check      Check formatting without modifying files (useful for CI)
`);
}

/**
 * Finds git submodule paths by parsing .gitmodules
 */
async function findSubmodulePaths(rootDir: string): Promise<string[]> {
  const gitmodulesPath = `${rootDir}/.gitmodules`;
  try {
    const content = await Deno.readTextFile(gitmodulesPath);
    const paths: string[] = [];

    // Parse .gitmodules for path = entries
    for (const line of content.split("\n")) {
      const match = line.match(/^\s*path\s*=\s*(.+?)\s*$/);
      if (match) {
        paths.push(match[1]);
      }
    }

    return paths;
  } catch {
    // No .gitmodules or can't read it
    return [];
  }
}

/**
 * Searches up the directory tree for .gitignore
 * Returns the path to the file and the directory it's in (project root)
 */
async function findGitignore(
  startDir: string,
): Promise<{ filePath: string; rootDir: string } | null> {
  let currentDir = startDir;

  while (true) {
    const filePath = `${currentDir}/.gitignore`;
    try {
      await Deno.stat(filePath);
      return { filePath, rootDir: currentDir };
    } catch {
      // Not found, go up
    }

    const parentDir = currentDir.substring(0, currentDir.lastIndexOf("/"));
    if (parentDir === "" || parentDir === currentDir) {
      // Reached root
      return null;
    }
    currentDir = parentDir;
  }
}

/**
 * Parses a .fmtignore file and returns ignore patterns
 */
function parseIgnorePatterns(content: string): IgnorePattern[] {
  const patterns: IgnorePattern[] = [];

  for (const line of content.split("\n")) {
    const trimmed = line.trim();

    // Skip empty lines and comments
    if (trimmed === "" || trimmed.startsWith("#")) {
      continue;
    }

    const negated = trimmed.startsWith("!");
    const pattern = negated ? trimmed.slice(1) : trimmed;

    // Convert gitignore-style pattern to regex
    // If pattern doesn't start with /, it can match anywhere
    // If pattern ends with /, it only matches directories
    let globPattern = pattern;

    // If pattern doesn't contain /, it matches anywhere in the tree
    if (!pattern.includes("/")) {
      globPattern = `**/${pattern}`;
    } else if (pattern.startsWith("/")) {
      // Leading slash means relative to root
      globPattern = pattern.slice(1);
    }

    // If pattern ends with /, match directory and everything under it
    if (globPattern.endsWith("/")) {
      globPattern = `${globPattern}**`;
    }

    try {
      const regex = globToRegExp(globPattern);
      patterns.push({ pattern: trimmed, regex, negated });
    } catch {
      console.warn(`Warning: invalid ignore pattern: ${trimmed}`);
    }
  }

  return patterns;
}

/**
 * Loads ignore patterns from .gitignore and adds submodule paths
 */
async function loadIgnorePatterns(startDir: string): Promise<{
  patterns: IgnorePattern[];
  rootDir: string;
  submodules: string[];
}> {
  const result = await findGitignore(startDir);
  const rootDir = result?.rootDir ?? startDir;

  // Find submodules
  const submodules = await findSubmodulePaths(rootDir);

  let patterns: IgnorePattern[] = [];

  // Add submodule paths as ignore patterns
  for (const submodule of submodules) {
    const globPattern = `${submodule}/**`;
    try {
      const regex = globToRegExp(globPattern);
      patterns.push({ pattern: submodule, regex, negated: false });
    } catch {
      console.warn(`Warning: invalid submodule path: ${submodule}`);
    }
  }

  if (!result) {
    return { patterns, rootDir, submodules };
  }

  try {
    const content = await Deno.readTextFile(result.filePath);
    const gitignorePatterns = parseIgnorePatterns(content);
    patterns = patterns.concat(gitignorePatterns);
    return { patterns, rootDir: result.rootDir, submodules };
  } catch (error) {
    console.warn(`Warning: failed to read .gitignore: ${error}`);
    return { patterns, rootDir, submodules };
  }
}

/**
 * Checks if a file path should be ignored based on patterns
 * @param relativePath Path relative to the project root
 * @param patterns Parsed ignore patterns
 */
function isIgnored(relativePath: string, patterns: IgnorePattern[]): boolean {
  let ignored = false;

  for (const { regex, negated } of patterns) {
    if (regex.test(relativePath)) {
      ignored = !negated;
    }
  }

  return ignored;
}

/**
 * Gets raw patterns from .gitignore for passing to deno fmt --ignore
 * Also includes submodule paths
 */
async function getRawIgnorePatterns(startDir: string): Promise<string[]> {
  const result = await findGitignore(startDir);
  const rootDir = result?.rootDir ?? startDir;

  const patterns: string[] = [];

  // Add submodule paths
  const submodules = await findSubmodulePaths(rootDir);
  for (const submodule of submodules) {
    patterns.push(submodule);
  }

  if (!result) {
    return patterns;
  }

  try {
    const content = await Deno.readTextFile(result.filePath);

    for (const line of content.split("\n")) {
      const trimmed = line.trim();
      // Skip empty lines, comments, and negation patterns (deno fmt doesn't support those)
      if (
        trimmed === "" || trimmed.startsWith("#") || trimmed.startsWith("!")
      ) {
        continue;
      }
      // Normalize patterns for deno fmt:
      // - Remove leading slash (deno fmt treats all patterns as relative)
      // - Convert /foo/* to foo/
      let pattern = trimmed;
      if (pattern.startsWith("/")) {
        pattern = pattern.slice(1);
      }
      // Remove trailing /* as deno fmt ignores directories recursively
      if (pattern.endsWith("/*")) {
        pattern = pattern.slice(0, -1);
      }
      patterns.push(pattern);
    }

    return patterns;
  } catch {
    return patterns;
  }
}

/**
 * Executes a command and returns the result
 */
async function runCommand(
  name: string,
  args: string[],
  dir: string,
  silent = false,
): Promise<{ success: boolean; output: string }> {
  if (silent) {
    const command = new Deno.Command(name, {
      args,
      cwd: dir,
      stdout: "piped",
      stderr: "piped",
    });

    const { code, stdout, stderr } = await command.output();
    const decoder = new TextDecoder();
    const output = decoder.decode(stdout) + decoder.decode(stderr);
    return { success: code === 0, output };
  } else {
    const command = new Deno.Command(name, {
      args,
      cwd: dir,
      stdout: "inherit",
      stderr: "inherit",
    });

    const { code } = await command.output();
    return { success: code === 0, output: "" };
  }
}

/**
 * Checks if a command is available in PATH
 */
async function isCommandAvailable(name: string): Promise<boolean> {
  try {
    const command = new Deno.Command("which", {
      args: [name],
      stdout: "null",
      stderr: "null",
    });
    const { code } = await command.output();
    return code === 0;
  } catch {
    return false;
  }
}

/**
 * Recursively finds all files with the given extension, respecting ignore patterns
 */
async function findFiles(
  dir: string,
  ext: string,
  patterns: IgnorePattern[] = [],
  rootDir: string = dir,
): Promise<string[]> {
  const files: string[] = [];

  async function walk(currentDir: string): Promise<void> {
    try {
      for await (const entry of Deno.readDir(currentDir)) {
        const fullPath = `${currentDir}/${entry.name}`;
        const relativePath = fullPath.startsWith(rootDir + "/")
          ? fullPath.slice(rootDir.length + 1)
          : fullPath;

        // Check if this path should be ignored
        if (patterns.length > 0 && isIgnored(relativePath, patterns)) {
          continue;
        }

        if (entry.isDirectory) {
          await walk(fullPath);
        } else if (entry.isFile && entry.name.endsWith(ext)) {
          files.push(fullPath);
        }
      }
    } catch (error) {
      console.log(error);
    }
  }

  await walk(dir);
  return files;
}

/**
 * Runs deno fmt for multiple file types
 */
async function runDenoFmt(
  dir: string,
  checkMode: boolean,
): Promise<{ success: boolean; error?: string }> {
  console.log("\n=== Deno Formatter ===");
  console.log(
    "Formats: JS, TS, JSON, MD, CSS, HTML, YAML, SCSS, SASS, LESS, Svelte, Vue, Astro",
  );

  if (!await isCommandAvailable("deno")) {
    return {
      success: false,
      error:
        "deno not found. Install with 'nix-shell -p deno' or use the flake.",
    };
  }

  // Get ignore patterns to pass to deno fmt
  const ignorePatterns = await getRawIgnorePatterns(dir);

  const args = checkMode
    ? ["fmt", "--check", "--unstable-component"]
    : ["fmt", "--unstable-component"];

  // Add ignore patterns if any
  if (ignorePatterns.length > 0) {
    args.push(`--ignore=${ignorePatterns.join(",")}`);
  }

  args.push(".");

  console.log(checkMode ? "Checking formatting..." : "Formatting files...");
  const result = await runCommand("deno", args, dir);

  if (!result.success) {
    return {
      success: false,
      error: checkMode ? "Files need formatting" : "Formatting failed",
    };
  }

  return { success: true };
}

/**
 * Runs alejandra for formatting Nix files
 */
async function runAlejandra(
  dir: string,
  checkMode: boolean,
  patterns: IgnorePattern[],
  rootDir: string,
): Promise<{ success: boolean; error?: string }> {
  console.log("\n=== Nix Formatter (Alejandra) ===");

  const nixFiles = await findFiles(dir, ".nix", patterns, rootDir);
  if (nixFiles.length === 0) {
    console.log("No Nix files found. Skipping.");
    return { success: true };
  }

  console.log(`Found ${nixFiles.length} Nix file(s)`);

  if (!await isCommandAvailable("alejandra")) {
    return {
      success: false,
      error:
        "alejandra not found. Install with 'nix-shell -p alejandra' or use the flake.",
    };
  }

  console.log(checkMode ? "Checking formatting..." : "Formatting files...");

  // Format each file individually to respect ignore patterns
  const formatPromises = nixFiles.map(async (file) => {
    const args = checkMode ? ["--check", file] : [file];
    const result = await runCommand("alejandra", args, dir, true);
    if (!result.success && checkMode) {
      console.log(`Needs formatting: ${file}`);
    }
    return result.success;
  });

  const results = await Promise.all(formatPromises);
  const allSucceeded = results.every((r) => r);

  if (!allSucceeded) {
    return {
      success: false,
      error: checkMode ? "Nix files need formatting" : "Nix formatting failed",
    };
  }

  return { success: true };
}

/**
 * Runs gofmt/goimports for formatting Go files
 */
async function runGoFmt(
  dir: string,
  checkMode: boolean,
  patterns: IgnorePattern[],
  rootDir: string,
): Promise<{ success: boolean; error?: string }> {
  console.log("\n=== Go Formatter ===");

  const goFiles = await findFiles(dir, ".go", patterns, rootDir);
  if (goFiles.length === 0) {
    console.log("No Go files found. Skipping.");
    return { success: true };
  }

  console.log(`Found ${goFiles.length} Go file(s)`);

  // Try goimports first, fall back to gofmt
  const useGoimports = await isCommandAvailable("goimports");
  const useGofmt = await isCommandAvailable("gofmt");

  if (!useGoimports && !useGofmt) {
    return {
      success: false,
      error:
        "No Go formatter found. Install with 'nix-shell -p go gotools' or use the flake.",
    };
  }

  const formatter = useGoimports ? "goimports" : "gofmt";
  console.log(checkMode ? "Checking formatting..." : `Using ${formatter}...`);

  // Format each file individually to respect ignore patterns
  const formatPromises = goFiles.map(async (file) => {
    if (checkMode) {
      const result = await runCommand(formatter, ["-l", file], dir, true);
      if (result.output.trim().length > 0) {
        console.log(`Needs formatting: ${file}`);
        return false;
      }
      return true;
    } else {
      const result = await runCommand(formatter, ["-w", file], dir);
      return result.success;
    }
  });

  const results = await Promise.all(formatPromises);
  const allSucceeded = results.every((r) => r);

  if (!allSucceeded) {
    return {
      success: false,
      error: checkMode ? "Go files need formatting" : "Go formatting failed",
    };
  }

  return { success: true };
}

/**
 * Runs pg_format for formatting SQL files
 */
async function runPgFormat(
  dir: string,
  checkMode: boolean,
  patterns: IgnorePattern[],
  rootDir: string,
): Promise<{ success: boolean; error?: string }> {
  console.log("\n=== SQL Formatter (pgFormatter) ===");

  const sqlFiles = await findFiles(dir, ".sql", patterns, rootDir);
  if (sqlFiles.length === 0) {
    console.log("No SQL files found. Skipping.");
    return { success: true };
  }

  console.log(`Found ${sqlFiles.length} SQL file(s)`);

  if (!await isCommandAvailable("pg_format")) {
    return {
      success: false,
      error:
        "pg_format not found. Install with 'nix-shell -p pgformatter' or use the flake.",
    };
  }

  console.log(checkMode ? "Checking formatting..." : "Formatting files...");

  const formatPromises = sqlFiles.map(async (file) => {
    if (checkMode) {
      const result = await runCommand(
        "pg_format",
        ["--check", file],
        dir,
        true,
      );
      if (!result.success) {
        console.log(`Needs formatting: ${file}`);
        return false;
      }
      return true;
    } else {
      console.log(`Formatting: ${file}`);
      const result = await runCommand("pg_format", ["--inplace", file], dir);
      return result.success;
    }
  });

  const results = await Promise.all(formatPromises);
  const allSucceeded = results.every((r) => r);

  if (!allSucceeded) {
    return {
      success: false,
      error: checkMode ? "SQL files need formatting" : "SQL formatting failed",
    };
  }

  return { success: true };
}

/**
 * Checks if Cargo.toml exists in the directory
 */
async function hasCargoToml(dir: string): Promise<boolean> {
  try {
    await Deno.stat(`${dir}/Cargo.toml`);
    return true;
  } catch {
    return false;
  }
}

/**
 * Runs rustfmt for formatting Rust files
 */
async function runRustFmt(
  dir: string,
  checkMode: boolean,
  patterns: IgnorePattern[],
  rootDir: string,
): Promise<{ success: boolean; error?: string }> {
  console.log("\n=== Rust Formatter (rustfmt) ===");

  const rustFiles = await findFiles(dir, ".rs", patterns, rootDir);
  if (rustFiles.length === 0) {
    console.log("No Rust files found. Skipping.");
    return { success: true };
  }

  console.log(`Found ${rustFiles.length} Rust file(s)`);

  // Check if this is a Cargo project
  const isCargoProject = await hasCargoToml(dir);

  if (isCargoProject) {
    // Use cargo fmt for Cargo projects (respects Cargo.toml edition)
    if (!await isCommandAvailable("cargo")) {
      return {
        success: false,
        error:
          "cargo not found. Install with 'nix-shell -p cargo' or use the flake.",
      };
    }

    console.log(checkMode ? "Checking formatting..." : "Formatting files...");
    // For cargo projects, format individual files to respect ignore patterns
    const formatPromises = rustFiles.map(async (file) => {
      const args = checkMode
        ? ["fmt", "--", "--check", file]
        : ["fmt", "--", file];
      const result = await runCommand("cargo", args, dir, true);
      if (!result.success && checkMode) {
        console.log(`Needs formatting: ${file}`);
      }
      return result.success;
    });

    const results = await Promise.all(formatPromises);
    const allSucceeded = results.every((r) => r);

    if (!allSucceeded) {
      return {
        success: false,
        error: checkMode
          ? "Rust files need formatting"
          : "Rust formatting failed",
      };
    }
  } else {
    // Fall back to rustfmt with edition 2024 for standalone files
    if (!await isCommandAvailable("rustfmt")) {
      return {
        success: false,
        error:
          "rustfmt not found. Install with 'nix-shell -p rustfmt' or use the flake.",
      };
    }

    console.log(checkMode ? "Checking formatting..." : "Formatting files...");

    const formatPromises = rustFiles.map(async (file) => {
      if (checkMode) {
        const result = await runCommand(
          "rustfmt",
          ["--edition", "2024", "--check", file],
          dir,
          true,
        );
        if (!result.success) {
          console.log(`Needs formatting: ${file}`);
          return false;
        }
        return true;
      } else {
        console.log(`Formatting: ${file}`);
        const result = await runCommand(
          "rustfmt",
          ["--edition", "2024", file],
          dir,
        );
        return result.success;
      }
    });

    const results = await Promise.all(formatPromises);
    const allSucceeded = results.every((r) => r);

    if (!allSucceeded) {
      return {
        success: false,
        error: checkMode
          ? "Rust files need formatting"
          : "Rust formatting failed",
      };
    }
  }

  return { success: true };
}

/**
 * Main formatting workflow
 */
async function run(checkMode: boolean): Promise<void> {
  const cwd = Deno.cwd();

  // Load ignore patterns from .gitignore and submodules
  const { patterns, rootDir, submodules } = await loadIgnorePatterns(cwd);

  if (patterns.length > 0) {
    console.log(`Using .gitignore from ${rootDir}`);
  }

  if (submodules.length > 0) {
    console.log(`Skipping submodules: ${submodules.join(", ")}`);
  }

  console.log(
    checkMode
      ? "Checking code formatting..."
      : "Formatting code in parallel...",
  );

  // Run all formatters in parallel
  const results = await Promise.allSettled([
    runDenoFmt(cwd, checkMode),
    runAlejandra(cwd, checkMode, patterns, rootDir),
    runGoFmt(cwd, checkMode, patterns, rootDir),
    runPgFormat(cwd, checkMode, patterns, rootDir),
    runRustFmt(cwd, checkMode, patterns, rootDir),
  ]);

  // Collect errors
  const errors: string[] = [];
  const formatterNames = [
    "Deno formatter",
    "Alejandra",
    "Go formatter",
    "SQL formatter",
    "Rust formatter",
  ];

  results.forEach((result, index) => {
    if (result.status === "rejected") {
      errors.push(`${formatterNames[index]}: ${result.reason}`);
    } else if (!result.value.success && result.value.error) {
      errors.push(`${formatterNames[index]}: ${result.value.error}`);
    }
  });

  if (errors.length > 0) {
    console.error("\n❌ Formatting errors:");
    errors.forEach((err) => console.error(`  - ${err}`));
    Deno.exit(1);
  }

  console.log(
    checkMode
      ? "\n✅ All files are properly formatted!"
      : "\n✅ All formatting completed successfully!",
  );
}

/**
 * Main entry point
 */
async function main(): Promise<void> {
  const args = parseArgs(Deno.args);

  if (args.help) {
    showHelp();
    Deno.exit(0);
  }

  try {
    await run(args.check);
  } catch (error) {
    console.error(`Error: ${error}`);
    Deno.exit(1);
  }
}

if (import.meta.main) {
  main();
}
