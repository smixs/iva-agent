// The `preinstall` of package.json. An updater of 0.3.7 to 0.3.14 builds a candidate of
// this tree in <installation>/.iva-update/staging before it moves the checkout, and
// `npm ci` there is the first code of this tree it runs. Failing it makes that updater
// drop the candidate and stay on its release (specs/UpdateFloor.tla, StaysOnItsRelease).
// Anywhere else this does nothing.
import { basename, dirname } from "node:path";

const staging = process.cwd();
const holder = dirname(staging);
if (basename(staging) === "staging" && basename(holder) === ".iva-update") {
  const { belowFloor } = await import("./lib/update-check.ts");
  const refusal = belowFloor(dirname(holder), staging);
  if (refusal) {
    console.error(refusal);
    process.exit(1);
  }
}
