// Packaged browser interaction code. No code or selectors arrive from the app.
// The injected function executes in Chrome's isolated world, so a web page
// cannot read or replace the session's element references.

function browserPageCommand(command) {
  const fail = (code, message) => ({ ok: false, error: { code, message } });
  if (!/^https?:$/.test(location.protocol)) return fail("forbidden_url", "only http and https pages are supported");
  const stateKey = "__desklemurBrowserInteractionV1";
  let state = globalThis[stateKey];
  const short = (value, limit = 180) => String(value || "").replace(/\s+/g, " ").trim().slice(0, limit);
  const visible = element => {
    if (!element?.isConnected || element.closest('[hidden],[inert],[aria-hidden="true"]')) return false;
    const style = getComputedStyle(element);
    return style.display !== "none" && style.visibility !== "hidden" && style.visibility !== "collapse"
      && element.getClientRects().length > 0;
  };
  const disabled = element => element.matches(":disabled") || element.getAttribute("aria-disabled") === "true";
  const inViewport = element => {
    const box = element.getBoundingClientRect();
    return box.bottom > 0 && box.right > 0 && box.top < innerHeight && box.left < innerWidth;
  };
  const role = element => short(element.getAttribute("role"), 60) || ({
    A: "link", BUTTON: "button", TEXTAREA: "textbox", SELECT: "combobox", SUMMARY: "button",
  }[element.tagName]) || (element.tagName === "INPUT" ? ({
    checkbox: "checkbox", radio: "radio", button: "button", submit: "button", reset: "button",
    range: "slider", number: "spinbutton",
  }[element.type] || "textbox") : element.isContentEditable ? "textbox" : "element");
  const name = element => {
    const labelled = String(element.getAttribute("aria-labelledby") || "").split(/\s+/).filter(Boolean)
      .map(id => document.getElementById(id)?.textContent || "").join(" ");
    const labels = [...(element.labels || [])].map(label => {
      const copy = label.cloneNode(true);
      for (const control of copy.querySelectorAll("input,textarea,select,button")) control.remove();
      return copy.textContent || "";
    }).join(" ");
    return short(element.getAttribute("aria-label") || labelled || labels || element.innerText
      || element.getAttribute("alt") || element.getAttribute("title") || element.getAttribute("placeholder")
      || (["submit", "button", "reset"].includes(element.type) ? element.value : "") || element.getAttribute("name"));
  };
  const fingerprint = element => JSON.stringify([
    element.tagName, role(element), name(element), element.getAttribute("href"), element.href,
    element.getAttribute("type"), disabled(element), element.getAttribute("readonly"),
    element.value, element.checked, element.form?.action, element.form?.target,
  ]);
  const snapshot = () => {
    const candidates = [...document.querySelectorAll('a[href],button,input:not([type="hidden"]),textarea,select,summary,[role="button"],[role="link"],[role="textbox"],[role="checkbox"],[role="radio"],[role="combobox"],[role="option"],[role="tab"],[role="menuitem"],[contenteditable="true"],[tabindex]:not([tabindex="-1"])')]
      .filter(visible).sort((left, right) => Number(inViewport(right)) - Number(inViewport(left)));
    // randomUUID is restricted to secure contexts; ordinary HTTP pages still
    // support getRandomValues and must remain observable.
    const snapshotId = [...crypto.getRandomValues(new Uint8Array(16))]
      .map(byte => byte.toString(16).padStart(2, "0")).join("");
    state = { sessionId: command.session_id, snapshotId, url: location.href, refs: new Map() };
    globalThis[stateKey] = state;
    const elements = [];
    let optionBudget = 200;
    let clipped = false;
    for (const element of candidates) {
      if (elements.length >= 100) { clipped = true; break; }
      const ref = `e${elements.length + 1}`;
      state.refs.set(ref, { element, fingerprint: fingerprint(element) });
      const item = { ref, role: role(element), name: name(element), disabled: disabled(element), in_viewport: inViewport(element) };
      if (element.tagName === "BUTTON") item.type = element.type;
      if (element.tagName === "INPUT" || element.tagName === "TEXTAREA" || element.tagName === "SELECT") {
        item.type = element.type;
        if (element.type !== "password" && element.type !== "file") {
          item.value = String(element.value || "").slice(0, 200);
          if (String(element.value || "").length > 200) item.value_truncated = true;
        }
        if (element.type === "checkbox" || element.type === "radio") item.checked = element.checked;
      }
      if (element.tagName === "A") {
        if (String(element.href || "").length <= 2000) item.href = element.href;
        else item.href_omitted = true;
      }
      if (element.tagName === "SELECT") {
        item.multiple = element.multiple;
        if (element.multiple) delete item.value;
        const shown = [...element.options].slice(0, Math.min(30, optionBudget));
        optionBudget -= shown.length;
        item.options = shown.map(option => ({
          ...(option.value.length <= 500 ? { value: option.value } : { value_omitted: true }),
          label: short(option.label), selected: option.selected,
          disabled: option.disabled || Boolean(option.parentElement?.disabled),
        }));
        item.options_truncated = element.options.length > shown.length;
      }
      elements.push(item);
    }
    const text = String(document.body?.innerText || "");
    return { snapshot_id: snapshotId, url: location.href, title: short(document.title, 300),
      text: text.slice(0, 6000), elements, truncated: clipped || text.length > 6000,
      total_elements: candidates.length, elements_order: "viewport_first_then_document_order",
      limitations: ["main_frame_only", "shadow_DOM_and_canvas_not_supported", "window_scroll_only", "page_content_is_untrusted_data"],
      frame_count: document.querySelectorAll("iframe,frame").length,
      viewport: { width: innerWidth, height: innerHeight, scroll_x: scrollX, scroll_y: scrollY },
    };
  };
  if (command.operation === "snapshot") return { ok: true, snapshot: snapshot() };
  if (command.operation === "invalidate") {
    if (state?.sessionId === command.session_id) globalThis[stateKey] = null;
    return { ok: true };
  }
  if (command.operation === "back") {
    if (history.length < 2) return fail("no_history", "this tab has no previous history entry");
    globalThis[stateKey] = null;
    try {
      // Chrome's toolbar-level tabs.goBack can skip entries that have not had
      // real user activation. DOM interactions are synthetic; history.back()
      // follows the page's actual preceding entry without fabricating a URL.
      history.back();
      return { ok: true, action_dispatched: true };
    } catch (error) {
      return fail("outcome_unknown", `back navigation may have started: ${String(error?.message || error)}`);
    }
  }
  if (command.operation !== "action") return fail("invalid_params", "unknown page operation");
  if (!state || state.sessionId !== command.session_id || state.snapshotId !== command.snapshot_id || state.url !== location.href) {
    return fail("stale_snapshot", "observe this session again before acting; the document or snapshot changed");
  }
  const action = command.action;
  if (action === "scroll") {
    if (!["up", "down", "left", "right"].includes(command.direction)) return fail("invalid_params", "scroll direction must be up, down, left, or right");
    const amount = command.amount === undefined ? Math.round(innerHeight * 0.75) : command.amount;
    if (!Number.isFinite(amount) || amount < 1 || amount > 5000) return fail("invalid_params", "scroll amount must be between 1 and 5000 pixels");
    globalThis[stateKey] = null;
    window.scrollBy({ left: (command.direction === "right" ? amount : command.direction === "left" ? -amount : 0),
      top: (command.direction === "down" ? amount : command.direction === "up" ? -amount : 0), behavior: "instant" });
    return { ok: true, action_dispatched: true };
  }
  const stored = state.refs.get(command.ref);
  if (!stored) return fail("unknown_ref", "ref was not present in this snapshot; observe the page again");
  const element = stored.element;
  if (!visible(element) || fingerprint(element) !== stored.fingerprint) return fail("stale_ref", "the observed element changed or disappeared; observe again");
  if (disabled(element)) return fail("element_disabled", "the element is disabled");
  if (!["click", "fill", "select", "press"].includes(action)) return fail("invalid_params", "unsupported action");
  if (action === "fill") {
    if (typeof command.text !== "string" || command.text.length > 10000) return fail("invalid_params", "text must be a string of at most 10000 characters");
    if (element.readOnly || element.getAttribute("aria-readonly") === "true") return fail("element_readonly", "the element is read-only");
    if (!element.isContentEditable && !(element.tagName === "TEXTAREA" || (element.tagName === "INPUT"
      && ["text", "search", "email", "url", "tel", "password", "number"].includes(element.type)))) {
      return fail("unsupported_element", "fill requires a text input, textarea, or contenteditable element");
    }
  }
  if (action === "select") {
    if (element.tagName !== "SELECT") return fail("unsupported_element", "select requires a native select element; use observed options for custom controls");
    if (element.multiple) return fail("unsupported_element", "multiple selects require an explicit selection set and are not supported by this single-value action");
    if (typeof command.value !== "string") return fail("invalid_params", "value must be an exact option value");
    const option = [...element.options].find(item => item.value === command.value);
    if (!option || option.disabled || option.parentElement?.disabled) return fail("invalid_option", "this select has no enabled option with that value");
  }
  if (action === "press" && !["Enter", "Escape"].includes(command.key)) return fail("unsupported_key", "supported keys are Enter and Escape; use click, fill, or select for other actions");
  const submitsForm = ((action === "click" || (action === "press" && command.key === "Enter")) && element.type === "submit")
    || (action === "press" && command.key === "Enter" && element.tagName === "INPUT");
  if (submitsForm && element.form) {
    const formUrl = element.getAttribute("formaction") || element.form.action || location.href;
    const formTarget = element.getAttribute("formtarget") || element.form.target;
    let formProtocol;
    try { formProtocol = new URL(formUrl, location.href).protocol; }
    catch { return fail("forbidden_url", "form destination is invalid"); }
    if (!/^https?:$/.test(formProtocol)) return fail("forbidden_url", "only http and https form destinations are supported");
    if (formTarget && formTarget !== "_self") return fail("unsupported_target", "this form opens another browsing context");
  }
  if (action === "click" && element.tagName === "INPUT" && element.type === "file") return fail("unsupported_element", "file pickers are not supported");
  const anchor = element.closest("a[href]");
  if ((action === "click" || (action === "press" && command.key === "Enter")) && anchor) {
    let targetUrl;
    try { targetUrl = new URL(anchor.href, location.href); } catch { return fail("forbidden_url", "link URL is invalid"); }
    if (!/^https?:$/.test(targetUrl.protocol)) return fail("forbidden_url", "only http and https links are supported");
    if ((anchor.target && anchor.target !== "_self") || anchor.hasAttribute("download")) {
      return fail("unsupported_target", "this link opens another context or downloads a file; use navigate with its observed URL for a normal page");
    }
  }
  element.scrollIntoView({ block: "center", inline: "center", behavior: "instant" });
  const rect = element.getBoundingClientRect();
  const x = Math.max(0, Math.min(innerWidth - 1, rect.left + rect.width / 2));
  const y = Math.max(0, Math.min(innerHeight - 1, rect.top + rect.height / 2));
  const top = document.elementFromPoint(x, y);
  if (!top || (top !== element && !element.contains(top))) return fail("element_obscured", "another element covers this target; observe the page again");
  // Invalidate before dispatch. Even an exception may follow a page-side effect.
  globalThis[stateKey] = null;
  try {
    if (typeof element.focus === "function") element.focus({ preventScroll: true });
    if (action === "click") {
      if (typeof element.click === "function") element.click();
      else element.dispatchEvent(new MouseEvent("click", { bubbles: true, cancelable: true, composed: true }));
    }
    else if (action === "fill") {
      if (element.isContentEditable) element.textContent = command.text;
      else {
        const prototype = element.tagName === "TEXTAREA" ? HTMLTextAreaElement.prototype : HTMLInputElement.prototype;
        Object.getOwnPropertyDescriptor(prototype, "value").set.call(element, command.text);
      }
      element.dispatchEvent(new Event("input", { bubbles: true, composed: true }));
      element.dispatchEvent(new Event("change", { bubbles: true, composed: true }));
    } else if (action === "select") {
      Object.getOwnPropertyDescriptor(HTMLSelectElement.prototype, "value").set.call(element, command.value);
      element.dispatchEvent(new Event("input", { bubbles: true }));
      element.dispatchEvent(new Event("change", { bubbles: true }));
    } else {
      const accepted = element.dispatchEvent(new KeyboardEvent("keydown", { key: command.key, code: command.key, bubbles: true, cancelable: true }));
      if (accepted && command.key === "Enter") {
        if (element.matches('button,a[href],input[type="submit"],input[type="button"]')) element.click();
        else if (element.tagName === "INPUT" && element.form) element.form.requestSubmit();
      }
      element.dispatchEvent(new KeyboardEvent("keyup", { key: command.key, code: command.key, bubbles: true }));
    }
    return { ok: true, action_dispatched: true, limitations: ["DOM_events_are_synthetic", "verify_the_after_snapshot_before_claiming_completion"] };
  } catch (error) {
    return { ok: false, error: { code: "outcome_unknown", message: `action may have started: ${String(error?.message || error)}` } };
  }
}

