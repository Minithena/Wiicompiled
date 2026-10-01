#pragma once

#if defined(__EMSCRIPTEN__)
#include <string>

// A race load reads one kart archive per player, one after another, and on a far-away host each is
// a blocking round trip (Race/Kart/<vehicle><kind>-<driver><suffix>.szs). The game builds those
// names from small tables indexed by each player's vehicle and character, and the roster is known
// when the course file is first read (just before the karts). So that first course read hands the
// fetcher every player's candidate names at once, and the downloads overlap.
namespace WebRaceWarm {

// Called for every disc read with the file's path; acts on the first read of each course.
void OnDiscRead(const std::string& path);

} // namespace WebRaceWarm
#endif
