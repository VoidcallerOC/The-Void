// Command line for the plan binding (bind / verify). The binding logic itself is in
// plan-binding-core.mjs, which the browser deployment page shares. Reads only local files; no keys.
import { readFile, writeFile } from "node:fs/promises";
import process from "node:process";
import { BindingError, bindPlan, verifyBinding } from "./plan-binding-core.mjs";

export { BINDERS, BindingError, bindPlan, canonical, verifyBinding } from "./plan-binding-core.mjs";

function option(argv, name) {
  const index = argv.indexOf(`--${name}`);
  if (index < 0 || !argv[index + 1]) throw new BindingError(`--${name} is required.`);
  return argv[index + 1];
}

const readJson = async (path) => JSON.parse(await readFile(path, "utf8"));

export async function main(argv = process.argv.slice(2)) {
  const [command] = argv;
  const kind = option(argv, "kind");
  if (command === "bind") {
    const binding = bindPlan(kind, await readJson(option(argv, "plan")), option(argv, "commit"));
    await writeFile(option(argv, "out"), `${JSON.stringify(binding, null, 2)}\n`);
    console.log(JSON.stringify({ step: "PLAN_BOUND", kind, sourceCommit: binding.sourceCommit, digest: binding.digest }));
    return binding;
  }
  if (command === "verify") {
    const fresh = verifyBinding(await readJson(option(argv, "approved")), kind, await readJson(option(argv, "plan")), option(argv, "commit"));
    console.log(JSON.stringify({ step: "PLAN_MATCHES_APPROVAL", kind, sourceCommit: fresh.sourceCommit, digest: fresh.digest }));
    return fresh;
  }
  throw new BindingError('Use "bind" or "verify".');
}

if (process.argv[1] && import.meta.url === `file://${process.argv[1]}`) {
  main().catch((error) => {
    console.error(`Deployment plan binding failed: ${error.message}`);
    process.exitCode = 1;
  });
}
