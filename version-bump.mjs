import { readFileSync, writeFileSync } from "fs";
const targetVersion = process.env.npm_package_version;
if (!targetVersion) { console.error("No version"); process.exit(1); }
let manifest = JSON.parse(readFileSync("manifest.json", "utf8"));
let versions = JSON.parse(readFileSync("versions.json", "utf8"));
manifest.version = targetVersion;
versions[targetVersion] = manifest.minAppVersion;
writeFileSync("manifest.json", JSON.stringify(manifest, null, "\t"));
writeFileSync("versions.json", JSON.stringify(versions, null, "\t"));
