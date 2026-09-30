// Cooperative guest contexts for the web build (HostContext, host_context.cpp).
//
// Each context is one JSPI call on the same thread: the scheduler is main() and every other
// context starts in mkw_fiber_entry (a JSPI export). mkw_fiber_switch suspends the caller on a
// promise and starts or resumes the target once the caller has suspended. JSPI switches the wasm
// call stack but not the linear-memory C stack, so the C stack pointer and limits are saved at
// every switch and restored on resume. The first two words of a context are its C stack base and
// size (struct Context).

addToLibrary({
  $MkwFibers: {
    // context pointer -> resolve function of the promise that context is suspended on
    suspended: new Map(),
  },

  $mkwFiberStart__deps: ['$MkwFibers', 'mkw_fiber_entry', 'emscripten_stack_set_limits', '$stackRestore'],
  $mkwFiberStart: (context) => {
    var stackBase = {{{ makeGetValue('context', 0, '*') }}};
    var stackSize = {{{ makeGetValue('context', POINTER_SIZE, 'u32') }}};
    var stackTop = stackBase + stackSize;
    _emscripten_stack_set_limits(stackTop, stackBase);
    stackRestore(stackTop);
    // Returns a promise that settles only if the context ends, which it never should.
    Promise.resolve(_mkw_fiber_entry(context)).catch((e) => {
      if (e !== 'unwind') abort(e);
    });
  },

  mkw_fiber_switch__deps: ['$MkwFibers', '$mkwFiberStart', '$stackSave', '$stackRestore',
                           'emscripten_stack_get_base', 'emscripten_stack_get_end',
                           'emscripten_stack_set_limits'],
  mkw_fiber_switch__async: true,
  mkw_fiber_switch: async (from, to) => {
    var saved = {
      sp: stackSave(),
      base: _emscripten_stack_get_base(),
      end: _emscripten_stack_get_end(),
    };
    var resumed = new Promise((resolve) => MkwFibers.suspended.set(from, resolve));
    var resumeTarget = MkwFibers.suspended.get(to);
    if (resumeTarget) {
      MkwFibers.suspended.delete(to);
      // Its continuation is a microtask, so it runs after this call has suspended.
      resumeTarget();
    } else {
      queueMicrotask(() => mkwFiberStart(to));
    }
    await resumed;
    _emscripten_stack_set_limits(saved.base, saved.end);
    stackRestore(saved.sp);
  },

  mkw_fiber_forget__deps: ['$MkwFibers'],
  mkw_fiber_forget: (context) => {
    // Dropping the resolver releases the suspended call for garbage collection.
    MkwFibers.suspended.delete(context);
  },
});
