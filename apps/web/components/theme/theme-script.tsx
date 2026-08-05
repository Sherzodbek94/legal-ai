/**
 * Applies the stored theme before first paint.
 *
 * Has to be a blocking inline script in `<head>`, not a `useEffect`: React
 * runs effects after the first paint, so doing it there shows a flash of the
 * light theme on every single navigation for a dark-mode user. This is the
 * one case where a synchronous inline script is the correct tool.
 *
 * Falls back to the OS preference when nothing has been chosen explicitly,
 * and is wrapped in try/catch because reading localStorage throws outright in
 * a browser with site data blocked.
 */
const SCRIPT = `
(function () {
  try {
    var stored = localStorage.getItem('theme');
    var dark = stored
      ? stored === 'dark'
      : window.matchMedia('(prefers-color-scheme: dark)').matches;
    if (dark) document.documentElement.classList.add('dark');
  } catch (e) {}
})();
`;

export function ThemeScript() {
  return <script dangerouslySetInnerHTML={{ __html: SCRIPT }} />;
}
