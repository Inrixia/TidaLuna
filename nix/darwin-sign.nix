# Replaces app.asar, so the bundle no longer matches the code signature TIDAL ships and macOS refuses to launch it.
# The app comes from the nix store and is not quarantined, so an ad-hoc signature is enough.
# Run this last: any later change to the bundle breaks the signature again.
app: ''
  chmod -R u+w ${app}
  /usr/bin/codesign --force --deep --sign - ${app}
  /usr/bin/codesign --verify --deep ${app}
''
