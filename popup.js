// DeskLemurOS Browser Bridge — toolbar popup.
//
// Shows whether this browser is connected to DeskLemurOS and, when it is not,
// which of the three independent causes it is — each has a different fix, and
// Chrome reports them only as a short English string on the closed port.
// Opening the popup also asks the service worker to connect, so it doubles as
// the "DeskLemurOS just started, connect now" button.

const REASONS = [
  {
    // No host manifest for this browser.
    match: /host not found/i,
    headline: "Not set up in this browser",
    guidance: "DeskLemurOS is not registered with this browser. In DeskLemurOS, open Tools → websurfing → Policy and choose “Register with Chrome”.",
  },
  {
    // A manifest exists but does not list this extension's ID.
    match: /forbidden/i,
    headline: "Not allowed by DeskLemurOS",
    guidance: "The registration in DeskLemurOS does not include this extension. Choose “Register with Chrome” again under Tools → websurfing → Policy.",
  },
  {
    // The host started and found no app listening.
    match: /exited/i,
    headline: "DeskLemurOS is not reachable",
    guidance: "DeskLemurOS is not running, or its browser bridge is switched off. Start DeskLemurOS and enable the bridge under Tools → websurfing → Policy.",
  },
];

function describe(link) {
  if (!link) {
    return { state: "disconnected", headline: "Extension is starting", guidance: "Try again in a moment.", detail: "" };
  }
  if (link.state === "connected") {
    return {
      state: "connected",
      headline: "Connected to DeskLemurOS",
      guidance: "DeskLemurOS can open pages in background tabs of this browser and read them. It cannot read tabs you opened yourself.",
      detail: "",
    };
  }
  if (link.state === "connecting") {
    return { state: "connecting", headline: "Connecting…", guidance: "Looking for DeskLemurOS on this computer.", detail: "" };
  }
  if (link.state === "rejected") {
    return {
      state: "rejected",
      headline: "Version mismatch",
      guidance: "DeskLemurOS and this extension use different bridge versions. Update whichever is older.",
      detail: link.detail || "",
    };
  }
  const known = REASONS.find(reason => reason.match.test(link.detail || ""));
  if (known) {
    return { state: "disconnected", headline: known.headline, guidance: known.guidance, detail: "" };
  }
  return {
    state: "disconnected",
    headline: "Not connected",
    guidance: "DeskLemurOS could not be reached from this browser.",
    // An unrecognised reason is shown as Chrome gave it, rather than guessed at.
    detail: link.detail || "",
  };
}

function render(link) {
  const view = describe(link);
  document.body.dataset.state = view.state;
  document.getElementById("headline").textContent = view.headline;
  document.getElementById("guidance").textContent = view.guidance;
  const detail = document.getElementById("detail");
  detail.textContent = view.detail;
  detail.hidden = !view.detail;
  document.getElementById("connect").hidden = view.state === "connected" || view.state === "connecting";
  document.getElementById("version").textContent = link?.version ? `v${link.version}` : "";
}

async function ask(type) {
  try {
    return await chrome.runtime.sendMessage({ type });
  } catch {
    return null; // the service worker is still starting
  }
}

async function refresh(type) {
  render(await ask(type));
}

document.getElementById("connect").addEventListener("click", () => refresh("connect"));
// The connection settles a moment after it is requested, so keep reading the
// state while the popup is open.
refresh("connect");
setInterval(() => refresh("status"), 700);
