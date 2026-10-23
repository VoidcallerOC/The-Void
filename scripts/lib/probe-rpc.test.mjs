import { describe, expect, it } from "vitest";
import { spawn, spawnSync } from "node:child_process";
import { mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import http from "node:http";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { PUBLIC_RPC_URLS, RPC_LIMITED_EXIT_CODE, describeRpc, retryDelayMs, rpcLimitKind } from "./probe-rpc.mjs";

const HELPER = new URL("./probe-rpc.mjs", import.meta.url).href;
const RUN_PROBE = fileURLToPath(new URL("../run-probe.sh", import.meta.url));
const SECRET = "SECRET-KEY-123";
const RANGE_ERROR = "block range too large: total block range in this request exceeds the maximum of 100 blocks";

/** Local JSON-RPC endpoint whose URL embeds a fake API key; `handler(payload, res)` answers each POST. */
async function rpcServer(handler) {
  const requests = [];
  const server = http.createServer((req, res) => {
    let body = "";
    req.on("data", (chunk) => { body += chunk; });
    req.on("end", () => { const payload = JSON.parse(body); requests.push(payload); handler(payload, res); });
  });
  await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
  return { url: `http://127.0.0.1:${server.address().port}/v2/${SECRET}`, requests, close: () => new Promise((resolve) => server.close(resolve)) };
}

function reply(res, payload, answer) {
  const one = (p) => ({ jsonrpc: "2.0", id: p.id, ...answer(p) });
  res.writeHead(200, { "content-type": "application/json" });
  res.end(JSON.stringify(Array.isArray(payload) ? payload.map(one) : one(payload)));
}

const healthy = (payload, res) => reply(res, payload, (p) => ({ result: p.method === "eth_getCode" ? "0x" : "0x10" }));

/** Runs `body` as a probe in a child process (exit handling is per process) with `provider` on `url`. */
function runProbe(body, url) {
  const code = `import { probeProvider } from ${JSON.stringify(HELPER)};
const provider = probeProvider(process.env.RPC, 43113, { retry: { attempts: 3, baseMs: 5, maxDelayMs: 20 } });
${body}`;
  return new Promise((resolve) => {
    const child = spawn(process.execPath, ["--input-type=module", "-e", code], { env: { ...process.env, RPC: url } });
    let stdout = "";
    let stderr = "";
    child.stdout.on("data", (chunk) => { stdout += chunk; });
    child.stderr.on("data", (chunk) => { stderr += chunk; });
    child.on("close", (status) => resolve({ status, stdout, stderr }));
  });
}

describe("probe RPC limits", () => {
  it("classifies HTTP 429, Cloudflare 1015 and JSON-RPC rate or log-range errors, and nothing else", () => {
    expect(rpcLimitKind({ status: "429 Too Many Requests" })).toBe("rate limit");
    expect(rpcLimitKind({ status: "599 CLIENT ESCALATED SERVER ERROR (429 Too Many Requests; exceeded maximum retry limit)", text: "error code: 1015\n" })).toBe("rate limit");
    expect(rpcLimitKind({ status: "403 Forbidden", text: "error code: 1015" })).toBe("rate limit");
    expect(rpcLimitKind({ text: "request limit reached - reduce calls per second" })).toBe("rate limit");
    expect(rpcLimitKind({ text: RANGE_ERROR })).toBe("log range limit");
    expect(rpcLimitKind({ text: "query returned more than 10000 results" })).toBe("log range limit");
    for (const other of [{ status: "500 Internal Server Error", text: "upstream error" }, { status: "200 OK" }, { text: "nonce too low" }, { text: "invalid block range params" }, {}]) expect(rpcLimitKind(other)).toBe(null);
  });

  it("backs off exponentially, honours Retry-After as seconds and caps each wait", () => {
    expect([0, 1, 2, 3].map((attempt) => retryDelayMs(attempt))).toEqual([1000, 2000, 4000, 8000]);
    expect(retryDelayMs(0, "5")).toBe(5000);
    expect(retryDelayMs(0, "600")).toBe(10000);
    expect(retryDelayMs(1, "Wed, 21 Oct 2026 07:28:00 GMT")).toBe(2000);
  });

  it("prints the public endpoints and never a private one", () => {
    expect(describeRpc(PUBLIC_RPC_URLS[43113])).toBe(PUBLIC_RPC_URLS[43113]);
    expect(describeRpc(PUBLIC_RPC_URLS[43114])).toBe(PUBLIC_RPC_URLS[43114]);
    expect(describeRpc(`https://avax-fuji.example/v2/${SECRET}`)).not.toContain(SECRET);
  });

  it("exits normally against a healthy endpoint", async () => {
    const server = await rpcServer(healthy);
    try {
      const run = await runProbe("console.log(await provider.getBlockNumber());", server.url);
      expect(run).toEqual({ status: 0, stdout: "16\n", stderr: "" });
    } finally { await server.close(); }
  });

  it("retries a 429 storm a bounded number of times, stops calling that chain and exits UNVERIFIED even when the probe swallowed the error", async () => {
    const server = await rpcServer((_payload, res) => { res.writeHead(429, { "content-type": "text/plain", "retry-after": "1" }); res.end("error code: 1015\n"); });
    try {
      const run = await runProbe(`const out = {};
try { await provider.getBlockNumber(); } catch (error) { out.first = error.message; }
try { await provider.getCode("0x0000000000000000000000000000000000000001"); } catch (error) { out.second = error.message; }
console.log(JSON.stringify(out));`, server.url);
      expect(run.status).toBe(RPC_LIMITED_EXIT_CODE);
      expect(server.requests).toHaveLength(3);
      const out = JSON.parse(run.stdout);
      expect(out.first).toContain("server response 429 Too Many Requests");
      expect(out.second).toContain("not sent");
      expect(run.stderr).toMatch(/^RPC_LIMIT UNVERIFIED: Avalanche Fuji \(43113\) via <private RPC endpoint, URL redacted>: rate limit \(HTTP 429 Too Many Requests: error code: 1015\); 1 later call\(s\) not sent\./);
      expect(run.stdout + run.stderr).not.toContain(SECRET);
    } finally { await server.close(); }
  });

  it("turns a probe crash caused by the rate limit into UNVERIFIED, with the key scrubbed from the printed error", async () => {
    const server = await rpcServer((_payload, res) => { res.writeHead(429); res.end("Too Many Requests"); });
    try {
      const run = await runProbe("await provider.getBlockNumber();", server.url);
      expect(run.status).toBe(RPC_LIMITED_EXIT_CODE);
      expect(run.stderr).toContain("server response 429 Too Many Requests");
      expect(run.stderr).toContain("RPC_LIMIT UNVERIFIED");
      expect(run.stderr).not.toContain(SECRET);
    } finally { await server.close(); }
  });

  it("reports an eth_getLogs range the endpoint refuses as UNVERIFIED without blocking later calls", async () => {
    const server = await rpcServer((payload, res) => reply(res, payload, (p) => (p.method === "eth_getLogs" ? { error: { code: -32602, message: RANGE_ERROR } } : { result: "0x10" })));
    try {
      const run = await runProbe(`try { await provider.getLogs({ fromBlock: 1, toBlock: 2048 }); } catch { console.log(await provider.getBlockNumber()); }`, server.url);
      expect(run.status).toBe(RPC_LIMITED_EXIT_CODE);
      expect(run.stdout).toBe("16\n");
      expect(run.stderr).toContain(`log range limit (eth_getLogs: ${RANGE_ERROR})`);
    } finally { await server.close(); }
  });

  it("keeps real failures and contract reverts as they are", async () => {
    const server = await rpcServer((payload, res) => reply(res, payload, (p) => (p.method === "eth_call" ? { error: { code: 3, message: "execution reverted: rate limit", data: "0x" } } : { result: "0x10" })));
    try {
      const crash = await runProbe(`await provider.getBlockNumber(); throw new Error("Unexpected chain ID 1");`, server.url);
      expect(crash.status).toBe(1);
      expect(crash.stderr).not.toContain("RPC_LIMIT");
      const revert = await runProbe(`try { await provider.call({ to: "0x0000000000000000000000000000000000000001", data: "0x" }); } catch (error) { console.log(error.code); }`, server.url);
      expect(revert).toEqual({ status: 0, stdout: "CALL_EXCEPTION\n", stderr: "" });
    } finally { await server.close(); }
  });
});

describe("run-probe.sh", () => {
  const dir = mkdtempSync(join(tmpdir(), "run-probe-"));
  const probe = (name, source) => { const file = join(dir, name); writeFileSync(file, source); return file; };
  const run = (out, script) => spawnSync("bash", [RUN_PROBE, out, script], { cwd: dir, encoding: "utf8", env: { ...process.env, GITHUB_STEP_SUMMARY: join(dir, "summary.md") } });

  it("passes OK and UNVERIFIED (with a warning) and fails anything else, recording each outcome", () => {
    const ok = run("ok.json", probe("ok.mjs", `console.log('{"ok":true}');`));
    expect(ok.status).toBe(0);
    expect(readFileSync(join(dir, "ok.json"), "utf8")).toBe('{"ok":true}\n');

    const limited = run("limited.json", probe("limited.mjs", `console.log("{}"); process.exitCode = ${RPC_LIMITED_EXIT_CODE};`));
    expect(limited.status).toBe(0);
    expect(limited.stdout).toContain("::warning title=UNVERIFIED (RPC limit)::");

    const broken = run("broken.json", probe("broken.mjs", "process.exit(1);"));
    expect(broken.status).toBe(1);

    expect(readFileSync(join(dir, "probe-outcomes.txt"), "utf8")).toBe([
      "ok.json: OK",
      "limited.json: UNVERIFIED (RPC limit; output incomplete, not a finding)",
      "broken.json: FAILED (exit 1)",
      "",
    ].join("\n"));
    expect(readFileSync(join(dir, "summary.md"), "utf8").split("\n").filter(Boolean)).toHaveLength(3);
  });
});
