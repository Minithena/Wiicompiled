#pragma once

#include <filesystem>
#include <string>

namespace WebPlatform {

// Mounts the served game folder at /game (web_platform.cpp). Call from main(); the default
// Config.toml is written earlier, by a static constructor.
void MountGame();

// Mounts the browser's persistent storage (OPFS) and moves user state there: settings, key
// bindings, saves and logs survive reloads. Seeds the NAND from game/save/rksys.dat once (or
// again for "?resetsave"). Call after MountGame, before RuntimeMain.
void UsePersistentStorage();

// Config.toml written when there is none.
std::string DefaultConfigText();

// Debugging aid: a thread that prints the game thread's scheduling state every few seconds, since
// a browser cannot show where a blocked worker is stuck.
void StartWatchdog();

} // namespace WebPlatform
