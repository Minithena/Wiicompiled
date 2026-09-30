#pragma once

#include <filesystem>

namespace WebPlatform {

// Mounts the served game folder at /game (web_platform.cpp). Call from main(); the default
// Config.toml is written earlier, by a static constructor.
void MountGame();

// Debugging aid: a thread that prints the game thread's scheduling state every few seconds, since
// a browser cannot show where a blocked worker is stuck.
void StartWatchdog();

} // namespace WebPlatform
