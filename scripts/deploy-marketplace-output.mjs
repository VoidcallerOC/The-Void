function isDeploymentResult(value) {
  return value && typeof value === "object" && !Array.isArray(value) && (
    typeof value.deployedTo === "string" ||
    typeof value.contractAddress === "string" ||
    typeof value.transactionHash === "string" ||
    typeof value.txHash === "string"
  );
}

export function extractForgeJson(output) {
  const candidates = [];
  const text = String(output ?? "");

  for (let start = 0; start < text.length; start += 1) {
    if (text[start] !== "{") continue;

    let depth = 0;
    let inString = false;
    let escaped = false;
    for (let index = start; index < text.length; index += 1) {
      const character = text[index];
      if (inString) {
        if (escaped) escaped = false;
        else if (character === "\\") escaped = true;
        else if (character === '"') inString = false;
        continue;
      }
      if (character === '"') {
        inString = true;
        continue;
      }
      if (character === "{") depth += 1;
      else if (character === "}") {
        depth -= 1;
        if (depth === 0) {
          try {
            const value = JSON.parse(text.slice(start, index + 1));
            if (isDeploymentResult(value)) candidates.push(value);
          } catch {
            // This brace-delimited region was not a complete JSON object.
          }
          break;
        }
      }
    }
  }

  const result = candidates.at(-1);
  if (!result) throw new Error("Forge did not return a parseable deployment result.");
  return result;
}
