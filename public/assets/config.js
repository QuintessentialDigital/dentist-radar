// API base helper (defaults to same origin)
window.DR_API_BASE = window.DR_API_BASE || '';
function apiPath(p){ return (window.DR_API_BASE || '') + p; }
window.apiPath = apiPath;
