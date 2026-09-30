#pragma once

#include <filesystem>

namespace WebPlatform {

// Mounts the served game folder at /game (web_platform.cpp). Call from main(); the default
// Config.toml is written earlier, by a static constructor.
void MountGame();

} // namespace WebPlatform
