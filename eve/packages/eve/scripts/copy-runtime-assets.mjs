import { cp, mkdir } from "node:fs/promises";
import { dirname, join } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

const packageRoot = fileURLToPath(new URL("..", import.meta.url));
// Hand-written declaration files are tsc inputs, not outputs. The ambient
// `workflow` module types are referenced from `eve/tools` and exported as
// `eve/workflow-modules`, so they ship beside the emitted declarations.
const runtimeAssetFiles = ["src/public/workflow-modules.d.ts"];

export async function copyRuntimeAssets() {
  for (const relativePath of runtimeAssetFiles) {
    const destinationPath = join(packageRoot, "dist", relativePath);
    await mkdir(dirname(destinationPath), { recursive: true });
    await cp(join(packageRoot, relativePath), destinationPath, { recursive: true });
  }
}

if (import.meta.url === pathToFileURL(process.argv[1]).href) {
  await copyRuntimeAssets();
}
