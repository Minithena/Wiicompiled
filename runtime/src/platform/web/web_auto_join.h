#pragma once

#if defined(__EMSCRIPTEN__)
#include <dolphin/pad.h>
namespace WebAutoJoin {
// Follows the ordinary title/licence/WFC menus for an invite, then releases control before
// character selection. It never edits saved data directly or accepts an unknown prompt.
void Apply(PADStatus& pad);
}
#endif