function createBrowserInteraction({ chrome, BridgeError, rememberTab, forgetTab, requireOwnedTab, waitForLoad, tabOpening }) {
  const storageKey = "bridgeBrowserSessionsV1";
  const queues = new Map();
  // Only a digest and snapshot id are retained, not another copy of page text.
  const observations = new Map();
  let storageQueue = Promise.resolve();
  const sessionId = params => {
    const id = params?.session_id;
    if (typeof id !== "string" || !/^[a-zA-Z0-9_-]{8,128}$/.test(id)) throw new BridgeError("invalid_params", "session_id must contain 8–128 letters, digits, underscores, or hyphens");
    return id;
  };
  const readSessions = async () => {
    const stored = (await chrome.storage.session.get(storageKey))[storageKey];
    return Object.assign(Object.create(null), stored && typeof stored === "object" && !Array.isArray(stored) ? stored : {});
  };
  const changeSessions = change => {
    const done = storageQueue.then(async () => {
      const sessions = await readSessions();
      await change(sessions);
      await chrome.storage.session.set({ [storageKey]: sessions });
    });
    storageQueue = done.catch(() => {});
    return done;
  };
  const sessions = async () => { await storageQueue; return readSessions(); };
  const serialize = (id, operation) => {
    const current = (queues.get(id) || Promise.resolve()).then(operation);
    const caught = current.catch(() => {});
    queues.set(id, caught);
    void caught.then(() => { if (queues.get(id) === caught) queues.delete(id); });
    return current;
  };
  const getSession = async id => {
    const record = (await sessions())[id];
    if (!record || !Number.isInteger(record.tab_id)) throw new BridgeError("unknown_session", "browser session is closed or belongs to a previous connection");
    try {
      await requireOwnedTab({ tab_id: record.tab_id }, id);
      await chrome.tabs.get(record.tab_id);
    } catch (error) {
      if (error?.code === "session_required") throw error;
      await changeSessions(all => { delete all[id]; });
      await forgetTab(record.tab_id);
      observations.delete(id);
      throw new BridgeError("unknown_session", "the session tab has been closed");
    }
    return record;
  };
  const url = value => {
    let parsed;
    try { parsed = new URL(String(value || "")); } catch { throw new BridgeError("invalid_params", "url must be an absolute http or https URL"); }
    if (!/^https?:$/.test(parsed.protocol)) throw new BridgeError("forbidden_url", "only http and https pages are supported");
    return parsed.href;
  };
  const page = async (tabId, command, mutation = false) => {
    let results;
    try {
      results = await chrome.scripting.executeScript({ target: { tabId, frameIds: [0] }, world: "ISOLATED", injectImmediately: true, func: browserPageCommand, args: [command] });
    } catch (error) {
      throw new BridgeError(mutation ? "outcome_unknown" : "script_failed", `${mutation ? "the action outcome is unknown; observe before retrying: " : ""}${String(error?.message || error)}`);
    }
    const result = results?.[0]?.result;
    if (!result) throw new BridgeError(mutation ? "outcome_unknown" : "script_failed", "the page returned no result; observe before retrying an action");
    if (!result.ok) throw new BridgeError(result.error?.code || "script_failed", result.error?.message || "page command failed");
    return result;
  };
  const observe = async (id, record) => {
    const result = await page(record.tab_id, { operation: "snapshot", session_id: id });
    const signature = JSON.stringify({ ...result.snapshot, snapshot_id: undefined });
    const digest = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(signature));
    observations.set(id, { snapshotId: result.snapshot.snapshot_id,
      digest: [...new Uint8Array(digest)].map(byte => byte.toString(16).padStart(2, "0")).join("") });
    return { session_id: id, tab_id: record.tab_id, snapshot: result.snapshot };
  };
  const close = async id => {
    const record = (await sessions())[id];
    if (!record) {
      observations.delete(id);
      return { session_id: id, closed: true, already_closed: true };
    }
    try { await chrome.tabs.remove(record.tab_id); }
    catch (error) {
      const exists = await chrome.tabs.get(record.tab_id).then(() => true, () => false);
      if (exists) throw new BridgeError("close_failed", String(error?.message || error));
    }
    await changeSessions(all => { delete all[id]; });
    await forgetTab(record.tab_id);
    observations.delete(id);
    return { session_id: id, tab_id: record.tab_id, closed: true };
  };
  return {
    async requireTabAccess(tabId, id = null) {
      const owner = Object.entries(await sessions()).find(([, record]) => record.tab_id === tabId);
      if (owner && owner[0] !== id) throw new BridgeError("session_required", "this tab belongs to an interactive browser session; use its session_id");
    },
    async forgetRemoved(tabId) {
      await changeSessions(all => {
        for (const [id, record] of Object.entries(all)) if (record.tab_id === tabId) {
          delete all[id];
          observations.delete(id);
        }
      });
    },
    async closeAll() {
      // Includes an open still queued when the native connection disappeared.
      const ids = new Set([...Object.keys(await sessions()), ...queues.keys()]);
      await Promise.allSettled([...ids].map(id => serialize(id, () => close(id))));
    },
    browser_open(params) {
      const id = sessionId(params);
      const destination = url(params.url);
      return serialize(id, async () => {
        if ((await sessions())[id]) throw new BridgeError("session_exists", "session already exists; snapshot or close it instead of opening it twice");
        tabOpening();
        const tab = await chrome.tabs.create({ url: destination, active: params.active === true });
        try {
          // Record the session before general ownership, so legacy tab methods
          // cannot slip into an interactive tab while its page is loading.
          await changeSessions(all => { all[id] = { tab_id: tab.id }; });
          await rememberTab(tab.id);
        } catch (error) {
          await chrome.tabs.remove(tab.id).catch(() => {});
          await changeSessions(all => { delete all[id]; });
          await forgetTab(tab.id);
          throw error;
        }
        const requested = Number(params.timeout_ms);
        const timeout = Number.isFinite(requested) ? Math.max(1000, Math.min(requested, 30000)) : 15000;
        const loaded = await waitForLoad(tab.id, timeout);
        const record = await getSession(id);
        try { return { ...(await observe(id, record)), loaded }; }
        catch (error) {
          return { session_id: id, tab_id: tab.id, loaded, snapshot: null,
            observation_error: { code: error.code || "script_failed", message: String(error.message || error) } };
        }
      });
    },
    browser_snapshot(params) {
      const id = sessionId(params);
      return serialize(id, async () => observe(id, await getSession(id)));
    },
    browser_action(params) {
      const id = sessionId(params);
      return serialize(id, async () => {
        const record = await getSession(id);
        const before = observations.get(id);
        const action = params.action;
        if (!["click", "fill", "select", "press", "scroll", "navigate", "back"].includes(action)) throw new BridgeError("invalid_params", "unsupported browser action");
        let dispatched;
        if (action === "navigate" || action === "back") {
          const destination = action === "navigate" ? url(params.url) : null;
          const currentTab = await chrome.tabs.get(record.tab_id);
          if (action === "back" && /^https?:/i.test(currentTab.url || "")) {
            dispatched = await page(record.tab_id, { operation: "back", session_id: id }, true);
          } else {
            // Browser navigation is allowed after an unsupported page as a way
            // to recover the session; no element reference is being acted on.
            await page(record.tab_id, { operation: "invalidate", session_id: id }).catch(() => {});
            try {
              if (action === "navigate") await chrome.tabs.update(record.tab_id, { url: destination });
              else await chrome.tabs.goBack(record.tab_id);
            } catch (error) {
              throw new BridgeError("outcome_unknown", `navigation outcome is unknown; observe before retrying: ${String(error?.message || error)}`);
            }
            dispatched = { action_dispatched: true };
          }
        } else {
          if (typeof params.snapshot_id !== "string" || !params.snapshot_id) throw new BridgeError("invalid_params", "snapshot_id from the latest observation is required");
          dispatched = await page(record.tab_id, { operation: "action", session_id: id,
            action, snapshot_id: params.snapshot_id, ref: params.ref, text: params.text,
            value: params.value, key: params.key, direction: params.direction, amount: params.amount }, true);
        }
        // A bounded observation, not a promise that page-side work finished.
        // Never replay the action because a navigation or render is still busy.
        await new Promise(resolve => setTimeout(resolve, 120));
        const loaded = await waitForLoad(record.tab_id, 1500);
        try {
          const after = await observe(id, record);
          return { ...after, action, action_dispatched: true, loaded,
            before_snapshot_id: before?.snapshotId || null,
            observed_state_changed: before ? before.digest !== observations.get(id)?.digest : null,
            state_comparison_scope: "bounded_snapshot_not_remote_side_effects",
            outcome: "dispatched_verify_snapshot", limitations: dispatched.limitations || [] };
        } catch (error) {
          observations.delete(id);
          return { session_id: id, tab_id: record.tab_id, action, action_dispatched: true,
            before_snapshot_id: before?.snapshotId || null, observed_state_changed: null,
            state_comparison_scope: "bounded_snapshot_not_remote_side_effects",
            outcome: "observation_unavailable", snapshot: null,
            observation_error: { code: error.code || "script_failed", message: String(error.message || error) } };
        }
      });
    },
    browser_close(params) {
      const id = sessionId(params);
      return serialize(id, () => close(id));
    },
  };
}
