// Citation popovers: keep them on screen; let multi-reference citations open on click.
(function () {
  function place(cite) {
    var pop = cite.querySelector(".cite-pop");
    if (!pop) return;
    pop.style.left = "";
    var rect = pop.getBoundingClientRect();
    var overflow = rect.right - (document.documentElement.clientWidth - 8);
    if (overflow > 0) pop.style.left = -overflow + "px";
  }

  function closeAll(except) {
    document.querySelectorAll(".cite-multi.open").forEach(function (c) {
      if (c !== except) {
        c.classList.remove("open");
        c.setAttribute("aria-expanded", "false");
      }
    });
  }

  document.querySelectorAll(".cite").forEach(function (cite) {
    cite.addEventListener("mouseenter", function () { place(cite); });
    cite.addEventListener("focus", function () { place(cite); });
  });

  document.querySelectorAll(".cite-multi").forEach(function (cite) {
    function toggle() {
      var open = !cite.classList.contains("open");
      closeAll(cite);
      cite.classList.toggle("open", open);
      cite.setAttribute("aria-expanded", String(open));
      if (open) place(cite);
    }
    cite.addEventListener("click", function (e) {
      if (e.target.closest(".cite-pop")) return; // let reference links work
      toggle();
    });
    cite.addEventListener("keydown", function (e) {
      if (e.key === "Enter" || e.key === " ") {
        e.preventDefault();
        toggle();
      }
    });
  });

  document.addEventListener("click", function (e) {
    if (!e.target.closest(".cite-multi")) closeAll(null);
  });
  document.addEventListener("keydown", function (e) {
    if (e.key === "Escape") closeAll(null);
  });
})();
