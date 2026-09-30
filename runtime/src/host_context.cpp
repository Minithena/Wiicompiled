#include "host_context.h"

#if defined(_WIN32)
#ifndef NOMINMAX
#define NOMINMAX
#endif
#ifndef WIN32_LEAN_AND_MEAN
#define WIN32_LEAN_AND_MEAN
#endif
#include <windows.h>
#elif defined(__APPLE__) && defined(__aarch64__)
#include <sys/mman.h>
#include <unistd.h>

extern "C" void mkw_co_switch(void** targetSp, void** sourceSp);
extern "C" void* mkw_co_init(void* stackTop, void (*entry)(void*), void* argument);
#elif defined(__EMSCRIPTEN__)
#include <pthread.h>
#include <semaphore.h>

#include <algorithm>
#include <cstdlib>
#elif defined(__linux__)
#include <libco.h>

#include <cstdlib>
#include <unordered_map>
#else
#error "HostContext needs a supported cooperative-context backend"
#endif

namespace HostContext {

#if defined(_WIN32)

namespace {
thread_local bool g_convertedScheduler = false;
}

bool InitializeScheduler(Handle* scheduler)
{
    void* context = ConvertThreadToFiber(nullptr);
    g_convertedScheduler = context != nullptr;
    if (!context) {
        context = GetCurrentFiber();
    }
    *scheduler = context;
    return context != nullptr;
}

void ShutdownScheduler(Handle scheduler)
{
    if (scheduler && g_convertedScheduler) {
        ConvertFiberToThread();
    }
    g_convertedScheduler = false;
}

Handle Create(std::size_t stackSize, Entry entry, void* argument)
{
    return CreateFiber(stackSize, entry, argument);
}

void Destroy(Handle context)
{
    if (context) {
        DeleteFiber(context);
    }
}

bool IsCurrent(Handle context)
{
    return context != nullptr && GetCurrentFiber() == context;
}

void Switch(Handle target)
{
    SwitchToFiber(target);
}

#elif defined(__APPLE__) && defined(__aarch64__)

namespace {
struct Context {
    void* savedStackPointer = nullptr;
    void* stack = nullptr;
    std::size_t stackSize = 0;
};

// Guest scheduling is confined to the initialized main host thread. Keeping
// this as ordinary process state also avoids relying on Darwin TLS internals
// while executing on a manually managed stack.
Context* g_current = nullptr;
}

bool InitializeScheduler(Handle* scheduler)
{
    auto* context = new Context();
    g_current = context;
    *scheduler = context;
    return true;
}

void ShutdownScheduler(Handle scheduler)
{
    auto* context = static_cast<Context*>(scheduler);
    if (g_current == context) {
        g_current = nullptr;
    }
    delete context;
}

Handle Create(std::size_t stackSize, Entry entry, void* argument)
{
    auto* context = new Context();
    const std::size_t guardSize = static_cast<std::size_t>(getpagesize());
    const std::size_t totalSize = stackSize + guardSize;
    context->stack = mmap(nullptr, totalSize, PROT_READ | PROT_WRITE,
                          MAP_ANON | MAP_PRIVATE, -1, 0);
    if (context->stack == MAP_FAILED) {
        delete context;
        return nullptr;
    }
    // Fault on stack overflow instead of corrupting the preceding mapping.
    if (mprotect(context->stack, guardSize, PROT_NONE) != 0) {
        munmap(context->stack, totalSize);
        delete context;
        return nullptr;
    }
    context->stackSize = totalSize;

    auto* stackTop = static_cast<char*>(context->stack) + totalSize;
    context->savedStackPointer = mkw_co_init(stackTop, entry, argument);
    return context;
}

void Destroy(Handle context)
{
    auto* nativeContext = static_cast<Context*>(context);
    if (!nativeContext) {
        return;
    }
    if (nativeContext->stack) {
        munmap(nativeContext->stack, nativeContext->stackSize);
    }
    delete nativeContext;
}

bool IsCurrent(Handle context)
{
    return context != nullptr && context == g_current;
}

void Switch(Handle target)
{
    auto* destination = static_cast<Context*>(target);
    Context* source = g_current;
    if (!destination || destination == source) {
        return;
    }

    g_current = destination;
    mkw_co_switch(&destination->savedStackPointer, &source->savedStackPointer);
    g_current = source;
}

#elif defined(__EMSCRIPTEN__)

// WebAssembly cannot switch stacks, so each context is a real pthread (a Web Worker) and a
// switch passes a baton: post the target's semaphore, then block on our own. Exactly one context
// runs at a time, as with fibers, and the semaphores order every handoff. Any thread_local state
// that the fibers shared by running on one host thread is per-context here.

namespace {
struct Context {
    sem_t resume;
    pthread_t thread{};
    Entry entry = nullptr;
    void* argument = nullptr;
    bool ownsThread = false;
    bool destroyed = false;
};

// Only the baton holder reads or writes this; the semaphores publish it to the next holder.
Context* g_current = nullptr;

void* ContextThread(void* argument)
{
    auto* context = static_cast<Context*>(argument);
    sem_wait(&context->resume);
    if (context->destroyed) {
        return nullptr;
    }
    g_current = context;
    context->entry(context->argument);

    // A guest fiber must return through FiberProc's scheduler handoff.
    std::abort();
}
} // namespace

bool InitializeScheduler(Handle* scheduler)
{
    auto* context = new Context();
    sem_init(&context->resume, 0, 0);
    g_current = context;
    *scheduler = context;
    return true;
}

void ShutdownScheduler(Handle scheduler)
{
    auto* context = static_cast<Context*>(scheduler);
    if (!context) {
        return;
    }
    if (g_current == context) {
        g_current = nullptr;
    }
    sem_destroy(&context->resume);
    delete context;
}

Handle Create(std::size_t stackSize, Entry entry, void* argument)
{
    auto* context = new Context();
    context->entry = entry;
    context->argument = argument;
    sem_init(&context->resume, 0, 0);

    pthread_attr_t attributes;
    pthread_attr_init(&attributes);
    pthread_attr_setstacksize(&attributes, std::max<std::size_t>(stackSize, 64 * 1024));
    const int result = pthread_create(&context->thread, &attributes, ContextThread, context);
    pthread_attr_destroy(&attributes);
    if (result != 0) {
        sem_destroy(&context->resume);
        delete context;
        return nullptr;
    }
    context->ownsThread = true;
    return context;
}

void Destroy(Handle context)
{
    auto* nativeContext = static_cast<Context*>(context);
    if (!nativeContext) {
        return;
    }
    // Never the running context (fiber_manager defers those), so its thread is parked on its
    // semaphore, either before its first run or inside Switch. Wake it to exit, then reap it.
    if (nativeContext->ownsThread) {
        nativeContext->destroyed = true;
        sem_post(&nativeContext->resume);
        pthread_join(nativeContext->thread, nullptr);
    }
    sem_destroy(&nativeContext->resume);
    delete nativeContext;
}

bool IsCurrent(Handle context)
{
    return context != nullptr && context == g_current;
}

void Switch(Handle target)
{
    auto* destination = static_cast<Context*>(target);
    Context* source = g_current;
    if (!destination || destination == source) {
        return;
    }

    g_current = destination;
    sem_post(&destination->resume);
    while (sem_wait(&source->resume) != 0) {
    }
    if (source->destroyed) {
        pthread_exit(nullptr);
    }
    g_current = source;
}

#elif defined(__linux__)

namespace {
struct Context {
    cothread_t native = nullptr;
    Entry entry = nullptr;
    void* argument = nullptr;
    bool ownsNative = false;
};

thread_local Context* g_current = nullptr;
thread_local std::unordered_map<cothread_t, Context*> g_contexts;

void ContextEntry()
{
    const auto found = g_contexts.find(co_active());
    if (found == g_contexts.end() || !found->second || !found->second->entry) {
        std::abort();
    }

    Context* context = found->second;
    g_current = context;
    context->entry(context->argument);

    // A guest fiber must return through FiberProc's scheduler handoff. There
    // is no valid native caller to return to from libco's entry trampoline.
    std::abort();
}
} // namespace

bool InitializeScheduler(Handle* scheduler)
{
    auto* context = new Context();
    context->native = co_active();
    if (!context->native) {
        delete context;
        return false;
    }

    g_current = context;
    g_contexts.emplace(context->native, context);
    *scheduler = context;
    return true;
}

void ShutdownScheduler(Handle scheduler)
{
    auto* context = static_cast<Context*>(scheduler);
    if (!context) {
        return;
    }

    g_contexts.erase(context->native);
    if (g_current == context) {
        g_current = nullptr;
    }
    delete context;
}

Handle Create(std::size_t stackSize, Entry entry, void* argument)
{
    auto* context = new Context();
    context->entry = entry;
    context->argument = argument;
    context->native = co_create(static_cast<unsigned int>(stackSize), ContextEntry);
    context->ownsNative = context->native != nullptr;
    if (!context->native) {
        delete context;
        return nullptr;
    }

    g_contexts.emplace(context->native, context);
    return context;
}

void Destroy(Handle context)
{
    auto* nativeContext = static_cast<Context*>(context);
    if (!nativeContext) {
        return;
    }

    g_contexts.erase(nativeContext->native);
    if (nativeContext->ownsNative) {
        co_delete(nativeContext->native);
    }
    delete nativeContext;
}

bool IsCurrent(Handle context)
{
    return context != nullptr && context == g_current;
}

void Switch(Handle target)
{
    auto* destination = static_cast<Context*>(target);
    Context* source = g_current;
    if (!destination || destination == source) {
        return;
    }

    g_current = destination;
    co_switch(destination->native);
    g_current = source;
}

#endif

} // namespace HostContext
