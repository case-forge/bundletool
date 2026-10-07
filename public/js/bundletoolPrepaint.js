/* BundleTool's pre-paint script: sets data-theme and data-palette (and the favicon and theme colour)
 * before the first paint so there is no flash of the wrong look. A synchronous external file in <head>,
 * not an inline script, so the page's Content-Security-Policy can forbid inline script. */
// Pre-paint: set data-theme before first render so there is no flash
// of the wrong theme. A deliberate duplicate of bundletoolTheme.js's
// apply() logic: that file loads as a module (deferred), which would run
// after paint. This script must stay a plain, untyped script tag (not
// type="module") to run synchronously in <head>. The favicon and
// theme-colour swap duplicates the shared theme script for the same
// before-paint reason.
(function () {
	// Lock-theme and lock-favicon toggles, set from the Settings modal.
	// Both are off by default: unlocked means shared with the rest of
	// CaseForge, and locked keeps BundleTool's own independent value.
	// Duplicated here (not imported) for the same pre-paint reason as
	// everything else in this block.
	var themeLocked, faviconLocked, faviconFrozen, existingOwnTheme;
	try { themeLocked = localStorage.getItem('cf_theme_locked'); } catch (e) {}
	try { faviconLocked = localStorage.getItem('cf_favicon_locked'); } catch (e) {}
	try { faviconFrozen = localStorage.getItem('cf_favicon_frozen'); } catch (e) {}
	try { existingOwnTheme = localStorage.getItem('buntool_theme'); } catch (e) {}
	var themeKey;
	if (themeLocked === 'true') themeKey = 'buntool_theme';
	else if (themeLocked === 'false') themeKey = 'cf_theme';
	// No explicit choice yet: preserve an existing independent
	// preference rather than silently merging it into the shared
	// theme.
	else themeKey = existingOwnTheme ? 'buntool_theme' : 'cf_theme';

	// Storage can be blocked (a private window with site data off): fall back to following the device.
	var pref;
	try { pref = localStorage.getItem(themeKey); } catch (e) {}
	pref = pref || 'auto';
	var systemDark = window.matchMedia('(prefers-color-scheme: dark)').matches;
	var mode = pref === 'auto' ? (systemDark ? 'dark' : 'light') : pref;
	document.documentElement.setAttribute('data-theme', mode);
	document.documentElement.dataset.themePref = pref;
	// Palette: Modern, the default, is Chambers Finder's scheme; Classic is
	// the original slate and blue. Set before paint for the same no-flash
	// reason as data-theme above.
	var palette = 'modern';
	try { if (localStorage.getItem('bundletool_palette') === 'classic') palette = 'classic'; } catch (e) {}
	document.documentElement.setAttribute('data-palette', palette);

	var favMode = (faviconLocked === 'true' && (faviconFrozen === 'light' || faviconFrozen === 'dark')) ? faviconFrozen : mode;
	var link = document.querySelector('link[rel="icon"][type="image/svg+xml"]');
	if (link) {
		var next = favMode === 'dark' ? link.dataset.dark : link.dataset.light;
		if (next && link.href.indexOf(next) === -1) link.href = next;
	}
	var meta = document.querySelector('meta[name="theme-color"]');
	if (meta) meta.content = palette === 'classic'
		? (mode === 'dark' ? '#020617' : '#f5f5f4')
		: (mode === 'dark' ? '#0e1014' : '#f0ebe1');
})();
