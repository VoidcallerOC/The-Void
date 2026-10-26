// The reviewed Genesis launch transactions on Avalanche C-Chain: six from the artist wallet and the single
// early-access test mint from 0x6a86…d2fb. No libraries, no keys. Each step is fixed call data (the test mint
// adds only the server's signed voucher, checked field by field), offered only after its live checks pass, and
// sent through the user's Rabby on an explicit click. Schedule (America/New_York): test mint window
// Mon Oct 26 05:00-06:00 EDT; Genesis claim and the paid sale's scheduled start Mon Oct 26 09:00 EDT, with the
// sale paused (purchase() checks paused before startTime) until the claim closes Tue Oct 27 09:00 EDT; then the paid sale alone until Tue Nov 3 07:59:59 EST (8-day public window, 7 full paid days).
(function () {
  var CHAIN_ID = 43114;
  var ARTIST = "0x284c09a7cc187e096cbbdc88d99defe6df32180a";
  var RELEASE = "0xf0c091a159de16cf0f306b2b61d37685ec5a830e";
  var SALE = "0xb4daae78a53c33f52c6eb573c4d6efc7b86f3845";
  var OLD_CLAIM = "0x8512be04a4e54cd8551738165f9c05c3303187a0";
  // GenesisHolderClaim the deployer creates at nonce 11 (getCreateAddress(0xaBd3…c174, 11)).
  var NEW_CLAIM = "0x7d1a068f532ad6c0f591d4fb9f82fd5b97495363";
  var SIGNER = "0xad3a1026b06c2a0b2091322410254363e2764c4e";
  var CLAIM_START = 1793019600;
  var CLAIM_END = 1793106000;
  var SALE_END = 1793710799;
  // One early-access test mint (EARLY_ACCESS_QUANTITY = 1) to this wallet: 05:00-06:00 EDT (end is the first
  // refused second), well before claimStart.
  var TEST_WALLET = "0x6a86efa012feda64b70112022487fee22e67d2fb";
  var EARLY_START = 1793005200;
  var EARLY_END = 1793008800;
  var PRICE_WEI = "250000000000000000";
  var ISSUER_ROLE = "0x114e74f6ea3bd819998f78687bfcb11b140da08e9b7d222fa9c1f1ba1f2aa122";
  var RESCHEDULE = "0x23a12617000000000000000000000000000000000000000000000000000000000000000100000000000000000000000000000000000000000000000003782dace9d9000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000003000000000000000000000000000000000000000000000000000000006adf4ed0000000000000000000000000000000000000000000000000000000006ae9dacf0000000000000000000000000000000000000000000000000000000000000000";
  var PAUSE = "0x23a12617000000000000000000000000000000000000000000000000000000000000000100000000000000000000000000000000000000000000000003782dace9d9000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000003000000000000000000000000000000000000000000000000000000006adf4ed0000000000000000000000000000000000000000000000000000000006ae9dacf0000000000000000000000000000000000000000000000000000000000000001";
  var EARLY_CONFIG = "0x9dc048040000000000000000000000006a86efa012feda64b70112022487fee22e67d2fb000000000000000000000000000000000000000000000000000000006adf1690000000000000000000000000000000000000000000000000000000006adf24a0";
  var EARLY_MINT = "0x43e6253e"; // earlyAccessMint((address,uint256,address,uint256,uint256,uint256,uint256,uint256,uint256),bytes)
  var GRANT = "0x2f2ff15d114e74f6ea3bd819998f78687bfcb11b140da08e9b7d222fa9c1f1ba1f2aa1220000000000000000000000007d1a068f532ad6c0f591d4fb9f82fd5b97495363";
  var REVOKE = "0xd547741f114e74f6ea3bd819998f78687bfcb11b140da08e9b7d222fa9c1f1ba1f2aa1220000000000000000000000008512be04a4e54cd8551738165f9c05c3303187a0";
  var SALES_1 = "0xb5f522f70000000000000000000000000000000000000000000000000000000000000001";
  var HAS_ROLE = "0x91d14854";
  var CLAIM_VIEWS = { signer: "0x238ac933", admin: "0xf851a440", claimStart: "0xf04d688f", claimEnd: "0x3ccfa92f", publicSaleEnd: "0xec9b5cb2", releaseContract: "0xc71ddb9f", primarySale: "0xa639ad79", tokenId: "0x17d70f7c", earlyAccessEnabled: "0xd99f35b7", earlyAccessClaimed: "0x959ead6c", earlyAccessWallet: "0x33d3a882", earlyAccessStart: "0x5db24af4", earlyAccessEnd: "0xffb62fdf" };
  var $ = function (id) { return document.getElementById(id); };
  var announced = {};
  var provider = null;
  var live = null;

  window.addEventListener("eip6963:announceProvider", function (e) {
    if (e.detail && e.detail.info && e.detail.provider) announced[e.detail.info.rdns] = e.detail.provider;
  });
  window.dispatchEvent(new Event("eip6963:requestProvider"));

  function call(to, data) { return provider.request({ method: "eth_call", params: [{ to: to, data: data }, "latest"] }); }
  function word(hex, i) { return BigInt("0x" + hex.slice(2 + 64 * i, 66 + 64 * i)); }
  function addr(hex) { return "0x" + hex.slice(-40).toLowerCase(); }
  function pad(a) { return "0".repeat(24) + a.slice(2); }

  async function read() {
    var accounts = await provider.request({ method: "eth_accounts" });
    var s = { account: accounts[0] ? accounts[0].toLowerCase() : null, chainId: Number(BigInt(await provider.request({ method: "eth_chainId" }))) };
    if (s.chainId !== CHAIN_ID) return s;
    var block = await provider.request({ method: "eth_getBlockByNumber", params: ["latest", false] });
    s.now = Number(BigInt(block.timestamp));
    var sale = await call(SALE, SALES_1);
    s.sale = { price: word(sale, 0).toString(), maxSupply: word(sale, 1), sold: word(sale, 2), limit: word(sale, 3), start: Number(word(sale, 4)), end: Number(word(sale, 5)), paused: word(sale, 6) === 1n, configured: word(sale, 7) === 1n };
    s.hasNew = BigInt(await call(RELEASE, HAS_ROLE + ISSUER_ROLE.slice(2) + pad(NEW_CLAIM))) === 1n;
    s.hasOld = BigInt(await call(RELEASE, HAS_ROLE + ISSUER_ROLE.slice(2) + pad(OLD_CLAIM))) === 1n;
    var code = await provider.request({ method: "eth_getCode", params: [NEW_CLAIM, "latest"] });
    s.claim = null;
    if (code && code !== "0x") {
      var v = {};
      for (var k in CLAIM_VIEWS) v[k] = await call(NEW_CLAIM, CLAIM_VIEWS[k]);
      s.claim = { signer: addr(v.signer), admin: addr(v.admin), claimStart: Number(BigInt(v.claimStart)), claimEnd: Number(BigInt(v.claimEnd)), publicSaleEnd: Number(BigInt(v.publicSaleEnd)), release: addr(v.releaseContract), sale: addr(v.primarySale), tokenId: BigInt(v.tokenId),
        early: { enabled: BigInt(v.earlyAccessEnabled) === 1n, claimed: BigInt(v.earlyAccessClaimed) === 1n, wallet: addr(v.earlyAccessWallet), start: Number(BigInt(v.earlyAccessStart)), end: Number(BigInt(v.earlyAccessEnd)) } };
    }
    return s;
  }

  function saleTermsKept(s) { return s.sale.configured && s.sale.price === PRICE_WEI && s.sale.maxSupply === 0n && s.sale.limit === 3n; }
  function saleScheduled(s) { return s.sale.start === CLAIM_START && s.sale.end === SALE_END && saleTermsKept(s); }
  function claimVerified(s) {
    var c = s.claim;
    return !!c && c.signer === SIGNER && c.admin === ARTIST && c.claimStart === CLAIM_START && c.claimEnd === CLAIM_END && c.publicSaleEnd === SALE_END && c.release === RELEASE && c.sale === SALE && c.tokenId === 1n;
  }

  function earlyConfigured(s) { var e = s.claim && s.claim.early; return !!e && e.enabled && e.wallet === TEST_WALLET && e.start === EARLY_START && e.end === EARLY_END; }

  var STEPS = [
    { n: 1, from: ARTIST, title: "Reschedule the paid sale (unpaused, same price, supply and limit)", to: SALE, data: RESCHEDULE,
      checks: function (s) { return [[s.now + 3600 <= EARLY_START, "At least 1 hour before the 05:00 EDT test window (" + (EARLY_START - s.now) + "s left)"], [s.sale.sold === 0n, "No paid mints yet (sold " + s.sale.sold + ")"], [saleTermsKept(s), "Sale keeps 0.25 AVAX, uncapped, 3 per wallet"], [!saleScheduled(s), "Sale is not already rescheduled"]]; } },
    { n: 2, from: ARTIST, title: "Configure the single early-access test mint for " + TEST_WALLET, to: NEW_CLAIM, data: EARLY_CONFIG,
      checks: function (s) { return [[claimVerified(s), "New claim " + NEW_CLAIM + " is deployed with signer " + SIGNER + ", admin = artist and the planned schedule"], [s.now + 300 <= EARLY_START, "At least 5 minutes before the test window opens (" + (EARLY_START - s.now) + "s left)"], [!!s.claim && !s.claim.early.enabled && !s.claim.early.claimed, "Early access not configured or used yet"]]; } },
    { n: 3, from: ARTIST, title: "Grant ISSUER_ROLE to the new claim", to: RELEASE, data: GRANT,
      checks: function (s) { return [[claimVerified(s), "New claim is deployed and verified as planned"], [!s.hasNew, "New claim does not hold ISSUER_ROLE yet"]]; } },
    { n: 4, from: ARTIST, title: "Revoke ISSUER_ROLE from the old claim " + OLD_CLAIM, to: RELEASE, data: REVOKE,
      checks: function (s) { return [[s.hasNew, "New claim already holds ISSUER_ROLE"], [s.hasOld, "Old claim still holds ISSUER_ROLE"]]; } },
    { n: 5, from: ARTIST, title: "Pause the paid sale for the claim day (its scheduled start stays Mon 09:00 EDT)", to: SALE, data: PAUSE,
      checks: function (s) { return [[claimVerified(s), "New claim is deployed and verified as planned"], [saleScheduled(s), "Sale is rescheduled to " + CLAIM_START + "-" + SALE_END], [!s.sale.paused, "Sale is not paused yet"], [s.now < CLAIM_START, "Before the claim start"]]; } },
    { n: 6, from: TEST_WALLET, title: "Test mint: exactly 1 token to " + TEST_WALLET + " (early access, free)", to: NEW_CLAIM, data: null,
      checks: function (s) { return [[claimVerified(s) && earlyConfigured(s), "Early access is configured for this wallet, " + EARLY_START + "-" + EARLY_END], [s.hasNew, "New claim holds ISSUER_ROLE"], [s.now >= EARLY_START && s.now < EARLY_END, "Inside the test window (05:00-06:00 EDT)"], [!!s.claim && !s.claim.early.claimed, "The test mint has not happened yet"], [saleScheduled(s), "Sale schedule unchanged"]]; } },
    { n: 7, from: ARTIST, title: "Unpause the paid sale when the claim closes (Tue 09:00 EDT)", to: SALE, data: RESCHEDULE,
      checks: function (s) { return [[s.now >= CLAIM_END, "The claim window has closed (" + (CLAIM_END - s.now) + "s to go)"], [saleScheduled(s), "Sale schedule unchanged"], [s.sale.paused, "Sale is paused"]]; } },
  ];

  function w(hex) { return BigInt(hex).toString(16).padStart(64, "0"); }
  // The server's early-access voucher, accepted only if every field is the fixed value this page expects.
  async function testMintData() {
    var response = await fetch("/api/claims/early-access/vouchers", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ wallet: TEST_WALLET }) });
    var body = await response.json();
    if (!response.ok) throw new Error((body && body.error && body.error.message) || "The server refused the early-access voucher.");
    var v = body.data.voucher, sig = String(body.data.signature);
    if (v.claimant.toLowerCase() !== TEST_WALLET || Number(v.destinationChainId) !== CHAIN_ID || v.releaseContract.toLowerCase() !== RELEASE || String(v.tokenId) !== "1"
      || String(v.quantity) !== "1" || Number(v.windowStart) !== EARLY_START || Number(v.windowEnd) !== EARLY_END || !/^0x[0-9a-fA-F]{130}$/.test(sig)) throw new Error("The voucher does not match the reviewed test mint. Nothing was sent.");
    var words = [v.claimant, v.destinationChainId, v.releaseContract, v.tokenId, v.quantity, v.windowStart, v.windowEnd, v.nonce, v.deadline].map(function (x) { return w(x); }).join("");
    return EARLY_MINT + words + w(320) + w(65) + sig.slice(2) + "0".repeat(62);
  }

  function row(ok, text) { return "<tr><td class=\"" + (ok ? "ok" : "bad") + "\">" + (ok ? "PASS" : "FAIL") + "</td><td>" + text + "</td></tr>"; }
  function base(s, step) { return [[!!provider, "Rabby detected"], [s.chainId === CHAIN_ID, "Chain is Avalanche C-Chain 43114 (wallet reports " + s.chainId + ")"], [s.account === step.from, "Active account is " + (step.from === ARTIST ? "the artist wallet " : "the test wallet ") + step.from + " (connected: " + s.account + ")"]]; }
  function ready(step) { return live && $("review" + step.n).checked && base(live, step).concat(live.chainId === CHAIN_ID ? step.checks(live) : [[false, "wrong chain"]]).every(function (c) { return c[0]; }); }

  function render() {
    $("steps").innerHTML = STEPS.map(function (step) {
      var checks = !live ? [] : base(live, step).concat(live.chainId === CHAIN_ID ? step.checks(live) : []);
      return "<section><h2>Step " + step.n + ": " + step.title + "</h2><table><tr><td>To</td><td><code>" + step.to + "</code></td></tr><tr><td>Value</td><td>0</td></tr><tr><td>Data</td><td><code>" + (step.data || "earlyAccessMint(server voucher for " + TEST_WALLET + ", quantity 1), checked field by field before sending") + "</code></td></tr></table><table>" +
        checks.map(function (c) { return row(c[0], c[1]); }).join("") + "</table><label><input type=\"checkbox\" id=\"review" + step.n + "\"> I reviewed step " + step.n + " and its checks pass.</label><br><button id=\"send" + step.n + "\" disabled>Request step " + step.n + " in Rabby</button><pre id=\"result" + step.n + "\"></pre></section>";
    }).join("");
    STEPS.forEach(function (step) {
      $("review" + step.n).addEventListener("change", function () { $("send" + step.n).disabled = !ready(step); });
      $("send" + step.n).addEventListener("click", function () { send(step); });
    });
  }

  async function refresh() { live = await read(); render(); }

  async function send(step) {
    var out = $("result" + step.n);
    try {
      live = await read();
      var checks = base(live, step).concat(live.chainId === CHAIN_ID ? step.checks(live) : [[false, "wrong chain"]]);
      if (!checks.every(function (c) { return c[0]; })) { out.textContent = "Checks no longer pass. Nothing was sent."; return; }
      var data = step.data || await testMintData();
      var hash = await provider.request({ method: "eth_sendTransaction", params: [{ from: step.from, to: step.to, value: "0x0", data: data }] });
      out.textContent = "Submitted. Transaction hash (send this to Claude):\n" + hash;
    } catch (e) {
      out.textContent = (e && e.code === 4001) ? "You rejected the request in Rabby. Nothing was sent." : "Rabby returned an error: " + (e && e.message || e) + "\nCheck Rabby's activity before trying again.";
    }
  }

  $("connect").addEventListener("click", async function () {
    provider = announced["io.rabby"] || (window.ethereum && window.ethereum.isRabby === true ? window.ethereum : null);
    if (!provider) { $("status").textContent = "Rabby was not detected. Unlock or install Rabby, then reload."; return; }
    try { await provider.request({ method: "eth_requestAccounts" }); await refresh(); } catch (e) { $("status").textContent = "Connect failed: " + (e && e.message || e); }
  });
  $("refresh").addEventListener("click", function () { if (provider) refresh(); });
  render();
})();
