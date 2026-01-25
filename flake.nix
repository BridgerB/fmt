{
  description = "Multi-language parallel code formatter";

  inputs = {
    nixpkgs.url = "github:nixos/nixpkgs?ref=nixos-unstable";
    systems.url = "github:nix-systems/default";
  };

  outputs = {
    self,
    nixpkgs,
    systems,
  }: let
    eachSystem = f:
      nixpkgs.lib.genAttrs (import systems) (
        system: f (nixpkgs.legacyPackages.${system}) system
      );

    # Map nix system to deno target triple
    denoTarget = {
      "x86_64-linux" = "x86_64-unknown-linux-gnu";
      "aarch64-linux" = "aarch64-unknown-linux-gnu";
      "x86_64-darwin" = "x86_64-apple-darwin";
      "aarch64-darwin" = "aarch64-apple-darwin";
    };
  in {
    packages = eachSystem (pkgs: system: let
      formatTools = with pkgs; [
        deno
        alejandra
        go
        gotools
        pgformatter
        rustfmt
      ];
      denoVersion = pkgs.deno.version;
      target = denoTarget.${system};

      # Platform-specific hashes for denort binary
      # Update these when deno version changes
      denortHashes = {
        "x86_64-unknown-linux-gnu" = "sha256-ZUmzB1FJYAOnYYvH4IMnAyLYDZhhOUmwrEAiNYAFuHQ=";
        "aarch64-unknown-linux-gnu" = "sha256-0000000000000000000000000000000000000000000=";
        "x86_64-apple-darwin" = "sha256-0000000000000000000000000000000000000000000=";
        "aarch64-apple-darwin" = "sha256-K4HfRWSZWkG7IDEVHOUKa4kqjwTlCJ9hFXD2mTmG3lg=";
      };

      # Fetch the deno runtime binary needed for compile
      denortZip = pkgs.fetchurl {
        url = "https://dl.deno.land/release/v${denoVersion}/denort-${target}.zip";
        sha256 = denortHashes.${target};
      };

      # Fixed-output derivation to fetch deno dependencies
      denoDeps = pkgs.stdenv.mkDerivation {
        pname = "fmt-deno-deps";
        version = "1.0.0";
        src = ./.;

        nativeBuildInputs = [pkgs.deno pkgs.cacert];

        buildPhase = ''
          export HOME="$TMPDIR"
          export DENO_DIR="$TMPDIR/deno"
          deno cache main.ts
        '';

        installPhase = ''
          cp -r $DENO_DIR $out
        '';

        outputHashMode = "recursive";
        outputHashAlgo = "sha256";
        outputHash = "sha256-55DMyYtXKJG3Pu1M7Y5IHzaXHUlle+sSCDlzEuURwgo=";
      };
    in {
      default = self.packages.${system}.fmt;
      fmt = pkgs.stdenv.mkDerivation {
        pname = "fmt";
        version = "1.0.0";
        src = ./.;

        nativeBuildInputs = with pkgs; [
          deno
          makeWrapper
        ];

        dontStrip = true;

        buildPhase = ''
          export HOME="$TMPDIR"
          export DENO_DIR="$TMPDIR/deno"

          # Copy cached deps (can't use read-only nix store directly)
          cp -r ${denoDeps} $DENO_DIR
          chmod -R u+w $DENO_DIR

          # Copy the denort zip so deno compile finds it
          mkdir -p $DENO_DIR/dl/release/v${denoVersion}
          cp ${denortZip} $DENO_DIR/dl/release/v${denoVersion}/denort-${target}.zip

          deno compile --cached-only --allow-run --allow-read --allow-env -o fmt main.ts
        '';

        installPhase = ''
          mkdir -p $out/bin
          cp fmt $out/bin/.fmt-wrapped
          chmod +x $out/bin/.fmt-wrapped

          # Wrap it with the required formatter tools in PATH
          makeWrapper $out/bin/.fmt-wrapped $out/bin/fmt \
            --prefix PATH : ${pkgs.lib.makeBinPath formatTools}
        '';

        meta = with pkgs.lib; {
          description = "Multi-language parallel code formatter";
          homepage = "https://github.com/BridgerB/fmt";
          license = licenses.mit;
          mainProgram = "fmt";
          platforms = ["x86_64-linux" "aarch64-linux" "x86_64-darwin" "aarch64-darwin"];
        };
      };
    });

    apps = eachSystem (pkgs: system: {
      default = {
        type = "app";
        program = "${self.packages.${system}.default}/bin/fmt";
      };

      check = {
        type = "app";
        program = toString (pkgs.writeShellScript "fmt-check" ''
          ${self.packages.${system}.fmt}/bin/fmt --check
        '');
      };

      type-check = {
        type = "app";
        program = toString (pkgs.writeShellScript "deno-check" ''
          ${pkgs.deno}/bin/deno check main.ts
        '');
      };
    });

    devShells = eachSystem (pkgs: system: {
      default = pkgs.mkShell {
        buildInputs = with pkgs; [
          deno
          alejandra
          go
          gotools
          pgformatter
          rustfmt
          git
        ];

        shellHook = ''
          echo "fmt development shell"
          echo ""
          echo "Commands:"
          echo "  deno run --allow-run --allow-read --allow-env main.ts  - Run formatter"
          echo "  deno compile --allow-run --allow-read --allow-env -o fmt main.ts  - Rebuild binary"
        '';
      };
    });
  };
}
