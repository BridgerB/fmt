# fmt

Parallel formatter for multiple languages: Deno
(JS/TS/JSON/MD/CSS/HTML/YAML/etc), PostgreSQL, Go, Nix, and others.

## Features

- **Multi-language support**: Formats JavaScript, TypeScript, JSON, Markdown,
  CSS, HTML, YAML, Nix, Go, and SQL files
- **Parallel execution**: Runs all formatters simultaneously for faster
  formatting
- **Check mode**: Verify formatting without modifying files (useful for CI/CD)
- **Exclude paths**: Skip formatting certain directories via configuration
- **Nix packaging**: Reproducible builds with all dependencies included

## Installation

With Nix and flakes enabled:

```bash
nix run github:BridgerB/fmt
```

Or clone and run with Deno:

```bash
git clone https://github.com/BridgerB/fmt.git
cd fmt
deno run --allow-run --allow-read --allow-env main.ts
```

## Usage

### Format all files

```bash
nix run github:BridgerB/fmt
# or locally:
deno run --allow-run --allow-read --allow-env main.ts
```

### Check formatting (without modifying files)

```bash
nix run github:BridgerB/fmt -- --check
# or locally:
deno run --allow-run --allow-read --allow-env main.ts --check
```

### Help

```bash
nix run github:BridgerB/fmt -- --help
```

## Supported Languages

- **JavaScript, TypeScript, JSON, Markdown, CSS, HTML, YAML, etc.**: via
  `deno fmt`
- **Nix**: via `alejandra`
- **Go**: via `goimports`/`gofmt`
- **SQL**: via `pg_format`

## Configuration

Create an `exclude-list.json` file in the same directory as the binary to
exclude specific paths:

```json
{
  "excluded_paths": [
    "/path/to/directory/to/exclude",
    "/another/path/to/exclude"
  ]
}
```

By default, an empty `exclude-list.json` is provided.

## Nix Flake Apps

The flake provides several useful apps:

- `nix run` - Format files in the current directory
- `nix run .#check` - Check formatting without modifying files
- `nix run .#type-check` - Check TypeScript types without running

## Development

Enter the development shell with all dependencies:

```bash
nix develop
```

This provides access to all formatters (deno, alejandra, go, gotools,
pgformatter) and git.
