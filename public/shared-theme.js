/* Mesh — shared theme toggle (dark/light) */
function getTheme(){return localStorage.getItem('mesh-theme')||(window.matchMedia('(prefers-color-scheme:light)').matches?'light':'dark')}
function applyTheme(t){document.documentElement.setAttribute('data-theme',t);localStorage.setItem('mesh-theme',t)}
function toggleTheme(){applyTheme(getTheme()==='dark'?'light':'dark')}
applyTheme(getTheme());
