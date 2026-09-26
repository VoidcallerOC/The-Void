import { readFile } from "node:fs/promises";
import { resolve } from "node:path";
import { describe, expect, it } from "vitest";

const workflowPath = resolve(import.meta.dirname, "..", ".github/workflows/deploy-release-v2-fuji.yml");

function sectionBetween(source, startMarker, endMarker) {
  const start = source.indexOf(startMarker);
  const end = source.indexOf(endMarker, start + startMarker.length);
  if (start < 0 || end < 0) throw new Error(`Workflow section not found: ${startMarker}`);
  return source.slice(start, end);
}

describe("Fuji V2 workflow dispatch safety", () => {
  it("allows read-only preflight dispatch without making deployment confirmation required", async () => {
    const workflow = await readFile(workflowPath, "utf8");
    const dispatch = sectionBetween(workflow, "on:\n  workflow_dispatch:", "permissions:");
    const confirmation = dispatch.slice(dispatch.indexOf("confirm_fuji_v2_deploy:"));

    expect(dispatch).toContain("preflight_only:");
    expect(dispatch).toContain("default: true");
    expect(confirmation).toContain("required: false");
    expect(confirmation).toContain('default: ""');
    expect(confirmation).not.toContain('default: "I_CONFIRM_FUJI_V2_PRIMARY_SALE_DEPLOY"');
  });

  it("keeps deployment behind preflight, the boolean switch, and the exact confirmation string", async () => {
    const workflow = await readFile(workflowPath, "utf8");
    const preflight = sectionBetween(workflow, "read-only-preflight:", "deploy-and-verify:");
    const deployment = workflow.slice(workflow.indexOf("deploy-and-verify:"));

    expect(preflight).toContain("Verify credentials, Fuji, balance, and gas without broadcasting");
    expect(preflight).not.toContain("npm run deploy:release-v2");
    expect(deployment).toContain("needs: [validate-fee-config, read-only-preflight]");
    expect(deployment).toContain("if: ${{ inputs.preflight_only != true }}");
    expect(deployment).toContain('expected="I_CONFIRM_FUJI_V2_PRIMARY_SALE_DEPLOY"');
    expect(deployment).toContain('if [ "${{ github.event.inputs.confirm_fuji_v2_deploy }}" != "${expected}" ]');
    expect(deployment).toContain("npm run deploy:release-v2");
  });

  it("uses command boundaries so V1 is forbidden but V2 is allowed", async () => {
    const workflow = await readFile(workflowPath, "utf8");
    const isolation = sectionBetween(workflow, "Confirm V2 script and V1 workflow isolation", "Deploy VoidRelease1155V2 and VoidPrimarySale to Fuji");
    const exactV1Command = /(^|\s)npm run deploy:release(\s|$)/;

    expect(exactV1Command.test("npm run deploy:release")).toBe(true);
    expect(exactV1Command.test("npm run deploy:release-v2")).toBe(false);
    expect(isolation).toContain("grep -Eq '(^|[[:space:]])npm run deploy:release([[:space:]]|$)'");
    expect(isolation).toContain("npm run deploy:release-v2");
    expect(isolation).not.toContain("! grep -Fq 'npm run deploy:release'");
  });
});
