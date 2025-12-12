{
  description = "Multi-language parallel code formatter";

  inputs = {
    nixpkgs.url = "github:NixOS/nixpkgs/nixos-unstable";
    flake-utils.url = "github:numtide/flake-utils";
  };

  outputs = {
    self,
    nixpkgs,
    flake-utils,
  }:
    flake-utils.lib.eachDefaultSystem (
      system: let
        pkgs = nixpkgs.legacyPackages.${system};

        # Define the formatter tools as a separate package set
        formatTools = with pkgs; [
          deno
          alejandra
          go
          gotools
          pgformatter
          rustfmt
        ];
        denoVersion = pkgs.deno.version;

        # Fetch the deno runtime binary needed for compile (as zip)
        denortZip = pkgs.fetchurl {
          url = "https://dl.deno.land/release/v${denoVersion}/denort-x86_64-unknown-linux-gnu.zip";
          sha256 = "sha256-ZUmzB1FJYAOnYYvH4IMnAyLYDZhhOUmwrEAiNYAFuHQ=";
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
          outputHash = "sha256-fR4ihmkjvrgtnumHHoiLMD+jnS2dUXWCU9z61+Bndxo=";
        };
      in {
        packages = {
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
              cp ${denortZip} $DENO_DIR/dl/release/v${denoVersion}/denort-x86_64-unknown-linux-gnu.zip

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
              platforms = ["x86_64-linux"];
            };
          };
        };

        apps = {
          default = flake-utils.lib.mkApp {
            drv = self.packages.${system}.default;
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
        };

        devShells.default = pkgs.mkShell {
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
      }
    );
}
