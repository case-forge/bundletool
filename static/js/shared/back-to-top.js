// Shared #cf-ascend back-to-top button behaviour: every product includes
// this file and layouts/partials/shared/back-to-top.html's markup rather
// than keeping a copy of its own.
(function () {
  const cfAscendBtn = document.getElementById("cf-ascend");
  if (!cfAscendBtn) return;

  const scrollToTop = () => {
    if (window.matchMedia("(prefers-reduced-motion: reduce)").matches) {
      window.scrollTo(0, 0);
      return;
    }
    const startY = window.scrollY || window.pageYOffset;
    const duration = 200;
    const startTime = performance.now();
    const step = now => {
      const elapsed = now - startTime;
      const progress = Math.min(elapsed / duration, 1);
      const ease = progress < 0.5
        ? 2 * progress * progress
        : 1 - Math.pow(-2 * progress + 2, 2) / 2;
      window.scrollTo(0, startY * (1 - ease));
      if (elapsed < duration) requestAnimationFrame(step);
    };
    requestAnimationFrame(step);
  };
  cfAscendBtn.addEventListener("click", () => {
    scrollToTop();
    // The button hides itself at the top, so keyboard focus moves to the page's first link
    // instead of falling to the document.
    const first = document.querySelector(".home-mark");
    if (first) first.focus({ preventScroll: true });
  });

  // On a narrow screen, once the footer's first line (the CaseForge credit, a short centred line) is
  // on screen, the button docks beside it at the right, so it never covers a footer link and never
  // lands on the page's last card. Wide screens keep it in the margin beside the column.
  const credit = document.querySelector(".cf-footer-credit, .bt-footer-credit");
  const narrow = window.matchMedia("(max-width: 900px)");
  const lift = () => {
    let px = 0;
    if (credit && narrow.matches) {
      const r = credit.getBoundingClientRect();
      const wanted = window.innerHeight - r.bottom - 24;   // the button's bottom edge sits on the credit line's, so it never reaches the links line below
      if (r.top < window.innerHeight) px = Math.max(0, wanted);
    }
    cfAscendBtn.style.setProperty("--ascend-lift", px + "px");
  };
  const sync = () => {
    lift();
    const maxScroll = document.documentElement.scrollHeight - window.innerHeight;
    if (maxScroll < 150) { cfAscendBtn.style.display = "none"; return; }
    const threshold = Math.min(300, maxScroll * 0.35);
    cfAscendBtn.style.display = window.scrollY > threshold ? "flex" : "none";
  };
  window.addEventListener("scroll", sync, { passive: true });
  window.addEventListener("resize", sync);
  sync();
})();
