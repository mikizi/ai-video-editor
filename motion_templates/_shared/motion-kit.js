/* Shared helpers for OpenMontage motion templates (HyperFrames + GSAP).
   Deterministic: no clocks, no randomness, no network. */
(function () {
  const root = document.querySelector("[data-composition-id]");
  const W = +root.dataset.width, H = +root.dataset.height, D = +root.dataset.duration;
  // 1u = 1% of the short side, so the same template works for 9:16, 16:9 and 1:1.
  document.documentElement.style.setProperty("--u", Math.min(W, H) / 100 + "px");
  document.documentElement.style.setProperty("--w", W + "px");
  document.documentElement.style.setProperty("--h", H + "px");
  const vars = (window.__hyperframes && window.__hyperframes.getVariables) ? window.__hyperframes.getVariables() : {};
  const isRtl = (s) => /[֐-׿؀-ۿ]/.test(s || "");
  // Put text into an element as one <span class="w"> per word (for staggered reveals).
  function words(el, text) {
    el.textContent = "";
    el.dir = isRtl(text) ? "rtl" : "ltr";
    (text || "").split(/\s+/).filter(Boolean).forEach((w) => {
      const outer = document.createElement("span"); outer.className = "wm";
      const inner = document.createElement("span"); inner.className = "w"; inner.textContent = w;
      outer.appendChild(inner); el.appendChild(outer); el.appendChild(document.createTextNode(" "));
    });
    return el.querySelectorAll(".w");
  }
  function text(el, t) { el.textContent = t || ""; el.dir = isRtl(t) ? "rtl" : "ltr"; }
  function colors(map) { for (const [k, v] of Object.entries(map)) if (v) document.documentElement.style.setProperty(k, v); }
  window.MK = { W, H, D, vars, isRtl, words, text, colors, vertical: H > W };
})();
