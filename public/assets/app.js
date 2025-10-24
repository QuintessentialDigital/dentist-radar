(function(){
  if (!('DR_API_BASE' in window)) window.DR_API_BASE = '';
  window.apiPath = function(p){ return (window.DR_API_BASE || '') + p; };
})();