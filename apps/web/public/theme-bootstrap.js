(function () {
  var root = document.documentElement;
  var theme = "system";
  var density = "comfortable";
  try {
    var storedTheme = localStorage.getItem("constructos:theme");
    if (storedTheme === "light" || storedTheme === "dark" || storedTheme === "system") {
      theme = storedTheme;
    }
    var storedDensity = localStorage.getItem("constructos:density");
    if (storedDensity === "comfortable" || storedDensity === "compact") {
      density = storedDensity;
    }
  } catch (_error) {
    /* Storage can be unavailable in hardened browser contexts. */
  }

  var resolved = theme;
  if (theme === "system") {
    resolved =
      window.matchMedia && window.matchMedia("(prefers-color-scheme: dark)").matches
        ? "dark"
        : "light";
  }

  root.setAttribute("data-theme", resolved);
  root.setAttribute("data-density", density);
  root.style.colorScheme = resolved;
  var meta = document.querySelector('meta[name="theme-color"]');
  if (meta) meta.setAttribute("content", resolved === "dark" ? "#0a0c11" : "#f6f7fa");
})();
