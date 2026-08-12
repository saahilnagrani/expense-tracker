// Progressive-enhancement custom dropdowns. Native <select> popups aren't
// themeable and can cover the field; here we hide the native select (keeping it
// in the DOM so all existing change/input handlers keep working) and show an
// app-styled button plus a popup that opens BELOW the field with a search box.

const esc = (s) => String(s ?? "").replace(/[&<>"]/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;" }[c]));

let openPop = null;
function closePop() {
  if (!openPop) return;
  openPop.el.remove();
  window.removeEventListener("scroll", closePop, true);
  window.removeEventListener("resize", closePop);
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
  openPop = { el, sel };
  const s = el.querySelector(".cs-search");
  if (s) { s.focus(); s.addEventListener("input", () => draw(s.value)); s.addEventListener("click", (e) => e.stopPropagation()); }
  window.addEventListener("scroll", closePop, true);
  window.addEventListener("resize", closePop);
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
