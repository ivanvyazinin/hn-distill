(function () {
  const cards = Array.from(document.querySelectorAll("section.js-card"));
  if (cards.length === 0) return;

  let i = 0; // current index
  const select = (next) => {
    cards[i]?.classList.remove("selected");
    i = Math.max(0, Math.min(next, cards.length - 1));
    const el = cards[i];
    if (!el) return;
    el.classList.add("selected");
    try {
      el.focus({ preventScroll: true });
    } catch {}
    el.scrollIntoView({ block: "nearest" });
  };

  // Initialize on first card for predictability
  select(0);

  const isTypingField = (t) => t && (t.tagName === "INPUT" || t.tagName === "TEXTAREA" || t.isContentEditable);

  const openOriginal = () => {
    const el = cards[i];
    const href = el?.dataset?.original;
    if (href) window.open(href, "_blank", "noopener,noreferrer");
  };

  const goPrevPage = () => {
    const a = document.querySelector('nav.pagination a[rel="prev"]');
    if (a) window.location.assign(a.getAttribute("href"));
  };

  const goNextPage = () => {
    const a =
      document.querySelector('nav.pagination a[rel="next"]') || document.querySelector("nav.pagination a[href]");
    if (a) window.location.assign(a.getAttribute("href"));
  };

  window.addEventListener(
    "keydown",
    (e) => {
      if (e.altKey || e.metaKey || e.ctrlKey) return;
      if (isTypingField(e.target)) return;

      switch (e.key) {
        case "j": {
          e.preventDefault();
          if (i === cards.length - 1) {
            goNextPage();
            return;
          }
          select(i + 1);
          break;
        }
        case "k": {
          e.preventDefault();
          if (i === 0) {
            goPrevPage();
            return;
          }
          select(i - 1);
          break;
        }
        case "o":
          e.preventDefault();
          openOriginal();
          break;
        case "h":
          e.preventDefault();
          goPrevPage();
          break;
        case "l":
          e.preventDefault();
          goNextPage();
          break;
      }
    },
    { passive: false }
  );
})();