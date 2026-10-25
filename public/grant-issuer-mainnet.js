// One reviewed transaction: grantRole(ISSUER_ROLE, claim) on the mainnet Forgive & Forget release (Avalanche C-Chain), from the artist wallet.
// No libraries, no keys. Submission only through the user's Rabby, on an explicit click.
(function () {
  var CHAIN_ID = 43114;
  var ARTIST = "0x284c09a7cc187e096cbbdc88d99defe6df32180a";
  var RELEASE = "0xf0c091a159de16cf0f306b2b61d37685ec5a830e";
  var CLAIM = "0x8512be04a4e54cd8551738165f9c05c3303187a0";
  var ISSUER_ROLE = "0x114e74f6ea3bd819998f78687bfcb11b140da08e9b7d222fa9c1f1ba1f2aa122";
  var ADMIN_ROLE = "0x" + "0".repeat(64);
  var SELECTOR = "0x2f2ff15d"; // grantRole(bytes32,address)
  var HAS_ROLE = "0x91d14854"; // hasRole(bytes32,address)
  var DATA = "0x2f2ff15d114e74f6ea3bd819998f78687bfcb11b140da08e9b7d222fa9c1f1ba1f2aa1220000000000000000000000008512be04a4e54cd8551738165f9c05c3303187a0";
  var $ = function (id) { return document.getElementById(id); };
  var announced = {};
  var provider = null;
  var state = { account: null, chainId: null, artistIsAdmin: null, alreadyGranted: null };

  window.addEventListener("eip6963:announceProvider", function (e) {
    if (e.detail && e.detail.info && e.detail.provider) announced[e.detail.info.rdns] = e.detail.provider;
  });
  window.dispatchEvent(new Event("eip6963:requestProvider"));

  function pad(addr) { return "0".repeat(24) + addr.slice(2); }
  function decoded() {
    return { selector: DATA.slice(0, 10), role: "0x" + DATA.slice(10, 74), account: "0x" + DATA.slice(98).slice(-40) };
  }
  function callMatches() {
    var d = decoded();
    return DATA.length === 2 + 8 + 64 + 64 && d.selector === SELECTOR && d.role === ISSUER_ROLE && d.account === CLAIM;
  }
  function renderCall() {
    var d = decoded();
    $("call").innerHTML = "<tr><td>Chain</td><td>Avalanche C-Chain (43114)</td></tr>" +
      "<tr><td>From</td><td><code>" + ARTIST + "</code> (artist wallet)</td></tr>" +
      "<tr><td>To</td><td><code>" + RELEASE + "</code> (release)</td></tr>" +
      "<tr><td>Value</td><td>0</td></tr>" +
      "<tr><td>Function</td><td><code>grantRole(bytes32 role, address account)</code> " + d.selector + "</td></tr>" +
      "<tr><td>role</td><td><code>" + d.role + "</code> (ISSUER_ROLE)</td></tr>" +
      "<tr><td>account</td><td><code>" + d.account + "</code> (Genesis claim contract)</td></tr>" +
      "<tr><td>Data</td><td><code>" + DATA + "</code></td></tr>";
  }
  function ethCall(data) {
    return provider.request({ method: "eth_call", params: [{ to: RELEASE, data: data }, "latest"] });
  }
  async function readRoles() {
    state.artistIsAdmin = BigInt(await ethCall(HAS_ROLE + ADMIN_ROLE.slice(2) + pad(ARTIST))) === 1n;
    state.alreadyGranted = BigInt(await ethCall(HAS_ROLE + ISSUER_ROLE.slice(2) + pad(CLAIM))) === 1n;
  }
  function row(ok, text) { return "<tr><td class=\"" + (ok ? "ok" : "bad") + "\">" + (ok ? "PASS" : "FAIL") + "</td><td>" + text + "</td></tr>"; }
  function ready() {
    return provider && callMatches() && state.chainId === CHAIN_ID && state.account === ARTIST && state.artistIsAdmin === true && state.alreadyGranted === false;
  }
  function renderChecks() {
    $("checks").innerHTML = "<table>" +
      row(callMatches(), "Call data decodes to grantRole(ISSUER_ROLE, claim)") +
      row(!!provider, "Rabby detected") +
      row(state.chainId === CHAIN_ID, "Chain is Avalanche C-Chain 43114 (wallet reports " + state.chainId + ")") +
      row(state.account === ARTIST, "Active account is the artist wallet (" + state.account + ")") +
      row(state.artistIsAdmin === true, "Artist wallet holds DEFAULT_ADMIN_ROLE on the release") +
      row(state.alreadyGranted === false, state.alreadyGranted === true ? "The claim already holds ISSUER_ROLE: nothing to send" : "The claim does not yet hold ISSUER_ROLE") + "</table>";
    $("send").disabled = !(ready() && $("review").checked);
  }
  async function refresh() {
    var accounts = await provider.request({ method: "eth_accounts" });
    state.account = accounts[0] ? accounts[0].toLowerCase() : null;
    state.chainId = Number(BigInt(await provider.request({ method: "eth_chainId" })));
    if (state.chainId === CHAIN_ID) await readRoles();
    renderChecks();
  }
  $("connect").addEventListener("click", async function () {
    provider = announced["io.rabby"] || (window.ethereum && window.ethereum.isRabby === true ? window.ethereum : null);
    if (!provider) { renderChecks(); $("result").textContent = "Rabby was not detected. Unlock or install Rabby, then reload."; return; }
    try { await provider.request({ method: "eth_requestAccounts" }); await refresh(); } catch (e) { $("result").textContent = "Connect failed: " + (e && e.message || e); }
  });
  $("review").addEventListener("change", renderChecks);
  $("send").addEventListener("click", async function () {
    try {
      await refresh();
      if (!ready() || !$("review").checked) { $("result").textContent = "Checks no longer pass. Nothing was sent."; return; }
      var hash = await provider.request({ method: "eth_sendTransaction", params: [{ from: ARTIST, to: RELEASE, value: "0x0", data: DATA }] });
      $("result").textContent = "Submitted. Transaction hash (send this to Claude):\n" + hash;
    } catch (e) {
      $("result").textContent = (e && e.code === 4001) ? "You rejected the request in Rabby. Nothing was sent." : "Rabby returned an error: " + (e && e.message || e) + "\nCheck Rabby's activity before trying again.";
    }
  });
  renderCall();
  renderChecks();
})();
