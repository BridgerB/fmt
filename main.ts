/**
 * Multi-language parallel code formatter
 * Formats code using appropriate tools: Deno, Alejandra (Nix), Go, PostgreSQL, and Rust formatters
 */

/** Configuration file structure */
interface Config {
  excluded_paths: string[];
}

/** File detection result */
interface FileCheckResult {
  found: boolean;
  count: number;
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
    Create exclude-list.json in the same directory as the binary to exclude paths:
    {
      "excluded_paths": ["/path/to/exclude"]
    }

EXAMPLES:
    fmt              Format all files in current directory
    fmt --check      Check formatting without modifying files (useful for CI)
`);
}

/**
 * Gets the path to the configuration file
 */
function getConfigPath(): string {
  const execPath = Deno.execPath();
  const binaryDir = execPath.substring(0, execPath.lastIndexOf("/"));
  return `${binaryDir}/exclude-list.json`;
}

/**
 * Loads the configuration file
 */
async function loadConfig(): Promise<Config> {
  const configPath = getConfigPath();

  try {
    const data = await Deno.readTextFile(configPath);
    return JSON.parse(data) as Config;
  } catch (error) {
    if (error instanceof Deno.errors.NotFound) {
      return { excluded_paths: [] };
    }
    console.warn(`Warning: failed to load config: ${error}`);
    return { excluded_paths: [] };
  }
}

/**
 * Checks if the given path should be excluded from formatting
 */
async function isPathExcluded(currentPath: string): Promise<boolean> {
  const config = await loadConfig();
  const normalizedCurrent = await Deno.realPath(currentPath).catch(() =>
    currentPath
  );

  for (const excludedPath of config.excluded_paths) {
    try {
      const normalizedExcluded = await Deno.realPath(excludedPath).catch(() =>
        excludedPath
      );

      if (
        normalizedCurrent === normalizedExcluded ||
        normalizedCurrent.startsWith(normalizedExcluded + "/")
      ) {
        return true;
      }
    } catch {
      continue;
    }
  }

  return false;
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
 * Recursively finds all files with the given extension
 */
async function findFiles(dir: string, ext: string): Promise<string[]> {
  const files: string[] = [];

  async function walk(currentDir: string): Promise<void> {
    try {
      for await (const entry of Deno.readDir(currentDir)) {
        const fullPath = `${currentDir}/${entry.name}`;

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
 * Checks if the directory contains files with the given extension
 */
async function hasFilesWithExt(
  dir: string,
  ext: string,
): Promise<FileCheckResult> {
  const files = await findFiles(dir, ext);
  return {
    found: files.length > 0,
    count: files.length,
  };
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

  const args = checkMode
    ? ["fmt", "--check", "--unstable-component", "."]
    : ["fmt", "--unstable-component", "."];

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
): Promise<{ success: boolean; error?: string }> {
  console.log("\n=== Nix Formatter (Alejandra) ===");

  const { found, count } = await hasFilesWithExt(dir, ".nix");
  if (!found) {
    console.log("No Nix files found. Skipping.");
    return { success: true };
  }

  console.log(`Found ${count} Nix file(s)`);

  if (!await isCommandAvailable("alejandra")) {
    return {
      success: false,
      error:
        "alejandra not found. Install with 'nix-shell -p alejandra' or use the flake.",
    };
  }

  const args = checkMode ? ["--check", "."] : ["."];
  console.log(checkMode ? "Checking formatting..." : "Formatting files...");

  const result = await runCommand("alejandra", args, dir);

  if (!result.success) {
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
): Promise<{ success: boolean; error?: string }> {
  console.log("\n=== Go Formatter ===");

  const { found, count } = await hasFilesWithExt(dir, ".go");
  if (!found) {
    console.log("No Go files found. Skipping.");
    return { success: true };
  }

  console.log(`Found ${count} Go file(s)`);

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

  if (checkMode) {
    console.log("Checking formatting...");
    const formatter = useGoimports ? "goimports" : "gofmt";
    const result = await runCommand(formatter, ["-l", "."], dir, true);

    if (result.output.trim().length > 0) {
      console.log("Files that need formatting:");
      console.log(result.output);
      return { success: false, error: "Go files need formatting" };
    }
  } else {
    const formatter = useGoimports ? "goimports" : "gofmt";
    console.log(`Using ${formatter}...`);
    const result = await runCommand(formatter, ["-w", "."], dir);

    if (!result.success) {
      return { success: false, error: "Go formatting failed" };
    }
  }

  return { success: true };
}

/**
 * Runs pg_format for formatting SQL files
 */
async function runPgFormat(
  dir: string,
  checkMode: boolean,
): Promise<{ success: boolean; error?: string }> {
  console.log("\n=== SQL Formatter (pgFormatter) ===");

  const sqlFiles = await findFiles(dir, ".sql");
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
 * Runs rustfmt for formatting Rust files
 */
async function runRustFmt(
  dir: string,
  checkMode: boolean,
): Promise<{ success: boolean; error?: string }> {
  console.log("\n=== Rust Formatter (rustfmt) ===");

  const rustFiles = await findFiles(dir, ".rs");
  if (rustFiles.length === 0) {
    console.log("No Rust files found. Skipping.");
    return { success: true };
  }

  console.log(`Found ${rustFiles.length} Rust file(s)`);

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
      const result = await runCommand("rustfmt", [file], dir);
      return result.success;
    }
  });

  const results = await Promise.all(formatPromises);
  const allSucceeded = results.every((r) => r);

  if (!allSucceeded) {
    return {
      success: false,
      error: checkMode ? "Rust files need formatting" : "Rust formatting failed",
    };
  }

  return { success: true };
}

/**
 * Main formatting workflow
 */
async function run(checkMode: boolean): Promise<void> {
  const cwd = Deno.cwd();

  if (await isPathExcluded(cwd)) {
    console.log(`Skipping: ${cwd} is in excluded paths`);
    return;
  }

  console.log(
    checkMode
      ? "Checking code formatting..."
      : "Formatting code in parallel...",
  );

  // Run all formatters in parallel
  const results = await Promise.allSettled([
    runDenoFmt(cwd, checkMode),
    runAlejandra(cwd, checkMode),
    runGoFmt(cwd, checkMode),
    runPgFormat(cwd, checkMode),
    runRustFmt(cwd, checkMode),
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
