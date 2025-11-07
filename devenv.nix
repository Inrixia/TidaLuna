{ pkgs, ... }:

{
  languages.javascript = {
   enable = true;
   corepack.enable = true;
    pnpm = {
      enable = true;
      install.enable = true;
    };

  };
}
