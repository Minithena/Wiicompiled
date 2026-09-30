// Reports WGSL compiler errors with the offending source lines. Browsers disagree about WGSL
// (Chrome's Tint and Firefox's naga accept different programs), and a failed shader module
// otherwise only surfaces as a generic "Shader validation error".
if (typeof GPUDevice !== 'undefined' && !GPUDevice.prototype.__mkwDiagnostics) {
  GPUDevice.prototype.__mkwDiagnostics = true;
  const createShaderModule = GPUDevice.prototype.createShaderModule;
  GPUDevice.prototype.createShaderModule = function(descriptor) {
    const module = createShaderModule.call(this, descriptor);
    module.getCompilationInfo().then((info) => {
      const errors = info.messages.filter((m) => m.type === 'error');
      if (!errors.length) return;
      const lines = String(descriptor.code).split('\n');
      for (const m of errors) {
        const context = lines.slice(Math.max(0, m.lineNum - 3), m.lineNum + 1).join('\n');
        err(`[wgsl] ${descriptor.label || 'shader'} ${m.lineNum}:${m.linePos}: ${m.message}\n${context}`);
      }
    }, () => {});
    return module;
  };
}
