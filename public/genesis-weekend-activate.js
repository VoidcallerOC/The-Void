const CHAIN = 43114;
const FROM = "0x284C09a7CC187E096cbbdc88d99DEFE6df32180a";
const PREDICTED = "";
const STEPS = [{"id":"activate","to":"0x6A251b2F591Df265A8D2B42991b4e672236e4F4A","data":"0x0f15f4c0","gas":"180000","nonce":196}];
const $ = (id) => document.getElementById(id);
$("jsstatus").className = "ok"; $("jsstatus").textContent = "Page script loaded (activate v1). Tick the box, type the phrase, then click Sign Step 6.";
function findRabby() {
  if (window.rabby && typeof window.rabby.request === "function") return window.rabby;
  const eth = window.ethereum;
  if (eth && Array.isArray(eth.providers)) { const r = eth.providers.find((x) => x && x.isRabby); if (r) return r; }
  if (eth && eth.isRabby) return eth;
  return null;
}
function walletDiag() {
  const eth = window.ethereum;
  if (!eth && !window.rabby) return "No wallet extension found on this page. Open it in the Chrome profile where Rabby is installed, and make sure Rabby is unlocked.";
  const names = [eth && eth.isMetaMask && "MetaMask", eth && eth.isCoinbaseWallet && "Coinbase", eth && eth.isRabby && "Rabby"].filter(Boolean).join(", ") || "an unknown wallet";
  return "Found " + names + " but not Rabby. In Rabby, make sure it is enabled for this site (not flipped to MetaMask) and unlocked, then reload.";
}
const withTimeout = (p, ms, msg) => Promise.race([p, new Promise((_, rej) => setTimeout(() => rej(new Error(msg)), ms))]);
let done = 0;
const hex = (n) => "0x" + BigInt(n).toString(16);
function arm() { STEPS.forEach((s, i) => { $("b-" + s.id).disabled = i !== done; }); }
$("review").addEventListener("change", arm);
window.addEventListener("pageshow", arm);
arm();
async function sleep(ms) { return new Promise((r) => setTimeout(r, ms)); }
STEPS.forEach((s, i) => $("b-" + s.id).addEventListener("click", async () => {
  const out = (h) => { $("o-" + s.id).innerHTML = h; };
  if (($("phrase").value || "").trim() !== "ACTIVATE 24-HOUR CLAIM") { out('<span class="bad">Type ACTIVATE 24-HOUR CLAIM exactly in the box above.</span>'); return; }
  if (!$("review").checked) { out('<span class="bad">Tick the authorization box above first.</span>'); return; }
  $("b-" + s.id).disabled = true;
  try {
    out("Contacting Rabby… if no popup appears, click the Rabby icon in the Chrome toolbar — a request may be waiting there.");
    const rabby = findRabby();
    if (!rabby) throw new Error(walletDiag());
    const accounts = await withTimeout(rabby.request({ method: "eth_requestAccounts" }), 60000, "Rabby did not answer the connect request within 60 s. Open the Rabby extension (toolbar icon), approve the connection, then click Sign Step 6 again.");
    const chainId = Number(BigInt(await rabby.request({ method: "eth_chainId" })));
    if (chainId !== CHAIN) throw new Error("Rabby is on chain " + chainId + ". Switch to Avalanche C-Chain (43114).");
    if (accounts[0].toLowerCase() !== FROM.toLowerCase()) throw new Error("Rabby account is " + accounts[0] + ". Switch to " + FROM + ".");
    const nonce = Number(BigInt(await rabby.request({ method: "eth_getTransactionCount", params: [FROM, "pending"] })));
    if (nonce !== s.nonce) throw new Error("Wallet nonce is " + nonce + ", expected " + s.nonce + ". STOP — do not sign. Report this.");
    const bal = BigInt(await rabby.request({ method: "eth_getBalance", params: [FROM, "latest"] }));
    if (bal < 2000000000000000n) throw new Error("Wallet balance is " + (Number(bal) / 1e18) + " AVAX. Send at least 0.01 AVAX to " + FROM + " first, then retry.");
    const tx = { from: FROM, value: "0x0", data: s.data, gas: hex(s.gas), nonce: hex(s.nonce) };
    if (s.to) tx.to = s.to;
    const est = BigInt(await rabby.request({ method: "eth_estimateGas", params: [{ from: FROM, value: "0x0", data: s.data, ...(s.to ? { to: s.to } : {}) }] }));
    if (est > BigInt(s.gas)) throw new Error("Simulation needs " + est + " gas, above the ceiling " + s.gas + ". STOP.");
    out("Simulation OK (" + est + " gas). Confirm in Rabby: nonce " + s.nonce + ", gas limit " + s.gas + ", value 0" + (s.to ? "" : ", no 'to' (contract creation)") + ".");
    const hash = await rabby.request({ method: "eth_sendTransaction", params: [tx] });
    out('<span class="ok">Sent: <code>' + hash + '</code></span><br>Waiting for confirmation… do not close this page.');
    let receipt = null;
    for (let k = 0; k < 100 && !receipt; k++) { await sleep(3000); receipt = await rabby.request({ method: "eth_getTransactionReceipt", params: [hash] }).catch(() => null); }
    if (!receipt) { out('Sent <code>' + hash + '</code> but not confirmed yet. <b>Do not resend.</b> Check <a style="color:#7bed9f" target="_blank" rel="noreferrer" href="https://snowtrace.io/tx/' + hash + '">Snowtrace</a> and report.'); return; }
    if (Number(receipt.status) !== 1) throw new Error("Transaction " + hash + " reverted. STOP and report.");
    let extra = "";
    if (!s.to) {
      const addr = (receipt.contractAddress || "").toLowerCase();
      extra = addr === PREDICTED ? '<br>Claim contract: <code>' + receipt.contractAddress + '</code> (matches prediction)' : '<br><span class="bad">Contract address ' + receipt.contractAddress + ' differs from prediction. STOP and report.</span>';
      if (addr !== PREDICTED) { out('<span class="bad">Deployed but address mismatch.</span>' + extra); return; }
    }
    out('<span class="ok">CONFIRMED: <code>' + hash + '</code></span>' + extra + '<br><a style="color:#7bed9f" target="_blank" rel="noreferrer" href="https://snowtrace.io/tx/' + hash + '">View on Snowtrace</a>');
    const word = async (sel) => BigInt(await rabby.request({ method: "eth_call", params: [{ to: "0x6A251b2F591Df265A8D2B42991b4e672236e4F4A", data: sel }, "latest"] }));
    const cs = await word("0xf04d688f"), ce = await word("0x3ccfa92f"), act = await word("0x02fb0c5e"), pz = await word("0x5c975abb");
    const ok = act === 1n && pz === 0n && ce === cs + 86400n;
    extra += ok ? '<br><b class="ok">CLAIM IS OPEN.</b> Started ' + new Date(Number(cs) * 1000).toUTCString() + ', closes <b>' + new Date(Number(ce) * 1000).toUTCString() + '</b> (' + new Date(Number(ce) * 1000).toLocaleString() + ' your time).' : '<br><span class="bad">Window check failed (active ' + act + ', paused ' + pz + ', start ' + cs + ', end ' + ce + '). Report this.</span>';
    out('<span class="ok">CONFIRMED: <code>' + hash + '</code></span>' + extra + '<br><a style="color:#7bed9f" target="_blank" rel="noreferrer" href="https://snowtrace.io/tx/' + hash + '">View on Snowtrace</a>');
    done = i + 1; arm();
    if (done === STEPS.length) $("o-" + s.id).innerHTML += '<p class="ok"><b>Step 6 done. Send the hash for on-chain verification.</b></p>';
  } catch (e) {
    out('<span class="bad">' + (e.code === 4001 ? "You rejected it in Rabby. Nothing was signed." : (e.message || e)) + '</span>');
    arm();
  }
}));
