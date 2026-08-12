// Progressive-enhancement custom dropdowns. Native <select> popups aren't
// themeable and can cover the field; here we hide the native select (keeping it
// in the DOM so all existing change/input handlers keep working) and show an
// app-styled button plus a popup that opens BELOW the field with a search box.

const esc = (s) => String(s ?? "").replace(/[&<>"]/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;" }[c]));

let openPop = null;
// Close when the page/a container behind the popup scrolls (the popup is
// fixed-positioned and would detach), but NOT when scrolling the option list
// inside the popup itself.
function onOuterScroll(e) {
  const t = e.target;
  if (openPop && t && t.nodeType === 1 && openPop.el.contains(t)) return; // inside the list
  closePop();
}
function closePop() {
  if (!openPop) return;
  openPop.el.remove();
  window.removeEventListener("scroll", onOuterScroll, true);
  window.removeEventListener("resize", onResize);
  openPop = null;
}

function optionLabel(sel) {
  const o = sel.options[sel.selectedIndex];
  return o ? o.textContent : "";
}

function enhanceSelect(sel) {
  if (sel.dataset.cs) return;
  sel.dataset.cs = "1";
  const origStyle = sel.getAttribute("style") || ""; // capture BEFORE hiding
  sel.setAttribute("aria-hidden", "true");
  sel.tabIndex = -1;
  sel.style.display = "none";
  const btn = document.createElement("button");
  btn.type = "button";
  btn.className = "cs-btn" + (sel.className ? " " + sel.className : "");
  if (origStyle) btn.setAttribute("style", origStyle);
  const paint = () => { btn.innerHTML = `<span class="cs-lab">${esc(optionLabel(sel)) || "&nbsp;"}</span>`; };
  paint();
  sel._csPaint = paint;
  sel.after(btn);
  btn.addEventListener("click", (e) => { e.preventDefault(); e.stopPropagation(); toggle(sel, btn); });
  sel.addEventListener("change", paint); // keep label synced if code sets .value
}

function toggle(sel, btn) {
  const wasOpen = openPop && openPop.sel === sel;
  closePop();
  if (wasOpen) return;
  const el = document.createElement("div");
  el.className = "cs-pop";
  const opts = [...sel.options];
  const withSearch = opts.length > 7;
  el.innerHTML = (withSearch ? `<div class="cs-search-wrap"><input class="cs-search" placeholder="Search…" autocomplete="off"></div>` : "") + `<div class="cs-list"></div>`;
  const list = el.querySelector(".cs-list");
  const draw = (q) => {
    const ql = (q || "").trim().toLowerCase();
    const items = opts.filter((o) => !ql || o.textContent.toLowerCase().includes(ql));
    list.innerHTML = items.length
      ? items.map((o) => `<div class="cs-opt${o.value === sel.value ? " sel" : ""}" data-v="${esc(o.value)}">${esc(o.textContent)}</div>`).join("")
      : `<div class="cs-empty">No matches</div>`;
    list.querySelectorAll(".cs-opt").forEach((it) => it.addEventListener("click", () => {
      sel.value = it.dataset.v;
      if (sel._csPaint) sel._csPaint();
      closePop();
      sel.dispatchEvent(new Event("input", { bubbles: true }));
      sel.dispatchEvent(new Event("change", { bubbles: true }));
    }));
  };
  draw("");
  document.body.appendChild(el);
  // Position below the field (above if there isn't room), clamped to viewport.
  const r = btn.getBoundingClientRect();
  el.style.minWidth = r.width + "px";
  const ph = el.offsetHeight, spaceBelow = window.innerHeight - r.bottom;
  const top = (spaceBelow >= ph + 8 || spaceBelow >= r.top) ? r.bottom + 4 : Math.max(8, r.top - ph - 4);
  let left = r.left;
  if (left + el.offsetWidth > window.innerWidth - 8) left = Math.max(8, window.innerWidth - el.offsetWidth - 8);
  el.style.top = top + "px";
  el.style.left = left + "px";
  openPop = { el, sel, w: window.innerWidth };
  const s = el.querySelector(".cs-search");
  // Do NOT auto-focus the search on touch devices: it pops the on-screen
  // keyboard, whose viewport resize used to close the popup instantly. Tapping
  // the search field still focuses it when the user wants to type.
  const coarse = window.matchMedia && window.matchMedia("(pointer: coarse)").matches;
  if (s) { if (!coarse) s.focus(); s.addEventListener("input", () => draw(s.value)); s.addEventListener("click", (e) => e.stopPropagation()); }
  window.addEventListener("scroll", onOuterScroll, true);
  window.addEventListener("resize", onResize);
}

// Close on orientation / real width change, but ignore height-only resizes
// (the mobile keyboard shrinks height and must not close the dropdown).
function onResize() {
  if (openPop && window.innerWidth !== openPop.w) closePop();
}

export function initSelectEnhancer() {
  const enhanceAll = (root) => root.querySelectorAll?.("select:not([data-cs])").forEach(enhanceSelect);
  enhanceAll(document);
  const mo = new MutationObserver((muts) => {
    for (const m of muts) for (const n of m.addedNodes) {
      if (n.nodeType !== 1) continue;
      if (n.matches?.("select:not([data-cs])")) enhanceSelect(n);
      enhanceAll(n);
    }
  });
  mo.observe(document.body, { childList: true, subtree: true });
  document.addEventListener("click", (e) => { if (openPop && !openPop.el.contains(e.target)) closePop(); });
  document.addEventListener("keydown", (e) => { if (e.key === "Escape") closePop(); });
}
