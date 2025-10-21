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
        ];
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

            buildPhase = ''
              export DENO_DIR="$TMPDIR/deno"
              ${pkgs.deno}/bin/deno check main.ts
            '';

            installPhase = ''
              # Install the TypeScript source
              mkdir -p $out/bin $out/share/fmt
              cp main.ts $out/share/fmt/main.ts

              # Copy exclude-list.json to the bin directory (same dir as binary)
              if [ -f exclude-list.json ]; then
                cp exclude-list.json $out/bin/exclude-list.json
              else
                # Create default empty exclude-list.json
                echo '{"excluded_paths":[]}' > $out/bin/exclude-list.json
              fi

              # Create wrapper script
              cat > $out/bin/fmt << EOF
              #!/bin/sh
              exec ${pkgs.deno}/bin/deno run --allow-run --allow-read --allow-env $out/share/fmt/main.ts "\$@"
              EOF
              chmod +x $out/bin/fmt

              # Wrap it with the required formatter tools in PATH
              wrapProgram $out/bin/fmt \
                --prefix PATH : ${pkgs.lib.makeBinPath formatTools}
            '';

            meta = with pkgs.lib; {
              description = "Multi-language parallel code formatter";
              homepage = "https://github.com/BridgerB/fmt";
              license = licenses.mit;
              mainProgram = "fmt";
              platforms = platforms.all;
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
            git
          ];

          shellHook = ''
            echo "Welcome to the fmt development shell!"
            echo "Deno version: $(deno --version | head -n1)"
            echo ""
            echo "Available commands:"
            echo "  deno run --allow-run --allow-read --allow-env main.ts       - Run formatter"
            echo "  deno run --allow-run --allow-read --allow-env main.ts --check - Check formatting"
            echo "  nix run                                                      - Run packaged version"
            echo "  nix run .#check                                              - Check with packaged version"
          '';
        };
      }
    );
}
