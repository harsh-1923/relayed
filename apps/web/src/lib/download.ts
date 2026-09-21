// Where the macOS build actually lives.
//
// The R2 key is stable — every release overwrites this same object — so the URL
// never changes and cutting a release needs no site deploy. The object is sent
// with a five-minute cache so an overwrite is picked up promptly; without that,
// Cloudflare would keep handing out the previous build with nothing to show for
// it.
//
// The server hands the SAME url to the in-app update nag, from
// RELAYED_DOWNLOAD_URL (apps/server/src/web/version.ts). The two are set by hand
// and must move together. The site cannot simply read `/version` instead: that
// endpoint sends no CORS headers, so a browser on this origin cannot see it.
export const DOWNLOAD_URL =
  "https://pub-5a99bbc59a0345d8a6403dbdaebdfc5f.r2.dev/Relayed-latest-arm64.dmg";

// The build is arm64-only, deliberately (apps/desktop/electron-builder.yml): a
// cross-built x64 package would ship without its native keyring module. Say so
// on the button rather than letting an Intel Mac download 153MB it cannot run.
export const DOWNLOAD_ARCH = "Apple Silicon";

// What an unsigned build costs every downloader (docs/RELEASE.md §2). macOS does
// not report this app as "unidentified" — an Electron app carries an ad-hoc
// signature that actively FAILS validation, so the dialog says "damaged", which
// reads as a corrupt or malicious download rather than a missing certificate.
// People trash the app at that point unless they were told first.
//
// `Relayed` here is the bundle name (electron-builder `productName`), not the
// product name used elsewhere on this site. It is a filesystem path, so it has
// to be exactly what lands in /Applications.
export const UNQUARANTINE_COMMAND = "xattr -cr /Applications/Relayed.app";
