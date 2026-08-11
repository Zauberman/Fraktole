// No-op stand-in for ink's optional react-devtools-core dependency: ink only
// connects to devtools when DEV=true, but esbuild hoists the guarded import,
// so the module must resolve at load time.
export default {
  connectToDevTools() {},
};
