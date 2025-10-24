// API base helper. If API and site are same origin, return p as-is.
window.DR_API_BASE = window.DR_API_BASE || '';
function apiPath(p){ return (window.DR_API_BASE || '') + p; }
window.apiPath = apiPath;
